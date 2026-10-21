import "server-only";

import { handleChatPost } from "./chat-http";
import { runModelStep, type ModelBudgetAdmission } from "./model-router";
import { chatAccess } from "./chat-access";
import { admitChat } from "./chat-admission";
import { loadAuthorizedModelTools } from "./authorized-tools";
import { getModelBudgetAdmission } from "./model-budgets";
import { createKnowledgeEvidence, rebuildKnowledgeContext } from "./knowledge-evidence";
import { productionKnowledgeResolver } from "./knowledge-context";
import { productionHistoryAuthority } from "./history-authority";
import type { ChatRequest } from "../chat-contract";
import { ModelRouterError } from "./model-router-error";
import { PluginResultContextStore } from "./plugin-result-context";
import { getServerChatStorage } from "./server-chat-storage";
import { loadActionContext, sameActionContext, type ActionContext } from "./action-context";

/** Trusted server composition only; request, source and model input cannot select admission. */
export function createChatPostHandler(options: {
  getBudgetAdmission?: () => Promise<ModelBudgetAdmission>;
} = {}) {
  const getBudgetAdmission = options.getBudgetAdmission ?? getModelBudgetAdmission;
  return async function post(request: Request) {
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
    let actionIds: readonly string[] = [];
    let actions: ActionContext = [];
    const assertNotCancelled = () => {
      if (access.request.signal.aborted) throw new ModelRouterError("request_cancelled", "Chat request cancelled");
    };
    const assertCurrent = async () => {
      assertNotCancelled();
      if (actionIds.length && !sameActionContext(actions, await loadActionContext(access.request, actionIds))) {
        throw new ModelRouterError("action_context_changed", "Action status changed");
      }
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
      run: async (input: ChatRequest, signal: AbortSignal) => {
        assertNotCancelled();
        if (signer) {
          authorityDigest = await productionHistoryAuthority(access.request);
          rebuilt = await rebuildKnowledgeContext(input, signer, resolve, authorityDigest, resolveTools);
        } else rebuilt = undefined;
        const request = rebuilt?.request ?? input;
        actionIds = input.proposalIds ?? [];
        actions = await loadActionContext(access.request, actionIds);
        assertNotCancelled();
        const reply = await runModelStep(request, { context: access.modelContext, budgetAdmission: await getBudgetAdmission(), routingPins: access.routingPins, authorizedTools: await loadAuthorizedModelTools(access.request), messageTimes: request.messages.map(message => access.clock.verify(message, message.timestamp)), actionContext: actions, beforeProviderCall: assertCurrent, signal, telemetry: metrics => { console.info("HASI model usage", JSON.stringify(metrics)); } });
        await assertCurrent();
        if (rebuilt?.changed) reply.contextNotice = "Frühere Inhalte ohne aktuelle Quellenfreigabe wurden aus dem Modellkontext entfernt.";
        return reply;
      },
      finalize: (reply, input, signal) => {
        if (signal.aborted) throw new ModelRouterError("request_cancelled", "Chat request cancelled");
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
  };
}
