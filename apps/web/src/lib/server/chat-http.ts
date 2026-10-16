import { chatRequestSchema, type ChatRequest, type ModelReply } from "../chat-contract";

const MAX_BODY_BYTES = 60_000;
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export interface ChatHttpDependencies {
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
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("size");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
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
    return Response.json(await dependencies.run(input), { headers });
  } catch {
    // Provider/SDK errors can contain request bodies, headers or credentials.
    return error("GroqCloud konnte die Anfrage nicht abschließen. Bitte versuche es erneut oder wähle ausdrücklich die Dialog-Demo.", 503);
  }
}
