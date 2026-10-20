import { chatAccess } from "@/lib/server/chat-access";
import { createHostDialogueSigner, handleHostDialoguePost } from "@/lib/server/host-dialogue";
import { productionHistoryAuthority } from "@/lib/server/history-authority";
import { readNativeBookings, readNativeResources } from "@/lib/server/native-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  if (!access.production) return Response.json({ error: "Nicht gefunden." }, { status: 404, headers: { "cache-control": "private, no-store" } });
  return handleHostDialoguePost(access.request, {
    allowedOrigins: access.allowedOrigins,
    signer: createHostDialogueSigner(access.production.secret, access.production.scope),
    authority: () => productionHistoryAuthority(access.request),
    resources: () => readNativeResources(access.request),
    bookingsEmpty: async () => (await readNativeBookings(access.request)).length === 0,
  });
}
