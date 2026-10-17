import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatWorkspaceStore } from "../src/lib/chat-workspace-store";
import { chatStorageKey, loadChatWorkspace } from "../src/lib/chat-sessions";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

afterEach(() => vi.useRealTimers());

describe("mounted chat workspace isolation", () => {
  it("does not reorder existing chats merely because fields arrive in a different object order after mounting", () => {
    vi.useFakeTimers();
    const storage = memory();
    const store = createChatWorkspaceStore("student", storage);
    const chat = store.getSnapshot().workspace.sessions[0]!;
    const { input, history, ...other } = chat.snapshot;
    vi.advanceTimersByTime(10_000);
    store.update(chat.id, { input, history, ...other }, false);
    expect(store.getSnapshot().workspace.sessions[0]!.updatedAt).toBe(chat.updatedAt);
    expect(store.getSnapshot().workspace).toBe(store.getSnapshot().workspace);
    store.flush();
  });

  it("routes background completions to their own chat, keeping the selected draft and profile", () => {
    vi.useFakeTimers();
    const storage = memory();
    const store = createChatWorkspaceStore("student", storage);
    const first = store.getSnapshot().workspace.sessions[0]!;
    const pending = { ...first.snapshot, history: [{ role: "user" as const, content: "Erster Kontext" }], messages: [{ id: "u1", role: "user" as const, text: "Erster Kontext" }], interrupted: true };
    store.update(first.id, pending, true);
    store.create();
    const second = store.getSnapshot().workspace.sessions[1]!;
    store.update(second.id, { ...second.snapshot, input: "Entwurf in Chat zwei", profileId: "groq-oss-20b" }, false);
    store.remove(first.id); // In-flight actions cannot be deleted.
    expect(store.getSnapshot().workspace.sessions).toHaveLength(2);
    store.update(first.id, { ...pending, history: [...pending.history, { role: "assistant", content: "Antwort für eins" }], messages: [...pending.messages, { id: "a1", role: "assistant", text: "Antwort für eins" }], interrupted: false }, false);
    expect(store.getSnapshot().workspace.activeId).toBe(second.id);
    expect(store.getSnapshot().workspace.sessions[1]!.snapshot).toMatchObject({ input: "Entwurf in Chat zwei", profileId: "groq-oss-20b", history: [] });
    store.flush();
    const restored = loadChatWorkspace("student", storage).workspace;
    expect(restored.sessions[0]!.snapshot.history.at(-1)?.content).toBe("Antwort für eins");
    expect(restored.sessions[1]!.snapshot.input).toBe("Entwurf in Chat zwei");
    expect(loadChatWorkspace("admin", storage).workspace.sessions[0]!.snapshot.messages).toEqual([]);
    store.remove(first.id);
    store.update(first.id, pending, false);
    expect(store.getSnapshot().workspace.sessions.map((chat) => chat.id)).toEqual([second.id]);
    store.flush();
  });

  it("starts new chats with the default profile while preserving existing profile selections", () => {
    const store = createChatWorkspaceStore("student", memory());
    const first = store.getSnapshot().workspace.sessions[0]!;

    store.update(first.id, { ...first.snapshot, profileId: "gwdg-qwen3-30b" }, false);
    store.create();

    const second = store.getSnapshot().workspace.sessions.find((session) => session.id === store.getSnapshot().workspace.activeId)!;
    expect(store.getSnapshot().workspace.sessions.find((session) => session.id === first.id)!.snapshot.profileId).toBe("gwdg-qwen3-30b");
    expect(second.snapshot.profileId).toBe("groq-oss-120b");

    store.update(second.id, { ...second.snapshot, profileId: "offline" }, false);
    store.create();

    const third = store.getSnapshot().workspace.sessions.find((session) => session.id === store.getSnapshot().workspace.activeId)!;
    expect(store.getSnapshot().workspace.sessions.find((session) => session.id === second.id)!.snapshot.profileId).toBe("offline");
    expect(third.snapshot.profileId).toBe("groq-oss-120b");
  });

  it("debounces storage and makes write failures visible without throwing or dropping in-memory chats", () => {
    vi.useFakeTimers();
    const storage = memory();
    const setItem = vi.spyOn(storage, "setItem");
    const store = createChatWorkspaceStore("student", storage);
    const chat = store.getSnapshot().workspace.sessions[0]!;
    store.update(chat.id, { ...chat.snapshot, input: "a" }, false);
    store.update(chat.id, { ...chat.snapshot, input: "ab" }, false);
    vi.advanceTimersByTime(180);
    expect(setItem).toHaveBeenCalledTimes(1);
    const prior = storage.getItem(chatStorageKey("student"));
    setItem.mockImplementation(() => { throw new Error("QuotaExceededError"); });
    store.update(chat.id, { ...chat.snapshot, input: "abc" }, false);
    store.flush();
    expect(store.getSnapshot().notice).toMatch(/nicht gespeichert/);
    expect(store.getSnapshot().workspace.sessions[0]!.snapshot.input).toBe("abc");
    expect(storage.getItem(chatStorageKey("student"))).toBe(prior);
  });
});
