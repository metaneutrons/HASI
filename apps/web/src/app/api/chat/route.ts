import { handleChatPost } from "@/lib/server/chat-http";
import { listModelProfiles, runModelStep } from "@/lib/server/model-router";
import { chatAccess } from "@/lib/server/chat-access";
import { admitChat } from "@/lib/server/chat-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  try { return Response.json(listModelProfiles(), { headers: { "cache-control": "private, no-store" } }); }
  catch { return Response.json({ error: "Die Modellkonfiguration ist nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}

export async function POST(request: Request) {
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  return handleChatPost(access.request, {
    run: input => runModelStep(input, { routingPins: access.routingPins, messageTimes: input.messages.map(message => access.clock.verify(message, message.timestamp)) }),
    clock: access.clock,
    allowedOrigins: access.allowedOrigins,
    admit: admitChat,
  });
}
