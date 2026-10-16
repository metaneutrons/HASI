import { checkRateLimit } from "@vercel/firewall";
import { handleChatPost } from "@/lib/server/chat-http";
import { listModelProfiles, runModelStep } from "@/lib/server/model-router";
import { canonicalDemoRequest, getDemoRuntime } from "@/lib/server/demo-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  return Response.json(listModelProfiles(), { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  if (process.env.VERCEL && process.env.HASI_DEMO_MODE !== "1") return Response.json({ error: "Die Testsitzung ist vorübergehend nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  let chatRequest = request;
  if (process.env.HASI_DEMO_MODE === "1") {
    try {
      const canonical = canonicalDemoRequest(request);
      if (!canonical) return Response.json({ error: "Unzulässiger Host." }, { status: 403, headers: { "cache-control": "private, no-store" } });
      chatRequest = canonical;
      if (!await (await getDemoRuntime()).hasSession(chatRequest)) return Response.json({ error: "Bitte wähle zuerst ein Testkonto." }, { status: 401, headers: { "cache-control": "private, no-store" } });
    } catch {
      return Response.json({ error: "Die Testsitzung ist vorübergehend nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } });
    }
  }
  const allowedOrigins = ["https://hasi.metaneutrons.cc"];
  if (process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
  if (!process.env.VERCEL) allowedOrigins.push("http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://localhost:3001");
  if (!process.env.VERCEL && process.env.HASI_DEMO_MODE === "1") allowedOrigins.push(new URL(chatRequest.url).origin);
  return handleChatPost(chatRequest, {
    run: runModelStep,
    allowedOrigins,
    admit: async () => {
      if (!process.env.VERCEL) return true;
      // Pin the firewall destination, rather than forwarding a caller-controlled
      // Host header. The public project domain also works for protected previews.
      const result = await checkRateLimit("hasi-chat", {
        headers: new Headers({ host: "hasi.metaneutrons.cc" }),
        rateLimitKey: "hasi:groq:shared:v1",
        timeout: 3000,
      });
      if (result.error) throw new Error("Chat admission unavailable");
      return !result.rateLimited;
    },
  });
}
