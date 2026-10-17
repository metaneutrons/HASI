import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { canonicalDemoRequest, getDemoRuntime } from "./demo-runtime";
import { createRoutingPins } from "./routing-pins";
import { createMessageClock } from "./message-timestamps";

// Local development has no durable identity/secret store. Its receipts last
// only for this server process; deployed demo receipts use the durable secret.
const localSecret = randomBytes(32).toString("base64url");

export async function chatAccess(request: Request) {
  const failure = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });
  if (process.env.VERCEL && process.env.HASI_DEMO_MODE !== "1") return failure("Die Testsitzung ist vorübergehend nicht verfügbar.", 503);
  try {
    let scope: string;
    let secret: string;
    if (process.env.HASI_DEMO_MODE === "1") {
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
    const allowedOrigins = ["https://hasi.metaneutrons.cc"];
    if (process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
    if (!process.env.VERCEL) allowedOrigins.push("http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://localhost:3001");
    if (!process.env.VERCEL && process.env.HASI_DEMO_MODE === "1") allowedOrigins.push(new URL(request.url).origin);
    return { request, allowedOrigins, timestampScope: createHash("sha256").update(scope).digest("hex"), routingPins: createRoutingPins(secret, `${new URL(request.url).origin}:${scope}`), clock: createMessageClock(secret, `${new URL(request.url).origin}:${scope}`) };
  } catch {
    return failure("Die Testsitzung ist vorübergehend nicht verfügbar.", 503);
  }
}
