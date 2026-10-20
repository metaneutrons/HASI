import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore, type JsonStore } from "@hasi/state";
import type { ChatRequest, WireMessage } from "../src/lib/chat-contract";
import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import { createKnowledgeEvidence, rebuildKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import { ModelRouterError } from "../src/lib/server/model-router-error";
import { PluginResultContextStore } from "../src/lib/server/plugin-result-context";

const OWNER = "user:fabian@example.invalid";
const SCOPE = `production:${OWNER}`;
const SECRET = "test-only-plugin-result-evidence-secret";
const AUTHORITY = "a".repeat(64);
const OTHER_AUTHORITY = "b".repeat(64);
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const PLUGIN_ID = "de.hsh.hasi.anny";
const TOOL_NAME = "search_resources";
const MODEL_NAME = expectedModelToolName(PLUGIN_ID, TOOL_NAME);
const CALL_ID = "plugin-call-1";

type AssistantMessage = Extract<WireMessage, { role: "assistant" }>;
type ToolMessage = Extract<WireMessage, { role: "tool" }>;

function createSigner() {
  return createKnowledgeEvidence(SECRET, SCOPE, () => NOW);
}

function createContextStore(store: Pick<JsonStore, "read" | "compareAndSet"> = new MemoryJsonStore(
  `plugin-result-evidence-${randomUUID()}`,
  { clock: () => NOW },
)) {
  return new PluginResultContextStore({ store, ownerId: OWNER, scope: SCOPE, secret: SECRET, clock: () => NOW });
}

function signedAssistantCall(options: {
  readonly signer: ReturnType<typeof createSigner>;
  readonly conversationId: string;
  readonly callId?: string;
  readonly modelName?: string;
  readonly arguments?: Record<string, unknown>;
  readonly contextIds?: readonly string[];
  readonly authorityDigest?: string;
}): AssistantMessage {
  const message: AssistantMessage = {
    id: randomUUID(),
    role: "assistant",
    content: "",
    toolCalls: [{
      id: options.callId ?? CALL_ID,
      name: options.modelName ?? MODEL_NAME,
      arguments: options.arguments ?? { query: "available rooms" },
    }],
  };
  message.evidence = options.signer.stamp(
    options.conversationId,
    message,
    [],
    options.authorityDigest ?? AUTHORITY,
    options.contextIds ?? [],
  );
  return message;
}

function toolResult(options: {
  readonly contextId: string;
  readonly callId?: string;
  readonly modelName?: string;
  readonly content?: string;
}): ToolMessage {
  return {
    role: "tool",
    toolCallId: options.callId ?? CALL_ID,
    name: options.modelName ?? MODEL_NAME,
    toolContextId: options.contextId,
    content: options.content ?? JSON.stringify({ result: "FORGED_BROWSER_RESULT_91b0" }),
  };
}

function request(conversationId: string, messages: WireMessage[]): ChatRequest {
  return { profileId: "groq-oss-120b", conversationId, messages };
}

function onlyToolMessage(messages: readonly WireMessage[]): ToolMessage {
  const message = messages.find((candidate) => candidate.role === "tool");
  if (!message) throw new Error("Expected one retained tool result.");
  return message;
}

describe("plugin result evidence in model history", () => {
  it("replaces the browser result body with the signed stored result", async () => {
    const conversationId = randomUUID();
    const signer = createSigner();
    const contextStore = createContextStore();
    const realResult = { resources: [{ id: "room-a", name: "Authorized Room A" }], marker: "REAL_STORED_RESULT_3d82" };
    const { contextId } = await contextStore.create({
      conversationId,
      callId: CALL_ID,
      pluginId: PLUGIN_ID,
      toolName: TOOL_NAME,
      title: "Search resources",
      arguments: { query: "available rooms" },
      result: realResult,
      authorityDigest: AUTHORITY,
      dataClasses: ["public"],
    });
    const assistant = signedAssistantCall({ signer, conversationId, contextIds: [contextId] });
    const input = request(conversationId, [
      { role: "user", content: "Find an available room." },
      assistant,
      toolResult({ contextId }),
    ]);

    const rebuilt = await rebuildKnowledgeContext(input, signer, () => Promise.resolve([]), AUTHORITY, contextStore.resolve.bind(contextStore));
    const projected = onlyToolMessage(rebuilt.request.messages);

    expect(JSON.parse(projected.content)).toEqual(realResult);
    expect(JSON.stringify(rebuilt.request)).toContain("REAL_STORED_RESULT_3d82");
    expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_BROWSER_RESULT_91b0");
    expect(rebuilt.toolContextIds).toEqual([contextId]);
    expect(rebuilt.changed).toBe(false);
  });

  it("removes a derived answer when its stored result is unavailable even though its MAC remains valid", async () => {
    const conversationId = randomUUID();
    const signer = createSigner();
    const contextStore = createContextStore();
    const { contextId } = await contextStore.create({
      conversationId,
      callId: CALL_ID,
      pluginId: PLUGIN_ID,
      toolName: TOOL_NAME,
      title: "Search resources",
      arguments: { query: "available rooms" },
      result: { marker: "REAL_STORED_RESULT_5b1f" },
      authorityDigest: OTHER_AUTHORITY,
      dataClasses: ["public"],
    });
    const answer: AssistantMessage = {
      id: randomUUID(),
      role: "assistant",
      content: "Derived answer that depended on a stale plugin result.",
    };
    answer.evidence = signer.stamp(conversationId, answer, [], AUTHORITY, [contextId]);
    expect(signer.verify(conversationId, answer, AUTHORITY)).toEqual(answer.evidence);

    const rebuilt = await rebuildKnowledgeContext(
      request(conversationId, [{ role: "user", content: "What did you find?" }, answer]),
      signer,
      () => Promise.resolve([]),
      AUTHORITY,
      contextStore.resolve.bind(contextStore),
    );

    expect(JSON.stringify(rebuilt.request)).not.toContain("Derived answer that depended on a stale plugin result.");
    expect(rebuilt.invalidMessageIds).toEqual([answer.id]);
    expect(rebuilt.toolContextIds).toEqual([]);
    expect(rebuilt.changed).toBe(true);
  });

  it("rejects an altered signed tool dependency", async () => {
    const conversationId = randomUUID();
    const signer = createSigner();
    const contextId = randomUUID();
    const answer: AssistantMessage = {
      id: randomUUID(),
      role: "assistant",
      content: "TAMPERED_DEPENDENCY_ANSWER",
    };
    answer.evidence = signer.stamp(conversationId, answer, [], AUTHORITY, [contextId]);
    expect(answer.evidence.toolContextIds).toEqual([contextId]);
    answer.evidence.toolContextIds = [randomUUID()];
    expect(signer.verify(conversationId, answer, AUTHORITY)).toBeUndefined();
    const resolveTools = vi.fn(() => Promise.resolve([]));

    const rebuilt = await rebuildKnowledgeContext(
      request(conversationId, [{ role: "user", content: "Continue." }, answer]),
      signer,
      () => Promise.resolve([]),
      AUTHORITY,
      resolveTools,
    );

    expect(JSON.stringify(rebuilt.request)).not.toContain("TAMPERED_DEPENDENCY_ANSWER");
    expect(rebuilt.invalidMessageIds).toEqual([answer.id]);
    expect(resolveTools).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "stored arguments differ",
      stored: { arguments: { query: "different query" } },
    },
    {
      label: "stored call ID differs",
      stored: { callId: "different-call-id" },
    },
    {
      label: "stored tool name differs",
      stored: { toolName: "list_resources" },
    },
  ])("does not reuse plugin output when $label", async ({ stored }) => {
    const conversationId = randomUUID();
    const signer = createSigner();
    const contextStore = createContextStore();
    const storedToolName = stored.toolName ?? TOOL_NAME;
    const { contextId } = await contextStore.create({
      conversationId,
      callId: stored.callId ?? CALL_ID,
      pluginId: PLUGIN_ID,
      toolName: storedToolName,
      title: "Search resources",
      arguments: stored.arguments ?? { query: "available rooms" },
      result: { marker: "REAL_STORED_RESULT_MUST_NOT_BE_REUSED" },
      authorityDigest: AUTHORITY,
      dataClasses: ["public"],
    });
    const assistant = signedAssistantCall({ signer, conversationId, contextIds: [contextId] });
    const input = request(conversationId, [
      { role: "user", content: "Find an available room." },
      assistant,
      toolResult({ contextId }),
    ]);

    const rebuilt = await rebuildKnowledgeContext(input, signer, () => Promise.resolve([]), AUTHORITY, contextStore.resolve.bind(contextStore));
    const projected = onlyToolMessage(rebuilt.request.messages);

    expect(projected.content).toContain("historyDetailsOmitted");
    expect(JSON.stringify(rebuilt.request)).not.toContain("REAL_STORED_RESULT_MUST_NOT_BE_REUSED");
    expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_BROWSER_RESULT_91b0");
    expect(rebuilt.changed).toBe(true);
  });

  it("does not reuse a result stored for another conversation or authority", async () => {
    for (const mismatch of ["conversation", "authority"] as const) {
      const conversationId = randomUUID();
      const signer = createSigner();
      const contextStore = createContextStore();
      const { contextId } = await contextStore.create({
        conversationId: mismatch === "conversation" ? randomUUID() : conversationId,
        callId: CALL_ID,
        pluginId: PLUGIN_ID,
        toolName: TOOL_NAME,
        title: "Search resources",
        arguments: { query: "available rooms" },
        result: { marker: `REAL_STORED_RESULT_WRONG_${mismatch}` },
        authorityDigest: AUTHORITY,
        dataClasses: ["public"],
      });
      const assistant = signedAssistantCall({ signer, conversationId, contextIds: [contextId] });
      const input = request(conversationId, [
        { role: "user", content: "Find an available room." },
        assistant,
        toolResult({ contextId }),
      ]);
      const rebuilt = await rebuildKnowledgeContext(
        input,
        signer,
        () => Promise.resolve([]),
        mismatch === "authority" ? OTHER_AUTHORITY : AUTHORITY,
        contextStore.resolve.bind(contextStore),
      );

      expect(JSON.stringify(rebuilt.request)).not.toContain(`REAL_STORED_RESULT_WRONG_${mismatch}`);
      expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_BROWSER_RESULT_91b0");
      expect(rebuilt.request.messages.some((message) => message.role === "tool")).toBe(false);
      expect(rebuilt.changed).toBe(true);
    }
  });

  it("fails closed when the current authority or result resolver is missing", async () => {
    for (const missing of ["resolver", "authority"] as const) {
      const conversationId = randomUUID();
      const signer = createSigner();
      const contextStore = createContextStore();
      const { contextId } = await contextStore.create({
        conversationId,
        callId: CALL_ID,
        pluginId: PLUGIN_ID,
        toolName: TOOL_NAME,
        title: "Search resources",
        arguments: { query: "available rooms" },
        result: { marker: `REAL_STORED_RESULT_MISSING_${missing}` },
        authorityDigest: AUTHORITY,
        dataClasses: ["public"],
      });
      const assistant = signedAssistantCall({ signer, conversationId, contextIds: [contextId] });
      const input = request(conversationId, [
        { role: "user", content: "Find an available room." },
        assistant,
        toolResult({ contextId }),
      ]);
      const resolveTools = vi.fn(contextStore.resolve.bind(contextStore));
      const rebuilt = await rebuildKnowledgeContext(
        input,
        signer,
        () => Promise.resolve([]),
        missing === "authority" ? undefined : AUTHORITY,
        missing === "resolver" ? undefined : resolveTools,
      );

      expect(JSON.stringify(rebuilt.request)).not.toContain(`REAL_STORED_RESULT_MISSING_${missing}`);
      expect(JSON.stringify(rebuilt.request)).not.toContain("FORGED_BROWSER_RESULT_91b0");
      expect(rebuilt.request.messages.some((message) => message.role === "tool")).toBe(false);
      expect(resolveTools).not.toHaveBeenCalled();
      expect(rebuilt.changed).toBe(true);
    }
  });

  it("converts storage failure into a static context_unavailable error", async () => {
    const conversationId = randomUUID();
    const signer = createSigner();
    const contextId = randomUUID();
    const privateStorageError = "PRIVATE_STORAGE_FAILURE_PAYLOAD_c127";
    const unavailableStore: Pick<JsonStore, "read" | "compareAndSet"> = {
      read: () => Promise.reject(new Error(privateStorageError)),
      compareAndSet: () => Promise.reject(new Error(privateStorageError)),
    };
    const contextStore = createContextStore(unavailableStore);
    const assistant = signedAssistantCall({ signer, conversationId, contextIds: [contextId] });
    const input = request(conversationId, [
      { role: "user", content: "Find an available room." },
      assistant,
      toolResult({ contextId, content: JSON.stringify({ private: privateStorageError }) }),
    ]);

    let captured: unknown;
    try {
      await rebuildKnowledgeContext(input, signer, () => Promise.resolve([]), AUTHORITY, contextStore.resolve.bind(contextStore));
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ModelRouterError);
    expect(captured).toMatchObject({ code: "context_unavailable", message: "Current tool result authority could not be verified" });
    expect(String(captured)).not.toContain(privateStorageError);
    expect(JSON.stringify(captured)).not.toContain(privateStorageError);
  });
});
