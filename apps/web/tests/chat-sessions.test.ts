import { describe, expect, it } from "vitest";
import { modelProfileIdSchema } from "../src/lib/chat-contract";
import {
  MAX_CHAT_MESSAGES,
  MAX_CHAT_SESSIONS,
  chatStorageKey,
  createChatSession,
  createChatWorkspace,
  deleteChat,
  loadChatWorkspace,
  renameChat,
  saveChatWorkspace,
  selectChat,
  updateChatSnapshot,
  type ChatMessage,
  type ChatSnapshot,
  type ChatStorageReader,
  type ChatStorageWriter,
  type ChatWorkspace,
} from "../src/lib/chat-sessions";
import { required } from "./test-utils";

class MemoryStorage implements ChatStorageReader, ChatStorageWriter {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeSnapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    messages: [],
    history: [],
    input: "",
    profileId: "groq-oss-120b",
    request: {},
    roomContext: false,
    chosenRoom: null,
    activeResult: null,
    activeProposal: null,
    interrupted: false,
    messagesTruncated: false,
    ...overrides,
  };
}

function textMessage(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return { id, role, text };
}

function withSession(workspace: ChatWorkspace, session = createChatSession()): ChatWorkspace {
  return {
    ...workspace,
    activeId: session.id,
    sessions: [...workspace.sessions, session],
  };
}

