import { z } from "zod";
import { MAX_CHAT_WORKSPACE_BYTES, parseChatWorkspace } from "@/lib/chat-sessions";
import { chatAccess } from "@/lib/server/chat-access";
import { protectedWebConfiguration } from "@/lib/server/core-api";
import { productionKnowledgeResolver } from "@/lib/server/knowledge-context";
import { ProtectedWorkspaceConflict, ProtectedWorkspaceStore } from "@/lib/server/protected-workspaces";
import { productionNativeHistoryResolver } from "@/lib/server/native-history";
import { productionHistoryAuthority } from "@/lib/server/history-authority";
import { getServerChatStorage } from "@/lib/server/server-chat-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = MAX_CHAT_WORKSPACE_BYTES + 8_192;
const updateSchema = z.strictObject({
  expectedRevision: z.uuid().nullable(),
  workspace: z.unknown(),
});
const responseHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

interface ProductionChatAccess {
  readonly request: Request;
  readonly production: { readonly ownerId: string; readonly scope: string; readonly secret: string };
}

function unavailable() {
  return Response.json({ error: "Der geschützte Chat-Speicher ist vorübergehend nicht verfügbar." }, { status: 503, headers: responseHeaders });
}

function notFound() {
  return Response.json({ error: "Nicht gefunden." }, { status: 404, headers: responseHeaders });
}

async function authorize(request: Request): Promise<Response | { access: ProductionChatAccess }> {
  if ((process.env.HASI_APP_MODE !== "production" && process.env.HASI_LOCAL_TEST_IDP !== "1") || process.env.HASI_DEMO_MODE === "1") return notFound();
  let configuration: ReturnType<typeof protectedWebConfiguration>;
  try {
    configuration = protectedWebConfiguration();
  } catch {
    return unavailable();
  }
  if (request.headers.get("host") !== new URL(configuration.origin).host) {
    return Response.json({ error: "Unzulässiger Host." }, { status: 403, headers: responseHeaders });
  }
  const origin = request.headers.get("origin");
  if (request.method === "PUT" && origin !== configuration.origin) {
    return Response.json({ error: "Ungültiger Anfrageursprung." }, { status: 403, headers: responseHeaders });
  }
  if (request.method === "GET" && origin !== null && origin !== configuration.origin) {
    return Response.json({ error: "Ungültiger Anfrageursprung." }, { status: 403, headers: responseHeaders });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Ungültiger Anfrageursprung." }, { status: 403, headers: responseHeaders });
  }
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  if (!access.production) return notFound();
  return { access: { request: access.request, production: access.production } };
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("body");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function createWorkspaceService(access: ProductionChatAccess) {
  return getServerChatStorage().then(store => new ProtectedWorkspaceStore({
    store,
    ownerId: access.production.ownerId,
    scope: access.production.scope,
    secret: access.production.secret,
    resolve: productionKnowledgeResolver(access.request),
    resolveNative: productionNativeHistoryResolver(access.request),
    authority: () => productionHistoryAuthority(access.request),
  }));
}

export async function GET(request: Request) {
  const authorized = await authorize(request);
  if (authorized instanceof Response) return authorized;
  try {
    const service = await createWorkspaceService(authorized.access);
    return Response.json(await service.load(), { headers: responseHeaders });
  } catch {
    return unavailable();
  }
}

export async function PUT(request: Request) {
  const authorized = await authorize(request);
  if (authorized instanceof Response) return authorized;
  if (authorized.access.request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return Response.json({ error: "Die Anfrage muss JSON enthalten." }, { status: 415, headers: responseHeaders });
  }
  let parsed: z.infer<typeof updateSchema>;
  try {
    const body = updateSchema.safeParse(await readJson(authorized.access.request));
    if (!body.success) return Response.json({ error: "Der Chat-Speicher ist ungültig oder zu groß." }, { status: 400, headers: responseHeaders });
    parseChatWorkspace(body.data.workspace, authorized.access.production.ownerId);
    parsed = body.data;
  } catch {
    return Response.json({ error: "Der Chat-Speicher ist ungültig oder zu groß." }, { status: 400, headers: responseHeaders });
  }
  try {
    const service = await createWorkspaceService(authorized.access);
    return Response.json(await service.save(parsed.expectedRevision, parsed.workspace), { headers: responseHeaders });
  } catch (error) {
    if (error instanceof ProtectedWorkspaceConflict) {
      return Response.json({ revision: error.current.revision, workspace: error.current.workspace, conflict: true }, { status: 409, headers: responseHeaders });
    }
    return unavailable();
  }
}
