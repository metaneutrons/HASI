import { handleChatPost } from "@/lib/server/chat-http";
import { listModelProfiles, runModelStep } from "@/lib/server/model-router";
import { chatAccess } from "@/lib/server/chat-access";
import { admitChat } from "@/lib/server/chat-admission";
import { loadAuthorizedModelTools } from "@/lib/server/authorized-tools";
import { getModelBudgetAdmission, loadModelPrices, modelPrice } from "@/lib/server/model-budgets";
import { loadModelConfiguration } from "@/lib/server/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET() {
  try {
    const result = listModelProfiles();
    const configuration = loadModelConfiguration(process.env);
    const prices = loadModelPrices(process.env);
    return Response.json({ ...result, profiles: result.profiles.map(profile => ({ ...profile, configured: profile.configured && modelPrice(profile.id, configuration, prices) !== undefined })) }, { headers: { "cache-control": "private, no-store" } });
  }
  catch { return Response.json({ error: "Die Modellkonfiguration ist nicht verfügbar." }, { status: 503, headers: { "cache-control": "private, no-store" } }); }
}

export async function POST(request: Request) {
  const access = await chatAccess(request);
  if (access instanceof Response) return access;
  return handleChatPost(access.request, {
    run: async input => runModelStep(input, { context: access.modelContext, budgetAdmission: await getModelBudgetAdmission(), routingPins: access.routingPins, authorizedTools: await loadAuthorizedModelTools(access.request), messageTimes: input.messages.map(message => access.clock.verify(message, message.timestamp)), telemetry: metrics => { console.info("HASI model usage", JSON.stringify(metrics)); } }),
    clock: access.clock,
    allowedOrigins: access.allowedOrigins,
    admit: admitChat,
  });
}
