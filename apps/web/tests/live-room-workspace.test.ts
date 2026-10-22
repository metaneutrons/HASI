import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import { chatStorageKey, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore, RemoteWorkspaceConflict, type ProtectedWorkspaceResult } from "../src/lib/chat-workspace-store";
import { LIVE_AVAILABILITY_MS, LiveRoomAvailability } from "../src/lib/live-room-availability";
import { ProtectedWorkspaceStore } from "../src/lib/server/protected-workspaces";
import { required } from "./test-utils";

const OWNER = "synthetic-live-room-subject";
const resource = { id: "desk-a", name: "Authorized desk A", description: "Synthetic desk", capacity: 1,
  location: "1J", features: [], serviceId: "service-a", kind: "workplace" as const };
const interval = { startDate: "2026-10-20T08:00:00Z", endDate: "2026-10-20T10:00:00Z", available: true };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

async function fixture() {
  let resources = [resource];
  let available = true;
  const database = new MemoryJsonStore("live-room-workspace");
  const service = new ProtectedWorkspaceStore({
    store: database, ownerId: OWNER, scope: `test:${OWNER}`, secret: "synthetic-test-signing-material",
    resolve: () => Promise.resolve([]),
    resolveNative: () => available ? Promise.resolve({ resources, bookings: [], proposals: new Map() }) : Promise.reject(new Error("unavailable")),
    authority: () => Promise.resolve("a".repeat(64)),
  });
  const initial = await service.load();
  let serialized = JSON.stringify(initial.workspace);
  const memory = { getItem: (key: string) => key === chatStorageKey(OWNER) ? serialized : null,
    setItem: (_key: string, value: string) => { serialized = value; } };
  let delay: Promise<void> | undefined;
  let fail: "offline" | "conflict" | undefined;
  let lastSaved: ProtectedWorkspaceResult | undefined;
  const save = vi.fn(async (workspace: ChatWorkspace, revision: string | null) => {
    await delay;
    if (fail === "offline") throw new Error("offline");
    if (fail === "conflict") throw new RemoteWorkspaceConflict(await service.load());
    lastSaved = await service.save(revision, workspace);
    return lastSaved;
  });
  const store = createChatWorkspaceStore(OWNER, memory, { revision: initial.revision, save });
  const id = required(initial.workspace.sessions[0]).id;
  const snapshot = () => required(store.getSnapshot().workspace.sessions.find(session => session.id === id)).snapshot;
  const messageId = randomUUID();
  function search(busy = false, interactionId?: string) {
    store.updateConversation(id, { ...snapshot(), activeResult: interactionId ?? messageId, chosenRoom: resource,
      messages: [{ id: messageId, role: "assistant", text: "Original live room helper", tool: "anny · Raumsuche",
        ...(interactionId ? { interactionId } : {}),
        rooms: [{ resource, checked: true, intervals: [interval], requestedStartDate: interval.startDate, requestedEndDate: interval.endDate }] }] }, busy);
  }
  return { store, id, service, memory, save, snapshot, search, saved: () => required(lastSaved),
    deny() { resources = []; }, unavailable() { available = false; },
    changeMetadata() { resources = [{ ...resource, name: "Renamed current desk" }]; },
    delay(value: Promise<void>) { delay = value; }, fail(value: "offline" | "conflict") { fail = value; } };
}

function seedNativeRoomSearch(f: Awaited<ReturnType<typeof fixture>>) {
  const request = { id: randomUUID(), role: "user" as const, text: "Ich brauche einen Raum." };
  const refinement = { id: randomUUID(), role: "user" as const, text: "Einzelbüro in Gebäude 1J." };
  const interactionId = randomUUID();
  const card = { id: randomUUID(), role: "assistant" as const, text: "Ergebnisse aus den anny-Testdaten.",
    tool: "anny · Raumsuche", model: "", interactionId,
    rooms: [{ resource, checked: false, intervals: [] }] };
  f.store.updateConversation(f.id, { ...f.snapshot(), activeResult: interactionId, chosenRoom: null,
    history: [{ role: "user", content: request.text }, { role: "user", content: refinement.text }],
    messages: [request, refinement, card] }, false);
  return { request, refinement, interactionId, card };
}

