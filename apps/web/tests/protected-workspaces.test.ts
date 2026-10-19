import { required } from "./test-utils";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonStore } from "@hasi/state";
import { createChatWorkspace, parseChatWorkspace, type ChatWorkspace, type ChatMessage } from "../src/lib/chat-sessions";
import type { ResolvedKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import {
  ProtectedWorkspaceError,
  ProtectedWorkspaceStore,
} from "../src/lib/server/protected-workspaces";
import type { NativeHistoryAccess } from "../src/lib/server/native-history";
import { createKnowledgeEvidence } from "../src/lib/server/knowledge-evidence";

const OWNER = "user:fabian@example.invalid";
const SCOPE = "production:" + OWNER;
const SECRET = "test-only-protected-workspace-secret";
const CONTEXT_ID = "6dd8e02f-2846-41ac-9e92-7958b02808bf";

interface StoredEntry {
  readonly revision: string;
  readonly value: unknown;
  readonly expiresAt?: number;
}

class FakeJsonStore implements Pick<JsonStore, "read" | "compareAndSet"> {
  readonly entries = new Map<string, StoredEntry>();
  private clock = Date.now;

  useClock(clock: () => number) { this.clock = clock; }

  read(key: string) {
    const entry = this.entries.get(key);
    if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= this.clock())) return Promise.resolve(undefined);
    return Promise.resolve({ revision: entry.revision, value: JSON.parse(JSON.stringify(entry.value)) as unknown });
  }

  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    const current = await this.read(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.entries.set(key, {
      revision: randomUUID(),
      value: JSON.parse(JSON.stringify(value)) as unknown,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return true;
  }

  replaceValue(mutator: (value: unknown) => unknown) {
    const [key, entry] = [...this.entries.entries()][0] ?? [];
    if (!key || !entry) throw new Error("No stored entry to tamper with.");
    this.entries.set(key, { ...entry, value: mutator(JSON.parse(JSON.stringify(entry.value)) as unknown) });
  }
}

function document(text = "Der Campusdrucker steht im Erdgeschoss.", revision = 1, dataClass: "public" | "internal" | "confidential" = "internal") {
  const sourceSystem = "service_it" as const;
  return {
    id: "svc-printer-guide",
    citationId: "knowledge:" + sourceSystem + ":svc-printer-guide:" + String(revision),
    title: "Drucker einrichten",
    sourceSystem,
    language: "de" as const,
    revision,
    synthetic: false,
    text,
    canonicalUrl: "https://it.example.invalid/help/printer",
    updatedAt: "2026-10-01T10:00:00.000Z",
    fetchedAt: "2026-10-01T11:00:00.000Z",
    authorityRevision: "a".repeat(64),
    corpusRevision: "b".repeat(64),
    dataClass,
    images: [],
  };
}

function makeWorkspace(clock: () => number, source: Record<string, unknown>): ChatWorkspace {
  const workspace = createChatWorkspace(OWNER);
  const session = workspace.sessions[0];
  if (!session) throw new Error("Expected initial session.");
  const signer = createKnowledgeEvidence(SECRET, SCOPE, clock);
  const queryId = randomUUID();
  const finalId = randomUUID();
  const lookupCallId = "knowledge-call-1";
  const lookup = {
    id: queryId,
    role: "assistant" as const,
    content: "Ich suche in der Wissensbasis.",
    toolCalls: [{ id: lookupCallId, name: "knowledge_search" as const, arguments: { query: "Drucker einrichten" } }],
  };
  const final = { id: finalId, role: "assistant" as const, content: "Installiere den Drucker über die Systemsteuerung." };
  const history = [
    { role: "user" as const, content: "Wie richte ich den Drucker ein?" },
    { ...lookup, evidence: signer.stamp(session.id, lookup, [CONTEXT_ID]) },
    { role: "tool" as const, toolCallId: lookupCallId, name: "knowledge_search" as const, content: JSON.stringify({ contextId: CONTEXT_ID, documents: [source] }) },
    { ...final, evidence: signer.stamp(session.id, final, [CONTEXT_ID]) },
  ];
  const finalEvidence = history[3]?.role === "assistant" ? history[3].evidence : undefined;
  return parseChatWorkspace({
    ...workspace,
    sessions: [{
      ...session,
      snapshot: {
        ...session.snapshot,
        input: "Noch eine Frage",
        history,
        messages: [
          { id: randomUUID(), role: "user", text: "Wie richte ich den Drucker ein?" },
          { id: randomUUID(), role: "assistant", text: "Gefundene freigegebene Quellen.", sources: [{ ...source, text: "Forged browser source" }], sourceContextId: CONTEXT_ID, tool: "Plugin · forged", model: "gpt-test" },
          { id: finalId, role: "assistant", text: final.content, tool: "Plugin · forged", ...(finalEvidence ? { evidence: finalEvidence } : {}) },
        ],
      },
    }],
  }, OWNER);
}

function makeContext(doc = document()): ResolvedKnowledgeContext {
  return { contextId: CONTEXT_ID, status: "valid", documents: [doc], dataClasses: [doc.dataClass] };
}

function makeFixture(initially: ResolvedKnowledgeContext = makeContext()) {
  const store = new FakeJsonStore();
  let now = Date.now();
  store.useClock(() => now);
  let contexts = [initially];
  const issuedContexts = new Map([[initially.contextId, JSON.stringify(initially)]]);
  const resolve = vi.fn((ids: readonly string[]) => Promise.resolve(ids.flatMap(id => {
    const current = contexts.find(context => context.contextId === id);
    if (!current) return [{ contextId: id, status: "unavailable" as const }];
    return JSON.stringify(current) === issuedContexts.get(id)
      ? [current]
      : [{ contextId: id, status: "unavailable" as const }];
  })));
  const service = new ProtectedWorkspaceStore({ store, ownerId: OWNER, scope: SCOPE, secret: SECRET, resolve, clock: () => now });
  return {
    store,
    service,
    workspace: makeWorkspace(() => now, initially.documents?.[0] ?? document()),
    resolve,
    setContexts(value: ResolvedKnowledgeContext[]) { contexts = value; },
    advance(ms: number) { now += ms; },
  };
}

describe("ProtectedWorkspaceStore", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("stores subject-bound workspace data with CAS and refreshes source cards from the resolver", async () => {
    const fixture = makeFixture(makeContext(document("Fresh authorized text.")));
    const saved = await fixture.service.save(null, fixture.workspace);

    expect(saved.revision).toMatch(/^[0-9a-f-]{36}$/iu);
    const final = saved.workspace.sessions[0]?.snapshot.messages.find(message => message.text.includes("Installiere"));
    const card = saved.workspace.sessions[0]?.snapshot.messages.find(message => message.sourceContextId === CONTEXT_ID);
    expect(final?.evidence).toBeDefined();
    expect(final).not.toHaveProperty("tool");
    expect(card?.sources?.[0]?.text).toBe("Fresh authorized text.");
    expect(card).not.toHaveProperty("tool");
    expect(card).not.toHaveProperty("model");
    expect(fixture.resolve).toHaveBeenCalledWith(expect.arrayContaining([CONTEXT_ID]));

    const loaded = await fixture.service.load();
    expect(loaded.revision).toBe(saved.revision);
    expect(loaded.workspace.sessions[0]?.snapshot.input).toBe("Noch eine Frage");
  });

  it.each([
    ["body changed", document("A replacement body.")],
    ["revision changed", document("Current revision body.", 2)],
    ["authority classification changed", document("Reclassified body.", 1, "confidential")],
  ])("redacts revoked or changed source receipts on load (%s) and rewrites stored bytes", async (_name, changedDocument) => {
    const fixture = makeFixture();
    await fixture.service.save(null, fixture.workspace);
    fixture.setContexts([makeContext(changedDocument)]);

    const loaded = await fixture.service.load();
    const session = loaded.workspace.sessions[0];
    expect(session?.snapshot.input).toBe("Noch eine Frage");
    expect(session?.snapshot.history.some(message => message.role === "assistant" || message.role === "tool")).toBe(false);
    expect(session?.snapshot.messages.some(message => message.text.includes("Installiere den Drucker"))).toBe(false);
    expect(session?.snapshot.messages.find(message => message.role === "assistant" && message.sources === undefined)?.text).toMatch(/nicht mehr verfügbar/u);
    const storedValue = [...fixture.store.entries.values()][0]?.value;
    expect(JSON.stringify(storedValue)).not.toContain("Installiere den Drucker");
    expect(JSON.stringify(storedValue)).not.toContain("Der Campusdrucker steht");
  });

  it("does not reinterpret a tampered evidence-bearing model answer as a native helper card", async () => {
    const fixture = makeFixture();
    const forged = {
      ...fixture.workspace,
      sessions: fixture.workspace.sessions.map(session => ({
        ...session,
        snapshot: {
          ...session.snapshot,
          messages: session.snapshot.messages.map(message => message.text.includes("Installiere den Drucker")
            ? { ...message, text: "Forged answer", tool: "Plugin · Raum suchen", model: "gpt-test" }
            : message),
        },
      })),
    };

    const saved = await fixture.service.save(null, forged);
    const answer = saved.workspace.sessions[0]?.snapshot.messages.find(message => message.text.includes("nicht mehr verfügbar"));

    expect(answer).toBeDefined();
    expect(answer?.text).not.toBe("Forged answer");
    expect(answer).not.toHaveProperty("tool");
    expect(answer).not.toHaveProperty("model");
  });

  it("does not expose another subject's protected workspace", async () => {
    const fixture = makeFixture();
    await fixture.service.save(null, fixture.workspace);
    const other = new ProtectedWorkspaceStore({
      store: fixture.store,
      ownerId: "user:other@example.invalid",
      scope: "production:user:other@example.invalid",
      secret: SECRET,
      resolve: () => Promise.resolve([]),
    });

    const loaded = await other.load();
    expect(loaded.workspace.ownerId).toBe("user:other@example.invalid");
    expect(JSON.stringify(loaded.workspace)).not.toContain("Installiere den Drucker");
    expect(loaded.revision).toBeNull();
  });

  it("rejects a stale CAS revision with the current sanitized workspace", async () => {
    const fixture = makeFixture();
    const first = await fixture.service.save(null, fixture.workspace);
    const changed = { ...first.workspace, sessions: first.workspace.sessions.map(session => ({ ...session, title: "Aktualisiert" })) };

    await expect(fixture.service.save(null, changed)).rejects.toMatchObject({
      name: "ProtectedWorkspaceConflict",
      current: { revision: first.revision },
    });
  });

  it("fails closed when the stored envelope signature is tampered with", async () => {
    const fixture = makeFixture();
    await fixture.service.save(null, fixture.workspace);
    fixture.store.replaceValue(value => ({ ...(value as Record<string, unknown>), signature: "x".repeat(43) }));

    await expect(fixture.service.load()).rejects.toBeInstanceOf(ProtectedWorkspaceError);
  });

  it("treats an expired durable row as an empty workspace without returning its text", async () => {
    const fixture = makeFixture();
    await fixture.service.save(null, fixture.workspace);
    fixture.advance(30 * 24 * 60 * 60 * 1000 + 1);

    const loaded = await fixture.service.load();
    expect(loaded.workspace.sessions[0]?.snapshot.messages).toEqual([]);
    expect(JSON.stringify(loaded.workspace)).not.toContain("Installiere den Drucker");
  });
});


