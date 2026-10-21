import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStorageKey, createChatWorkspace, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore, RemoteWorkspaceConflict, type ProtectedWorkspaceResult } from "../src/lib/chat-workspace-store";
import { protectWorkspaceNavigation } from "../src/lib/protected-workspace-navigation";
import { required } from "./test-utils";

const OWNER = "synthetic-navigation-owner";
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  vi.useFakeTimers();
  const initial = createChatWorkspace(OWNER);
  let serialized = JSON.stringify(initial);
  const storage = {
    getItem: (key: string) => key === chatStorageKey(OWNER) ? serialized : null,
    setItem: (_key: string, value: string) => { serialized = value; },
  };
  const saved = deferred<ProtectedWorkspaceResult>();
  const save = vi.fn((_workspace: ChatWorkspace, _revision: string | null) => saved.promise);
  const store = createChatWorkspaceStore(OWNER, storage, { revision: "initial-revision", save });
  const id = required(initial.sessions[0]).id;
  const page = new EventTarget();
  const visibilityState: { visibilityState: DocumentVisibilityState } = { visibilityState: "visible" };
  const visibility = Object.assign(new EventTarget(), visibilityState);
  const stop = protectWorkspaceNavigation(store, page, visibility);
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    page.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { initial, store, id, page, visibility, saved, save, stop, unload,
    input: () => required(store.getSnapshot().workspace.sessions.find(session => session.id === id)).snapshot.input };
}

async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

describe("protected workspace navigation", () => {
  it("guards the first synchronous draft before debounce, keeps guarding in flight, and permits reload only after acknowledgement", async () => {
    const f = fixture();
    expect(f.unload()).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    f.store.updateDraft(f.id, "Immediate unsent draft");
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved"); // debounce has not run
    expect(f.unload()).toBe(true);
    expect(f.input()).toBe("Immediate unsent draft");
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1);
    const submitted = required(f.save.mock.calls[0])[0];
    expect(f.unload()).toBe(true);
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1); // no unload-triggered retry
    f.saved.resolve({ revision: "acknowledged-revision", workspace: submitted });
    await settle();
    expect(f.unload()).toBe(false);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved");
    expect(required(submitted.sessions[0]).snapshot.input).toBe("Immediate unsent draft");
    f.stop();
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("does not unlock navigation when an older acknowledgement preserves a newer local draft", async () => {
    const f = fixture();
    const second = deferred<ProtectedWorkspaceResult>();
    f.save.mockImplementationOnce(() => f.saved.promise).mockImplementationOnce(() => second.promise);
    f.store.updateDraft(f.id, "First draft");
    f.page.dispatchEvent(new Event("pagehide"));
    await settle();
    const first = required(f.save.mock.calls[0])[0];
    f.store.updateDraft(f.id, "Newer draft");
    f.saved.resolve({ revision: "first-acknowledgement", workspace: first });
    await settle();
    expect(f.input()).toBe("Newer draft");
    expect(f.unload()).toBe(true);
    await settle();
    const latest = required(f.save.mock.calls[1])[0];
    expect(required(latest.sessions[0]).snapshot.input).toBe("Newer draft");
    second.resolve({ revision: "second-acknowledgement", workspace: latest });
    await settle();
    expect(f.unload()).toBe(false);
    expect(f.save).toHaveBeenCalledTimes(2);
    f.stop();
  });

  it.each(["offline", "conflict"] as const)("retains the warning and unsent draft after %s without an implicit retry", async failure => {
    const f = fixture();
    f.store.updateDraft(f.id, "Keep this unsent text");
    expect(f.unload()).toBe(true);
    await settle();
    f.saved.reject(failure === "conflict"
      ? new RemoteWorkspaceConflict({ revision: "other-writer", workspace: f.initial })
      : new Error("synthetic transport failure"));
    await settle();
    expect(f.store.hasPendingWrites()).toBe(false);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe(failure === "conflict" ? "conflict" : "unsaved");
    expect(f.input()).toBe("Keep this unsent text");
    expect(f.unload()).toBe(true);
    f.visibility.visibilityState = "hidden";
    f.visibility.dispatchEvent(new Event("visibilitychange"));
    f.page.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1);
    f.stop();
  });

  it("flushes on hidden/pagehide rather than waiting for debounce and does not enqueue duplicate clean or in-flight saves", async () => {
    const f = fixture();
    f.visibility.visibilityState = "hidden";
    f.visibility.dispatchEvent(new Event("visibilitychange"));
    f.page.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(f.save).not.toHaveBeenCalled();
    f.visibility.visibilityState = "visible";
    f.store.updateDraft(f.id, "Save on backgrounding");
    f.visibility.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(f.save).not.toHaveBeenCalled();
    f.visibility.visibilityState = "hidden";
    f.visibility.dispatchEvent(new Event("visibilitychange"));
    f.page.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1);
    f.saved.resolve({ revision: "saved", workspace: required(f.save.mock.calls[0])[0] });
    await settle();
    f.page.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.unload()).toBe(false);
    f.stop();
  });

  it("detaches account-bound listeners without starting a save during logout or account disposal", async () => {
    const f = fixture();
    f.store.updateDraft(f.id, "First account draft");
    f.stop();
    expect(f.unload()).toBe(false);
    f.page.dispatchEvent(new Event("pagehide"));
    f.visibility.visibilityState = "hidden";
    f.visibility.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(f.save).not.toHaveBeenCalled();
    // Existing autosave policy is separate; disposing the guard does not
    // execute an account-bound request as a teardown side effect.
    expect(f.store.hasPendingWrites()).toBe(true);
  });
});