describe("chat session persistence", () => {
  it("salvages incomplete generic exchanges without replaying pending calls and retains complete context references", () => {
    const workspace = createChatWorkspace("generic-owner");
    const session = required(workspace.sessions[0]);
    const name = "hasi_aaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const user = { role: "user" as const, content: "Read reference status." };
    const assistant = { role: "assistant" as const, content: "", toolCalls: [
      { id: "read-1", name, arguments: {} }, { id: "read-2", name, arguments: {} },
    ] };
    const contextId = "4de1c038-4b30-4c6c-9e14-3f7c9cac1b89";
    const first = { role: "tool" as const, name, toolCallId: "read-1", content: "{}", toolContextId: contextId };
    for (const history of [[user, assistant], [user, assistant, first]]) {
      const saved = updateChatSnapshot(workspace, session.id, makeSnapshot({ history, interrupted: true }));
      expect(required(saved.sessions[0]).snapshot.history).toEqual([user]);
    }
    const history = [user, assistant, first, { role: "tool" as const, name, toolCallId: "read-2", content: "{}", toolContextId: contextId }];
    const complete = updateChatSnapshot(workspace, session.id, makeSnapshot({ history }));
    expect(required(complete.sessions[0]).snapshot.history).toEqual(history);
  });

  it("retains a blocked service request and its calendar anchor across connection navigation", () => {
    const initial = createChatWorkspace("user-1");
    const session = required(initial.sessions[0]);
    const requestId = "ae93bd5b-49b1-40a9-8250-370d6c355fa7";
    const serviceConnection = { installationId: "de.hsh.hasi.anny", label: "anny", requestId };
    const snapshot = makeSnapshot({
      request: { kind: "workplace", location: "1J", date: "2026-10-19", time: "10:00", durationMinutes: 360 }, roomContext: true,
      messages: [textMessage(requestId, "user", "Heute in 1J von 10–16 Uhr"), { ...textMessage("connect", "assistant", "Verbinde anny"), tool: "anny · Dienstverbindung", serviceConnection }],
      history: [{ id: requestId, role: "user", content: "Heute in 1J von 10–16 Uhr" }],
    });
    const storage = new MemoryStorage();
    expect(saveChatWorkspace(updateChatSnapshot(initial, session.id, snapshot), storage)).toBe(true);
    const restored = required(loadChatWorkspace("user-1", storage).workspace.sessions[0]).snapshot;
    expect(restored.messages[1]?.serviceConnection).toEqual(serviceConnection);
    expect(restored.request).toEqual(snapshot.request);
    expect(restored.history).toEqual(snapshot.history);
  });
  it("preserves syntax-valid dynamic profile IDs and rejects invalid profile IDs", () => {
    const dynamicProfileId = "openai-uni_model-2";
    expect(modelProfileIdSchema.safeParse("groq-qwen-3.8-27b").success).toBe(true);
    expect(modelProfileIdSchema.safeParse(dynamicProfileId).success).toBe(true);
    expect(modelProfileIdSchema.safeParse("Invalid Profile").success).toBe(false);
    expect(modelProfileIdSchema.safeParse("offline").success).toBe(false);

    const initial = createChatWorkspace("user-1");
    const session = createChatSession(dynamicProfileId);
    const workspace = withSession(initial, session);
    const storage = new MemoryStorage();
    expect(saveChatWorkspace(workspace, storage)).toBe(true);
    expect(loadChatWorkspace("user-1", storage).workspace.sessions.find(({ id }) => id === session.id)?.snapshot.profileId).toBe(dynamicProfileId);

    const saved = JSON.parse(required(storage.getItem(chatStorageKey("user-1")))) as ChatWorkspace;
    required(saved.sessions.find(({ id }) => id === session.id)).snapshot.profileId = "Invalid Profile";
    storage.setItem(chatStorageKey("user-1"), JSON.stringify(saved));
    const invalid = loadChatWorkspace("user-1", storage);
    expect(invalid.notice).not.toBeNull();
    expect(required(invalid.workspace.sessions[0]).snapshot.profileId).toBe("groq-oss-120b");
  });

  it.each(["gwdg-qwen3-30b", "offline"] as const)("replaces the final %s chat with a fresh Groq chat", profileId => {
    const initial = createChatWorkspace("user-1");
    const session = required(initial.sessions[0]);
    const selected = updateChatSnapshot(initial, session.id, makeSnapshot({ profileId }));
    const next = deleteChat(selected, session.id);
    expect(required(next.sessions[0]).snapshot.profileId).toBe("groq-oss-120b");
    expect(required(next.sessions[0]).id).not.toBe(session.id);
  });

  it("roundtrips server metadata and leaves legacy message times absent", () => {
    const initial = createChatWorkspace("user-1");
    const session = required(initial.sessions[0]);
    const id = "ae93bd5b-49b1-40a9-8250-370d6c355fa7";
    const timestamp = { createdAt: "2026-10-17T09:00:00.000Z", receipt: "A".repeat(43) };
    const snapshot = makeSnapshot({ messages: [{ id, role: "user", text: "Morgen", timestamp }, textMessage("old", "assistant", "Alt")], history: [{ id, role: "user", content: "Morgen", timestamp }, { role: "assistant", content: "Alt" }] });
    const storage = new MemoryStorage();
    saveChatWorkspace(updateChatSnapshot(initial, session.id, snapshot), storage);
    const restored = required(loadChatWorkspace("user-1", storage).workspace.sessions[0]).snapshot;
    expect(required(restored.messages[0]).timestamp).toEqual(timestamp);
    expect(required(restored.history[0]).timestamp).toEqual(timestamp);
    expect(required(restored.messages[1]).timestamp).toBeUndefined();
    expect(required(restored.history[1]).timestamp).toBeUndefined();
  });
  it("persists a workplace office preference and rejects unsupported stored values", () => {
    const storage = new MemoryStorage();
    const initial = createChatWorkspace("user-1");
    const session = required(initial.sessions[0]);
    const snapshot = makeSnapshot({
      request: { kind: "workplace", officeType: "shared", location: "1J", date: "2030-01-03" },
      messages: [{
        ...textMessage("workplace-result", "assistant", "Katalogtreffer"),
        rooms: [{
          requestedStartDate: "2030-01-03T08:00:00.000Z",
          requestedEndDate: "2030-01-03T16:00:00.000Z",
          resource: { id: "desk-1", name: "Arbeitsplatz", description: "", capacity: null, location: "1J", features: [], serviceId: "service-1", kind: "workplace", officeWorkplaceCount: 2 },
          intervals: [],
          checked: false,
        }],
      }],
    });
    expect(saveChatWorkspace(updateChatSnapshot(initial, session.id, snapshot), storage)).toBe(true);
    const restored = required(loadChatWorkspace("user-1", storage).workspace.sessions[0]).snapshot;
    expect(restored.request).toEqual(snapshot.request);
    expect(restored.messages[0]?.rooms?.[0]?.resource.officeWorkplaceCount).toBe(2);
    expect(restored.messages[0]?.rooms?.[0]?.requestedStartDate).toBe("2030-01-03T08:00:00.000Z");
    expect(restored.messages[0]?.rooms?.[0]?.requestedEndDate).toBe("2030-01-03T16:00:00.000Z");

    const stored = JSON.parse(required(storage.getItem(chatStorageKey("user-1")))) as {
      sessions: { snapshot: { request: { officeType?: string } } }[];
    };
    required(stored.sessions[0]).snapshot.request.officeType = "private";
    storage.setItem(chatStorageKey("user-1"), JSON.stringify(stored));
    expect(loadChatWorkspace("user-1", storage).notice).not.toBeNull();
  });
  it("keeps multiple sessions, drafts, profiles, and history independent", () => {
    const initial = createChatWorkspace("user-1");
    const first = required(initial.sessions[0]);
    const second = createChatSession("groq-oss-20b");
    const workspace = withSession(initial, second);
    const firstSnapshot = makeSnapshot({
      profileId: "groq-oss-120b",
      input: "first draft",
      messages: [textMessage("m1", "user", "First question")],
      history: [{ role: "user", content: "First question" }],
    });
    const secondSnapshot = makeSnapshot({
      profileId: "groq-oss-20b",
      input: "second draft",
      messages: [textMessage("m2", "user", "Second question")],
      history: [{ role: "user", content: "Second question" }],
    });

    let updated = updateChatSnapshot(workspace, first.id, firstSnapshot);
    updated = updateChatSnapshot(updated, second.id, secondSnapshot);

    firstSnapshot.messages.push(textMessage("m3", "assistant", "mutated caller state"));
    (firstSnapshot.history as { role: "user"; content: string }[]).push({ role: "user", content: "mutated history" });

    const storedFirst = required(updated.sessions.find(({ id }) => id === first.id));
    const storedSecond = required(updated.sessions.find(({ id }) => id === second.id));
    expect(storedFirst.snapshot).toMatchObject({
      profileId: "groq-oss-120b",
      input: "first draft",
      history: [{ role: "user", content: "First question" }],
    });
    expect(storedSecond.snapshot).toMatchObject({
      profileId: "groq-oss-20b",
      input: "second draft",
      history: [{ role: "user", content: "Second question" }],
    });
  });

  it("applies a late update only to its target session and never resurrects deleted chats", () => {
    const initial = createChatWorkspace("user-1");
    const first = required(initial.sessions[0]);
    const second = createChatSession();
    const workspace = withSession(initial, second);
    const lateUpdate = updateChatSnapshot(workspace, first.id, makeSnapshot({ input: "late draft" }));

    expect(lateUpdate.activeId).toBe(second.id);
    expect(lateUpdate.sessions.find(({ id }) => id === second.id)?.snapshot.input).toBe("");
    expect(lateUpdate.sessions.find(({ id }) => id === first.id)?.snapshot.input).toBe("late draft");

    const deleted = deleteChat(lateUpdate, first.id);
    expect(updateChatSnapshot(deleted, first.id, makeSnapshot({ input: "stale response" }))).toBe(deleted);
    expect(selectChat(deleted, first.id)).toBe(deleted);
    expect(renameChat(deleted, first.id, "Stale rename")).toBe(deleted);
    expect(deleteChat(deleted, first.id)).toBe(deleted);
    expect(deleted.sessions.map(({ id }) => id)).toEqual([second.id]);
  });

  it("scopes storage by owner and rejects malformed, duplicate, and unsupported payloads", () => {
    const storage = new MemoryStorage();
    const ownerOne = createChatWorkspace("owner-one");
    expect(saveChatWorkspace(ownerOne, storage)).toBe(true);

    storage.setItem(chatStorageKey("owner-two"), required(storage.getItem(chatStorageKey("owner-one"))));
    const wrongOwner = loadChatWorkspace("owner-two", storage);
    expect(wrongOwner.workspace.ownerId).toBe("owner-two");
    expect(wrongOwner.notice).not.toBeNull();

    const raw = JSON.parse(required(storage.getItem(chatStorageKey("owner-one")))) as Record<string, unknown>;
    storage.setItem(chatStorageKey("owner-one"), JSON.stringify({ ...raw, version: 2 }));
    expect(loadChatWorkspace("owner-one", storage).notice).not.toBeNull();

    const duplicate = JSON.parse(required(storage.getItem(chatStorageKey("owner-one")))) as ChatWorkspace;
    duplicate.version = 1;
    duplicate.sessions.push({ ...required(duplicate.sessions[0]) });
    expect(duplicate.sessions.length).toBeGreaterThan(1);
    storage.setItem(chatStorageKey("owner-one"), JSON.stringify(duplicate));
    expect(loadChatWorkspace("owner-one", storage).notice).not.toBeNull();

    const malformed = createChatWorkspace("owner-one");
    required(malformed.sessions[0]).snapshot.messages.push(textMessage("bad", "assistant", "x".repeat(8_001)));
    storage.setItem(chatStorageKey("owner-one"), JSON.stringify(malformed));
    expect(loadChatWorkspace("owner-one", storage).notice).not.toBeNull();
  });

  it("drops only an interrupted trailing tool exchange and rejects corruption before it", () => {
    const storage = new MemoryStorage();
    const workspace = createChatWorkspace("user-1");
    const session = required(workspace.sessions[0]);
    const prefix = [
      { role: "user", content: "Find a room" },
      { role: "assistant", content: "I will check rooms." },
      { role: "user", content: "For tomorrow" },
    ];
    const interrupted = [
      ...prefix,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "anny_search_resources", arguments: { query: "seminar" } },
          { id: "call-b", name: "anny_list_my_bookings", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "call-a", name: "anny_search_resources", content: "{}" },
    ];
    const stored = {
      ...workspace,
      sessions: [{
        ...session,
        snapshot: makeSnapshot({ history: interrupted as ChatSnapshot["history"] }),
      }],
    };
    storage.setItem(chatStorageKey("user-1"), JSON.stringify(stored));

    const recovered = loadChatWorkspace("user-1", storage);
    expect(recovered.notice).toBeNull();
    expect(recovered.workspace.sessions[0]?.snapshot.history).toEqual(prefix);

    const corrupt = structuredClone(stored);
    const corruptHistory = required(corrupt.sessions[0]).snapshot.history as { role: string; content?: string }[];
    corruptHistory[1] = { role: "assistant", content: "x", unexpected: true } as never;
    storage.setItem(chatStorageKey("user-1"), JSON.stringify(corrupt));
    expect(loadChatWorkspace("user-1", storage).notice).not.toBeNull();
  });

  it("does not overwrite prior data when storage fails or size and count bounds are exceeded", () => {
    const storage = new MemoryStorage();
    const workspace = createChatWorkspace("user-1");
    expect(saveChatWorkspace(workspace, storage)).toBe(true);
    const key = chatStorageKey("user-1");
    const previous = storage.getItem(key);
    const quotaStorage: ChatStorageWriter = {
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveChatWorkspace(workspace, quotaStorage)).toBe(false);
    expect(storage.getItem(key)).toBe(previous);

    const largeMessages = Array.from({ length: MAX_CHAT_MESSAGES }, (_, index) =>
      textMessage(`large-${String(index)}`, "assistant", "x".repeat(8_000)),
    );
    const largeSessionOne = {
      ...required(workspace.sessions[0]),
      snapshot: makeSnapshot({ messages: largeMessages }),
    };
    const largeSessionTwo = {
      ...createChatSession(),
      snapshot: makeSnapshot({ messages: largeMessages }),
    };
    const oversized = {
      ...workspace,
      sessions: [largeSessionOne, largeSessionTwo],
    };
    expect(saveChatWorkspace(oversized, storage)).toBe(false);
    expect(storage.getItem(key)).toBe(previous);

    const tooMany = {
      ...workspace,
      sessions: Array.from({ length: MAX_CHAT_SESSIONS + 1 }, (_, index) => ({
        ...required(workspace.sessions[0]),
        id: `session-${String(index)}`,
      })),
    };
    expect(saveChatWorkspace(tooMany, storage)).toBe(false);
    expect(storage.getItem(key)).toBe(previous);
  });

  it("preserves manual titles, selects a remaining active chat, and resets after deleting the last chat", () => {
    const created = new Date("2026-10-15T10:00:00.000Z");
    const secondCreated = new Date("2026-10-15T10:01:00.000Z");
    const initial = createChatWorkspace("user-1");
    const first = { ...required(initial.sessions[0]), createdAt: created.toISOString(), updatedAt: created.toISOString() };
    const second = createChatSession("offline", secondCreated);
    const workspace = { ...initial, sessions: [first, second], activeId: second.id };
    const autoTitled = updateChatSnapshot(workspace, first.id, makeSnapshot({
      profileId: "groq-oss-120b",
      messages: [textMessage("first-question", "user", "A room for a seminar")],
    }), new Date("2026-10-15T10:02:00.000Z"));
    expect(autoTitled.sessions.find(({ id }) => id === first.id)?.title).toBe("A room for a seminar");

    const renamed = renameChat(autoTitled, first.id, "Planning notes");
    const updated = updateChatSnapshot(renamed, first.id, makeSnapshot({
      profileId: "groq-oss-120b",
      messages: [textMessage("first-question", "user", "A room for a seminar")],
    }), new Date("2026-10-15T10:02:30.000Z"));

    expect(updated.sessions.find(({ id }) => id === first.id)).toMatchObject({
      title: "Planning notes",
      titleSource: "manual",
    });
    expect(selectChat(updated, first.id).activeId).toBe(first.id);

    const selected = selectChat(updated, second.id);
    const withoutSecond = deleteChat(selected, second.id, new Date("2026-10-15T10:03:00.000Z"));
    expect(withoutSecond.activeId).toBe(first.id);
    expect(withoutSecond.sessions.map(({ id }) => id)).toEqual([first.id]);

    const reset = deleteChat(withoutSecond, first.id, new Date("2026-10-15T10:04:00.000Z"));
    expect(reset.sessions).toHaveLength(1);
    expect(reset.activeId).toBe(reset.sessions[0]?.id);
    expect(reset.sessions[0]?.snapshot).toMatchObject({
      profileId: "groq-oss-120b",
      messages: [],
      history: [],
      input: "",
    });
  });

  it("trims only old displayed messages on update and restores interruption and safe proposal state", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const workspace = createChatWorkspace("user-1");
    const session = required(workspace.sessions[0]);
    const messages = Array.from({ length: MAX_CHAT_MESSAGES + 3 }, (_, index) =>
      textMessage(`m-${String(index)}`, index === 0 ? "user" : "assistant", `Message ${String(index)}`),
    );
    const updated = updateChatSnapshot(workspace, session.id, makeSnapshot({
      messages,
      interrupted: true,
      activeProposal: "proposal-1",
      messagesTruncated: false,
    }), now);

    const snapshot = required(updated.sessions[0]).snapshot;
    expect(snapshot.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(snapshot.messages[0]?.id).toBe("m-3");
    expect(snapshot.messagesTruncated).toBe(true);
    expect(snapshot.interrupted).toBe(true);
    expect(snapshot.activeProposal).toBeNull();

    const proposal = {
      id: "proposal-1",
      resourceName: "Seminarraum",
      startDate: "2030-01-02T10:00:00Z",
      endDate: "2030-01-02T11:00:00Z",
      status: "pending" as const,
      expiresAt: "2030-01-01T01:00:00Z",
    };
    const active = updateChatSnapshot(updated, session.id, makeSnapshot({
      messages: [
        textMessage("user-1", "user", "Book this room"),
        { ...textMessage("assistant-1", "assistant", "Please confirm."), proposal },
      ],
      activeProposal: proposal.id,
      interrupted: true,
    }), now);
    expect(active.sessions[0]?.snapshot.activeProposal).toBe(proposal.id);

    const storage = new MemoryStorage();
    expect(saveChatWorkspace(active, storage)).toBe(true);
    const restored = loadChatWorkspace("user-1", storage).workspace;
    expect(restored.sessions[0]?.snapshot).toMatchObject({
      interrupted: true,
      activeProposal: proposal.id,
    });
  });

  it("roundtrips a generic plugin proposal without parsing its plugin-specific date strings", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const workspace = createChatWorkspace("user-1");
    const session = required(workspace.sessions[0]);
    const proposal = {
      action: "execute_tool" as const,
      id: "5f891aac-81c0-4c7e-9a89-aed77396eea9",
      pluginId: "example.plugin",
      executionTool: "resource.confirm",
      executionTitle: "Ressource bestätigen",
      executionDescription: "Bestätigt die ausgewählte Ressource.",
      toolName: "resource.prepare",
      title: "Ressource prüfen",
      arguments: { resourceId: "resource-1" },
      resourceName: "Ressource 1",
      startDate: "",
      endDate: "",
      status: "pending" as const,
      expiresAt: "2100-01-01T01:00:00.000Z",
    };
    const active = updateChatSnapshot(workspace, session.id, makeSnapshot({
      messages: [
        textMessage("plugin-user", "user", "Bitte Vorschlag erstellen"),
        { ...textMessage("plugin-assistant", "assistant", "Bitte prüfen."), proposal },
      ],
      activeProposal: proposal.id,
    }), now);
    const storage = new MemoryStorage();
    expect(saveChatWorkspace(active, storage)).toBe(true);
    const restored = loadChatWorkspace("user-1", storage).workspace.sessions[0]?.snapshot;
    expect(restored?.activeProposal).toBe(proposal.id);
    expect(restored?.messages[1]?.proposal).toEqual(proposal);
  });
});
