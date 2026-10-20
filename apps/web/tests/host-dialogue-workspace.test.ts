import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MemoryJsonStore } from "@hasi/state";
import { chatStorageKey, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore } from "../src/lib/chat-workspace-store";
import { createHostDialogueSigner } from "../src/lib/server/host-dialogue";
import { ProtectedWorkspaceStore } from "../src/lib/server/protected-workspaces";
import { required } from "./test-utils";

const owner = "synthetic-dialogue-owner";
const secret = "synthetic-dialogue-signing-material";
const scope = "synthetic-dialogue-scope";
const authority = "a".repeat(64);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("display-only host dialogue during protected autosave", () => {
  it("retains a signed clarification and draft without remounting a busy conversation or adding model authority", async () => {
    const service = new ProtectedWorkspaceStore({ store: new MemoryJsonStore("dialogue-workspace-tests"), ownerId: owner,
      scope, secret, authority: () => Promise.resolve(authority), resolve: () => Promise.resolve([]) });
    const initial = await service.load();
    let serialized = JSON.stringify(initial.workspace);
    const store = createChatWorkspaceStore(owner, { getItem: key => key === chatStorageKey(owner) ? serialized : null,
      setItem: (_key, value) => { serialized = value; } }, { revision: initial.revision,
      save: (workspace: ChatWorkspace, revision) => service.save(revision, workspace) });
    const id = required(initial.workspace.sessions[0]).id;
    const snapshot = () => required(store.getSnapshot().workspace.sessions[0]).snapshot;
    const userId = randomUUID();
    store.updateConversation(id, { ...snapshot(), interrupted: true,
      messages: [{ id: userId, role: "user", text: "Hallo" }], history: [{ id: userId, role: "user", content: "Hallo" }] }, true);
    await vi.advanceTimersByTimeAsync(200);
    const epoch = store.getSnapshot().sessionEpochs[id] ?? 0;
    const message = createHostDialogueSigner(secret, scope).issue(id, "Hallo. Was möchtest du erledigen?", "greeting", authority);
    store.updateConversation(id, { ...snapshot(), messages: [...snapshot().messages, { ...message, tool: "HASI · Dialoghinweis" }] }, true);
    store.updateDraft(id, "My next question");
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getSnapshot().sessionEpochs[id] ?? 0).toBe(epoch);
    expect(store.getSnapshot().busy[id]).toBe(true);
    expect(snapshot().messages.at(-1)?.text).toBe(message.text);
    expect(snapshot().history).toHaveLength(1);
    store.updateConversation(id, { ...snapshot(), interrupted: false }, false);
    await vi.advanceTimersByTimeAsync(200);
    const loaded = required((await service.load()).workspace.sessions[0]).snapshot;
    expect(loaded.messages.at(-1)?.hostDialogue).toEqual(message.hostDialogue);
    expect(loaded.input).toBe("My next question");
    expect(loaded.history).toEqual([{ id: userId, role: "user", content: "Hallo" }]);
    store.updateConversation(id, { ...snapshot(), interrupted: true,
      messages: snapshot().messages.map(item => item.id === message.id ? { ...item, text: "FORGED claim" } : item) }, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getSnapshot().sessionEpochs[id] ?? 0).toBeGreaterThan(epoch);
    expect(JSON.stringify(snapshot())).not.toContain("FORGED");
    expect(snapshot().input).toBe("My next question");
  });
});
