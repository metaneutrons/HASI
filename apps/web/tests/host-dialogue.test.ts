import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JsonStore } from "@hasi/state";
import { createChatWorkspace, type ChatMessage, type ChatSession, type ChatWorkspace } from "../src/lib/chat-sessions";
import { staticHostDialogue, type HostDialogueMessage } from "../src/lib/host-dialogue";
import { planRoomDialogue } from "../src/lib/room-dialogue";
import type { Resource } from "../src/lib/types";
import {
  createHostDialogueSigner,
  handleHostDialoguePost,
} from "../src/lib/server/host-dialogue";
import {
  ProtectedWorkspaceStore,
} from "../src/lib/server/protected-workspaces";
import type { NativeHistoryAccess, NativeHistoryResolver } from "../src/lib/server/native-history";
import {
  createKnowledgeEvidence,
  rebuildKnowledgeContext,
} from "../src/lib/server/knowledge-evidence";
import { knowledgeEvidenceSchema, type KnowledgeEvidence } from "../src/lib/chat-contract";

const OWNER = "user:fabian@example.invalid";
const SCOPE = `production:${OWNER}`;
const SECRET = "test-only-host-dialogue-secret";
const CONVERSATION_ID = "c8e19d86-02e7-45d6-bc3a-f71a488b18a1";
const AUTHORITY = "a".repeat(64);
const OTHER_AUTHORITY = "b".repeat(64);
const ORIGIN = "https://hasi.example.invalid";
const DIALOGUE_URL = `${ORIGIN}/api/chat/dialogue`;
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function resource(id: string, name = `Resource ${id}`): Resource {
  return {
    id,
    name,
    description: `Authorized description for ${id}`,
    capacity: 8,
    location: "1J",
    features: ["Beamer"],
    serviceId: "rooms",
    kind: "meeting_room",
  };
}