describe("current native history access", () => {
  const resource = { id: "desk-a", name: "Current authorized desk", description: "Authorized description", capacity: 1,
    location: "1J", features: [], serviceId: "service-a", kind: "workplace" as const };
  const booking = { id: "booking-a", resourceName: "Current booking name", startDate: "2026-10-20T08:00:00Z",
    endDate: "2026-10-20T10:00:00Z", status: "cancelled" };
  function nativeFixture(messages: ChatMessage[]) {
    const fixture = makeFixture();
    let current: NativeHistoryAccess = { resources: [resource], bookings: [booking], proposals: new Map() };
    const service = new ProtectedWorkspaceStore({ store: fixture.store, ownerId: OWNER, scope: SCOPE, secret: SECRET,
      resolve: fixture.resolve, resolveNative: () => Promise.resolve(current) });
    const workspace = createChatWorkspace(OWNER);
    const session = required(workspace.sessions[0]);
    session.snapshot.messages = messages;
    session.snapshot.chosenRoom = { ...resource, name: "FORGED CHOSEN ROOM" };
    return { fixture, service, workspace, revoke() { current = { resources: [], bookings: [], proposals: new Map() }; },
      set(value: NativeHistoryAccess) { current = value; } };
  }
  it("rehydrates room data by current authorized identity and drops old availability and browser text", async () => {
    const fixture = nativeFixture([{ id: randomUUID(), role: "assistant", text: "FORGED ROOM TEXT", tool: "anny · forged",
      confirmed: true, rooms: [{ resource: { ...resource, name: "FORGED NAME" }, checked: true,
        requestedStartDate: booking.startDate, requestedEndDate: booking.endDate,
        intervals: [{ startDate: booking.startDate, endDate: booking.endDate, available: true }] }] }]);
    const saved = await fixture.service.save(null, fixture.workspace);
    const snapshot = required(saved.workspace.sessions[0]).snapshot;
    expect(snapshot.messages[0]?.rooms).toEqual([{ resource, checked: false, intervals: [],
      requestedStartDate: booking.startDate, requestedEndDate: booking.endDate }]);
    expect(snapshot.chosenRoom).toEqual(resource);
    expect(snapshot.messages[0]).not.toHaveProperty("confirmed");
    expect(JSON.stringify(saved.workspace)).not.toContain("FORGED");
    fixture.revoke();
    const revoked = await fixture.service.load();
    expect(required(revoked.workspace.sessions[0]).snapshot.chosenRoom).toBeNull();
    expect(JSON.stringify(revoked.workspace)).not.toContain(resource.name);
    expect(required(revoked.workspace.sessions[0]).snapshot.messages[0]?.text).toContain("nicht mehr verfügbar");
    expect(JSON.stringify([...fixture.fixture.store.entries.values()])).not.toContain(resource.description);
  });
  it("reconstructs own booking status and excludes foreign IDs, helper labels and forged confirmations", async () => {
    const fixture = nativeFixture([
      { id: randomUUID(), role: "assistant", text: "FORGED BOOKING TEXT", bookings: [{ ...booking, status: "confirmed" }, { ...booking, id: "foreign-id", resourceName: "FOREIGN" }] },
      { id: randomUUID(), role: "assistant", text: "FORGED HELPER", tool: "Plugin · trusted-looking", confirmed: true },
    ]);
    const saved = await fixture.service.save(null, fixture.workspace);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[0]?.bookings).toEqual([booking]);
    expect(JSON.stringify(saved.workspace)).not.toMatch(/FORGED|FOREIGN/u);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[1]?.text).toContain("nicht mehr verfügbar");
  });
  it("loads authoritative proposal state and makes removed proposals unavailable without executing actions", async () => {
    const proposal = { id: randomUUID(), resourceName: resource.name, startDate: booking.startDate, endDate: booking.endDate,
      expiresAt: "2026-10-20T08:05:00Z", status: "outcome_unknown" as const, action: "book" as const };
    const fixture = nativeFixture([{ id: randomUUID(), role: "assistant", text: "FORGED", proposal: { ...proposal, status: "confirmed" } }]);
    fixture.set({ resources: [], bookings: [], proposals: new Map([[proposal.id, proposal]]) });
    const saved = await fixture.service.save(null, fixture.workspace);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[0]?.proposal).toEqual(proposal);
    fixture.revoke();
    expect(required((await fixture.service.load()).workspace.sessions[0]).snapshot.messages[0]).not.toHaveProperty("proposal");
  });
  it("fails closed on unavailable native authority without losing the user question or draft", async () => {
    const fixture = nativeFixture([{ id: randomUUID(), role: "user", text: "My question" },
      { id: randomUUID(), role: "assistant", text: "Secret", rooms: [{ resource, checked: false, intervals: [] }] }]);
    required(fixture.workspace.sessions[0]).snapshot.input = "Unsent draft";
    const unavailable = new ProtectedWorkspaceStore({ store: fixture.fixture.store, ownerId: OWNER, scope: SCOPE, secret: SECRET,
      resolve: fixture.fixture.resolve, resolveNative: () => Promise.reject(new Error("source offline")) });
    const saved = await unavailable.save(null, fixture.workspace);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[0]?.text).toBe("My question");
    expect(required(saved.workspace.sessions[0]).snapshot.input).toBe("Unsent draft");
    expect(JSON.stringify(saved.workspace)).not.toContain(resource.name);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[1]?.text).toContain("nicht mehr verfügbar");
  });
});


