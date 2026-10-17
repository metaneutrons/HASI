import { chatAccess } from "@/lib/server/chat-access";
import { admitTimestamps } from "@/lib/server/chat-admission";
import { handleTimestampPost } from "@/lib/server/chat-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  return handleTimestampPost(access.request, { ...access, admit: () => admitTimestamps(access.timestampScope) });
}
