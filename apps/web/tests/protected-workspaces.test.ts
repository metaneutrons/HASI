import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonStore } from "@hasi/state";
import { createChatWorkspace, parseChatWorkspace, type ChatWorkspace } from "../src/lib/chat-sessions";
import type { ResolvedKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import {
  ProtectedWorkspaceError,
  ProtectedWorkspaceStore,
} from "../src/lib/server/protected-workspaces";
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
