import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PostgresJsonStore, type JsonStore } from "@hasi/state";
import { createChatWorkspace, parseChatWorkspace, type ChatWorkspace } from "../src/lib/chat-sessions";
import type { ResolvedKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import {
  ProtectedWorkspaceConflict,
  ProtectedWorkspaceStore,
} from "../src/lib/server/protected-workspaces";
import { createKnowledgeEvidence } from "../src/lib/server/knowledge-evidence";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const OWNER = "user:fabian@example.invalid";
const SCOPE = "production:" + OWNER;
const SECRET = "test-only-protected-workspace-secret";
const CONTEXT_ID = "6dd8e02f-2846-41ac-9e92-7958b02808bf";

class TrackedJsonStore implements Pick<JsonStore, "read" | "compareAndSet"> {
  readonly keys = new Set<string>();

  constructor(private readonly delegate: JsonStore) {}

  read(key: string) {
    this.keys.add(key);
    return this.delegate.read(key);
  }

  compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    this.keys.add(key);
    return this.delegate.compareAndSet(key, expectedRevision, value, expiresAt);
  }
}

function document(text = "Der Campusdrucker steht im Erdgeschoss.") {
  const sourceSystem = "service_it" as const;
  return {
    id: "svc-printer-guide",
    citationId: "knowledge:" + sourceSystem + ":svc-printer-guide:1",
    title: "Drucker einrichten",
    sourceSystem,
    language: "de" as const,
    revision: 1,
    synthetic: false,
    text,
    canonicalUrl: "https://it.example.invalid/help/printer",
    updatedAt: "2026-10-01T10:00:00.000Z",
    fetchedAt: "2026-10-01T11:00:00.000Z",
    authorityRevision: "a".repeat(64),
    corpusRevision: "b".repeat(64),
    dataClass: "internal" as const,
    images: [],
  };
}

function makeWorkspace(source: Record<string, unknown>): ChatWorkspace {
  const workspace = createChatWorkspace(OWNER);
  const session = workspace.sessions[0];
  if (!session) throw new Error("Expected initial session.");
  const signer = createKnowledgeEvidence(SECRET, SCOPE);
  const lookupId = randomUUID();
  const answerId = randomUUID();
  const lookupCallId = "knowledge-call-1";
  const lookup = {
    id: lookupId,
    role: "assistant" as const,
    content: "Ich suche in der Wissensbasis.",
    toolCalls: [{ id: lookupCallId, name: "knowledge_search" as const, arguments: { query: "Drucker einrichten" } }],
  };
  const answer = { id: answerId, role: "assistant" as const, content: "Installiere den Drucker über die Systemsteuerung." };
  const history = [
    { role: "user" as const, content: "Wie richte ich den Drucker ein?" },
    { ...lookup, evidence: signer.stamp(session.id, lookup, [CONTEXT_ID]) },
    { role: "tool" as const, toolCallId: lookupCallId, name: "knowledge_search" as const, content: JSON.stringify({ contextId: CONTEXT_ID, documents: [source] }) },
    { ...answer, evidence: signer.stamp(session.id, answer, [CONTEXT_ID]) },
  ];
  const answerEvidence = history[3]?.role === "assistant" ? history[3].evidence : undefined;

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
          { id: randomUUID(), role: "assistant", text: "Gefundene freigegebene Quellen.", sources: [{ ...source, text: "Forged browser source" }], sourceContextId: CONTEXT_ID },
          { id: answerId, role: "assistant", text: answer.content, ...(answerEvidence ? { evidence: answerEvidence } : {}) },
        ],
      },
    }],
  }, OWNER);
}

function makeContext(doc: ReturnType<typeof document>): ResolvedKnowledgeContext {
  return { contextId: CONTEXT_ID, status: "valid", documents: [doc], dataClasses: [doc.dataClass] };
}

