import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatStorageKey, createChatSession, createChatWorkspace, parseChatWorkspace, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore, type ProtectedWorkspaceResult } from "../src/lib/chat-workspace-store";
import { refreshProtectedWorkspace } from "../src/lib/protected-workspace-refresh";
import { required } from "./test-utils";

const OWNER = "synthetic-protected-refresh-subject";

function withProtectedContent(content: string, draft = "", base = createChatWorkspace(OWNER)): ChatWorkspace {
  const session = required(base.sessions[0]);
  return parseChatWorkspace({
    ...base,
    sessions: base.sessions.map(item => item.id === session.id ? {
      ...item,
      snapshot: {
        ...item.snapshot,
        input: draft,
        messages: [
          { id: randomUUID(), role: "user" as const, text: "Question" },
          { id: randomUUID(), role: "assistant" as const, text: content },
        ],
        history: [
          { role: "user" as const, content: "Question" },
          { role: "assistant" as const, content },
        ],
      },
    } : item),
  }, OWNER);
}

function memory(initial: ChatWorkspace) {
  let serialized: string | null = JSON.stringify(initial);
  return {
    getItem: (key: string) => key === chatStorageKey(OWNER) ? serialized : null,
    setItem: (key: string, value: string) => { if (key === chatStorageKey(OWNER)) serialized = value; },
  };
}

function makeStore(initial: ChatWorkspace, save = (workspace: ChatWorkspace) => Promise.resolve({ revision: "saved-revision", workspace })) {
  return createChatWorkspaceStore(OWNER, memory(initial), { revision: "initial-revision", save });
}

