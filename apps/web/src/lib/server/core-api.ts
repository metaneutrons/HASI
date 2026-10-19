import "server-only";
import { z } from "zod";

const dataClasses = z.array(z.enum(["public", "internal", "confidential"])).min(1).max(3);

export function productionWebConfiguration() {
  if (process.env.HASI_APP_MODE !== "production" || process.env.HASI_DEMO_MODE === "1") throw new Error("Production web mode is not configured");
  const origin = new URL(process.env.HASI_WEB_ORIGIN ?? "");
  const api = new URL(process.env.HASI_API_ORIGIN ?? "");
  if ([origin, api].some(url => url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)) throw new Error("Invalid production origin configuration");
  if (origin.origin === api.origin) throw new Error("Production frontend and API require separate origins");
  const secret = process.env.HASI_CHAT_SIGNING_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{43,128}$/u.test(secret)) throw new Error("Production chat signing configuration unavailable");
  // Conservative deployment ceiling for the entire outgoing context, including imported history.
  // This policy cannot be lowered by a browser message or plugin-provided classification.
  const classes = dataClasses.parse(JSON.parse(process.env.HASI_CONTEXT_DATA_CLASSES ?? '["public","internal","confidential"]') as unknown);
  return { origin: origin.origin, apiOrigin: api.origin, secret, dataClasses: classes };
}

export async function productionCoreRequest(path: string, request: Request, method = request.method): Promise<Response> {
  const configuration = productionWebConfiguration();
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#")) throw new Error("Invalid API path");
  const target = new URL(path, configuration.apiOrigin);
  if (target.origin !== configuration.apiOrigin) throw new Error("Invalid API destination");
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "content-type"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (request.headers.get("origin")) headers.set("origin", request.headers.get("origin") ?? "");
  const hasBody = method !== "GET" && method !== "HEAD";
  let body: Uint8Array | undefined;
  if (hasBody) {
    const reader = request.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error("API body too large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      body = Buffer.concat(chunks);
    }
  }
  return fetch(target, { method, headers, ...(body ? { body: Buffer.from(body) } : {}), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(45000) });
}

export async function productionApiResponse(request: Request) {
  try {
    const configuration = productionWebConfiguration();
    if (request.headers.get("host") !== new URL(configuration.origin).host) return Response.json({ error: "Unzulässiger Host." }, { status: 403 });
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== configuration.origin) return Response.json({ error: "Ungültiger Anfrageursprung." }, { status: 403 });
    const url = new URL(request.url);
    const response = await productionCoreRequest(`${url.pathname}${url.search}`, request);
    const headers = new Headers({ "cache-control": "private, no-store" });
    for (const name of ["content-type", "location"] as const) { const value = response.headers.get(name); if (value) headers.set(name, value); }
    const requestId = response.headers.get("x-request-id");
    if (requestId && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)) headers.set("x-request-id", requestId);
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    // OIDC redirects are intentional. The fixed API performs return-path and IdP-origin checks.
    return new Response(response.body, { status: response.status, headers });
  } catch { return Response.json({ error: "Der HASI-Dienst ist vorübergehend nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}
