import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/lib/chat-sessions";
import type { KnowledgeDocument } from "../src/lib/knowledge";
import { chatKnowledgeCitations } from "../src/lib/chat-knowledge-citations";

const context = "6dd8e02f-2846-41ac-9e92-7958b02808bf";
const otherContext = "6dd8e02f-2846-41ac-9e92-7958b02808ba";
const document: KnowledgeDocument = {
  id: "svc-001", citationId: "knowledge:service_it:svc-001:1", title: "Demo: WLAN",
  sourceSystem: "service_it", language: "de", revision: 1, synthetic: true,
  text: "Synthetic WLAN instructions", updatedAt: "2026-10-16T00:00:00Z", fetchedAt: "2026-10-16T00:00:00Z",
  authorityRevision: "a".repeat(64), corpusRevision: "b".repeat(64), dataClass: "synthetic_demo", images: [],
};
const source: ChatMessage = { id: "source", role: "assistant", text: "Sources", sources: [document], sourceContextId: context };
const evidence = { contextIds: [context], expiresAt: "2099-01-01T00:00:00Z", receipt: "a".repeat(43) };
const answer: ChatMessage = { id: "answer", role: "assistant", text: `WLAN [${document.citationId}]`, evidence };

describe("answer-scoped knowledge citation presentation", () => {
  it("uses the same stable number for a source card and its evidenced answer", () => {
    const result = chatKnowledgeCitations([source, answer]);
    expect(result.answers.get(answer.id)).toEqual(result.sourceCards.get(source.id));
    expect(result.answers.get(answer.id)?.[0]).toMatchObject({ number: 1, href: "/sources/svc-001?revision=1" });
  });
  it("does not infer proof from nearby sources, foreign contexts or a later source result", () => {
    const unsigned: ChatMessage = { id: answer.id, role: "assistant", text: answer.text };
    expect(chatKnowledgeCitations([source, unsigned]).answers.get(answer.id)).toEqual([]);
    const foreign = { ...answer, evidence: { ...evidence, contextIds: [otherContext] } };
    expect(chatKnowledgeCitations([source, foreign]).answers.get(answer.id)).toEqual([]);
    expect(chatKnowledgeCitations([answer, source]).answers.get(answer.id)).toEqual([]);
    expect(chatKnowledgeCitations([answer]).answers.get(answer.id)).toEqual([]);
  });
  it("limits unsigned synthetic demo linking to the same user turn", () => {
    const unsigned: ChatMessage = { id: answer.id, role: "assistant", text: answer.text };
    const user: ChatMessage = { id: "user", role: "user", text: "Next question" };
    expect(chatKnowledgeCitations([source, unsigned], true).answers.get(answer.id)).toHaveLength(1);
    expect(chatKnowledgeCitations([source, user, unsigned], true).answers.get(answer.id)).toEqual([]);
    expect(chatKnowledgeCitations([source, { ...unsigned, role: "user" }], true).answers.has(answer.id)).toBe(false);
  });
  it("does not permit unsigned non-synthetic source linking or broaden an explicit empty evidence set", () => {
    const real: KnowledgeDocument = { ...document, synthetic: false, dataClass: "internal", canonicalUrl: "https://it.example.invalid/wlan" };
    const unsigned: ChatMessage = { id: answer.id, role: "assistant", text: answer.text };
    expect(chatKnowledgeCitations([{ ...source, sources: [real] }, unsigned], true).answers.get(answer.id)).toEqual([]);
    expect(chatKnowledgeCitations([source, { ...answer, evidence: { ...evidence, contextIds: [] } }], true).answers.get(answer.id)).toEqual([]);
  });
  it("deduplicates repeated documents and gives distinct revisions distinct numbers", () => {
    const next: KnowledgeDocument = { ...document, revision: 2, citationId: "knowledge:service_it:svc-001:2" };
    const source2 = { ...source, id: "source2", sourceContextId: otherContext, sources: [document, next] };
    const proof = { ...answer, evidence: { ...evidence, contextIds: [context, otherContext] } };
    expect(chatKnowledgeCitations([source, source2, proof]).answers.get(answer.id)?.map(item => item.number)).toEqual([1, 2]);
  });
});