function result(workspace: ChatWorkspace, revision = "remote-revision"): ProtectedWorkspaceResult {
  return { revision, workspace };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function currentSnapshot(store: ReturnType<typeof makeStore>) {
  return required(store.getSnapshot().workspace.sessions.find(session => session.id === store.getSnapshot().workspace.activeId)).snapshot;
}

describe("refreshProtectedWorkspace", () => {
  it.each([false, true])("keeps the locally active chat after %s canonical refresh", async recover => {
    const initial = createChatWorkspace(OWNER);
    const first = required(initial.sessions[0]);
    const second = createChatSession();
    const shared = parseChatWorkspace({ ...initial, activeId: second.id, sessions: [first, second] }, OWNER);
    const localWithContent = withProtectedContent("Older first-chat answer", "", shared);
    const local = parseChatWorkspace({
      ...localWithContent,
      activeId: second.id,
      sessions: localWithContent.sessions.map(session => session.id === second.id
        ? { ...session, snapshot: { ...session.snapshot, input: "Draft in active second chat" } }
        : session),
    }, OWNER);
    const remoteWithContent = withProtectedContent("Canonical first-chat answer", "", shared);
    const remote = parseChatWorkspace({ ...remoteWithContent, activeId: first.id }, OWNER);
    const store = makeStore(local);

    expect(await refreshProtectedWorkspace(store, () => Promise.resolve(result(remote)), {
      recover,
      failureMessage: "Protected workspace unavailable",
    })).toBe(true);

    const workspace = store.getSnapshot().workspace;
    const active = required(workspace.sessions.find(session => session.id === workspace.activeId));
    const firstAfterRefresh = required(workspace.sessions.find(session => session.id === first.id));
    expect(workspace.activeId).toBe(second.id);
    expect(active.snapshot.input).toBe("Draft in active second chat");
    expect(firstAfterRefresh.snapshot.messages.map(message => message.text)).toContain("Canonical first-chat answer");
    expect(JSON.stringify(workspace)).not.toContain("Older first-chat answer");
  });

  it("applies an authorized read and keeps the current local draft", async () => {
    const local = withProtectedContent("Older authorized answer", "Unsent local draft");
    const remote = withProtectedContent("Canonical authorized answer", "", local);
    const store = makeStore(local);

    const applied = await refreshProtectedWorkspace(store, () => Promise.resolve(result(remote)), {
      failureMessage: "Protected workspace unavailable",
    });

    expect(applied).toBe(true);
    expect(currentSnapshot(store).messages.map(message => message.text)).toContain("Canonical authorized answer");
    expect(currentSnapshot(store).history).toContainEqual({ role: "assistant", content: "Canonical authorized answer" });
    expect(currentSnapshot(store).input).toBe("Unsent local draft");
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Older authorized answer");
  });

  it("discards a delayed success after redaction", async () => {
    const local = withProtectedContent("Previously visible answer", "Draft retained");
    const remote = withProtectedContent("Late protected answer", "", local);
    const pending = deferred<ProtectedWorkspaceResult>();
    const store = makeStore(local);
    const authorityBefore = store.getAuthorityVersion();
    const refresh = refreshProtectedWorkspace(store, () => pending.promise, {
      failureMessage: "Protected workspace unavailable",
    });

    store.redactProtectedContent("Personal workspace disconnected");
    expect(store.getAuthorityVersion()).not.toBe(authorityBefore);
    pending.resolve(result(remote));

    expect(await refresh).toBe(false);
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Late protected answer");
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Previously visible answer");
    expect(currentSnapshot(store).history).toEqual([]);
    expect(currentSnapshot(store).input).toBe("Draft retained");
  });

  it("does not let a stale failure redact content restored by a newer recovery", async () => {
    const local = withProtectedContent("Old answer", "Current draft");
    const recovered = withProtectedContent("Current canonical answer", "", local);
    const pending = deferred<ProtectedWorkspaceResult>();
    const store = makeStore(local);
    const staleRefresh = refreshProtectedWorkspace(store, () => pending.promise, {
      failureMessage: "Stale read failed",
    });

    store.redactProtectedContent("Reconnecting protected workspace");
    expect(await refreshProtectedWorkspace(store, () => Promise.resolve(result(recovered)), {
      recover: true,
      failureMessage: "Recovery failed",
    })).toBe(true);
    pending.reject(new Error("late network failure"));

    expect(await staleRefresh).toBe(false);
    expect(currentSnapshot(store).messages.map(message => message.text)).toContain("Current canonical answer");
    expect(currentSnapshot(store).history).toContainEqual({ role: "assistant", content: "Current canonical answer" });
    expect(currentSnapshot(store).input).toBe("Current draft");
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Old answer");
  });

  it("invalidates a delayed read after redaction of an already empty workspace", async () => {
    const empty = createChatWorkspace(OWNER);
    const remote = withProtectedContent("Must remain unavailable", "", empty);
    const pending = deferred<ProtectedWorkspaceResult>();
    const store = makeStore(empty);
    const authorityBefore = store.getAuthorityVersion();
    const refresh = refreshProtectedWorkspace(store, () => pending.promise, {
      failureMessage: "Protected workspace unavailable",
    });

    store.redactProtectedContent("Personal workspace disconnected");
    expect(store.getAuthorityVersion()).not.toBe(authorityBefore);
    pending.resolve(result(remote));

    expect(await refresh).toBe(false);
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Must remain unavailable");
    expect(currentSnapshot(store).history).toEqual([]);
  });

  it("skips normal reads without protected persistence, while unsaved, busy or pending", async () => {
    const remote = withProtectedContent("Canonical answer");
    const read = vi.fn(() => Promise.resolve(result(remote)));
    const withoutProtectedPersistence = createChatWorkspaceStore(OWNER, memory(createChatWorkspace(OWNER)));
    expect(await refreshProtectedWorkspace(withoutProtectedPersistence, read, { failureMessage: "Unavailable" })).toBe(false);

    const unsaved = makeStore(withProtectedContent("Old answer"));
    unsaved.redactProtectedContent("Unsaved local state");
    expect(unsaved.getSnapshot().protectedPersistence?.state).toBe("unsaved");
    expect(await refreshProtectedWorkspace(unsaved, read, { failureMessage: "Unavailable" })).toBe(false);

    const busy = makeStore(withProtectedContent("Busy answer"));
    const busySession = required(busy.getSnapshot().workspace.sessions[0]);
    busy.update(busySession.id, busySession.snapshot, true);
    expect(busy.hasBusyChats()).toBe(true);
    expect(await refreshProtectedWorkspace(busy, read, { failureMessage: "Unavailable" })).toBe(false);

    const pending = makeStore(createChatWorkspace(OWNER));
    const pendingSession = required(pending.getSnapshot().workspace.sessions[0]);
    pending.updateDraft(pendingSession.id, "Unsaved draft");
    expect(pending.hasPendingWrites()).toBe(true);
    expect(await refreshProtectedWorkspace(pending, read, { failureMessage: "Unavailable" })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    pending.flush();
    await vi.waitFor(() => { expect(pending.hasPendingWrites()).toBe(false); });
  });

  it("blocks recovery behind an authority-change barrier until a later canonical read", async () => {
    const local = withProtectedContent("Personal content", "Draft survives disconnect");
    const remote = withProtectedContent("Verified canonical content", "", local);
    const store = makeStore(local);
    const inFlightRead = deferred<ProtectedWorkspaceResult>();
    const inFlightRefresh = refreshProtectedWorkspace(store, () => inFlightRead.promise, {
      failureMessage: "Read failed during disconnect",
    });
    const blockedRead = vi.fn(() => Promise.resolve(result(remote)));
    const release = store.beginAuthorityChange("Personal workspace disconnected");

    expect(store.hasAuthorityChange()).toBe(true);
    expect(await refreshProtectedWorkspace(store, blockedRead, {
      recover: true,
      failureMessage: "Unavailable",
    })).toBe(false);
    expect(blockedRead).not.toHaveBeenCalled();
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Personal content");
    expect(currentSnapshot(store).input).toBe("Draft survives disconnect");
    inFlightRead.resolve(result(remote));
    expect(await inFlightRefresh).toBe(false);
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Verified canonical content");

    release();
    expect(store.hasAuthorityChange()).toBe(false);
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Personal content");
    expect(await refreshProtectedWorkspace(store, () => Promise.resolve(result(remote)), {
      recover: true,
      failureMessage: "Unavailable",
    })).toBe(true);
    expect(currentSnapshot(store).messages.map(message => message.text)).toContain("Verified canonical content");
    expect(currentSnapshot(store).input).toBe("Draft survives disconnect");
  });

  it("redacts a current read failure and later restores only canonical content and the current draft", async () => {
    const local = withProtectedContent("Stale protected answer", "Current local draft");
    const canonical = withProtectedContent("Canonical answer after recovery", "", local);
    const store = makeStore(local);

    expect(await refreshProtectedWorkspace(store, () => Promise.reject(new Error("network details are not exposed")), {
      failureMessage: "Protected workspace unavailable",
    })).toBe(false);
    expect(currentSnapshot(store).history).toEqual([]);
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Stale protected answer");
    expect(currentSnapshot(store).input).toBe("Current local draft");

    expect(await refreshProtectedWorkspace(store, () => Promise.resolve(result(canonical)), {
      recover: true,
      failureMessage: "Protected workspace recovery failed",
    })).toBe(true);
    expect(currentSnapshot(store).messages.map(message => message.text)).toContain("Canonical answer after recovery");
    expect(currentSnapshot(store).history).toContainEqual({ role: "assistant", content: "Canonical answer after recovery" });
    expect(currentSnapshot(store).input).toBe("Current local draft");
    expect(JSON.stringify(currentSnapshot(store))).not.toContain("Stale protected answer");
  });
});