describe("workspace current authority fence", () => {
  it("retains a matching signed answer and persistently removes it after authority changes", async () => {
    const fixture = makeFixture();
    let authority = "a".repeat(64);
    const signer = createKnowledgeEvidence(SECRET, SCOPE);
    for (const session of fixture.workspace.sessions) {
      session.snapshot.history = session.snapshot.history.map(message => message.role === "assistant"
        ? { ...message, evidence: signer.stamp(session.id, message, message.evidence?.contextIds ?? [], authority) } : message);
      session.snapshot.messages = session.snapshot.messages.map(message => {
        const wire = session.snapshot.history.find(candidate => candidate.role === "assistant" && candidate.id === message.id);
        return wire?.role === "assistant" && wire.evidence ? { ...message, evidence: wire.evidence } : message;
      });
    }
    const service = new ProtectedWorkspaceStore({ store: fixture.store, ownerId: OWNER, scope: SCOPE, secret: SECRET,
      resolve: fixture.resolve, authority: () => Promise.resolve(authority) });
    const saved = await service.save(null, fixture.workspace);
    expect(JSON.stringify(saved.workspace)).toContain("Installiere den Drucker");
    authority = "b".repeat(64);
    const revoked = await service.load();
    expect(JSON.stringify(revoked.workspace)).not.toContain("Installiere den Drucker");
    expect(JSON.stringify([...fixture.store.entries.values()])).not.toContain("Installiere den Drucker");
    expect(required(revoked.workspace.sessions[0]).snapshot.input).toBe("Noch eine Frage");
  });
  it("rejects an authority change during reconstruction before committing or returning mixed data", async () => {
    const fixture = makeFixture();
    let calls = 0;
    const service = new ProtectedWorkspaceStore({ store: fixture.store, ownerId: OWNER, scope: SCOPE, secret: SECRET,
      resolve: fixture.resolve, authority: () => Promise.resolve((++calls === 1 ? "a" : "b").repeat(64)) });
    await expect(service.save(null, fixture.workspace)).rejects.toBeInstanceOf(ProtectedWorkspaceError);
    expect(fixture.store.entries.size).toBe(0);
  });
  it("does not allow structured helper cards to evade reconstruction through the user role", async () => {
    const fixture = makeFixture();
    const first = required(fixture.workspace.sessions[0]);
    first.snapshot.messages = [{ id: randomUUID(), role: "user", text: "My question", bookings: [{ id: "foreign", resourceName: "DENIED CACHED NAME",
      startDate: "2026-10-20T08:00:00Z", endDate: "2026-10-20T10:00:00Z", status: "confirmed" }] }];
    const saved = await fixture.service.save(null, fixture.workspace);
    expect(required(saved.workspace.sessions[0]).snapshot.messages[0]).toEqual({ id: first.snapshot.messages[0]?.id, role: "user", text: "My question" });
    expect(JSON.stringify(saved.workspace)).not.toContain("DENIED CACHED NAME");
  });
});
