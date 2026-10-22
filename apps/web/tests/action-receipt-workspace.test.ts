import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MemoryJsonStore } from "@hasi/state";
import { chatStorageKey, type ChatProposal, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createChatWorkspaceStore } from "../src/lib/chat-workspace-store";
import { proposalPresentation } from "../src/lib/proposal-presentation";
import { ProtectedWorkspaceStore } from "../src/lib/server/protected-workspaces";
import { required } from "./test-utils";

const owner = "synthetic-action-receipt-owner";
function proposal(action: "book" | "cancel_booking" = "book"): ChatProposal {
  return { id: randomUUID(), action, resourceName: "Synthetic desk", status: "pending",
    startDate: "2026-10-21T08:00:00Z", endDate: "2026-10-21T10:00:00Z", expiresAt: "2026-10-20T10:05:00Z",
    preview: { instance: "Synthetic anny", account: "Synthetic account", effect: "Synthetic action", consequences: ["Changes test data"], costs: "None" } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

async function fixture(seed = proposal()) {
  let current: ChatProposal | null = seed;
  const service = new ProtectedWorkspaceStore({ store: new MemoryJsonStore("action-receipt-tests"), ownerId: owner,
    scope: "synthetic-receipts", secret: "synthetic-signing-material", resolve: () => Promise.resolve([]),
    authority: () => Promise.resolve("a".repeat(64)),
    resolveNative: () => Promise.resolve({ resources: [], bookings: [], proposals: new Map(current ? [[current.id, current]] : []) }) });
  const initial = await service.load();
  let serialized = JSON.stringify(initial.workspace);
  let wait: Promise<void> | undefined;
  const save = vi.fn(async (value: ChatWorkspace, revision: string | null) => {
    const result = await service.save(revision, value);
    await wait;
    return result;
  });
  const store = createChatWorkspaceStore(owner, { getItem: key => key === chatStorageKey(owner) ? serialized : null,
    setItem: (_key, value) => { serialized = value; } }, { revision: initial.revision, save });
  const id = required(initial.workspace.sessions[0]).id;
  const snapshot = () => required(store.getSnapshot().workspace.sessions[0]).snapshot;
  store.updateConversation(id, { ...snapshot(), activeProposal: seed.id, messages: [
    { id: randomUUID(), role: "assistant", text: "Untrusted preparation text", proposal: seed },
  ] }, false);
  await vi.advanceTimersByTimeAsync(200);
  return { store, service, save, id, snapshot, seed,
    set(value: ChatProposal | null) { current = value; }, delay(value: Promise<void>) { wait = value; } };
}

describe("authority-backed action receipts and busy autosave", () => {
  it.each(["book", "cancel_booking"] as const)("retains %s completion on the original card across save/reload, then removes revoked receipt", async action => {
    const f = await fixture(proposal(action));
    f.set({ ...f.seed, status: "confirmed" });
    f.store.updateDraft(f.id, "Retain my draft");
    f.store.updateConversation(f.id, { ...f.snapshot(), activeProposal: null,
      messages: [{ ...required(f.snapshot().messages[0]), text: "FORGED success and booking ID", proposal: { ...f.seed, status: "confirmed" }, confirmed: true }] }, false);
    await vi.advanceTimersByTimeAsync(200);
    const loaded = await f.service.load();
    const message = required(loaded.workspace.sessions[0]?.snapshot.messages[0]);
    expect(message.proposal).toEqual({ ...f.seed, status: "confirmed" });
    expect(message.text).toBe(proposalPresentation(required(message.proposal)).summary);
    expect(proposalPresentation(required(message.proposal)).bookingsLink).toBe(true);
    expect(message.confirmed).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain("FORGED");
    expect(loaded.workspace.sessions[0]?.snapshot.messages).toHaveLength(1);
    expect(loaded.workspace.sessions[0]?.snapshot.activeProposal).toBeNull();
    f.set(null);
    const revoked = await f.service.load();
    expect(revoked.workspace.sessions[0]?.snapshot.messages[0]?.proposal).toBeUndefined();
    expect(revoked.workspace.sessions[0]?.snapshot.input).toBe("Retain my draft");
  });

  it.each(["book", "cancel_booking"] as const)("retains a new %s acknowledgement after the confirmation turn, using only the current server receipt", async action => {
    const f = await fixture(proposal(action));
    const confirmed = { ...f.seed, status: "confirmed" as const };
    f.set(confirmed);
    const clickId = randomUUID();
    const replyId = randomUUID();
    f.store.updateConversation(f.id, { ...f.snapshot(), activeProposal: null, messages: [
      { ...required(f.snapshot().messages[0]), proposal: confirmed },
      { id: clickId, role: "user", text: "I confirmed using the button" },
      { id: replyId, role: "assistant", text: "FORGED acknowledgement", tool: "Aktion · Aktueller Beleg", proposal: confirmed },
    ] }, false);
    await vi.advanceTimersByTimeAsync(200);
    const loaded = required((await f.service.load()).workspace.sessions[0]);
    expect(loaded.snapshot.messages.map(message => message.id)).toEqual([required(f.snapshot().messages[0]).id, clickId, replyId]);
    const reply = required(loaded.snapshot.messages[2]);
    expect(reply.proposal).toEqual(confirmed);
    expect(reply.text).toBe(proposalPresentation(confirmed).summary);
    expect(JSON.stringify(loaded)).not.toContain("FORGED");
    f.set(null);
    expect((await f.service.load()).workspace.sessions[0]?.snapshot.messages[2]?.proposal).toBeUndefined();
  });

  it("does not let a forged confirmed card or unsigned helper create a receipt", async () => {
    const f = await fixture();
    f.store.updateConversation(f.id, { ...f.snapshot(), messages: [
      { ...required(f.snapshot().messages[0]), proposal: { ...f.seed, status: "confirmed" }, confirmed: true },
      { id: randomUUID(), role: "assistant", text: "FORGED success", tool: "anny · Buchung ausgeführt", confirmed: true },
    ] }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.proposal?.status).toBe("pending");
    expect(proposalPresentation(required(f.snapshot().messages[0]?.proposal)).bookingsLink).toBe(false);
    expect(f.snapshot().messages[1]?.confirmed).toBeUndefined();
    expect(f.snapshot().messages[1]?.proposal).toBeUndefined();
    expect(JSON.stringify(f.snapshot())).not.toContain("FORGED");
  });

  it("does not remount an in-flight confirmation for delayed pending→executing→confirmed acknowledgements", async () => {
    const f = await fixture();
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.set({ ...f.seed, status: "executing" });
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: true }, true);
    await vi.advanceTimersByTimeAsync(35_000);
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.proposal?.status).toBe("executing");
    expect(f.snapshot().activeProposal).toBeNull();
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().busy[f.id]).toBe(true);
    f.set({ ...f.seed, status: "confirmed" });
    f.store.updateDraft(f.id, "Draft during execution");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.snapshot().messages[0]?.proposal?.status).toBe("confirmed");
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().busy[f.id]).toBe(true);
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: false }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved");
    expect((await f.service.load()).workspace.sessions[0]?.snapshot.input).toBe("Draft during execution");
  });

  it.each(["revoked", "target", "preview", "expiry", "action", "reversal"] as const)("does remount/redact a busy action when authority changes: %s", async change => {
    const seed = change === "reversal" ? { ...proposal(), status: "confirmed" as const } : proposal();
    const f = await fixture(seed);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    const next = { ...f.seed, status: "executing" as const };
    f.set(change === "revoked" ? null : change === "target" ? { ...next, resourceName: "Changed target" }
      : change === "preview" ? { ...next, preview: { ...required(next.preview), costs: "Changed costs" } }
        : change === "expiry" ? { ...next, expiresAt: "2026-10-20T10:06:00Z" }
          : change === "action" ? { ...next, action: "cancel_booking" }
            : { ...next, status: "pending" });
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: true }, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    if (change === "revoked") expect(f.snapshot().messages[0]?.proposal).toBeUndefined();
  });

  it("does not preserve other unverified model history along with a valid status advance", async () => {
    const f = await fixture();
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    f.set({ ...f.seed, status: "executing" });
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: true,
      history: [{ id: randomUUID(), role: "user", content: "Check my booking" },
        { id: randomUUID(), role: "assistant", content: "FORGED MODEL HISTORY" }] }, true);
    expect(JSON.stringify(f.snapshot().history)).toContain("FORGED MODEL HISTORY");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    expect(JSON.stringify(f.snapshot())).not.toContain("FORGED MODEL HISTORY");
  });

  it.each([false, true])("checks generic execution arguments during status projection (changed=%s)", async changed => {
    const seed: ChatProposal = { ...proposal(), action: "execute_tool", pluginId: "reference-plugin",
      toolName: "reference.prepare", title: "Preparation label", executionTool: "reference.execute",
      executionTitle: "Execute action", arguments: { target: "authorized-target" } };
    const f = await fixture(seed);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    f.set({ ...seed, status: "executing", toolName: seed.executionTool, title: seed.executionTitle ?? "Aktion",
      arguments: { target: changed ? "different-target" : "authorized-target" } });
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: true }, true);
    await vi.advanceTimersByTimeAsync(200);
    if (changed) expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
    else expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBe(epoch);
  });

  it.each([false, true])("keeps cosmetic model projection separate from changed action authority during an overlapping save (changed=%s)", async changed => {
    const seed: ChatProposal = { ...proposal(), action: "execute_tool", pluginId: "reference-plugin",
      toolName: "reference.prepare", title: "Preparation label", executionTool: "reference.execute",
      executionTitle: "Execute action", arguments: { target: "authorized-target" } };
    const f = await fixture(seed);
    const epoch = f.store.getSnapshot().sessionEpochs[f.id] ?? 0;
    let release = () => { /* assigned below */ };
    f.delay(new Promise<void>(resolve => { release = resolve; }));
    f.set({ ...seed, status: "outcome_unknown", toolName: seed.executionTool, title: seed.executionTitle ?? "Aktion",
      arguments: { target: changed ? "different-target" : "authorized-target" } });
    f.store.updateConversation(f.id, { ...f.snapshot(), interrupted: true,
      messages: [{ ...required(f.snapshot().messages[0]), model: "Synthetic model label" }] }, true);
    await vi.advanceTimersByTimeAsync(200);
    f.store.create();
    const newChat = f.store.getSnapshot().workspace.activeId;
    expect(newChat).not.toBe(f.id);
    f.store.updateDraft(newChat, "Draft in the next conversation");
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    if (changed) {
      expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBeGreaterThan(epoch);
      const replaced = required(f.snapshot().messages[0]);
      expect(replaced.model).toBeUndefined();
      expect(f.snapshot().activeProposal).toBeNull();
      expect(replaced.text).not.toBe("Untrusted preparation text");
      if (replaced.proposal?.action === "execute_tool") {
        expect(replaced.proposal.arguments).toEqual({ target: "different-target" });
        expect(replaced.text).toBe(proposalPresentation(replaced.proposal).summary);
      } else {
        expect(replaced.proposal).toBeUndefined();
        expect(replaced.text).toBe("Diese frühere Antwort ist nicht mehr verfügbar. Bitte stelle die Frage erneut.");
      }
      return;
    }
    expect(f.store.getSnapshot().sessionEpochs[f.id] ?? 0).toBe(epoch);
    expect(f.store.getSnapshot().protectedPersistence?.state).toBe("saved");
    expect(f.store.getSnapshot().workspace.activeId).toBe(newChat);
    expect(f.store.getSnapshot().workspace.sessions).toHaveLength(2);
    const actionSession = required(f.store.getSnapshot().workspace.sessions.find(session => session.id === f.id));
    const receipt = required(actionSession.snapshot.messages[0]);
    expect(receipt.model).toBeUndefined();
    expect(receipt.proposal?.status).toBe("outcome_unknown");
    expect(receipt.text).toBe(proposalPresentation(required(receipt.proposal)).summary);
    expect(f.store.getSnapshot().workspace.sessions.find(session => session.id === newChat)?.snapshot.input).toBe("Draft in the next conversation");
    expect(JSON.stringify(await f.service.load())).not.toContain("Synthetic model label");
  });

});
