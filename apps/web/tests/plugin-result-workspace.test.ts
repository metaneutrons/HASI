import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore, type JsonStore } from "@hasi/state";
import { compactPluginToolResult } from "../src/lib/plugin-tools";
import { createChatWorkspace, saveChatWorkspace, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore } from "../src/lib/chat-workspace-store";
import type { WireMessage } from "../src/lib/chat-contract";
import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import { createKnowledgeEvidence } from "../src/lib/server/knowledge-evidence";
import { PluginResultContextStore } from "../src/lib/server/plugin-result-context";
import { ProtectedWorkspaceStore } from "../src/lib/server/protected-workspaces";

const OWNER = "user:fabian@example.invalid";
const SCOPE = `production:${OWNER}`;
const OTHER_OWNER = "user:other@example.invalid";
const OTHER_SCOPE = `production:${OTHER_OWNER}`;
const SECRET = "test-only-plugin-result-workspace-secret";
const AUTHORITY = "a".repeat(64);
const OTHER_AUTHORITY = "b".repeat(64);
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const PLUGIN_ID = "de.hsh.hasi.anny";
const TOOL_NAME = "search_resources";
const MODEL_NAME = expectedModelToolName(PLUGIN_ID, TOOL_NAME);
const CALL_ID = "plugin-call-1";
const RESULT = { resources: [{ id: "room-a", name: "Authorized Room A" }], marker: "STORED_PLUGIN_RESULT_8d31" };
const COMPACT_RESULT = compactPluginToolResult({ marker: RESULT.marker, resources: RESULT.resources });

type AssistantMessage = Extract<WireMessage, { role: "assistant" }>;

function createResultStore(ownerId = OWNER, scope = SCOPE) {
  const backing = new MemoryJsonStore(`plugin-result-workspace-${randomUUID()}`, { clock: () => NOW });
  const keys: string[] = [];
  const store: Pick<JsonStore, "read" | "compareAndSet"> = {
    read: key => backing.read(key),
    compareAndSet: (key, expectedRevision, value, expiresAt) => {
      keys.push(key);
      return backing.compareAndSet(key, expectedRevision, value, expiresAt);
    },
  };
  const contexts = new PluginResultContextStore({ store, ownerId, scope, secret: SECRET, clock: () => NOW });
  return { backing, store, keys, contexts };
}

function makeWorkspace(options: {
  readonly ownerId?: string;
  readonly scope?: string;
  readonly contextId: string;
  readonly cardText?: string;
  readonly cardTitle?: string;
  readonly initial?: ChatWorkspace;
}): ChatWorkspace {
  const ownerId = options.ownerId ?? OWNER;
  const scope = options.scope ?? SCOPE;
  const workspace = options.initial ?? createChatWorkspace(ownerId);
  const session = workspace.sessions[0];
  if (!session) throw new Error("Expected an initial chat session.");
  const signer = createKnowledgeEvidence(SECRET, scope, () => NOW);
  const call: AssistantMessage = {
    id: randomUUID(),
    role: "assistant",
    content: "",
    toolCalls: [{ id: CALL_ID, name: MODEL_NAME, arguments: { query: "available rooms" } }],
  };
  call.evidence = signer.stamp(session.id, call, [], AUTHORITY);
  const result: Extract<WireMessage, { role: "tool" }> = {
    role: "tool",
    toolCallId: CALL_ID,
    name: MODEL_NAME,
    toolContextId: options.contextId,
    content: JSON.stringify({ browserBody: "FORGED_BROWSER_TOOL_RESULT_8d31" }),
  };
  const answer: AssistantMessage = { id: randomUUID(), role: "assistant", content: "The search found one room." };
  answer.evidence = signer.stamp(session.id, answer, [], AUTHORITY, [options.contextId]);
  session.snapshot.history = [{ role: "user", content: "Find an available room." }, call, result, answer];
  session.snapshot.messages = [
    { id: randomUUID(), role: "user", text: "Find an available room." },
    {
      id: randomUUID(),
      role: "assistant",
      text: options.cardText ?? "FORGED_BROWSER_CARD_8d31",
      tool: `Plugin · ${options.cardTitle ?? "Forged title"}`,
      pluginResultContextId: options.contextId,
    },
    { id: answer.id ?? randomUUID(), role: "assistant", text: answer.content, evidence: answer.evidence },
  ];
  return workspace;
}

