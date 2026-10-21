import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonStore } from "@hasi/state";
import { createChatWorkspace, type ChatProposal, type ChatWorkspace } from "../src/lib/chat-sessions";
import { createKnowledgeEvidence, type ResolvedKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import {
  ProtectedWorkspaceConflict,
  ProtectedWorkspaceError,
  ProtectedWorkspaceStore,
} from "../src/lib/server/protected-workspaces";
import { actionReferencesSchema } from "../src/lib/server/action-history-references";
import type { NativeHistoryAccess } from "../src/lib/server/native-history";
import { required } from "./test-utils";

const OWNER = "user:fabian@example.invalid";
const SCOPE = `production:${OWNER}`;
const SECRET = "test-only-action-history-secret";
const AUTHORITY_A = "a".repeat(64);
const AUTHORITY_B = "b".repeat(64);
const AUTHORITY_C = "c".repeat(64);
const CONTEXT_ID = "6dd8e02f-2846-41ac-9e92-7958b02808bf";
const FIXTURE_NOW = Date.parse("2026-10-20T12:00:00.000Z");
const SOURCE_TEXT = "OLD_SOURCE_TEXT_SENTINEL";
const EVIDENCE_TEXT = "OLD_EVIDENCE_TEXT_SENTINEL";
const TARGET_TEXT = "OLD_TARGET_TEXT_SENTINEL";
const ARGUMENT_TEXT = "OLD_ARGUMENT_TEXT_SENTINEL";
const PLACEHOLDER = "Diese frühere Antwort ist nicht mehr verfügbar. Bitte stelle die Frage erneut.";
const ACTION_RECEIPT_UNAVAILABLE = "Der Beleg für diese frühere Aktion ist derzeit nicht verfügbar. Bitte prüfe das Ergebnis im zuständigen Dienst, bevor du die Aktion erneut startest.";

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

function sourceDocument(text = SOURCE_TEXT) {
  return {
    id: "svc-old-action-source",
    citationId: "knowledge:service_it:svc-old-action-source:1",
    title: "Old action source",
    sourceSystem: "service_it" as const,
    language: "en" as const,
    revision: 1,
    synthetic: false,
    text,
    canonicalUrl: "https://it.example.invalid/action-source",
    updatedAt: "2026-10-01T10:00:00.000Z",
    fetchedAt: "2026-10-01T11:00:00.000Z",
    authorityRevision: "d".repeat(64),
    corpusRevision: "e".repeat(64),
    dataClass: "internal" as const,
    images: [],
  };
}

function sourceContext(): ResolvedKnowledgeContext {
  return { contextId: CONTEXT_ID, status: "valid", documents: [sourceDocument()], dataClasses: ["internal"] };
}

function proposal(id: string, status: ChatProposal["status"] = "pending", prefix = "OLD") : ChatProposal {
  return {
    action: "execute_tool",
    id,
    pluginId: "plugin-action-history",
    executionTool: "plugin.perform_action",
    executionTitle: `${prefix} execution title`,
    executionDescription: `${prefix} execution description`,
    toolName: "perform_action",
    title: `${prefix} action title`,
    arguments: { target: prefix === "OLD" ? TARGET_TEXT : `${prefix} target`, evidence: prefix === "OLD" ? ARGUMENT_TEXT : `${prefix} evidence` },
    resourceName: prefix === "OLD" ? TARGET_TEXT : `${prefix} resource`,
    startDate: "2026-10-21T08:00:00Z",
    endDate: "2026-10-21T09:00:00Z",
    status,
    expiresAt: "2099-10-21T08:05:00Z",
    ...(prefix === "OLD" ? {
      preview: {
        instance: "OLD_INSTANCE_SENTINEL",
        account: "OLD_ACCOUNT_SENTINEL",
        effect: "OLD_EFFECT_SENTINEL",
        consequences: ["OLD_PREVIEW_EVIDENCE_SENTINEL"],
        costs: "OLD_COST_SENTINEL",
      },
    } : {}),
  };
}

function actionWorkspace(initialProposal: ChatProposal) {
  const workspace = createChatWorkspace(OWNER);
  const session = required(workspace.sessions[0]);
  const answerId = randomUUID();
  const questionId = randomUUID();
  const sourceCardId = randomUUID();
  const actionMessageId = randomUUID();
  const wire = { id: answerId, role: "assistant" as const, content: EVIDENCE_TEXT };
  const signer = createKnowledgeEvidence(SECRET, SCOPE, () => FIXTURE_NOW);
  const evidence = signer.stamp(session.id, wire, [CONTEXT_ID], AUTHORITY_A);
  const secondWorkspace = createChatWorkspace(OWNER);
  const second = required(secondWorkspace.sessions[0]);

  session.snapshot.history = [
    { role: "user", content: "Find the relevant guidance." },
    { ...wire, evidence },
  ];
  session.snapshot.messages = [
    { id: questionId, role: "user", text: "Find the relevant guidance." },
    { id: answerId, role: "assistant", text: wire.content, evidence },
    { id: sourceCardId, role: "assistant", text: "Old source card", sourceContextId: CONTEXT_ID, sources: [sourceDocument()] },
    { id: actionMessageId, role: "assistant", text: `${TARGET_TEXT} ${ARGUMENT_TEXT}`, proposal: initialProposal },
  ];
  session.snapshot.activeProposal = initialProposal.id;
  workspace.sessions.push({ ...second, title: "Unrelated chat", titleSource: "manual" });

  return { workspace, sessionId: session.id, questionId, answerId, sourceCardId, actionMessageId, actionIndex: 3,
    secondarySessionId: second.id };
}

function makeFixture() {
  const store = new FakeJsonStore();
  let now = FIXTURE_NOW;
  store.useClock(() => now);
  let contexts: ResolvedKnowledgeContext[] = [sourceContext()];
  let proposals = new Map<string, ChatProposal>();
  let authority = AUTHORITY_A;

  const resolve = vi.fn((ids: readonly string[]) => Promise.resolve(ids.map(id =>
    contexts.find(context => context.contextId === id) ?? { contextId: id, status: "unavailable" as const })));
  const resolveNative = vi.fn((candidate: ChatWorkspace, recoveryProposalIds: readonly string[] = []): Promise<NativeHistoryAccess> => {
    const visibleProposalIds = candidate.sessions.flatMap(session => session.snapshot.messages.flatMap(message =>
      message.proposal ? [message.proposal.id] : []));
    const requested = new Set([...visibleProposalIds, ...recoveryProposalIds]);
    return Promise.resolve({
      resources: [],
      bookings: [],
      proposals: new Map([...proposals].filter(([id]) => requested.has(id))),
    });
  });
  const service = new ProtectedWorkspaceStore({
    store,
    ownerId: OWNER,
    scope: SCOPE,
    secret: SECRET,
    resolve,
    resolveNative,
    authority: () => Promise.resolve(authority),
    clock: () => now,
  });

  return {
    store,
    service,
    resolve,
    resolveNative,
    setProposals(values: readonly ChatProposal[]) { proposals = new Map(values.map(value => [value.id, value])); },
    setContexts(values: ResolvedKnowledgeContext[]) { contexts = values; },
    setAuthority(value: string) { authority = value; },
    advance(ms: number) { now += ms; },
  };
}

function storedEnvelope(fixture: ReturnType<typeof makeFixture>): Record<string, unknown> {
  const entry = [...fixture.store.entries.values()][0];
  if (!entry || typeof entry.value !== "object" || entry.value === null || Array.isArray(entry.value)) {
    throw new Error("Expected a stored protected workspace envelope.");
  }
  return entry.value as Record<string, unknown>;
}

function storedReferences(fixture: ReturnType<typeof makeFixture>): Record<string, unknown>[] {
  const refs = storedEnvelope(fixture).actionReferences;
  return Array.isArray(refs) ? refs as Record<string, unknown>[] : [];
}

describe("ProtectedWorkspaceStore action-history recovery", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("accepts bounded unique server references and rejects ambiguous or oversized locations", () => {
    const reference = { sessionId: randomUUID(), messageId: randomUUID(), proposalId: randomUUID(), readOnly: true };
    expect(actionReferencesSchema.safeParse([reference]).success).toBe(true);
    expect(actionReferencesSchema.safeParse([reference, { ...reference, proposalId: randomUUID() }]).success).toBe(false);
    expect(actionReferencesSchema.safeParse(Array.from({ length: 4_001 }, (_, index) => ({ ...reference, messageId: String(index) }))).success).toBe(false);
  });

  it("keeps an opaque signed reference through denial, then rebuilds the same card from fresh authority", async () => {
    const id = randomUUID();
    const initial = proposal(id);
    const current = proposal(id, "pending", "CURRENT");
    const seeded = actionWorkspace(initial);
    const fixture = makeFixture();
    fixture.setProposals([initial]);

    const saved = await fixture.service.save(null, seeded.workspace);
    const savedSession = required(saved.workspace.sessions.find(session => session.id === required(saved.workspace.sessions[0]).id));
    const sessionId = saved.workspace.activeId;
    const actionMessageId = required(savedSession.snapshot.messages[3]).id;
    const originalEnvelopeExpiry = storedEnvelope(fixture).expiresAt;

    expect(savedSession.snapshot.history.some(message => message.role === "assistant" && message.content === EVIDENCE_TEXT)).toBe(true);
    expect(savedSession.snapshot.messages.find(message => message.id === seeded.answerId)?.text).toBe(EVIDENCE_TEXT);
    expect(savedSession.snapshot.messages.find(message => message.id === seeded.sourceCardId)?.sources?.[0]?.text).toBe(SOURCE_TEXT);
    expect(saved.workspace).not.toHaveProperty("actionReferences");
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: false }]);
    expect(savedSession.snapshot.messages[3]?.proposal?.id).toBe(id);

    fixture.setAuthority(AUTHORITY_B);
    fixture.setContexts([]);
    fixture.setProposals([]);
    const denied = await fixture.service.load();
    const deniedSession = required(denied.workspace.sessions.find(session => session.id === sessionId));
    expect(deniedSession.snapshot.messages[3]).toMatchObject({ id: actionMessageId, role: "assistant", text: ACTION_RECEIPT_UNAVAILABLE });
    for (const field of ["proposal", "tool", "model", "confirmed", "serviceConnection", "evidence"]) {
      expect(deniedSession.snapshot.messages[3]).not.toHaveProperty(field);
    }
    expect(deniedSession.snapshot.messages[2]?.text).toContain("nicht mehr verfügbar");
    expect(deniedSession.snapshot.messages[2]).not.toHaveProperty("sources");
    expect(JSON.stringify(deniedSession.snapshot.history)).not.toContain(EVIDENCE_TEXT);
    expect(JSON.stringify(denied.workspace)).not.toContain(SOURCE_TEXT);
    expect(JSON.stringify(denied.workspace)).not.toContain(TARGET_TEXT);
    expect(JSON.stringify(denied.workspace)).not.toContain(ARGUMENT_TEXT);
    expect(JSON.stringify(denied.workspace)).not.toContain("OLD_PREVIEW_EVIDENCE_SENTINEL");
    expect(deniedSession.snapshot.activeProposal).toBeNull();
    expect(storedEnvelope(fixture).expiresAt).toBe(originalEnvelopeExpiry);

    const deniedRevision = denied.revision;
    expect(deniedRevision).not.toBeNull();
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: true }]);
    const privateBytes = JSON.stringify(storedEnvelope(fixture));
    for (const text of [SOURCE_TEXT, EVIDENCE_TEXT, TARGET_TEXT, ARGUMENT_TEXT, "OLD_INSTANCE_SENTINEL", "OLD_PREVIEW_EVIDENCE_SENTINEL"]) {
      expect(privateBytes).not.toContain(text);
    }

    deniedSession.snapshot.input = "New draft while access is denied.";
    deniedSession.title = "Renamed while access is denied";
    deniedSession.titleSource = "manual";
    deniedSession.snapshot.activeProposal = id;
    const deniedSaved = await fixture.service.save(deniedRevision, denied.workspace);
    const autosavedSession = required(deniedSaved.workspace.sessions.find(session => session.id === sessionId));
    expect(autosavedSession.title).toBe("Renamed while access is denied");
    expect(autosavedSession.snapshot.input).toBe("New draft while access is denied.");
    expect(autosavedSession.snapshot.activeProposal).toBeNull();
    expect(deniedSaved.workspace).not.toHaveProperty("actionReferences");
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: true }]);

    fixture.setAuthority(AUTHORITY_C);
    fixture.setProposals([current]);
    const recovered = await fixture.service.load();
    const recoveredSession = required(recovered.workspace.sessions.find(session => session.id === sessionId));
    const card = required(recoveredSession.snapshot.messages[3]);
    expect(recoveredSession.id).toBe(sessionId);
    expect(card.id).toBe(actionMessageId);
    expect(card.proposal).toEqual({ ...current, status: "invalidated" });
    expect(card.text).not.toContain(TARGET_TEXT);
    expect(recoveredSession.snapshot.activeProposal).toBeNull();
    expect(recoveredSession.title).toBe("Renamed while access is denied");
    expect(recoveredSession.snapshot.input).toBe("New draft while access is denied.");
    expect(fixture.resolveNative.mock.calls.some(([, ids]) => ids?.includes(id))).toBe(true);
    expect(current.status).toBe("pending");

    const stable = await fixture.service.load();
    expect(stable.revision).toBe(recovered.revision);
    expect(stable.workspace).toEqual(recovered.workspace);
    const resaved = await fixture.service.save(stable.revision, stable.workspace);
    const loadedAgain = await fixture.service.load();
    expect(loadedAgain.workspace).toEqual(resaved.workspace);
    expect(required(loadedAgain.workspace.sessions.find(session => session.id === sessionId)).snapshot.messages[3]?.proposal)
      .toEqual({ ...current, status: "invalidated" });
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: true }]);
  });

  it.each([
    ["pending", "invalidated"],
    ["confirmed", "confirmed"],
    ["outcome_unknown", "outcome_unknown"],
    ["executing", "executing"],
  ] as const)("recovers %s as %s without activating or executing it", async (currentStatus, expectedStatus) => {
    const id = randomUUID();
    const initial = proposal(id, "pending");
    const seeded = actionWorkspace(initial);
    const fixture = makeFixture();
    fixture.setProposals([initial]);
    const first = await fixture.service.save(null, seeded.workspace);
    const sessionId = first.workspace.activeId;
    const actionMessageId = required(required(first.workspace.sessions.find(session => session.id === sessionId)).snapshot.messages[3]).id;

    fixture.setAuthority(AUTHORITY_B);
    fixture.setContexts([]);
    fixture.setProposals([]);
    const denied = await fixture.service.load();
    const edit = required(denied.workspace.sessions.find(session => session.id === sessionId));
    const unavailableReceipt = required(edit.snapshot.messages.find(message => message.id === actionMessageId));
    expect(unavailableReceipt).toMatchObject({ id: actionMessageId, role: "assistant", text: ACTION_RECEIPT_UNAVAILABLE });
    for (const field of ["proposal", "tool", "model", "confirmed", "serviceConnection", "evidence"]) {
      expect(unavailableReceipt).not.toHaveProperty(field);
    }
    expect(unavailableReceipt.text).not.toContain(TARGET_TEXT);
    edit.snapshot.activeProposal = id;
    const savedWhileDenied = await fixture.service.save(denied.revision, denied.workspace);
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: true }]);

    fixture.setAuthority(AUTHORITY_C);
    const renewed = proposal(id, currentStatus, "CURRENT");
    fixture.setProposals([renewed]);
    const loaded = await fixture.service.load();
    const session = required(loaded.workspace.sessions.find(item => item.id === sessionId));
    const card = required(session.snapshot.messages.find(message => message.id === actionMessageId));

    expect(card.proposal?.status).toBe(expectedStatus);
    expect(session.snapshot.activeProposal).toBeNull();
    expect(storedReferences(fixture)).toEqual([{ sessionId, messageId: actionMessageId, proposalId: id, readOnly: true }]);
    expect(fixture.resolveNative.mock.calls.some(([, ids]) => ids?.includes(id))).toBe(true);
    expect(required(savedWhileDenied.workspace.sessions.find(item => item.id === sessionId)).snapshot.activeProposal).toBeNull();
    expect(renewed.status).toBe(currentStatus);
  });

  it.each(["message deletion", "chat deletion", "role change", "message ID change", "session move", "duplicate message ID"] as const)(
    "drops recovery authority after %s",
    async change => {
      const id = randomUUID();
      const initial = proposal(id);
      const seeded = actionWorkspace(initial);
      const fixture = makeFixture();
      fixture.setProposals([initial]);
      const first = await fixture.service.save(null, seeded.workspace);
      const sessionId = first.workspace.activeId;
      const actionMessageId = seeded.actionMessageId;

      fixture.setAuthority(AUTHORITY_B);
      fixture.setContexts([]);
      fixture.setProposals([]);
      const denied = await fixture.service.load();
      const workspace = denied.workspace;
      const session = required(workspace.sessions.find(item => item.id === sessionId));
      const index = session.snapshot.messages.findIndex(message => message.id === actionMessageId);
      if (index < 0) throw new Error("Expected the unavailable action placeholder.");

      if (change === "message deletion") {
        session.snapshot.messages.splice(index, 1);
      } else if (change === "chat deletion") {
        workspace.sessions = workspace.sessions.filter(item => item.id !== sessionId);
        workspace.activeId = required(workspace.sessions[0]).id;
      } else if (change === "role change") {
        const message = required(session.snapshot.messages[index]);
        session.snapshot.messages[index] = { ...message, role: "user" };
      } else if (change === "message ID change") {
        session.snapshot.messages[index] = { ...required(session.snapshot.messages[index]), id: randomUUID() };
      } else if (change === "session move") {
        const [message] = session.snapshot.messages.splice(index, 1);
        if (!message) throw new Error("Expected the unavailable action placeholder.");
        required(workspace.sessions.find(item => item.id === seeded.secondarySessionId)).snapshot.messages.push(message);
      } else {
        session.snapshot.messages.push({ ...required(session.snapshot.messages[index]) });
      }

      const saved = await fixture.service.save(denied.revision, workspace);
      expect(saved.workspace).not.toHaveProperty("actionReferences");
      expect(storedReferences(fixture).some(reference => reference.proposalId === id)).toBe(false);

      fixture.setAuthority(AUTHORITY_C);
      fixture.setProposals([proposal(id, "pending", "CURRENT")]);
      const reauthorized = await fixture.service.load();
      expect(JSON.stringify(reauthorized.workspace)).not.toContain("CURRENT target");
      expect(fixture.resolveNative.mock.calls.at(-1)?.[1] ?? []).not.toContain(id);
      expect(reauthorized.workspace.sessions.flatMap(item => item.snapshot.messages).some(message => message.proposal?.id === id)).toBe(false);
    },
  );

  it.each(["denied", "foreign ID"] as const)("does not mint a recovery reference for a first-save %s proposal", async condition => {
    const id = randomUUID();
    const initial = proposal(id);
    const fixture = makeFixture();
    fixture.setProposals(condition === "foreign ID" ? [proposal(randomUUID(), "pending", "FOREIGN")] : []);

    const saved = await fixture.service.save(null, actionWorkspace(initial).workspace);
    expect(saved.workspace.sessions.flatMap(session => session.snapshot.messages).some(message => message.proposal?.id === id)).toBe(false);
    expect(storedReferences(fixture)).not.toContainEqual(expect.objectContaining({ proposalId: id }));

    fixture.setProposals([proposal(id, "pending", "CURRENT")]);
    const later = await fixture.service.load();
    expect(later.workspace.sessions.flatMap(session => session.snapshot.messages).some(message => message.proposal?.id === id)).toBe(false);
    expect(fixture.resolveNative.mock.calls.at(-1)?.[1] ?? []).not.toContain(id);
  });

  it("does not accept a client-only action-receipt notice as a recovery reference", async () => {
    const id = randomUUID();
    const seeded = actionWorkspace(proposal(id));
    const session = required(seeded.workspace.sessions.find(item => item.id === seeded.sessionId));
    session.snapshot.messages[seeded.actionIndex] = {
      id: seeded.actionMessageId,
      role: "assistant",
      text: ACTION_RECEIPT_UNAVAILABLE,
    };
    const fixture = makeFixture();

    const saved = await fixture.service.save(null, seeded.workspace);
    const savedSession = required(saved.workspace.sessions.find(item => item.id === seeded.sessionId));
    const message = required(savedSession.snapshot.messages.find(item => item.id === seeded.actionMessageId));
    expect(message).toMatchObject({ id: seeded.actionMessageId, role: "assistant", text: PLACEHOLDER });
    expect(storedReferences(fixture)).toEqual([]);

    fixture.setProposals([proposal(id, "confirmed", "CURRENT")]);
    const reloaded = await fixture.service.load();
    const reloadedSession = required(reloaded.workspace.sessions.find(item => item.id === seeded.sessionId));
    const reloadedMessage = required(reloadedSession.snapshot.messages.find(item => item.id === seeded.actionMessageId));
    expect(reloadedMessage).toMatchObject({ id: seeded.actionMessageId, role: "assistant", text: PLACEHOLDER });
    expect(reloadedMessage).not.toHaveProperty("proposal");
    expect(storedReferences(fixture)).toEqual([]);
    expect(fixture.resolveNative.mock.calls.at(-1)?.[1] ?? []).not.toContain(id);
  });

  it("rejects a client-forged sidecar and an unsigned sidecar change", async () => {
    const id = randomUUID();
    const initial = proposal(id);
    const seeded = actionWorkspace(initial);
    const fixture = makeFixture();
    fixture.setProposals([initial]);
    const forged = {
      ...seeded.workspace,
      actionReferences: [{ sessionId: seeded.sessionId, messageId: seeded.actionMessageId, proposalId: id, readOnly: false }],
    };

    await expect(fixture.service.save(null, forged)).rejects.toBeInstanceOf(ProtectedWorkspaceError);
    expect(fixture.store.entries.size).toBe(0);

    await fixture.service.save(null, seeded.workspace);
    fixture.store.replaceValue(value => {
      const envelope = value as Record<string, unknown>;
      const refs = envelope.actionReferences as Record<string, unknown>[];
      return { ...envelope, actionReferences: refs.map(reference => ({ ...reference, readOnly: !reference.readOnly })) };
    });
    await expect(fixture.service.load()).rejects.toBeInstanceOf(ProtectedWorkspaceError);
  });

  it("does not let a stale compare-and-set remove or replace the current recovery reference", async () => {
    const id = randomUUID();
    const initial = proposal(id);
    const seeded = actionWorkspace(initial);
    const fixture = makeFixture();
    fixture.setProposals([initial]);
    const first = await fixture.service.save(null, seeded.workspace);

    fixture.setAuthority(AUTHORITY_B);
    fixture.setContexts([]);
    fixture.setProposals([]);
    const denied = await fixture.service.load();
    const currentReference = storedReferences(fixture);
    const staleWorkspace = structuredClone(first.workspace);
    const oldSession = required(staleWorkspace.sessions.find(session => session.id === seeded.sessionId));
    oldSession.snapshot.messages = oldSession.snapshot.messages.filter(message => message.id !== seeded.actionMessageId);

    await expect(fixture.service.save(first.revision, staleWorkspace)).rejects.toBeInstanceOf(ProtectedWorkspaceConflict);
    expect(storedReferences(fixture)).toEqual(currentReference);
    expect(storedReferences(fixture)).toEqual([{ sessionId: seeded.sessionId, messageId: seeded.actionMessageId, proposalId: id, readOnly: true }]);
    expect(denied.revision).not.toBe(first.revision);
  });
});
