import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { digest } from "@hasi/plugin-sdk";
import { z } from "zod";
import { knowledgeEvidenceSchema, type ChatRequest, type KnowledgeEvidence, type WireMessage } from "../chat-contract";
import { knowledgeModelDocuments } from "../knowledge";
import { MODEL_PLUGIN_TOOL_NAME } from "../plugin-tools";
import { ModelRouterError } from "./model-router-error";
import type { PluginResultResolution } from "./plugin-result-context";

const EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORITY_DIGEST = /^[a-f0-9]{64}$/u;

type AssistantMessage = Extract<WireMessage, { role: "assistant" }>;
export interface ResolvedKnowledgeContext {
  contextId: string;
  status: "valid" | "unavailable";
  documents?: Record<string, unknown>[];
  dataClasses?: string[];
}
export type KnowledgeContextResolver = (contextIds: readonly string[]) => Promise<readonly ResolvedKnowledgeContext[]>;
export type PluginResultContextResolver = (conversationId: string, contextIds: readonly string[], authorityDigest: string) => Promise<readonly PluginResultResolution[]>;

function body(message: AssistantMessage) {
  return { id: message.id ?? null, content: message.content, toolCalls: message.toolCalls ?? null };
}

/** Distinct from timestamp receipts: the public timestamp endpoint cannot mint this proof. */
export function createKnowledgeEvidence(secret: string, scope: string, clock: () => number = Date.now) {
  if (!secret || !scope) throw new TypeError("Knowledge evidence requires a host secret and subject scope");
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hasi-derived-knowledge-v1", 32));
  const proof = (conversationId: string, message: AssistantMessage, contextIds: readonly string[], expiresAt: string, authorityDigest: string | undefined, toolContextIds: readonly string[]) =>
    createHmac("sha256", key).update(digest({ scope, conversationId, body: body(message), contextIds, toolContextIds, expiresAt, authorityDigest: authorityDigest ?? null })).digest();
  return {
    stamp(conversationId: string, message: AssistantMessage, ids: readonly string[], authorityDigest?: string, toolIds: readonly string[] = []): KnowledgeEvidence {
      z.uuid().parse(conversationId);
      z.uuid().parse(message.id);
      if (authorityDigest !== undefined && !AUTHORITY_DIGEST.test(authorityDigest)) throw new TypeError("Invalid history authority digest");
      const contextIds = [...new Set(ids)].sort();
      const toolContextIds = [...new Set(toolIds)].sort();
      z.array(z.uuid()).parse(toolContextIds);
      if (contextIds.length + toolContextIds.length > 32) throw new ModelRouterError("context_unavailable", "Context dependency limit reached");
      const expiresAt = new Date(clock() + EVIDENCE_RETENTION_MS).toISOString();
      return knowledgeEvidenceSchema.parse({ ...(authorityDigest ? { authorityDigest } : {}), contextIds,
        ...(toolContextIds.length ? { toolContextIds } : {}), expiresAt,
        receipt: proof(conversationId, message, contextIds, expiresAt, authorityDigest, toolContextIds).toString("base64url") });
    },
    verify(conversationId: string, message: AssistantMessage, currentAuthorityDigest?: string): KnowledgeEvidence | undefined {
      try {
        z.uuid().parse(conversationId);
        z.uuid().parse(message.id);
        if (currentAuthorityDigest !== undefined && !AUTHORITY_DIGEST.test(currentAuthorityDigest)) return undefined;
        const evidence = knowledgeEvidenceSchema.parse(message.evidence);
        if (currentAuthorityDigest !== undefined && evidence.authorityDigest !== currentAuthorityDigest) return undefined;
        const expires = Date.parse(evidence.expiresAt);
        const toolContextIds = evidence.toolContextIds ?? [];
        if (expires <= clock() || expires > clock() + EVIDENCE_RETENTION_MS || new Set(evidence.contextIds).size !== evidence.contextIds.length
          || new Set(toolContextIds).size !== toolContextIds.length || evidence.contextIds.length + toolContextIds.length > 32) return undefined;
        const actual = Buffer.from(evidence.receipt, "base64url");
        const expected = proof(conversationId, message, evidence.contextIds, evidence.expiresAt, evidence.authorityDigest, toolContextIds);
        return actual.length === expected.length && timingSafeEqual(actual, expected) ? evidence : undefined;
      } catch { return undefined; }
    },
  };
}

function toolContextId(message: Extract<WireMessage, { role: "tool" }>) {
  if (message.name !== "knowledge_search") return undefined;
  try {
    const raw: unknown = JSON.parse(message.content);
    const value = z.object({ contextId: z.uuid() }).safeParse(raw);
    return value.success ? value.data.contextId : undefined;
  } catch { return undefined; }
}