async function createResult(contexts: PluginResultContextStore, conversationId: string) {
  return contexts.create({
    conversationId,
    callId: CALL_ID,
    pluginId: PLUGIN_ID,
    toolName: TOOL_NAME,
    title: "Search resources",
    arguments: { query: "available rooms" },
    result: RESULT,
    authorityDigest: AUTHORITY,
    dataClasses: ["public"],
  });
}

function workspaceService(
  fixture: ReturnType<typeof createResultStore>,
  options: { readonly ownerId?: string; readonly scope?: string; readonly authority?: () => Promise<string> } = {},
) {
  return new ProtectedWorkspaceStore({
    store: fixture.store,
    ownerId: options.ownerId ?? OWNER,
    scope: options.scope ?? SCOPE,
    secret: SECRET,
    resolve: () => Promise.resolve([]),
    resolvePluginResults: fixture.contexts.resolve.bind(fixture.contexts),
    authority: options.authority ?? (() => Promise.resolve(AUTHORITY)),
    clock: () => NOW,
  });
}

function localStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("protected plugin result workspace projection", () => {
  it("reconstructs a result card and derived answer from the stored invocation, ignoring browser bodies", async () => {
    const fixture = createResultStore();
    const workspace = createChatWorkspace(OWNER);
    const conversationId = workspace.sessions[0]?.id;
    if (!conversationId) throw new Error("Expected an initial chat session.");
    const { contextId } = await createResult(fixture.contexts, conversationId);
    const service = workspaceService(fixture);

    const saved = await service.save(null, makeWorkspace({ contextId, initial: workspace }));
    const snapshot = saved.workspace.sessions[0]?.snapshot;
    const card = snapshot?.messages.find(message => message.pluginResultContextId === contextId);

    expect(card).toEqual(expect.objectContaining({
      role: "assistant",
      text: COMPACT_RESULT,
      tool: "Plugin · Search resources",
      pluginResultContextId: contextId,
    }));
    expect(snapshot?.messages.some(message => message.text === "The search found one room.")).toBe(true);
    expect(JSON.stringify(saved.workspace)).toContain("STORED_PLUGIN_RESULT_8d31");
    expect(JSON.stringify(saved.workspace)).not.toMatch(/FORGED_BROWSER_(?:CARD|TOOL_RESULT)_8d31/u);
    const resultWire = snapshot?.history.find(message => message.role === "tool");
    expect(resultWire?.role === "tool" ? JSON.parse(resultWire.content) : undefined).toEqual(RESULT);
  });

  it("removes the tampered result and its signed dependent answer", async () => {
    const fixture = createResultStore();
    const workspace = createChatWorkspace(OWNER);
    const conversationId = workspace.sessions[0]?.id;
    if (!conversationId) throw new Error("Expected an initial chat session.");
    const { contextId } = await createResult(fixture.contexts, conversationId);
    const key = fixture.keys[0];
    if (!key) throw new Error("Expected a stored result context.");
    const stored = await fixture.backing.read(key);
    if (!stored) throw new Error("Expected the stored result context row.");
    const record = stored.value as Record<string, unknown>;
    const replaced = await fixture.backing.compareAndSet(key, stored.revision, {
      ...record,
      signature: "x".repeat(43),
    }, typeof record.expiresAt === "number" ? record.expiresAt : undefined);
    expect(replaced).toBe(true);

    const saved = await workspaceService(fixture).save(null, makeWorkspace({ contextId, initial: workspace }));
    const snapshot = saved.workspace.sessions[0]?.snapshot;

    expect(JSON.stringify(snapshot)).not.toContain("STORED_PLUGIN_RESULT_8d31");
    expect(JSON.stringify(snapshot)).not.toContain("The search found one room.");
    expect(snapshot?.messages.find(message => message.pluginResultContextId === undefined
      && message.role === "assistant")?.text).toContain("Plugin-Ergebnis ist nicht mehr verfügbar");
    expect(snapshot?.history.some(message => message.role === "tool" && message.content.includes("historyDetailsOmitted"))).toBe(true);
  });

  it("revokes cards and derived answers when current history authority changes", async () => {
    const fixture = createResultStore();
    const workspace = createChatWorkspace(OWNER);
    const conversationId = workspace.sessions[0]?.id;
    if (!conversationId) throw new Error("Expected an initial chat session.");
    const { contextId } = await createResult(fixture.contexts, conversationId);
    let authority = AUTHORITY;
    const service = workspaceService(fixture, { authority: () => Promise.resolve(authority) });
    await service.save(null, makeWorkspace({ contextId, initial: workspace }));

    authority = OTHER_AUTHORITY;
    const loaded = await service.load();
    const snapshot = loaded.workspace.sessions[0]?.snapshot;

    expect(JSON.stringify(snapshot)).not.toContain("STORED_PLUGIN_RESULT_8d31");
    expect(JSON.stringify(snapshot)).not.toContain("The search found one room.");
    expect(snapshot?.messages.some(message => message.pluginResultContextId === contextId)).toBe(false);
    expect(JSON.stringify((await service.load()).workspace)).not.toContain("The search found one room.");
  });

  it("does not reuse a result record from another owner even with the same conversation and call", async () => {
    const fixture = createResultStore();
    const workspace = createChatWorkspace(OTHER_OWNER);
    const conversationId = workspace.sessions[0]?.id;
    if (!conversationId) throw new Error("Expected an initial chat session.");
    const { contextId } = await createResult(fixture.contexts, conversationId);
    const otherOwnerContexts = new PluginResultContextStore({
      store: fixture.store,
      ownerId: OTHER_OWNER,
      scope: OTHER_SCOPE,
      secret: SECRET,
      clock: () => NOW,
    });
    const service = new ProtectedWorkspaceStore({
      store: fixture.store,
      ownerId: OTHER_OWNER,
      scope: OTHER_SCOPE,
      secret: SECRET,
      resolve: () => Promise.resolve([]),
      resolvePluginResults: otherOwnerContexts.resolve.bind(otherOwnerContexts),
      authority: () => Promise.resolve(AUTHORITY),
      clock: () => NOW,
    });

    const saved = await service.save(null, makeWorkspace({ ownerId: OTHER_OWNER, scope: OTHER_SCOPE, contextId, initial: workspace }));
    const snapshot = saved.workspace.sessions[0]?.snapshot;

    expect(JSON.stringify(snapshot)).not.toContain("STORED_PLUGIN_RESULT_8d31");
    expect(JSON.stringify(snapshot)).not.toContain("The search found one room.");
    expect(snapshot?.messages.some(message => message.pluginResultContextId === contextId)).toBe(false);
  });

  it("retries a concurrent save after the server reconstructs the authentic result card", async () => {
    const fixture = createResultStore();
    const workspace = createChatWorkspace(OWNER);
    const conversationId = workspace.sessions[0]?.id;
    if (!conversationId) throw new Error("Expected an initial chat session.");
    const { contextId } = await createResult(fixture.contexts, conversationId);
    const service = workspaceService(fixture);
    const initial = makeWorkspace({ contextId, initial: workspace });
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const storage = localStorage();
    expect(saveChatWorkspace(initial, storage)).toBe(true);
    const client = createChatWorkspaceStore(OWNER, storage, {
      revision: null,
      save: async (snapshot, expectedRevision) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await release.promise;
        }
        return service.save(expectedRevision, snapshot);
      },
    });
    const initialSession = client.getSnapshot().workspace.sessions[0];
    if (!initialSession) throw new Error("Expected a client chat session.");
    client.update(initialSession.id, initial.sessions[0]?.snapshot ?? initialSession.snapshot, false);
    client.flush();
    await started.promise;

    const latestSnapshot = { ...(initial.sessions[0]?.snapshot ?? initialSession.snapshot) };
    const signer = createKnowledgeEvidence(SECRET, SCOPE, () => NOW);
    const concurrentAnswer: AssistantMessage = { id: randomUUID(), role: "assistant", content: "Concurrent answer is retained." };
    concurrentAnswer.evidence = signer.stamp(initialSession.id, concurrentAnswer, [], AUTHORITY);
    latestSnapshot.history = [...latestSnapshot.history, { role: "user", content: "One more question." }, concurrentAnswer];
    latestSnapshot.messages = [...latestSnapshot.messages,
      { id: randomUUID(), role: "user", text: "One more question." },
      { id: concurrentAnswer.id ?? randomUUID(), role: "assistant", text: concurrentAnswer.content, evidence: concurrentAnswer.evidence },
    ];
    client.update(initialSession.id, latestSnapshot, false);
    release.resolve();

    await vi.waitFor(() => { expect(client.hasPendingWrites()).toBe(false); }, { timeout: 3_000 });
    const finalSnapshot = client.getSnapshot().workspace.sessions.find(session => session.id === initialSession.id)?.snapshot;

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(finalSnapshot?.messages.some(message => message.text === "Concurrent answer is retained.")).toBe(true);
    expect(finalSnapshot?.messages.some(message => message.text === COMPACT_RESULT)).toBe(true);
    expect(client.getSnapshot().protectedPersistence?.state).toBe("saved");
  });
});