describe.skipIf(!databaseUrl)("ProtectedWorkspaceStore with PostgreSQL", () => {
  it("shares durable workspaces, enforces simultaneous CAS, and persists source revocation", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for this integration test.");

    const namespace = `protected-workspace-test:${randomUUID()}`;
    const firstDatabase = new PostgresJsonStore(namespace, { poolConfig: { connectionString: databaseUrl, max: 2 } });
    const secondDatabase = new PostgresJsonStore(namespace, { poolConfig: { connectionString: databaseUrl, max: 2 } });
    const firstKeys = new TrackedJsonStore(firstDatabase);
    const secondKeys = new TrackedJsonStore(secondDatabase);
    let firstInitialized = false;

    try {
      await Promise.all([firstDatabase.initialize(), secondDatabase.initialize()]);
      firstInitialized = true;

      let grantActive = true;
      const issuedContext = makeContext(document("Current authorized printer instructions."));
      const resolve = (contextIds: readonly string[]) => Promise.resolve(contextIds.map(contextId => {
        if (contextId === CONTEXT_ID && grantActive) return issuedContext;
        return { contextId, status: "unavailable" as const };
      }));
      const first = new ProtectedWorkspaceStore({ store: firstKeys, ownerId: OWNER, scope: SCOPE, secret: SECRET, resolve });
      const second = new ProtectedWorkspaceStore({ store: secondKeys, ownerId: OWNER, scope: SCOPE, secret: SECRET, resolve });
      const workspace = makeWorkspace(issuedContext.documents?.[0] ?? document());

      const initial = await first.save(null, workspace);
      const shared = await second.load();
      expect(shared.revision).toBe(initial.revision);
      expect(JSON.stringify(shared.workspace)).toContain("Installiere den Drucker über die Systemsteuerung.");
      expect(JSON.stringify(shared.workspace)).toContain("Current authorized printer instructions.");
      expect(JSON.stringify(shared.workspace)).not.toContain("Forged browser source");

      const candidate = (title: string) => ({
        ...shared.workspace,
        sessions: shared.workspace.sessions.map(session => ({ ...session, title })),
      });
      const writes = await Promise.allSettled([
        first.save(initial.revision, candidate("First writer")),
        second.save(initial.revision, candidate("Second writer")),
      ]);
      const commits = writes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.save>>> => result.status === "fulfilled");
      const conflicts = writes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(commits).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.reason).toBeInstanceOf(ProtectedWorkspaceConflict);
      if (!commits[0] || !conflicts[0]) throw new Error("Expected one committed write and one conflict.");
      expect((conflicts[0].reason as ProtectedWorkspaceConflict).current.revision).toBe(commits[0].value.revision);

      grantActive = false;
      const revoked = await second.load();
      const revokedSession = revoked.workspace.sessions[0];
      expect(revokedSession?.snapshot.history.some(message => message.role === "assistant" || message.role === "tool")).toBe(false);
      expect(JSON.stringify(revoked.workspace)).not.toContain("Installiere den Drucker über die Systemsteuerung.");
      expect(JSON.stringify(revoked.workspace)).not.toContain("Current authorized printer instructions.");
      expect(revokedSession?.snapshot.messages.some(message => message.sourceContextId === CONTEXT_ID)).toBe(false);

      const reloaded = await first.load();
      expect(reloaded.revision).toBe(revoked.revision);
      expect(JSON.stringify(reloaded.workspace)).not.toContain("Installiere den Drucker über die Systemsteuerung.");
      expect(JSON.stringify(reloaded.workspace)).not.toContain("Current authorized printer instructions.");
      const workspaceKey = [...firstKeys.keys][0];
      expect(workspaceKey).toBeDefined();
      if (!workspaceKey) throw new Error("Expected the test workspace key to be tracked.");
      const persisted = await firstDatabase.read(workspaceKey);
      expect(persisted).toBeDefined();
      if (!persisted) throw new Error("Expected the protected workspace to remain in PostgreSQL.");
      expect(JSON.stringify(persisted.value)).not.toContain("Installiere den Drucker über die Systemsteuerung.");
      expect(JSON.stringify(persisted.value)).not.toContain("Current authorized printer instructions.");
    } finally {
      const keys = new Set([...firstKeys.keys, ...secondKeys.keys]);
      try {
        if (firstInitialized) await Promise.all([...keys].map(key => firstDatabase.delete(key)));
      } finally {
        await Promise.allSettled([firstDatabase.close(), secondDatabase.close()]);
      }
    }
  });
});