/** Rebuild protected history from host evidence; browser-carried source bodies are never authoritative. */
export async function rebuildKnowledgeContext(input: ChatRequest, signer: ReturnType<typeof createKnowledgeEvidence>, resolve: KnowledgeContextResolver, currentAuthorityDigest?: string, resolveTools?: PluginResultContextResolver) {
  const conversationId = input.conversationId;
  if (!conversationId) throw new ModelRouterError("context_unavailable", "A production conversation identity is required");
  const proofs = new Map<AssistantMessage, KnowledgeEvidence>();
  const ids = new Set<string>();
  const toolIds = new Set<string>();
  const pending = new Map<string, NonNullable<AssistantMessage["toolCalls"]>[number]>();
  for (const message of input.messages) {
    if (message.role === "user") { pending.clear(); continue; }
    if (message.role === "assistant") {
      const evidence = signer.verify(conversationId, message, currentAuthorityDigest);
      pending.clear();
      if (evidence) {
        proofs.set(message, evidence);
        evidence.contextIds.forEach(id => ids.add(id));
        evidence.toolContextIds?.forEach(id => toolIds.add(id));
        message.toolCalls?.forEach(call => pending.set(call.id, call));
      }
    } else {
      if (pending.get(message.toolCallId)?.name !== message.name) continue;
      pending.delete(message.toolCallId);
      if (message.name === "knowledge_search") {
        const id = toolContextId(message);
        if (id) ids.add(id);
      } else if (MODEL_PLUGIN_TOOL_NAME.test(message.name) && message.toolContextId) {
        toolIds.add(message.toolContextId);
      }
    }
  }
  if (ids.size + toolIds.size > 32) throw new ModelRouterError("context_unavailable", "Context dependency limit reached");
  let resolved: readonly ResolvedKnowledgeContext[];
  try { resolved = ids.size ? await resolve([...ids]) : []; }
  catch { throw new ModelRouterError("context_unavailable", "Current source rights could not be verified"); }
  const valid = new Map(resolved.filter(value => value.status === "valid" && Array.isArray(value.documents)).map(value => [value.contextId, value]));
  const validTools = new Map<string, Extract<PluginResultResolution, { status: "valid" }>["context"]>();
  if (toolIds.size && currentAuthorityDigest && resolveTools) {
    try {
      for (const resolved of await resolveTools(conversationId, [...toolIds], currentAuthorityDigest)) {
        if (resolved.status !== "valid" || !toolIds.has(resolved.contextId)) continue;
        if (validTools.has(resolved.contextId) || resolved.context.conversationId !== conversationId
          || resolved.context.authorityDigest !== currentAuthorityDigest) throw new Error("Invalid result resolution");
        validTools.set(resolved.contextId, resolved.context);
      }
    } catch { throw new ModelRouterError("context_unavailable", "Current tool result authority could not be verified"); }
  }
  const dependencies = new Set<string>();
  const toolDependencies = new Set<string>();
  const messages: WireMessage[] = [];
  pending.clear();
  const invalidMessageIds: string[] = [];
  let changed = false;
  for (const message of input.messages) {
    if (message.role === "user") { messages.push(message); pending.clear(); continue; }
    if (message.role === "assistant") {
      const evidence = proofs.get(message);
      if (!evidence || evidence.contextIds.some(id => !valid.has(id)) || evidence.toolContextIds?.some(id => !validTools.has(id))) {
        changed = true;
        if (message.id) invalidMessageIds.push(message.id);
        pending.clear();
        continue;
      }
      evidence.contextIds.forEach(id => dependencies.add(id));
      evidence.toolContextIds?.forEach(id => toolDependencies.add(id));
      messages.push(message);
      pending.clear();
      message.toolCalls?.forEach(call => pending.set(call.id, call));
      continue;
    }
    const call = pending.get(message.toolCallId);
    if (call?.name !== message.name) { changed = true; continue; }
    pending.delete(message.toolCallId);
    if (message.name !== "knowledge_search") {
      const context = message.toolContextId ? validTools.get(message.toolContextId) : undefined;
      if (context && MODEL_PLUGIN_TOOL_NAME.test(message.name) && context.callId === message.toolCallId
        && context.modelName === message.name && digest(context.arguments) === digest(call.arguments)) {
        toolDependencies.add(context.contextId);
        messages.push({ ...message, content: JSON.stringify(context.result) });
        continue;
      }
      changed = true;
      messages.push({
        ...message,
        content: JSON.stringify({
          historyDetailsOmitted: true,
          requiresFreshRead: true,
          notice: "Frühere Tool-Daten sind nicht verifiziert. Verwende aktuelle Werkzeugabfragen; die Oberfläche zeigt separate Ergebniskarten.",
        }),
      });
      continue;
    }
    const id = toolContextId(message);
    const context = id ? valid.get(id) : undefined;
    if (context && id) {
      dependencies.add(id);
      messages.push({ ...message, content: JSON.stringify({ documents: knowledgeModelDocuments(context.documents ?? []), contextId: id }) });
    } else {
      changed = true;
      messages.push({ ...message, content: JSON.stringify({ documents: [], notice: "Frühere Quellen sind nicht mehr freigegeben oder aktuell. Bitte erneut suchen." }) });
    }
  }
  return { request: { ...input, messages }, contextIds: [...dependencies], toolContextIds: [...toolDependencies], invalidMessageIds, changed };
}
