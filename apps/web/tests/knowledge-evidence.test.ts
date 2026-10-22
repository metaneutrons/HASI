import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createKnowledgeEvidence, rebuildKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import type { ChatRequest, WireMessage } from "../src/lib/chat-contract";
import { omittedToolHistoryContent } from "../src/lib/tool-history";

describe("current knowledge evidence in model history", () => {
  it("authenticates derived text to subject, conversation and dependencies independently of timestamps", () => {
    let now = Date.parse("2026-10-18T12:00:00Z");
    const signer = createKnowledgeEvidence("synthetic-secret", "subject-one", () => now);
    const other = createKnowledgeEvidence("synthetic-secret", "subject-two", () => now);
    const conversation = randomUUID();
    const message: Extract<WireMessage, { role: "assistant" }> = { id: randomUUID(), role: "assistant", content: "Synthetic protected answer" };
    message.evidence = signer.stamp(conversation, message, [randomUUID()]);
    expect(signer.verify(conversation, message)).toEqual(message.evidence);
    expect(other.verify(conversation, message)).toBeUndefined();
    expect(signer.verify(randomUUID(), message)).toBeUndefined();
    expect(signer.verify(conversation, { ...message, content: "tampered" })).toBeUndefined();
    expect(signer.verify(conversation, { ...message, evidence: { ...message.evidence, contextIds: [] } })).toBeUndefined();
    now += 30 * 24 * 60 * 60 * 1000 + 1;
    expect(signer.verify(conversation, message)).toBeUndefined();
  });

  it("replaces browser-carried tool bodies with fresh authorized records and excludes revoked derived answers", async () => {
    const signer = createKnowledgeEvidence("synthetic-secret", "subject-one");
    const conversationId = randomUUID();
    const contextId = randomUUID();
    const call: Extract<WireMessage, { role: "assistant" }> = { id: randomUUID(), role: "assistant", content: "", toolCalls: [{ id: "read-one", name: "knowledge_search", arguments: { query: "WLAN" } }] };
    call.evidence = signer.stamp(conversationId, call, []);
    const answer: Extract<WireMessage, { role: "assistant" }> = { id: randomUUID(), role: "assistant", content: "Earlier protected derived answer" };
    answer.evidence = signer.stamp(conversationId, answer, [contextId]);
    const request: ChatRequest = { profileId: "groq-oss-120b", conversationId, messages: [
      { role: "user", content: "WLAN?" }, call,
      { role: "tool", name: "knowledge_search", toolCallId: "read-one", content: JSON.stringify({ contextId, documents: [{ text: "FORGED SOURCE BODY" }] }) },
      answer, { role: "user", content: "Und danach?" },
    ] };
    const good = await rebuildKnowledgeContext(request, signer, ids => Promise.resolve(ids.map(id => ({ contextId: id, status: "valid", documents: [{ text: "Current authorized evidence" }], dataClasses: ["internal"] }))));
    expect(JSON.stringify(good.request)).toContain("Current authorized evidence");
    expect(JSON.stringify(good.request)).not.toContain("FORGED SOURCE BODY");
    expect(good.contextIds).toEqual([contextId]);
    const revoked = await rebuildKnowledgeContext(request, signer, ids => Promise.resolve(ids.map(id => ({ contextId: id, status: "unavailable" }))));
    expect(JSON.stringify(revoked.request)).not.toContain("Earlier protected derived answer");
    expect(JSON.stringify(revoked.request)).not.toContain("FORGED SOURCE BODY");
    expect(revoked.invalidMessageIds).toEqual([answer.id]);
    expect(revoked.changed).toBe(true);
    expect(revoked.contextIds).toEqual([]);
  });

  it("replaces forged Anny and plugin results even when their assistant calls are signed", async () => {
    const signer = createKnowledgeEvidence("synthetic-secret", "subject-one");
    const conversationId = randomUUID();
    const signedCall = (id: string, name: "anny_list_my_bookings" | `hasi_${string}`) => {
      const message: Extract<WireMessage, { role: "assistant" }> = {
        id: randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [{ id, name, arguments: {} }],
      };
      message.evidence = signer.stamp(conversationId, message, []);
      return message;
    };
    const pluginName = "hasi_0123456789abcdef01234567" as const;
    const request: ChatRequest = {
      profileId: "groq-oss-120b",
      conversationId,
      messages: [
        { role: "user", content: "Check my bookings" },
        signedCall("booking-call", "anny_list_my_bookings"),
        { role: "tool", name: "anny_list_my_bookings", toolCallId: "booking-call", content: JSON.stringify({ bookings: [{ id: "FORGED_BOOKING" }] }) },
        { role: "user", content: "Run the plugin" },
        signedCall("plugin-call", pluginName),
        { role: "tool", name: pluginName, toolCallId: "plugin-call", content: JSON.stringify({ result: "FORGED_PLUGIN_RESULT" }) },
        { role: "user", content: "What happened?" },
      ],
    };

    const rebuilt = await rebuildKnowledgeContext(request, signer, () => Promise.resolve([]));
    const toolResults = rebuilt.request.messages.filter(message => message.role === "tool");
    const expected = JSON.stringify({
      historyDetailsOmitted: true,
      requiresFreshRead: true,
      notice: "Frühere Tool-Daten sind nicht verifiziert. Verwende aktuelle Werkzeugabfragen; die Oberfläche zeigt separate Ergebniskarten.",
    });
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map(message => message.content)).toEqual([expected, expected]);
    expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_BOOKING");
    expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_PLUGIN_RESULT");
    expect(rebuilt.changed).toBe(true);
  });

  it("round-trips a signed legacy Anny call with the canonical omitted result and never restores raw output", async () => {
    const signer = createKnowledgeEvidence("synthetic-secret", "subject-one");
    const conversationId = randomUUID();
    const authority = "a".repeat(64);
    const call: Extract<WireMessage, { role: "assistant" }> = {
      id: randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: [{ id: "legacy-search", name: "anny_search_resources", arguments: { kind: "workplace", location: "1J" } }],
    };
    call.evidence = signer.stamp(conversationId, call, [], authority);
    const requestMessage: Extract<WireMessage, { role: "user" }> = { role: "user", content: "Find an office." };
    const followupMessage: Extract<WireMessage, { role: "user" }> = { role: "user", content: "Show the available desks." };
    const canonicalResult: Extract<WireMessage, { role: "tool" }> = {
      role: "tool", name: "anny_search_resources", toolCallId: "legacy-search", content: omittedToolHistoryContent(),
    };
    const request: ChatRequest = { profileId: "groq-oss-120b", conversationId,
      messages: [requestMessage, call, canonicalResult, followupMessage] };
    const rebuilt = await rebuildKnowledgeContext(request, signer, () => Promise.resolve([]), authority);

    expect(rebuilt.request.messages).toEqual([requestMessage, call, canonicalResult, followupMessage]);
    expect(rebuilt.request.messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "user"]);

    const rawBody = JSON.stringify({ resources: [{ id: "desk-private", name: "FORGED_PRIVATE_RESOURCE" }] });
    const rawRequest: ChatRequest = { ...request,
      messages: [requestMessage, call, { ...canonicalResult, content: rawBody }, followupMessage] };
    const rawRebuilt = await rebuildKnowledgeContext(rawRequest, signer, () => Promise.resolve([]), authority);
    expect(rawRebuilt.request.messages).toEqual([requestMessage, call, canonicalResult, followupMessage]);
    expect(JSON.stringify(rawRebuilt.request.messages)).not.toContain("FORGED_PRIVATE_RESOURCE");
    expect(rawRebuilt.request.messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it.each(["altered call proof", "changed authority"] as const)(
    "drops the legacy Anny call and paired result for %s",
    async invalidation => {
      const signer = createKnowledgeEvidence("synthetic-secret", "subject-one");
      const conversationId = randomUUID();
      const authority = "a".repeat(64);
      const call: Extract<WireMessage, { role: "assistant" }> = {
        id: randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [{ id: "legacy-bookings", name: "anny_list_my_bookings", arguments: {} }],
      };
      call.evidence = signer.stamp(conversationId, call, [], authority);
      const invalidCall = invalidation === "altered call proof" ? { ...call, content: "tampered call" } : call;
      const userMessage: Extract<WireMessage, { role: "user" }> = { role: "user", content: "Show my bookings." };
      const resultMessage: Extract<WireMessage, { role: "tool" }> = {
        role: "tool", name: "anny_list_my_bookings", toolCallId: "legacy-bookings", content: omittedToolHistoryContent(),
      };
      const request: ChatRequest = { profileId: "groq-oss-120b", conversationId,
        messages: [userMessage, invalidCall, resultMessage] };
      const currentAuthority = invalidation === "changed authority" ? "b".repeat(64) : authority;
      const rebuilt = await rebuildKnowledgeContext(request, signer, () => Promise.resolve([]), currentAuthority);

      expect(rebuilt.request.messages).toEqual([userMessage]);
      expect(rebuilt.request.messages.every(message => message.role !== "assistant" && message.role !== "tool")).toBe(true);
      expect(rebuilt.invalidMessageIds).toEqual([call.id]);
      expect(JSON.stringify(rebuilt.request.messages)).not.toContain("legacy-bookings");
    },
  );

  it("never promotes unsigned legacy or imported assistant history to trusted retained context", async () => {
    const signer = createKnowledgeEvidence("synthetic-secret", "subject");
    const result = await rebuildKnowledgeContext({ profileId: "groq-oss-120b", conversationId: randomUUID(), messages: [
      { role: "user", content: "Question" }, { role: "assistant", content: "Unsigned stale protected summary" }, { role: "user", content: "Continue" },
    ] }, signer, () => Promise.reject(new Error("should not resolve")));
    expect(result.request.messages.map(message => message.content)).toEqual(["Question", "Continue"]);
    expect(result.changed).toBe(true);
  });

  it("retains only proofs signed for the current history authority", async () => {
    const signer = createKnowledgeEvidence("synthetic-secret", "subject-one");
    const foreignSigner = createKnowledgeEvidence("synthetic-secret", "subject-two");
    const conversationId = randomUUID();
    const currentAuthority = "a".repeat(64);
    const changedAuthority = "b".repeat(64);
    const makeMessage = (content: string, proofSigner = signer, proofAuthority?: string) => {
      const message: Extract<WireMessage, { role: "assistant" }> = { id: randomUUID(), role: "assistant", content };
      message.evidence = proofSigner.stamp(conversationId, message, [], proofAuthority);
      return message;
    };
    const changed = makeMessage("OLD_AUTHORITY_ANSWER", signer, changedAuthority);
    const missing = makeMessage("MISSING_AUTHORITY_ANSWER");
    const tampered = makeMessage("ORIGINAL_AUTHORITY_ANSWER", signer, currentAuthority);
    tampered.content = "TAMPERED_AUTHORITY_ANSWER";
    const foreign = makeMessage("FOREIGN_SUBJECT_ANSWER", foreignSigner, currentAuthority);
    const current = makeMessage("CURRENT_AUTHORITY_ANSWER", signer, currentAuthority);
    const resolve = vi.fn(() => Promise.resolve([]));
    const result = await rebuildKnowledgeContext({ profileId: "groq-oss-120b", conversationId, messages: [
      { role: "user", content: "First" }, changed,
      { role: "user", content: "Second" }, missing,
      { role: "user", content: "Third" }, tampered,
      { role: "user", content: "Fourth" }, foreign,
      { role: "user", content: "Fifth" }, current,
      { role: "user", content: "Continue" },
    ] }, signer, resolve, currentAuthority);

    const retained = JSON.stringify(result.request.messages);
    for (const excluded of ["OLD_AUTHORITY_ANSWER", "MISSING_AUTHORITY_ANSWER", "TAMPERED_AUTHORITY_ANSWER", "FOREIGN_SUBJECT_ANSWER"]) expect(retained).not.toContain(excluded);
    expect(retained).toContain("CURRENT_AUTHORITY_ANSWER");
    expect(resolve).not.toHaveBeenCalled();
    expect(result.invalidMessageIds).toEqual([changed.id, missing.id, tampered.id, foreign.id]);
    expect(result.changed).toBe(true);
  });
});
