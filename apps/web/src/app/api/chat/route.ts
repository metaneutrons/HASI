import { checkRateLimit } from "@vercel/firewall";
import { handleChatPost } from "@/lib/server/chat-http";
import { listModelProfiles, runModelStep } from "@/lib/server/model-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function GET() {
  return Response.json(listModelProfiles(), { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const allowedOrigins = ["https://hasi.metaneutrons.cc"];
  if (process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
  if (!process.env.VERCEL) allowedOrigins.push("http://127.0.0.1:3001", "http://127.0.0.1:3002", "http://localhost:3001");
  return handleChatPost(request, {
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