const ROOM = resource("room-1", "Besprechungsraum A");
const CATALOG = [ROOM, resource("room-2", "Besprechungsraum B")];

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request(DIALOGUE_URL, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function baseDialogueDependencies(overrides: Partial<Parameters<typeof handleHostDialoguePost>[1]> = {}) {
  const signer = createHostDialogueSigner(SECRET, SCOPE, () => NOW);
  return {
    allowedOrigins: [ORIGIN],
    signer,
    authority: vi.fn(() => Promise.resolve(AUTHORITY)),
    resources: vi.fn(() => Promise.resolve(CATALOG)),
    bookingsEmpty: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

interface StoredEntry {
  readonly revision: string;
  readonly value: unknown;
  readonly expiresAt?: number;
}

class MemoryJsonStore implements Pick<JsonStore, "read" | "compareAndSet"> {
  readonly entries = new Map<string, StoredEntry>();
  private nextRevision = 1;

  read(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(undefined);
    return Promise.resolve({ revision: entry.revision, value: structuredClone(entry.value) });
  }

  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    const current = await this.read(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.entries.set(key, {
      revision: `revision-${String(this.nextRevision++)}`,
      value: structuredClone(value),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return true;
  }
}

function required<T>(value: T | undefined, description = "Expected a value."): T {
  if (value === undefined) throw new Error(description);
  return value;
}

function sessionOf(workspace: ChatWorkspace): ChatSession {
  return required(workspace.sessions[0], "Expected one chat session.");
}

function makeWorkspaceStore(options: {
  readonly store?: MemoryJsonStore;
  readonly authority?: () => Promise<string>;
  readonly resolveNative?: NativeHistoryResolver;
  readonly clock?: () => number;
} = {}) {
  const store = options.store ?? new MemoryJsonStore();
  const service = new ProtectedWorkspaceStore({
    store,
    ownerId: OWNER,
    scope: SCOPE,
    secret: SECRET,
    resolve: () => Promise.resolve([]),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.resolveNative ? { resolveNative: options.resolveNative } : {}),
  });
  return { store, service };
}

function assistantMessages(workspace: ChatWorkspace): ChatMessage[] {
  return workspace.sessions[0]?.snapshot.messages.filter(message => message.role === "assistant") ?? [];
}

describe("host dialogue receipts", () => {
  let now: number;
  let signer: ReturnType<typeof createHostDialogueSigner>;

  beforeEach(() => {
    now = NOW;
    signer = createHostDialogueSigner(SECRET, SCOPE, () => now);
  });

  it("binds display text, message identity, conversation, scope and signing key", () => {
    const message = signer.issue(CONVERSATION_ID, "Hallo.", "greeting", AUTHORITY);
    expect(signer.verify(CONVERSATION_ID, message, { authorityDigest: AUTHORITY, resources: [] })).toEqual(message);
    expect(signer.verify(CONVERSATION_ID, { ...message, text: "Forged text." }, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
    expect(signer.verify(CONVERSATION_ID, { ...message, id: randomUUID() }, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
    expect(signer.verify(randomUUID(), message, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
    expect(createHostDialogueSigner(SECRET, "another subject", () => now)
      .verify(CONVERSATION_ID, message, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
    expect(createHostDialogueSigner("another key", SCOPE, () => now)
      .verify(CONVERSATION_ID, message, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
  });

  it("expires at the exact boundary and rejects changed authority", () => {
    const message = signer.issue(CONVERSATION_ID, "Hallo.", "greeting", AUTHORITY);
    expect(signer.verify(CONVERSATION_ID, message, { authorityDigest: OTHER_AUTHORITY, resources: [] })).toBeUndefined();
    now += RETENTION_MS;
    expect(signer.verify(CONVERSATION_ID, message, { authorityDigest: AUTHORITY, resources: [] })).toBeUndefined();
  });

  it("binds candidate cards to the full current catalog and requires an available catalog", () => {
    const message = signer.issue(CONVERSATION_ID, "Besprechungsraum gefunden.", "room_details", AUTHORITY, CATALOG, [ROOM.id]);
    expect(signer.verify(CONVERSATION_ID, message, {
      authorityDigest: AUTHORITY,
      resources: CATALOG,
      resourcesAvailable: true,
    })).toEqual(message);
    expect(signer.verify(CONVERSATION_ID, message, {
      authorityDigest: AUTHORITY,
      resources: [resource(ROOM.id, "Name changed"), required(CATALOG[1])],
      resourcesAvailable: true,
    })).toBeUndefined();
    expect(signer.verify(CONVERSATION_ID, message, {
      authorityDigest: AUTHORITY,
      resources: CATALOG,
      resourcesAvailable: false,
    })).toBeUndefined();
    expect(signer.verify(CONVERSATION_ID, message, { authorityDigest: AUTHORITY, resources: CATALOG })).toBeUndefined();
  });

  it("distinguishes a signed empty catalog from an unavailable catalog", () => {
    const message = signer.issue(CONVERSATION_ID,
      "In den zugänglichen Raumdaten finde ich keinen passenden Raum.", "room_empty", AUTHORITY, [], []);
    expect(message.hostDialogue.resourceDigest).toBeDefined();
    expect(signer.verify(CONVERSATION_ID, message, {
      authorityDigest: AUTHORITY,
      resources: [],
      resourcesAvailable: true,
    })).toEqual(message);
    expect(signer.verify(CONVERSATION_ID, message, {
      authorityDigest: AUTHORITY,
      resources: [],
      resourcesAvailable: false,
    })).toBeUndefined();
  });

  it("cannot turn a display receipt into model knowledge evidence", async () => {
    const message = signer.issue(CONVERSATION_ID, "Hallo.", "greeting", AUTHORITY);
    const forgedEvidence = message.hostDialogue as unknown as KnowledgeEvidence;
    expect(knowledgeEvidenceSchema.safeParse(forgedEvidence).success).toBe(false);

    const reshapedEvidence = { contextIds: [], authorityDigest: AUTHORITY, expiresAt: message.hostDialogue.expiresAt,
      receipt: message.hostDialogue.receipt };
    expect(knowledgeEvidenceSchema.safeParse(reshapedEvidence).success).toBe(true);
    const knowledgeSigner = createKnowledgeEvidence(SECRET, SCOPE, () => now);
    expect(knowledgeSigner.verify(CONVERSATION_ID, { id: message.id, role: "assistant", content: message.text, evidence: reshapedEvidence }, AUTHORITY)).toBeUndefined();
    const assistant = { id: message.id, role: "assistant" as const, content: message.text, evidence: forgedEvidence };
    expect(knowledgeSigner.verify(CONVERSATION_ID, assistant, AUTHORITY)).toBeUndefined();
    const rebuilt = await rebuildKnowledgeContext({
      conversationId: CONVERSATION_ID,
      profileId: "groq-oss-120b",
      messages: [{ role: "user", content: "Hallo?" }, assistant],
    }, knowledgeSigner, () => Promise.resolve([]), AUTHORITY);
    expect(rebuilt.request.messages).toEqual([{ role: "user", content: "Hallo?" }]);
    expect(rebuilt.contextIds).toEqual([]);
  });
});

describe("ProtectedWorkspaceStore host dialogue reconstruction", () => {
  const native: NativeHistoryAccess = {
    resources: CATALOG,
    resourcesAvailable: true,
    bookings: [],
    proposals: new Map(),
  };

  function signedHelpers(conversationId: string) {
    const signer = createHostDialogueSigner(SECRET, SCOPE, () => NOW);
    const staticNote = signer.issue(conversationId, staticHostDialogue.greeting, "greeting", AUTHORITY);
    const plan = planRoomDialogue({ kind: "meeting_room" }, CATALOG);
    if (plan.code !== "room_details") throw new Error("The fixture must ask for room details.");
    const searchNote = signer.issue(conversationId, plan.text, plan.code, AUTHORITY, CATALOG, plan.resources.map(item => item.id));
    return { staticNote, searchNote };
  }

  it("retains signed notes and rebuilds candidate cards from the current authorized catalog", async () => {
    const workspace = createChatWorkspace(OWNER);
    const session = sessionOf(workspace);
    const { staticNote, searchNote } = signedHelpers(session.id);
    const forgedRoom = { ...ROOM, name: "Browser supplied room", description: "Forged" };
    session.snapshot.input = "Keep this draft";
    session.snapshot.history = [{ role: "user", content: "Find a meeting room." }];
    session.snapshot.messages = [
      { id: randomUUID(), role: "user", text: "Find a meeting room." },
      staticNote,
      { ...searchNote, rooms: [{ resource: forgedRoom, intervals: [], checked: true }] },
    ];
    const { service } = makeWorkspaceStore({
      authority: () => Promise.resolve(AUTHORITY),
      resolveNative: () => Promise.resolve(native),
      clock: () => NOW,
    });

    const saved = await service.save(null, workspace);
    const loaded = await service.load();
    const notes = assistantMessages(loaded.workspace);
    const greeting = notes.find(message => message.hostDialogue?.code === "greeting");
    const roomNote = notes.find(message => message.hostDialogue?.code === "room_details");

    expect(greeting?.text).toBe(staticHostDialogue.greeting);
    expect(roomNote?.text).toBe(searchNote.text);
    expect(roomNote?.tool).toBe("HASI · Dialoghinweis");
    expect(roomNote?.rooms).toEqual(searchNote.hostDialogue.resourceIds.map(id => ({
      resource: CATALOG.find(item => item.id === id),
      intervals: [],
      checked: false,
    })));
    expect(JSON.stringify(loaded.workspace)).not.toContain("Browser supplied room");
    expect(JSON.stringify(loaded.workspace)).not.toContain("Forged");
    expect(loaded.workspace.sessions[0]?.snapshot.history).toEqual([{ role: "user", content: "Find a meeting room." }]);
    expect(loaded.workspace.sessions[0]?.snapshot.input).toBe("Keep this draft");
    expect(saved.revision).toBe(loaded.revision);
  });

  it("rejects changed text and display messages carrying additional evidence or action claims", async () => {
    const workspace = createChatWorkspace(OWNER);
    const session = sessionOf(workspace);
    const signed = createHostDialogueSigner(SECRET, SCOPE, () => NOW)
      .issue(session.id, staticHostDialogue.greeting, "greeting", AUTHORITY);
    const knowledge = createKnowledgeEvidence(SECRET, SCOPE, () => NOW);
    const evidence = knowledge.stamp(session.id, { id: signed.id, role: "assistant", content: signed.text }, [], AUTHORITY);
    const forgedProposal = {
      action: "book" as const,
      id: "proposal-a",
      resourceName: "Unapproved room",
      startDate: "2026-10-21T14:00:00.000Z",
      endDate: "2026-10-21T15:00:00.000Z",
      status: "pending" as const,
      expiresAt: "2026-10-20T11:00:00.000Z",
    };
    const workspaceFor = (message: ChatMessage) => {
      const value = structuredClone(workspace);
      sessionOf(value).snapshot.messages = [message];
      return value;
    };
    const { service } = makeWorkspaceStore({ authority: () => Promise.resolve(AUTHORITY), clock: () => NOW });

    const control = await service.save(null, workspaceFor(signed));
    expect(assistantMessages(control.workspace)[0]?.hostDialogue).toEqual(signed.hostDialogue);
    const changedText = await service.save(control.revision, workspaceFor({ ...signed, text: "Browser replaced the host text." }));
    const changedMessage = assistantMessages(changedText.workspace)[0];
    expect(changedMessage?.text).not.toContain("Browser replaced");
    expect(changedMessage?.text).toMatch(/nicht mehr verfügbar/u);

    const decorated = await service.save(changedText.revision, workspaceFor({
      ...signed,
      evidence,
      proposal: forgedProposal,
      model: "browser-selected-model",
    }));
    const denied = assistantMessages(decorated.workspace)[0];
    expect(denied?.text).toMatch(/nicht mehr verfügbar/u);
    expect(denied).not.toHaveProperty("hostDialogue");
    expect(denied).not.toHaveProperty("evidence");
    expect(denied).not.toHaveProperty("proposal");
    expect(denied).not.toHaveProperty("model");
  });

  it("drops helper content after authority revocation while retaining user text and the draft", async () => {
    const workspace = createChatWorkspace(OWNER);
    const session = sessionOf(workspace);
    const { staticNote, searchNote } = signedHelpers(session.id);
    session.snapshot.input = "Preserved draft";
    session.snapshot.messages = [
      { id: randomUUID(), role: "user", text: "Please find a room." },
      staticNote,
      searchNote,
    ];
    let authority = AUTHORITY;
    const { service } = makeWorkspaceStore({
      authority: () => Promise.resolve(authority),
      resolveNative: () => Promise.resolve(native),
      clock: () => NOW,
    });
    await service.save(null, workspace);
    authority = OTHER_AUTHORITY;

    const loaded = await service.load();
    const sessionAfterRevoke = loaded.workspace.sessions[0];
    expect(sessionAfterRevoke?.snapshot.input).toBe("Preserved draft");
    expect(sessionAfterRevoke?.snapshot.messages.find(message => message.role === "user")?.text).toBe("Please find a room.");
    expect(assistantMessages(loaded.workspace).every(message => message.hostDialogue === undefined && message.rooms === undefined)).toBe(true);
    expect(JSON.stringify(loaded.workspace)).not.toContain(staticHostDialogue.greeting);
    expect(JSON.stringify(loaded.workspace)).not.toContain(searchNote.text);
  });

  it("revalidates catalog data and fails closed when the current catalog is unavailable", async () => {
    const workspace = createChatWorkspace(OWNER);
    const session = sessionOf(workspace);
    const { staticNote, searchNote } = signedHelpers(session.id);
    session.snapshot.messages = [staticNote, searchNote];
    let currentNative = native;
    const { service } = makeWorkspaceStore({
      authority: () => Promise.resolve(AUTHORITY),
      resolveNative: () => Promise.resolve(currentNative),
      clock: () => NOW,
    });
    await service.save(null, workspace);

    currentNative = { ...native, resources: [resource(ROOM.id, "Renamed authorized room"), required(CATALOG[1])] };
    const changedCatalog = await service.load();
    expect(assistantMessages(changedCatalog.workspace).find(message => message.hostDialogue?.code === "greeting")?.text)
      .toBe(staticHostDialogue.greeting);
    expect(assistantMessages(changedCatalog.workspace).some(message => message.text.includes("nicht mehr verfügbar"))).toBe(true);

    currentNative = native;
    const fresh = makeWorkspaceStore({ authority: () => Promise.resolve(AUTHORITY),
      resolveNative: () => Promise.resolve(currentNative), clock: () => NOW });
    const beforeUnavailable = await fresh.service.save(null, workspace);
    expect(assistantMessages(beforeUnavailable.workspace).some(message => message.hostDialogue?.code === "room_details")).toBe(true);
    currentNative = { ...native, resourcesAvailable: false };
    const unavailable = await fresh.service.load();
    expect(assistantMessages(unavailable.workspace).some(message => message.hostDialogue?.code === "room_details")).toBe(false);
    expect(assistantMessages(unavailable.workspace).some(message => message.hostDialogue?.code === "greeting")).toBe(true);
  });

  it("never copies display notes into the model history", async () => {
    const workspace = createChatWorkspace(OWNER);
    const session = sessionOf(workspace);
    const note = createHostDialogueSigner(SECRET, SCOPE, () => NOW)
      .issue(session.id, staticHostDialogue.greeting, "greeting", AUTHORITY);
    session.snapshot.messages = [note];
    session.snapshot.history = [
      { role: "user", content: "What can you do?" },
      { role: "assistant", content: note.text },
    ];
    const { service } = makeWorkspaceStore({ authority: () => Promise.resolve(AUTHORITY), clock: () => NOW });

    const saved = await service.save(null, workspace);
    const history = saved.workspace.sessions[0]?.snapshot.history ?? [];
    expect(history).toEqual([{ role: "user", content: "What can you do?" }]);
    expect(JSON.stringify(history)).not.toContain(note.text);
    expect(assistantMessages(saved.workspace).some(message => message.hostDialogue?.code === "greeting")).toBe(true);
  });
});

describe("host dialogue endpoint", () => {
  it("rejects client-authored text, counts, results and unrecognized codes", async () => {
    const dependencies = baseDialogueDependencies();
    const conversationId = randomUUID();
    const invalidInputs = [
      { kind: "static", conversationId, code: "greeting", text: "Sign this attacker text." },
      { kind: "static", conversationId, code: "room_empty" },
      { kind: "rooms", conversationId, request: { kind: "meeting_room" }, total: 99 },
      { kind: "rooms", conversationId, request: { kind: "meeting_room" }, results: [ROOM], text: "No rooms." },
      { kind: "rooms", conversationId, request: { kind: "meeting_room" }, code: "room_empty" },
    ];

    for (const input of invalidInputs) {
      const response = await handleHostDialoguePost(makeRequest(input), dependencies);
      expect(response.status).toBe(400);
    }
    expect(dependencies.authority).not.toHaveBeenCalled();
    expect(dependencies.resources).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and oversized bodies before calling authority or catalog services", async () => {
    const dependencies = baseDialogueDependencies();
    const input = { kind: "static", conversationId: randomUUID(), code: "greeting" };
    const crossOrigin = await handleHostDialoguePost(makeRequest(input, { origin: "https://attacker.example" }), dependencies);
    const oversizedBody = JSON.stringify({ ...input, filler: "x".repeat(9_000) });
    const oversized = await handleHostDialoguePost(makeRequest(oversizedBody), dependencies);

    expect(crossOrigin.status).toBe(403);
    expect(oversized.status).toBe(400);
    expect(dependencies.authority).not.toHaveBeenCalled();
    expect(dependencies.resources).not.toHaveBeenCalled();
  });

  it("avoids catalog reads for static, group and invalid-request dialogue", async () => {
    const dependencies = baseDialogueDependencies();
    const conversationId = randomUUID();
    const requests = [
      { kind: "static", conversationId, code: "greeting" },
      { kind: "rooms", conversationId, request: { kind: "workplace", capacity: 4 } },
      { kind: "rooms", conversationId, request: { kind: "meeting_room", date: "__invalid__" } },
    ];

    for (const input of requests) {
      const response = await handleHostDialoguePost(makeRequest(input), dependencies);
      expect(response.status).toBe(200);
    }
    expect(dependencies.resources).not.toHaveBeenCalled();
  });

  it("derives refinement and empty results from its own authorized catalog", async () => {
    const manyResources = Array.from({ length: 9 }, (_, index) => ({
      ...resource(`desk-${String(index)}`, `Workplace ${String(index)}`),
      kind: "workplace" as const,
      officeWorkplaceCount: 2,
    }));
    const dependencies = baseDialogueDependencies({ resources: vi.fn(() => Promise.resolve(manyResources)) });
    const conversationId = randomUUID();
    const refineResponse = await handleHostDialoguePost(makeRequest({
      kind: "rooms", conversationId, request: { kind: "workplace" },
    }), dependencies);
    const refineBody = await refineResponse.json() as { plan: { code: string; total: number }; message: HostDialogueMessage };
    expect(refineResponse.status).toBe(200);
    expect(refineBody.plan).toMatchObject({ code: "room_refine", total: 9 });
    expect(dependencies.resources).toHaveBeenCalledTimes(1);
    expect(dependencies.signer.verify(conversationId, refineBody.message, {
      authorityDigest: AUTHORITY,
      resources: manyResources,
      resourcesAvailable: true,
    })).toEqual(refineBody.message);

    const authorizedEmpty = baseDialogueDependencies({ resources: vi.fn(() => Promise.resolve([])) });
    const emptyCatalogResponse = await handleHostDialoguePost(makeRequest({
      kind: "rooms", conversationId, request: { kind: "meeting_room" },
    }), authorizedEmpty);
    const emptyCatalogBody = await emptyCatalogResponse.json() as { plan: { code: string }; message: HostDialogueMessage };
    expect(emptyCatalogBody.plan.code).toBe("room_empty");
    expect(authorizedEmpty.signer.verify(conversationId, emptyCatalogBody.message, {
      authorityDigest: AUTHORITY,
      resources: [],
      resourcesAvailable: true,
    })).toEqual(emptyCatalogBody.message);
    expect(authorizedEmpty.signer.verify(conversationId, emptyCatalogBody.message, {
      authorityDigest: AUTHORITY,
      resources: [],
      resourcesAvailable: false,
    })).toBeUndefined();

    const emptyDependencies = baseDialogueDependencies();
    const emptyResponse = await handleHostDialoguePost(makeRequest({
      kind: "rooms", conversationId, request: { kind: "meeting_room" }, selectedResourceId: "not-authorized",
    }), emptyDependencies);
    const emptyBody = await emptyResponse.json() as { plan: { code: string; resources: Resource[] }; message: HostDialogueMessage };
    expect(emptyBody.plan).toMatchObject({ code: "room_empty", resources: [] });
    expect(emptyDependencies.signer.verify(conversationId, emptyBody.message, {
      authorityDigest: AUTHORITY,
      resources: CATALOG,
      resourcesAvailable: true,
    })).toEqual(emptyBody.message);

    const unavailable = baseDialogueDependencies({ resources: vi.fn(() => Promise.reject(new Error("catalog unavailable"))) });
    const unavailableResponse = await handleHostDialoguePost(makeRequest({
      kind: "rooms", conversationId, request: { kind: "meeting_room" }, selectedResourceId: "not-authorized",
    }), unavailable);
    expect(unavailableResponse.status).toBe(503);
    const unavailableBody = await unavailableResponse.json() as { message?: unknown };
    expect(unavailableBody.message).toBeUndefined();
  });

  it("checks that authority stays stable across a catalog-backed response", async () => {
    const order: string[] = [];
    const dependencies = baseDialogueDependencies({
      authority: vi.fn(() => {
        order.push("authority");
        return Promise.resolve(order.length === 1 ? AUTHORITY : OTHER_AUTHORITY);
      }),
      resources: vi.fn(() => {
        order.push("catalog");
        return Promise.resolve(CATALOG);
      }),
    });
    const response = await handleHostDialoguePost(makeRequest({
      kind: "rooms",
      conversationId: randomUUID(),
      request: { kind: "meeting_room" },
    }), dependencies);

    expect(response.status).toBe(409);
    const body = await response.json() as { plan?: unknown };
    expect(body.plan).toBeUndefined();
    expect(dependencies.resources).toHaveBeenCalledTimes(1);
    expect(dependencies.authority).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["authority", "catalog", "authority"]);
  });

  it("signs an empty-bookings note only after a successful empty read", async () => {
    const conversationId = randomUUID();
    const found = baseDialogueDependencies({ bookingsEmpty: vi.fn(() => Promise.resolve(false)) });
    const foundResponse = await handleHostDialoguePost(makeRequest({ kind: "bookings_empty", conversationId }), found);
    expect(foundResponse.status).toBe(409);
    const foundBody = await foundResponse.json() as { message?: unknown };
    expect(foundBody.message).toBeUndefined();

    const unavailable = baseDialogueDependencies({ bookingsEmpty: vi.fn(() => Promise.reject(new Error("booking read unavailable"))) });
    const unavailableResponse = await handleHostDialoguePost(makeRequest({ kind: "bookings_empty", conversationId }), unavailable);
    expect(unavailableResponse.status).toBe(503);
    const unavailableBody = await unavailableResponse.json() as { message?: unknown };
    expect(unavailableBody.message).toBeUndefined();

    const empty = baseDialogueDependencies();
    const emptyResponse = await handleHostDialoguePost(makeRequest({ kind: "bookings_empty", conversationId }), empty);
    const body = await emptyResponse.json() as { message: HostDialogueMessage };
    expect(emptyResponse.status).toBe(200);
    expect(body.message.hostDialogue.code).toBe("bookings_empty");
    expect(empty.signer.verify(conversationId, body.message, { authorityDigest: AUTHORITY, resources: [] })).toEqual(body.message);
    expect(empty.resources).not.toHaveBeenCalled();
  });
});

it("issues only fixed display guidance for action controls and rejects client status claims", async () => {
  const dependencies = baseDialogueDependencies();
  const response = await handleHostDialoguePost(makeRequest({ kind: "static", conversationId: CONVERSATION_ID, code: "action_controls_guidance" }), dependencies);
  expect(response.status).toBe(200);
  const body = await response.json() as { message: HostDialogueMessage };
  expect(body.message.text).toBe(staticHostDialogue.action_controls_guidance);
  expect(body.message.hostDialogue.code).toBe("action_controls_guidance");
  expect(dependencies.resources).not.toHaveBeenCalled();
  expect(dependencies.bookingsEmpty).not.toHaveBeenCalled();
  const forged = await handleHostDialoguePost(makeRequest({ kind: "static", conversationId: CONVERSATION_ID, code: "action_controls_guidance", status: "confirmed" }), dependencies);
  expect(forged.status).toBe(400);
});
