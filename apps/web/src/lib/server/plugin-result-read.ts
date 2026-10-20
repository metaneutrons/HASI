import "server-only";

import { canonicalJson } from "@hasi/plugin-sdk";
import { z } from "zod";
import { wireMessageSchema } from "../chat-contract";
import { boundedPluginToolResult, type PluginToolDescriptor } from "../plugin-tools";
import { knownToolAlias, validatePluginToolArguments } from "./authorized-tools";
import type { createKnowledgeEvidence } from "./knowledge-evidence";
import type { PluginResultContextStore } from "./plugin-result-context";

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const inputSchema = z.strictObject({
  conversationId: z.uuid(),
  assistantMessage: wireMessageSchema.refine(message => message.role === "assistant"),
  toolCallId: z.string().trim().min(1).max(128),
});
const dataClass = z.enum(["synthetic_demo", "public", "internal", "confidential"]);
const envelopeSchema = z.object({
  version: z.literal(1),
  provenance: z.object({
    installationId: z.string().min(1).max(128),
    packageId: z.string().min(1).max(256),
    version: z.string().min(1).max(128),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    configurationRevision: z.number().int().nonnegative(),
    authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    fetchedAt: z.iso.datetime(),
    sourceId: z.string().min(1).max(128),
    policyRevision: z.string().min(1).max(128),
    dataClasses: z.array(dataClass).min(1).max(4),
  }),
});

interface ReadDependencies {
  allowedOrigins: readonly string[];
  dataClasses: readonly string[];
  signer: ReturnType<typeof createKnowledgeEvidence>;
  contexts: Pick<PluginResultContextStore, "create">;
  authority: () => Promise<string>;
  tools: () => Promise<readonly PluginToolDescriptor[]>;
  invoke: (tool: PluginToolDescriptor, arguments_: Record<string, unknown>) => Promise<Response>;
}

async function boundedJson(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<unknown> {
  const reader = body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > maximum) throw new Error("size");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Invoke a signed, currently authorized read. Never signs a caller-supplied result. */
export async function handlePluginResultRead(request: Request, dependencies: ReadDependencies): Promise<Response> {
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || !dependencies.allowedOrigins.includes(origin)
    || request.headers.get("sec-fetch-site") === "cross-site") return fail("Unzulässiger Anfrageursprung.", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return fail("Die Anfrage muss JSON enthalten.", 415);
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await boundedJson(request.body, 60_000)); }
  catch { return fail("Ungültige Werkzeuganfrage.", 400); }
  try {
    const authority = await dependencies.authority();
    const message = input.assistantMessage;
    if (!dependencies.signer.verify(input.conversationId, message, authority)) {
      return fail("Der Werkzeugaufruf ist nicht mehr freigegeben. Bitte stelle die Anfrage erneut.", 409);
    }
    const calls = message.toolCalls?.filter(call => call.id === input.toolCallId) ?? [];
    const [call] = calls;
    if (calls.length !== 1 || !call) return fail("Ungültiger Werkzeugaufruf.", 400);
    const matches = (await dependencies.tools()).filter(tool => tool.modelName === call.name);
    const tool = matches.length === 1 ? matches[0] : undefined;
    if (tool?.effect !== "read" || knownToolAlias(tool) || !validatePluginToolArguments(tool, call.arguments)) {
      return fail("Dieses Lesewerkzeug ist derzeit nicht freigegeben.", 403);
    }
    // Registry and core reauthorize independently; the descriptor never supplies
    // a destination, secret reference or execution permission.
    if (await dependencies.authority() !== authority) return fail("Die Dienstfreigabe hat sich geändert. Bitte erneut versuchen.", 409);
    const response = await dependencies.invoke(tool, call.arguments);
    if (!response.ok || response.redirected || response.headers.has("location")) {
      return fail("Die Dienstabfrage ist derzeit nicht möglich. Prüfe die Verbindung unter „Verbundene Dienste“.", response.status === 401 || response.status === 403 ? 403 : 503);
    }
    const raw = z.record(z.string(), z.unknown()).parse(await boundedJson(response.body, 96 * 1024));
    const envelope = envelopeSchema.parse(raw._hasi);
    if (envelope.provenance.installationId !== tool.pluginId
      || envelope.provenance.dataClasses.some(value => !dependencies.dataClasses.includes(value))) {
      return fail("Die Ergebnisfreigabe konnte nicht geprüft werden.", 409);
    }
    const output = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "_hasi"));
    const result = JSON.parse(canonicalJson(boundedPluginToolResult(output))) as Record<string, unknown>;
    if (await dependencies.authority() !== authority) return fail("Die Dienstfreigabe hat sich geändert. Bitte erneut versuchen.", 409);
    const { contextId } = await dependencies.contexts.create({
      conversationId: input.conversationId, callId: call.id, pluginId: tool.pluginId, toolName: tool.name,
      title: tool.title, arguments: call.arguments, result, authorityDigest: authority,
      dataClasses: [...new Set(envelope.provenance.dataClasses)],
    });
    // A result saved during withdrawal remains unusable under its old digest.
    if (await dependencies.authority() !== authority) return fail("Die Dienstfreigabe hat sich geändert. Bitte erneut versuchen.", 409);
    return Response.json({ result, contextId }, { headers });
  } catch {
    return fail("Das Werkzeugergebnis konnte nicht sicher geprüft werden. Bitte versuche es erneut.", 503);
  }
}
