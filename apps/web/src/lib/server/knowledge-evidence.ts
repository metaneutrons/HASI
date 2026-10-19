import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { digest } from "@hasi/plugin-sdk";
import { z } from "zod";
import { knowledgeEvidenceSchema, type ChatRequest, type KnowledgeEvidence, type WireMessage } from "../chat-contract";
import { knowledgeModelDocuments } from "../knowledge";
import { ModelRouterError } from "./model-router-error";

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

function body(message: AssistantMessage) {
  return { id: message.id ?? null, content: message.content, toolCalls: message.toolCalls ?? null };
}

/** Distinct from timestamp receipts: the public timestamp endpoint cannot mint this proof. */
export function createKnowledgeEvidence(secret: string, scope: string, clock: () => number = Date.now) {
  if (!secret || !scope) throw new TypeError("Knowledge evidence requires a host secret and subject scope");
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hasi-derived-knowledge-v1", 32));
  const proof = (conversationId: string, message: AssistantMessage, contextIds: readonly string[], expiresAt: string, authorityDigest?: string) =>
    createHmac("sha256", key).update(digest({ scope, conversationId, body: body(message), contextIds, expiresAt, authorityDigest: authorityDigest ?? null })).digest();
  return {
    stamp(conversationId: string, message: AssistantMessage, ids: readonly string[], authorityDigest?: string): KnowledgeEvidence {
      z.uuid().parse(conversationId);
      z.uuid().parse(message.id);
      if (authorityDigest !== undefined && !AUTHORITY_DIGEST.test(authorityDigest)) throw new TypeError("Invalid history authority digest");
      const contextIds = [...new Set(ids)].sort();
      if (contextIds.length > 32) throw new ModelRouterError("context_unavailable", "Knowledge dependency limit reached");
      const expiresAt = new Date(clock() + EVIDENCE_RETENTION_MS).toISOString();
      return knowledgeEvidenceSchema.parse({ ...(authorityDigest ? { authorityDigest } : {}), contextIds, expiresAt, receipt: proof(conversationId, message, contextIds, expiresAt, authorityDigest).toString("base64url") });
    },
    verify(conversationId: string, message: AssistantMessage, currentAuthorityDigest?: string): KnowledgeEvidence | undefined {
      try {
        z.uuid().parse(conversationId);
        z.uuid().parse(message.id);
        if (currentAuthorityDigest !== undefined && !AUTHORITY_DIGEST.test(currentAuthorityDigest)) return undefined;
        const evidence = knowledgeEvidenceSchema.parse(message.evidence);
        if (currentAuthorityDigest !== undefined && evidence.authorityDigest !== currentAuthorityDigest) return undefined;
        const expires = Date.parse(evidence.expiresAt);
        if (expires <= clock() || expires > clock() + EVIDENCE_RETENTION_MS || new Set(evidence.contextIds).size !== evidence.contextIds.length) return undefined;
        const actual = Buffer.from(evidence.receipt, "base64url");
        const expected = proof(conversationId, message, evidence.contextIds, evidence.expiresAt, evidence.authorityDigest);
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
export async function rebuildKnowledgeContext(input: ChatRequest, signer: ReturnType<typeof createKnowledgeEvidence>, resolve: KnowledgeContextResolver, currentAuthorityDigest?: string) {
  const conversationId = input.conversationId;
  if (!conversationId) throw new ModelRouterError("context_unavailable", "A production conversation identity is required");
  const proofs = new Map<AssistantMessage, KnowledgeEvidence>();
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of input.messages) {
    if (message.role === "user") { pending.clear(); continue; }
    if (message.role === "assistant") {
      const evidence = signer.verify(conversationId, message, currentAuthorityDigest);
      pending.clear();
      if (evidence) {
        proofs.set(message, evidence);
        evidence.contextIds.forEach(id => ids.add(id));
        message.toolCalls?.forEach(call => pending.set(call.id, call.name));
      }
    } else {
      if (pending.get(message.toolCallId) !== message.name) continue;
      pending.delete(message.toolCallId);
      if (message.name === "knowledge_search") {
        const id = toolContextId(message);
        if (id) ids.add(id);
      }
    }
  }
  if (ids.size > 32) throw new ModelRouterError("context_unavailable", "Knowledge dependency limit reached");
  let resolved: readonly ResolvedKnowledgeContext[];
  try { resolved = ids.size ? await resolve([...ids]) : []; }
  catch { throw new ModelRouterError("context_unavailable", "Current source rights could not be verified"); }
  const valid = new Map(resolved.filter(value => value.status === "valid" && Array.isArray(value.documents)).map(value => [value.contextId, value]));
  const dependencies = new Set<string>();
  const messages: WireMessage[] = [];
  pending.clear();
  const invalidMessageIds: string[] = [];
  let changed = false;
  for (const message of input.messages) {
    if (message.role === "user") { messages.push(message); pending.clear(); continue; }
    if (message.role === "assistant") {
      const evidence = proofs.get(message);
      if (!evidence || evidence.contextIds.some(id => !valid.has(id))) {
        changed = true;
        if (message.id) invalidMessageIds.push(message.id);
        pending.clear();
        continue;
      }
      evidence.contextIds.forEach(id => dependencies.add(id));
      messages.push(message);
      pending.clear();
      message.toolCalls?.forEach(call => pending.set(call.id, call.name));
      continue;
    }
    if (pending.get(message.toolCallId) !== message.name) { changed = true; continue; }
    pending.delete(message.toolCallId);
    if (message.name !== "knowledge_search") {
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
  return { request: { ...input, messages }, contextIds: [...dependencies], invalidMessageIds, changed };
}
