import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { canonicalDemoRequest, getDemoRuntime } from "./demo-runtime";
import { createRoutingPins } from "./routing-pins";
import { createMessageClock } from "./message-timestamps";
import { productionCoreRequest, productionWebConfiguration } from "./core-api";

// Local development has no durable identity/secret store. Its receipts last
// only for this server process; deployed demo receipts use the durable secret.
const localSecret = randomBytes(32).toString("base64url");

export async function chatAccess(request: Request) {
  const failure = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });
  if (process.env.VERCEL && process.env.HASI_DEMO_MODE !== "1" && process.env.HASI_APP_MODE !== "production") return failure("Die Testsitzung ist vorübergehend nicht verfügbar.", 503);
  try {
    let scope: string;
    let secret: string;
    let production: ReturnType<typeof productionWebConfiguration> | undefined;
    if (process.env.HASI_APP_MODE === "production") {
      production = productionWebConfiguration();
      if (request.headers.get("host") !== new URL(production.origin).host) return failure("Unzulässiger Host.", 403);
      const incoming = new URL(request.url);
      request = new Request(new URL(`${incoming.pathname}${incoming.search}`, production.origin), request);
      const response = await productionCoreRequest("/api/session", new Request(request.url, { headers: request.headers }), "GET");
      const session = await response.json() as { user?: { id?: unknown }; mode?: unknown; modelContext?: { dataClasses?: unknown } };
      if (!response.ok || session.mode !== "oidc" || typeof session.user?.id !== "string") return failure("Bitte melde dich an.", 401);
      const sourceClasses = session.modelContext?.dataClasses;
      if (!Array.isArray(sourceClasses) || sourceClasses.length === 0 || sourceClasses.length > 4 || sourceClasses.some((value: unknown) => value !== "public" && value !== "internal" && value !== "confidential")) return failure("Die Datenfreigabe ist nicht verfügbar.", 503);
      const approvedClasses = production.dataClasses;
      if (sourceClasses.some((value: unknown) => !approvedClasses.includes(value as "public" | "internal" | "confidential"))) return failure("Die Quellen überschreiten die freigegebene Datenrichtlinie dieser Installation.", 503);
      scope = `production:${session.user.id}`;
      secret = production.secret;
    } else if (process.env.HASI_DEMO_MODE === "1") {
      const canonical = canonicalDemoRequest(request);
      if (!canonical) return failure("Unzulässiger Host.", 403);
      request = canonical;
      const identity = await (await getDemoRuntime()).chatScope(request);
      if (!identity) return failure("Bitte wähle zuerst ein Testkonto.", 401);
      scope = identity;
      secret = process.env.HASI_DEMO_SECRET ?? "";
      if (!secret) return failure("Die Serverzeit ist vorübergehend nicht verfügbar.", 503);
    } else {
      const host = request.headers.get("host");
      const localOrigins = ["http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://localhost:3001"];
      const origin = localOrigins.find(value => new URL(value).host === host);
      if (!origin) return failure("Unzulässiger Host.", 403);
      const incoming = new URL(request.url);
      request = new Request(new URL(`${incoming.pathname}${incoming.search}`, origin), request);
      const response = await fetch("http://127.0.0.1:4100/api/session", { headers: { cookie: request.headers.get("cookie") ?? "" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
      const session = await response.json() as { user?: { id?: unknown } };
      if (!response.ok || typeof session.user?.id !== "string") return failure("Bitte wähle zuerst ein Testkonto.", 401);
      scope = `local:${session.user.id}:${request.headers.get("cookie") ?? ""}`;
      secret = localSecret;
    }
    const allowedOrigins = production ? [production.origin] : ["https://hasi.metaneutrons.cc"];
    if (!production && process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
    if (!production && !process.env.VERCEL) allowedOrigins.push("http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://localhost:3001");
    if (!process.env.VERCEL && process.env.HASI_DEMO_MODE === "1") allowedOrigins.push(new URL(request.url).origin);
    // Classification comes from explicit deployment policy and the current API
    // authority. It is never a claim that free text was scanned or that future
    // institutional output is synthetic.
    const modelContext = { dataClasses: production?.dataClasses ?? ["synthetic_demo"], toolsRequired: true };
    return { request, allowedOrigins, modelContext, timestampScope: createHash("sha256").update(scope).digest("hex"), routingPins: createRoutingPins(secret, `${new URL(request.url).origin}:${scope}`), clock: createMessageClock(secret, `${new URL(request.url).origin}:${scope}`) };
  } catch {
    return failure("Die Sitzung ist vorübergehend nicht verfügbar.", 503);
  }
}
