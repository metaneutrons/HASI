import { getModelBudgetAdmission } from "@/lib/server/model-budgets";
import { getServerChatStorage } from "@/lib/server/server-chat-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness verifies durable storage and the existing budget without inference. */
export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const revision = process.env.HASI_BUILD_REVISION;
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision)) {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
  try {
    await getModelBudgetAdmission();
    const store = await getServerChatStorage();
    await store.read("deployment-readiness");
    return Response.json({ status: "ready", revision }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
