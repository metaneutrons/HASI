import { randomUUID } from "node:crypto";
import { timestampRequestSchema, chatRequestSchema, type ChatRequest, type ModelReply } from "../chat-contract";
import { ModelRouterError } from "./model-router-error";

import type { createMessageClock } from "./message-timestamps";

const MAX_BODY_BYTES = 60_000;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export interface ChatHttpDependencies {
  clock?: ReturnType<typeof createMessageClock>;
  finalize?: (reply: ModelReply, input: ChatRequest) => Promise<void>;
  run: (input: ChatRequest) => Promise<ModelReply>;
  admit: (request: Request) => Promise<boolean>;
  allowedOrigins: readonly string[];
}

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("size");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function handleChatPost(request: Request, dependencies: ChatHttpDependencies): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !dependencies.allowedOrigins.includes(origin) || origin !== new URL(request.url).origin) {
    return error("Diese Anfrage stammt nicht aus einer zugelassenen HASI-Oberfläche.", 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return error("Die Anfrage muss JSON enthalten.", 415);
  }
  let input: ChatRequest;
  try {
    const result = chatRequestSchema.safeParse(await readBody(request));
    if (!result.success) return error("Die Nachricht oder der Gesprächsverlauf ist ungültig oder zu lang. Beginne gegebenenfalls einen neuen Chat.", 400);
    input = result.data;
  } catch {
    return error("Die Anfrage ist ungültig oder überschreitet die zulässige Größe.", 400);
  }
  try {
    if (!await dependencies.admit(request)) {
      return Response.json({ error: "Das Anfragelimit der Demo ist erreicht. Bitte versuche es später erneut." }, { status: 429, headers: { ...headers, "retry-after": "60" } });
    }
  } catch {
    return error("Der Anfrageschutz ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.", 503);
  }
  try {
    const reply = await dependencies.run(input);
    if (dependencies.clock) {
      reply.message.id = randomUUID();
      reply.message.timestamp = dependencies.clock.stamp(reply.message);
    }
    await dependencies.finalize?.(reply, input);
    return Response.json(reply, { headers });
  } catch (cause) {
    // Provider/SDK errors can contain request bodies, headers or credentials.
    // Serialize allowlisted metadata so nested schema issue names remain visible.
    // Never log the cause or provider payload.
    console.warn("HASI model request failed", JSON.stringify(cause instanceof ModelRouterError
      ? { code: cause.code, providerStatus: cause.providerStatus, ...(cause.diagnostics && Object.keys(cause.diagnostics).length ? { diagnostics: cause.diagnostics } : {}), ...(cause.rateLimits && Object.keys(cause.rateLimits).length ? { rateLimits: cause.rateLimits } : {}) }
      : { code: "unexpected_provider_failure" }));
    if (cause instanceof ModelRouterError && cause.code === "context_unavailable") {
      return error("Die Quellenrechte oder Dokumentfassungen haben sich geändert oder können nicht geprüft werden. Bitte suche erneut. Eine Antwort ohne aktuelle Quellenfreigabe wird nicht angezeigt.", 409);
    }
    if (cause instanceof ModelRouterError && cause.code === "required_tools_unavailable") {
      return Response.json({ code: "required_tools_unavailable", error: "Der benötigte Dienst ist für dein Konto derzeit nicht freigegeben. Prüfe die Verbindung unter „Verbundene Dienste“. Eine interne Ressourcen-ID ist dafür nicht nötig." }, { status: 409, headers });
    }
    if (cause instanceof ModelRouterError && cause.code === "profile_not_approved") {
      return error("Das gewählte Modell oder die Routing-Freigabe ist für diese Anfrage nicht zugelassen. Beginne einen neuen Chat mit dem konfigurierten Standardmodell.", 403);
    }
    if (cause instanceof ModelRouterError && cause.code === "budget_exhausted") {
      return error("Das gemeinsame Tagesbudget für Modellanfragen ist ausgeschöpft. Bestehende Suchergebnisse und Buchungen kannst du weiter nutzen. Das Budget wird um 00:00 UTC erneuert.", 429);
    }
    if (cause instanceof ModelRouterError && cause.code === "budget_unpriced") {
      return error("Für dieses Modell ist noch kein freigegebener Tarif hinterlegt. Bitte wähle ein anderes Modell.", 503);
    }
    if (cause instanceof ModelRouterError && (cause.code === "budget_unavailable" || cause.code === "budget_usage_invalid")) {
      return error("Die gemeinsame Budgetprüfung ist vorübergehend nicht verfügbar. Es werden keine weiteren Modellanfragen gestartet. Vorhandene Buchungskarten bleiben nutzbar.", 503);
    }
    if (cause instanceof ModelRouterError && cause.code === "provider_rate_limited") {
      const retryAfter = cause.rateLimits?.retryAfterSeconds ?? 60;
      return Response.json({ error: `Das Anfragelimit des ausgewählten Modellanbieters ist erreicht. Bitte versuche es in ${String(retryAfter)} Sekunden erneut. Vorhandene Buchungskarten kannst du weiter nutzen.` }, { status: 429, headers: { ...headers, "retry-after": String(retryAfter) } });
    }
    return error("Der ausgewählte Modellanbieter konnte die Anfrage nicht abschließen. Bitte versuche es erneut oder wähle ausdrücklich die Dialog-Demo.", 503);
  }
}

/** Receipts certify server receipt time, not the truth of client-carried text. */
export async function handleTimestampPost(request: Request, dependencies: Pick<ChatHttpDependencies, "allowedOrigins" | "admit"> & { clock: ReturnType<typeof createMessageClock> }): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !dependencies.allowedOrigins.includes(origin) || origin !== new URL(request.url).origin) return error("Unzulässiger Ursprung.", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return error("Die Anfrage muss JSON enthalten.", 415);
  try {
    const result = timestampRequestSchema.safeParse(await readBody(request));
    if (!result.success) return error("Ungültige Nachrichten für die Zeiterfassung.", 400);
    if (!await dependencies.admit(request)) return error("Das Anfragelimit ist erreicht. Bitte versuche es später erneut.", 429);
    return Response.json({ timestamps: result.data.messages.map(message => ({ id: message.id, timestamp: dependencies.clock.verify(message, message.timestamp) ? message.timestamp : dependencies.clock.stamp(message) })) }, { headers });
  } catch {
    return error("Die Serverzeit konnte nicht erfasst werden.", 503);
  }
}
