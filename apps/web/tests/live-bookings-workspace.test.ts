import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import { chatStorageKey, type ChatMessage, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore, type ProtectedWorkspaceResult } from "../src/lib/chat-workspace-store";
import { ProtectedWorkspaceStore } from "../src/lib/server/protected-workspaces";
import { required } from "./test-utils";

const OWNER = "synthetic-live-bookings-subject";
type Booking = NonNullable<ChatMessage["bookings"]>[number];
const booking: Booking = {
  id: "booking-a",
  resourceName: "Authorized meeting room",
  startDate: "2026-10-20T08:00:00Z",
  endDate: "2026-10-20T10:00:00Z",
  status: "confirmed",
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  let nativeBookings = [booking];
  let nativeAvailable = true;
  const service = new ProtectedWorkspaceStore({
    store: new MemoryJsonStore(`live-bookings-${randomUUID()}`),
    ownerId: OWNER,
    scope: `test:${OWNER}`,
    secret: "synthetic-test-signing-material",
    resolve: () => Promise.resolve([]),
    resolveNative: () => nativeAvailable
      ? Promise.resolve({ resources: [], bookings: nativeBookings, proposals: new Map() })
      : Promise.reject(new Error("unavailable")),
    authority: () => Promise.resolve("a".repeat(64)),
  });
  const initial = await service.load();
  let serialized = JSON.stringify(initial.workspace);
  const storage = {
    getItem: (key: string) => key === chatStorageKey(OWNER) ? serialized : null,
    setItem: (_key: string, value: string) => { serialized = value; },
  };
  let firstSaveGate: ReturnType<typeof deferred> | undefined;
  const firstSaveStarted = deferred();
  let saveCount = 0;
  let lastSaved: ProtectedWorkspaceResult | undefined;
  const save = vi.fn(async (workspace: ChatWorkspace, revision: string | null) => {
    saveCount += 1;
    if (saveCount === 1 && firstSaveGate) {
      firstSaveStarted.resolve();
      await firstSaveGate.promise;
    }
    lastSaved = await service.save(revision, workspace);
    return lastSaved;
  });
  const store = createChatWorkspaceStore(OWNER, storage, { revision: initial.revision, save });
  const id = required(initial.workspace.sessions[0]).id;
  const snapshot = () => required(store.getSnapshot().workspace.sessions.find(session => session.id === id)).snapshot;
  return {
    store,
    id,
    snapshot,
    save,
    lastSaved: () => required(lastSaved),
    setNativeBookings(value: Booking[]) { nativeBookings = value; nativeAvailable = true; },
    makeNativeUnavailable() { nativeAvailable = false; },
    holdFirstSave() {
      firstSaveGate = deferred();
      return { started: firstSaveStarted.promise, release: firstSaveGate.resolve };
    },
  };
}

function seedBookings(f: Awaited<ReturnType<typeof fixture>>, shownBookings: Booking[] = [booking]) {
  const request = { id: randomUUID(), role: "user" as const, text: "Zeige mir meine Buchungen." };
  const card: ChatMessage = {
    id: randomUUID(),
    role: "assistant",
    text: "Deine Buchungen aus der Testumgebung.",
    tool: "anny · Eigene Buchungen",
    model: "",
    interactionId: randomUUID(),
    bookings: shownBookings,
  };
  f.store.updateConversation(f.id, {
    ...f.snapshot(),
    messages: [request, card],
    history: [{ role: "user", content: request.text }],
  }, false);
  return { request, card };
}

async function settleWrites(f: Awaited<ReturnType<typeof fixture>>) {
  for (let attempt = 0; attempt < 8 && f.store.hasPendingWrites(); attempt += 1) {
    await vi.advanceTimersByTimeAsync(180);
  }
  expect(f.store.hasPendingWrites()).toBe(false);
}