describe("live room availability with the real protected server projection", () => {
  it("keeps own fresh availability after autosave, but persists and reloads unchecked history", async () => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.hasPendingWrites()).toBe(false);
    expect(f.snapshot().messages[0]?.rooms?.[0]).toMatchObject({ checked: true, intervals: [interval], resource });
    expect(f.snapshot().messages[0]?.text).toContain("erneut geprüft");
    expect(f.saved().workspace.sessions[0]?.snapshot.messages[0]?.rooms?.[0]).toMatchObject({ checked: false, intervals: [] });
    const reloaded = await f.service.load();
    expect(reloaded.workspace.sessions[0]?.snapshot.messages[0]?.rooms?.[0]).toMatchObject({ checked: false, intervals: [] });
    f.store.applyRemoteWorkspace(reloaded.workspace, reloaded.revision);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(false);
  });

  it("keeps model-tool card grouping usable after projection without treating it as authority", async () => {
    const f = await fixture();
    f.search(false, "synthetic-model-turn");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().activeResult).toBe("synthetic-model-turn");
    expect(f.snapshot().messages[0]?.interactionId).toBe(f.snapshot().activeResult);
    const loaded = await f.service.load();
    expect(loaded.workspace.sessions[0]?.snapshot.messages[0]).toMatchObject({ interactionId: "synthetic-model-turn",
      rooms: [{ checked: false, intervals: [] }] });
    f.deny();
    const denied = await f.service.load();
    expect(denied.workspace.sessions[0]?.snapshot.messages[0]?.interactionId).toBeUndefined();
    expect(denied.workspace.sessions[0]?.snapshot.messages[0]?.rooms).toBeUndefined();
  });

  it.each(["deny", "unavailable", "changeMetadata"] as const)("does not restore availability over current server %s", async change => {
    const f = await fixture();
    f.search();
    f[change]();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.rooms?.some(room => room.checked)).not.toBe(true);
    expect(JSON.stringify(f.snapshot())).not.toContain("Authorized desk A");
    if (change === "changeMetadata") expect(f.snapshot().messages[0]?.rooms?.[0]?.resource.name).toBe("Renamed current desk");
    else expect(f.snapshot().chosenRoom).toBeNull();
  });

  it.each(["requestedStartDate", "requestedEndDate"] as const)("does not overlay a different %s", async field => {
    const f = await fixture();
    f.search();
    const live = f.store.getSnapshot().workspace;
    const overlay = new LiveRoomAvailability();
    overlay.capture(live, Date.now());
    const approved = (await f.service.save(null, live)).workspace;
    const room = required(approved.sessions[0]?.snapshot.messages[0]?.rooms?.[0]);
    room[field] = "2026-10-21T12:00:00Z";
    expect(overlay.apply(approved, Date.now()).sessions[0]?.snapshot.messages[0]?.rooms?.[0]).toMatchObject({ checked: false, intervals: [] });
  });

  it("rejects a display lease if the local wall clock moves behind its capture", async () => {
    const f = await fixture();
    f.search();
    const live = f.store.getSnapshot().workspace;
    const overlay = new LiveRoomAvailability();
    overlay.capture(live, Date.now());
    const approved = (await f.service.save(null, live)).workspace;
    expect(overlay.apply(approved, Date.now() - 1).sessions[0]?.snapshot.messages[0]?.rooms?.[0]?.checked).toBe(false);
    expect(overlay.expire(live, Date.now() - 1).sessions[0]?.snapshot.messages[0]?.rooms?.[0]?.checked).toBe(false);
  });

  it("expires a fresh observation without a new request, and draft edits cannot renew it", async () => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(LIVE_AVAILABILITY_MS - 1_000);
    f.store.updateDraft(f.id, "A new unsent question");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(true);
    const saves = f.save.mock.calls.length;
    await vi.advanceTimersByTimeAsync(601);
    expect(f.snapshot().messages[0]?.rooms?.[0]).toMatchObject({ checked: false, intervals: [] });
    expect(f.snapshot().input).toBe("A new unsent question");
    expect(f.save).toHaveBeenCalledTimes(saves);
    f.store.updateConversation(f.id, f.snapshot(), false);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(false);
  });

  it("preserves a draft typed during an own save without redacting its unchanged room conversation", async () => {
    const f = await fixture();
    let release = () => { /* assigned by the deferred promise */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    f.store.updateDraft(f.id, "Typed while saving");
    await vi.advanceTimersByTimeAsync(300); // Queue another write behind the first.
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().input).toBe("Typed while saving");
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(true);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved");
  });

  it("keeps a new unsent chat created while another chat's save is in flight", async () => {
    const f = await fixture();
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    f.store.create();
    const created = required(f.store.getSnapshot().workspace.sessions.find(session => session.id !== f.id));
    f.store.updateDraft(created.id, "Unsent in new chat");
    await vi.advanceTimersByTimeAsync(300);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.getSnapshot().workspace.activeId).toBe(created.id);
    expect(f.store.getSnapshot().workspace.sessions.find(session => session.id === created.id)?.snapshot.input).toBe("Unsent in new chat");
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(true);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved");
  });

  it("does not abort a new request in an existing chat while a room save in another chat completes", async () => {
    const f = await fixture();
    f.store.updateDraft(f.id, "Make room for a second chat");
    f.store.create();
    const second = required(f.store.getSnapshot().workspace.sessions.find(session => session.id !== f.id));
    f.store.updateDraft(second.id, "Existing second draft");
    await vi.advanceTimersByTimeAsync(200);
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    const current = required(f.store.getSnapshot().workspace.sessions.find(session => session.id === second.id));
    f.store.updateConversation(second.id, { ...current.snapshot, input: "", interrupted: true,
      messages: [{ id: "pending-question", role: "user", text: "A second synthetic request" }],
      history: [{ role: "user", content: "A second synthetic request" }] }, true);
    const epoch = f.store.getSnapshot().sessionEpochs[second.id] ?? 0;
    await vi.advanceTimersByTimeAsync(300);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(true);
    expect(f.store.getSnapshot().sessionEpochs[second.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().busy[second.id]).toBe(true);
    expect(f.store.getSnapshot().workspace.sessions.find(session => session.id === second.id)?.snapshot.messages[0]?.text).toBe("A second synthetic request");
    f.store.updateConversation(second.id, required(f.store.getSnapshot().workspace.sessions.find(session => session.id === second.id)).snapshot, false);
    await vi.advanceTimersByTimeAsync(200);
  });

  it("keeps a newer user-only room-selection turn across an own native-card projection", async () => {
    const f = await fixture();
    const seeded = seedNativeRoomSearch(f);
    let release = () => { /* assigned by the deferred promise */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(180);
    expect(f.save).toHaveBeenCalledTimes(1);

    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    const current = f.snapshot();
    const selection = { id: randomUUID(), role: "user" as const,
      text: "Ich möchte den Arbeitsplatz Authorized desk A buchen." };
    f.store.updateConversation(f.id, { ...current, interrupted: true, chosenRoom: resource, activeResult: null,
      history: [...current.history, { role: "user", content: selection.text }],
      messages: [...current.messages, selection] }, true);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);

    const view = f.store.getSnapshot();
    const snapshot = f.snapshot();
    expect(view.sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(view.busy[f.id]).toBe(true);
    expect(snapshot.messages.at(-1)).toMatchObject({ id: selection.id, role: "user", text: selection.text });
    expect(snapshot.history).toEqual([
      { role: "user", content: seeded.request.text },
      { role: "user", content: seeded.refinement.text },
      { role: "user", content: selection.text },
    ]);
    expect(snapshot.messages.find(message => message.id === seeded.card.id)).toMatchObject({
      role: "assistant",
      rooms: [{ resource, checked: false, intervals: [] }],
    });
    expect(snapshot.chosenRoom).toEqual(resource);
    expect(view.protectedPersistence?.state).toBe("saved");
    expect(f.store.hasPendingWrites()).toBe(false);
  });

  it("redacts and remounts a busy room-selection turn when the held save loses native access", async () => {
    const f = await fixture();
    const seeded = seedNativeRoomSearch(f);
    let release = () => { /* assigned by the deferred promise */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(180);
    expect(f.save).toHaveBeenCalledTimes(1);

    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    const selection = { id: randomUUID(), role: "user" as const,
      text: "Ich möchte den Arbeitsplatz Authorized desk A buchen." };
    const current = f.snapshot();
    f.store.updateConversation(f.id, { ...current, interrupted: true, chosenRoom: resource, activeResult: null,
      history: [...current.history, { role: "user", content: selection.text }],
      messages: [...current.messages, selection] }, true);
    f.deny();

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);

    const view = f.store.getSnapshot();
    const snapshot = f.snapshot();
    expect(view.sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    expect(snapshot.messages.at(-1)).toMatchObject({ id: selection.id, role: "user", text: selection.text });
    const unavailableCard = snapshot.messages.find(message => message.id === seeded.card.id);
    expect(unavailableCard?.rooms).toBeUndefined();
    expect(unavailableCard?.text).toMatch(/nicht mehr verfügbar/u);
    expect(snapshot.chosenRoom).toBeNull();
    expect(snapshot.history).toEqual([]);
    expect(view.protectedPersistence?.state).toBe("unsaved");
  });

  it("does not preserve a concurrently changed chat over a revoked protected baseline", async () => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    f.store.create();
    const second = required(f.store.getSnapshot().workspace.sessions.find(session => session.id !== f.id));
    f.store.updateConversation(second.id, f.snapshot(), false);
    await vi.advanceTimersByTimeAsync(200);
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.store.updateDraft(f.id, "Trigger a protected save");
    await vi.advanceTimersByTimeAsync(180);
    const current = required(f.store.getSnapshot().workspace.sessions.find(session => session.id === second.id));
    f.store.updateConversation(second.id, { ...current.snapshot, interrupted: true,
      messages: [...current.snapshot.messages, { id: "later", role: "user", text: "Another question" }] }, true);
    f.deny();
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.stringify(f.store.getSnapshot().workspace)).not.toContain(resource.name);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("unsaved");
    expect(f.store.getSnapshot().workspace.sessions.find(session => session.id === second.id)?.snapshot.messages.at(-1)?.text).toBe("Another question");
  });

  it("immediately reauthorizes new protected results missing from the older acknowledgement", async () => {
    const f = await fixture();
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.store.updateDraft(f.id, "Start an empty-baseline save");
    await vi.advanceTimersByTimeAsync(180);
    f.search();
    f.deny();
    release();
    await vi.advanceTimersByTimeAsync(0); // No debounce or later queued write is allowed to provide the check.
    expect(f.save.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(f.snapshot())).not.toContain(resource.name);
    expect(f.snapshot().messages[0]?.rooms).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
  });

  it("bounds repeated concurrent changes and fails closed rather than retrying forever", async () => {
    const f = await fixture();
    f.save.mockImplementation(async (workspace, revision) => {
      const result = await f.service.save(revision, workspace);
      f.store.updateConversation(f.id, { ...f.snapshot(), messages: [...f.snapshot().messages,
        { id: randomUUID(), role: "user", text: "Synthetic concurrent change" }] }, false);
      return result;
    });
    f.store.updateDraft(f.id, "Start the bounded serial operation");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.save).toHaveBeenCalledTimes(3);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.save).toHaveBeenCalledTimes(3);
  });

  it("ignores an in-flight acknowledgement after authority was explicitly redacted", async () => {
    const f = await fixture();
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    f.store.redactProtectedContent("Current authority could not be verified");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(f.snapshot())).not.toContain(resource.name);
    expect(f.snapshot().messages[0]?.rooms).toBeUndefined();
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("unsaved");
  });

  it.each(["offline", "conflict"] as const)("clears live observations on %s, without losing the draft", async failure => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    f.fail(failure);
    f.store.updateDraft(f.id, "Keep this unsent question");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.rooms?.some(room => room.checked)).not.toBe(true);
    expect(f.snapshot().input).toBe("Keep this unsent question");
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe(failure === "conflict" ? "conflict" : "unsaved");
  });

  it("does not remount a busy business action at lease expiry, then expires immediately on completion", async () => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    f.store.updateConversation(f.id, f.snapshot(), true);
    const epoch = f.store.getSnapshot().accessEpoch;
    await vi.advanceTimersByTimeAsync(LIVE_AVAILABILITY_MS);
    expect(f.store.getSnapshot().accessEpoch).toBe(epoch);
    f.store.updateConversation(f.id, f.snapshot(), false);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
  });

  it("does not abort a busy business action when a delayed acknowledgement arrives after lease expiry", async () => {
    const f = await fixture();
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    const live = f.snapshot();
    f.store.updateConversation(f.id, live, true);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    await vi.advanceTimersByTimeAsync(LIVE_AVAILABILITY_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().busy[f.id]).toBe(true);
    f.store.updateConversation(f.id, live, false);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
  });

  it("does remount a busy conversation when its own acknowledgement withdraws resource access", async () => {
    const f = await fixture();
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.search();
    await vi.advanceTimersByTimeAsync(180);
    f.store.updateConversation(f.id, f.snapshot(), true);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    f.deny();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    expect(JSON.stringify(f.snapshot())).not.toContain(resource.name);
    f.store.updateConversation(f.id, f.snapshot(), false);
    await vi.advanceTimersByTimeAsync(200);
  });

  it("expires an idle conversation independently of a busy action in another chat", async () => {
    const f = await fixture();
    f.search();
    await vi.advanceTimersByTimeAsync(200);
    f.store.create();
    const second = required(f.store.getSnapshot().workspace.sessions.find(session => session.id !== f.id));
    await vi.advanceTimersByTimeAsync(200);
    f.store.updateConversation(second.id, second.snapshot, true);
    const epoch = f.store.getSnapshot().sessionEpochs[second.id] ?? 0;
    await vi.advanceTimersByTimeAsync(LIVE_AVAILABILITY_MS);
    expect(f.snapshot().messages[0]?.rooms?.[0]?.checked).toBe(false);
    expect(f.store.getSnapshot().sessionEpochs[second.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().busy[second.id]).toBe(true);
    f.store.updateConversation(second.id, second.snapshot, false);
  });

  it("does not share leases between subjects/stores or restore arbitrary assistant text", async () => {
    const f = await fixture();
    f.search();
    f.store.updateConversation(f.id, { ...f.snapshot(), messages: [...f.snapshot().messages,
      { id: "forged-model", role: "assistant", text: "UNSIGNED PRIVATE ANSWER" }] }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.stringify(f.snapshot())).not.toContain("UNSIGNED PRIVATE ANSWER");
    const other = createChatWorkspaceStore("other-subject");
    expect(JSON.stringify(other.getSnapshot().workspace)).not.toContain(resource.id);
    const reloaded = createChatWorkspaceStore(OWNER, { getItem: () => JSON.stringify(f.saved().workspace), setItem: () => undefined });
    expect(reloaded.getSnapshot().workspace.sessions[0]?.snapshot.messages[0]?.rooms?.[0]?.checked).toBe(false);
  });
});
