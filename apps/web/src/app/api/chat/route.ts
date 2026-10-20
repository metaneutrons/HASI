import { handleChatPost } from "@/lib/server/chat-http";
import { listModelProfiles, runModelStep } from "@/lib/server/model-router";
import { chatAccess } from "@/lib/server/chat-access";
import { admitChat } from "@/lib/server/chat-admission";
import { loadAuthorizedModelTools } from "@/lib/server/authorized-tools";
import { getModelBudgetAdmission, loadModelPrices, modelPrice } from "@/lib/server/model-budgets";
import { createKnowledgeEvidence, rebuildKnowledgeContext } from "@/lib/server/knowledge-evidence";
import { productionKnowledgeResolver } from "@/lib/server/knowledge-context";
import { productionHistoryAuthority } from "@/lib/server/history-authority";
import type { ChatRequest } from "@/lib/chat-contract";
import { ModelRouterError } from "@/lib/server/model-router-error";
import { loadModelConfiguration } from "@/lib/server/model-config";
import { PluginResultContextStore } from "@/lib/server/plugin-result-context";
import { getServerChatStorage } from "@/lib/server/server-chat-storage";

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
  const signer = access.production ? createKnowledgeEvidence(access.production.secret, access.production.scope) : undefined;
  const resolve = productionKnowledgeResolver(access.request);
  const production = access.production;
  const resolveTools = production ? async (conversationId: string, ids: readonly string[], authority: string) => {
    const contexts = new PluginResultContextStore({ store: await getServerChatStorage(), ...production });
    return contexts.resolve(conversationId, ids, authority);
  } : undefined;
  let rebuilt: Awaited<ReturnType<typeof rebuildKnowledgeContext>> | undefined;
  let authorityDigest: string | undefined;
  const assertCurrent = async () => {
    if (signer) {
      if (!authorityDigest || await productionHistoryAuthority(access.request) !== authorityDigest) throw new ModelRouterError("context_unavailable", "Conversation authority changed");
    }
    if (rebuilt?.contextIds.length) {
      const current = await resolve(rebuilt.contextIds);
      if (current.some(item => item.status !== "valid")) throw new ModelRouterError("context_unavailable", "Source authority changed");
    }
    if (rebuilt?.toolContextIds.length) {
      if (!resolveTools || !authorityDigest || !rebuilt.request.conversationId) throw new ModelRouterError("context_unavailable", "Tool authority unavailable");
      const current = await resolveTools(rebuilt.request.conversationId, rebuilt.toolContextIds, authorityDigest);
      if (current.length !== rebuilt.toolContextIds.length || current.some(item => item.status !== "valid")) throw new ModelRouterError("context_unavailable", "Tool result authority changed");
    }
  };
  return handleChatPost(access.request, {
    run: async (input: ChatRequest) => {
      if (signer) {
        authorityDigest = await productionHistoryAuthority(access.request);
        rebuilt = await rebuildKnowledgeContext(input, signer, resolve, authorityDigest, resolveTools);
      } else rebuilt = undefined;
      const request = rebuilt?.request ?? input;
      const reply = await runModelStep(request, { context: access.modelContext, budgetAdmission: await getModelBudgetAdmission(), routingPins: access.routingPins, authorizedTools: await loadAuthorizedModelTools(access.request), messageTimes: request.messages.map(message => access.clock.verify(message, message.timestamp)), ...(signer ? { beforeProviderCall: assertCurrent } : {}), telemetry: metrics => { console.info("HASI model usage", JSON.stringify(metrics)); } });
      await assertCurrent();
      if (rebuilt?.changed) reply.contextNotice = "Frühere Inhalte ohne aktuelle Quellenfreigabe wurden aus dem Modellkontext entfernt.";
      return reply;
    },
    finalize: (reply, input) => {
      if (signer && input.conversationId) {
        if (!authorityDigest) throw new ModelRouterError("context_unavailable", "Current conversation authority is unavailable");
        reply.message.evidence = signer.stamp(input.conversationId, reply.message, rebuilt?.contextIds ?? [], authorityDigest, rebuilt?.toolContextIds ?? []);
      }
      return Promise.resolve();
    },
    clock: access.clock,
    allowedOrigins: access.allowedOrigins,
    admit: admitChat,
  });
}