describe("own-booking cards with the real protected workspace projection", () => {
  it("keeps a newer cancellation-intent turn while an identical booking card is reprojected", async () => {
    const f = await fixture();
    const seeded = seedBookings(f);
    const held = f.holdFirstSave();
    await vi.advanceTimersByTimeAsync(180);
    await held.started;
    expect(f.save).toHaveBeenCalledTimes(1);

    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    const cancellationIntent = { id: randomUUID(), role: "user" as const,
      text: "Bitte bereite die Stornierung meiner Buchung vor." };
    const current = f.snapshot();
    f.store.updateConversation(f.id, {
      ...current,
      interrupted: true,
      messages: [...current.messages, cancellationIntent],
      history: [...current.history, { role: "user", content: cancellationIntent.text }],
    }, true);

    held.release();
    await vi.advanceTimersByTimeAsync(0);
    await settleWrites(f);

    const view = f.store.getSnapshot();
    const snapshot = f.snapshot();
    expect(view.sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(view.busy[f.id]).toBe(true);
    expect(snapshot.messages.at(-1)).toMatchObject({
      id: cancellationIntent.id,
      role: "user",
      text: cancellationIntent.text,
    });
    expect(snapshot.history).toEqual([
      { role: "user", content: seeded.request.text },
      { role: "user", content: cancellationIntent.text },
    ]);
    const projected = snapshot.messages.find(message => message.id === seeded.card.id);
    expect(projected).toMatchObject({
      id: seeded.card.id,
      role: "assistant",
      text: "Aktueller Stand deiner früher angezeigten Buchungen.",
      tool: "anny · Eigene Buchungen",
      bookings: [booking],
    });
    expect(projected).not.toHaveProperty("model");
    expect(projected).not.toHaveProperty("interactionId");
    expect(f.lastSaved().workspace.sessions[0]?.snapshot.messages.find(message => message.id === seeded.card.id)?.bookings).toEqual([booking]);
    expect(view.protectedPersistence?.state).toBe("saved");
  });

  it.each(["status", "interval", "resourceName", "removed", "unavailable"] as const)(
    "replaces or withdraws the stale booking card when current %s changes",
    async change => {
      const f = await fixture();
      const seeded = seedBookings(f);
      let currentBooking: Booking | undefined = booking;
      if (change === "status") currentBooking = { ...booking, status: "cancelled" };
      if (change === "interval") currentBooking = { ...booking, startDate: "2026-10-20T09:00:00Z", endDate: "2026-10-20T11:00:00Z" };
      if (change === "resourceName") currentBooking = { ...booking, resourceName: "Renamed authorized room" };
      if (change === "removed") currentBooking = undefined;
      if (change !== "unavailable") f.setNativeBookings(currentBooking ? [currentBooking] : []);
      else f.makeNativeUnavailable();

      const busySnapshot = f.snapshot();
      f.store.updateConversation(f.id, { ...busySnapshot, interrupted: true }, true);
      const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
      await settleWrites(f);

      const view = f.store.getSnapshot();
      const snapshot = f.snapshot();
      const projected = snapshot.messages.find(message => message.id === seeded.card.id);
      expect(view.sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
      expect(view.busy[f.id]).toBe(true);
      if (currentBooking && change !== "unavailable") {
        expect(projected?.bookings).toEqual([currentBooking]);
        expect(projected?.bookings).not.toEqual([booking]);
        expect(projected?.text).toBe("Aktueller Stand deiner früher angezeigten Buchungen.");
      } else {
        expect(projected).not.toHaveProperty("bookings");
        expect(projected?.text).toMatch(/nicht mehr verfügbar/u);
        expect(JSON.stringify(snapshot)).not.toContain(booking.resourceName);
      }
      expect(view.protectedPersistence?.state).toBe("saved");
    },
  );

  it("does not accept forged metadata attached to a current booking ID", async () => {
    const f = await fixture();
    const forged = { ...booking, resourceName: "FORGED booking name" };
    const seeded = seedBookings(f, [forged]);
    const busySnapshot = f.snapshot();
    f.store.updateConversation(f.id, { ...busySnapshot, interrupted: true }, true);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;

    await settleWrites(f);

    const view = f.store.getSnapshot();
    const snapshot = f.snapshot();
    const projected = snapshot.messages.find(message => message.id === seeded.card.id);
    expect(view.sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    expect(projected?.bookings).toEqual([booking]);
    expect(JSON.stringify(snapshot)).not.toContain("FORGED booking name");
    expect(view.protectedPersistence?.state).toBe("saved");
  });
});
