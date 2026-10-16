import { z } from "zod";
import {
  CHAT_TOOL_NAMES,
  MODEL_PROFILE_IDS,
  chatRequestSchema,
  chatToolSchemas,
  type ChatToolName,
  type ModelProfileId,
  type WireMessage,
} from "./chat-contract";
import { knowledgeDocumentSchema, type KnowledgeDocument } from "./knowledge";
import type { RoomRequest } from "./chat-demo";
import type { Booking, Resource, TimeInterval } from "./types";

export const MAX_CHAT_SESSIONS = 20;
export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_HISTORY = 64;
export const MAX_CHAT_WORKSPACE_BYTES = 2 * 1024 * 1024;

export type ChatProposal = {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "confirmed" | "outcome_unknown" | "failed";
  expiresAt: string;
};

export type ChatRoomOption = {
  resource: Resource;
  intervals: TimeInterval[];
  checked: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tool?: string;
  rooms?: ChatRoomOption[];
  sources?: KnowledgeDocument[];
  proposal?: ChatProposal;
  bookings?: Booking[];
  confirmed?: boolean;
  model?: string;
  interactionId?: string;
};

export type ChatProfileId = ModelProfileId | "offline";

export type ChatSnapshot = {
  messages: ChatMessage[];
  history: WireMessage[];
  input: string;
  profileId: ChatProfileId;
  request: RoomRequest;
  roomContext: boolean;
  chosenRoom: Resource | null;
  activeResult: string | null;
  activeProposal: string | null;
  interrupted: boolean;
  messagesTruncated: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  titleSource: "auto" | "manual";
  createdAt: string;
  updatedAt: string;
  snapshot: ChatSnapshot;
};

export type ChatWorkspace = {
  version: 1;
  ownerId: string;
  activeId: string;
  sessions: ChatSession[];
};

export type ChatStorageReader = { getItem(key: string): string | null };
export type ChatStorageWriter = { setItem(key: string, value: string): void };

const STORAGE_PREFIX = "hasi:chat-workspace:v1:";
const DEFAULT_PROFILE: ChatProfileId = "groq-oss-120b";
const DEFAULT_TITLE = "Neuer Chat";
const HISTORY_SENTINEL = " ";
const ownerIdSchema = z.string().trim().min(1).max(256);
const idSchema = z.string().trim().min(1).max(128);
const offsetDateTimeSchema = z.iso.datetime({ offset: true });

const plainTextSchema = (maximum: number) =>
  z.string().max(maximum).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Text contains unsupported control characters.",
  );

const resourceSchema = z.strictObject({
  id: idSchema,
  name: plainTextSchema(160),
  description: plainTextSchema(320),
  capacity: z.number().int().min(1).max(10_000).nullable(),
  location: plainTextSchema(140),
  features: z.array(plainTextSchema(48)).max(12),
  serviceId: idSchema,
  kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']).optional(),
  parentId: idSchema.nullable().optional(),
  parentName: plainTextSchema(160).nullable().optional(),
});

const intervalSchema = z
  .strictObject({
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    available: z.boolean(),
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

const proposalSchema = z
  .strictObject({
    id: idSchema,
    resourceName: plainTextSchema(160),
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    status: z.enum(["pending", "confirmed", "outcome_unknown", "failed"]),
    expiresAt: offsetDateTimeSchema,
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

const bookingSchema = z
  .strictObject({
    id: idSchema,
    resourceName: plainTextSchema(160),
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    status: plainTextSchema(64),
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

const chatMessageSchema = z.strictObject({
  id: idSchema,
  role: z.enum(["user", "assistant"]),
  text: plainTextSchema(8_000),
  tool: plainTextSchema(128).optional(),
  rooms: z
    .array(
      z.strictObject({
        resource: resourceSchema,
        intervals: z.array(intervalSchema).max(8),
        checked: z.boolean(),
      }),
    )
    .max(8)
    .optional(),
  sources: z.array(knowledgeDocumentSchema).max(5).optional(),
  proposal: proposalSchema.optional(),
  bookings: z.array(bookingSchema).max(10).optional(),
  confirmed: z.boolean().optional(),
  model: plainTextSchema(128).optional(),
  interactionId: idSchema.optional(),
});

const roomRequestSchema = z.strictObject({
  kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']).optional(),
  date: plainTextSchema(32).optional(),
  time: plainTextSchema(32).optional(),
  durationMinutes: z.number().int().min(0).max(10_080).optional(),
  capacity: z.number().int().min(0).max(10_000).optional(),
  features: z.array(plainTextSchema(128)).max(20).optional(),
  location: plainTextSchema(300).optional(),
  query: plainTextSchema(500).optional(),
});

const snapshotEnvelopeSchema = z.strictObject({
  messages: z.array(chatMessageSchema).max(MAX_CHAT_MESSAGES),
  history: z.array(z.unknown()).max(MAX_CHAT_HISTORY),
  input: plainTextSchema(4_000),
  profileId: z.enum([...MODEL_PROFILE_IDS, "offline"]),
  request: roomRequestSchema,
  roomContext: z.boolean(),
  chosenRoom: resourceSchema.nullable(),
  activeResult: idSchema.nullable(),
  activeProposal: idSchema.nullable(),
  interrupted: z.boolean().optional().default(false),
  messagesTruncated: z.boolean().optional().default(false),
});

const titleSourceSchema = z.enum(["auto", "manual"]);

const sessionEnvelopeSchema = z.strictObject({
  id: idSchema,
  title: plainTextSchema(64).refine((value) => value.trim().length > 0),
  titleSource: titleSourceSchema.optional().default("auto"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  snapshot: z.unknown(),
});

const workspaceEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  ownerId: ownerIdSchema,
  activeId: idSchema,
  sessions: z.array(z.unknown()).min(1).max(MAX_CHAT_SESSIONS),
});

const incompleteToolCallSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  name: z.enum(CHAT_TOOL_NAMES),
  arguments: z.record(z.string(), z.unknown()),
});

const incompleteAssistantToolMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: plainTextSchema(4_000),
  toolCalls: z.array(incompleteToolCallSchema).min(1).max(4),
});

const incompleteToolResultSchema = z.strictObject({
  role: z.literal("tool"),
  content: plainTextSchema(8_000),
  toolCallId: z.string().trim().min(1).max(128),
  name: z.enum(CHAT_TOOL_NAMES),
});

const finalAssistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: plainTextSchema(4_000),
  toolCalls: z.never().optional(),
});

const freshWorkspaceNotice = "Die gespeicherten Chats sind ungültig oder nicht unterstützt. Ein neuer Chat wurde angelegt.";
const storageUnavailableNotice = "Der Chat-Speicher ist derzeit nicht verfügbar.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(now: Date): string {
  const value = now.toISOString();
  return value;
}

function generateId(): string {
  return globalThis.crypto.randomUUID();
}

function emptySnapshot(profileId: ChatProfileId): ChatSnapshot {
  return {
    messages: [],
    history: [],
    input: "",
    profileId,
    request: {},
    roomContext: false,
    chosenRoom: null,
    activeResult: null,
    activeProposal: null,
    interrupted: false,
    messagesTruncated: false,
  };
}

function truncateDisplayMessages(value: unknown, enabled: boolean): { value: unknown; truncated: boolean } {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return { value, truncated: false };
  }
  if (!enabled || value.messages.length <= MAX_CHAT_MESSAGES) {
    return { value, truncated: value.messages.length > MAX_CHAT_MESSAGES };
  }
  return {
    value: { ...value, messages: value.messages.slice(-MAX_CHAT_MESSAGES), messagesTruncated: true },
    truncated: true,
  };
}

function profileForHistory(profileId: ChatProfileId): ModelProfileId {
  return profileId === "offline" ? "groq-oss-120b" : profileId;
}

function parseWithSentinel(messages: unknown[], profileId: ChatProfileId) {
  return chatRequestSchema.safeParse({
    profileId: profileForHistory(profileId),
    messages: [...messages, { role: "user", content: HISTORY_SENTINEL }],
  });
}

function salvageInterruptedToolExchange(messages: unknown[], profileId: ChatProfileId): WireMessage[] | null {
  if (messages.length === 0) return null;

  let exchangeStart = -1;
  let assistantResult: z.infer<typeof incompleteAssistantToolMessageSchema> | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = incompleteAssistantToolMessageSchema.safeParse(messages[index]);
    if (parsed.success) {
      exchangeStart = index;
      assistantResult = parsed.data;
      break;
    }
  }
  if (exchangeStart < 0 || assistantResult === null) return null;

  const prior = messages.slice(0, exchangeStart);
  const priorLast = prior.at(-1);
  if (isRecord(priorLast) && priorLast.role === "assistant") return null;
  const priorResult = parseWithSentinel(prior, profileId);
  if (!priorResult.success) return null;

  const pending = new Map<string, ChatToolName>();
  for (const [index, call] of assistantResult.toolCalls.entries()) {
    if (pending.has(call.id) || !chatToolSchemas[call.name].safeParse(call.arguments).success) {
      return null;
    }
    pending.set(call.id, call.name);
    if (index > 3) return null;
  }

  for (const rawResult of messages.slice(exchangeStart + 1)) {
    const parsed = incompleteToolResultSchema.safeParse(rawResult);
    if (!parsed.success) return null;
    const expectedName = pending.get(parsed.data.toolCallId);
    if (expectedName === undefined || expectedName !== parsed.data.name) return null;
    pending.delete(parsed.data.toolCallId);
  }
  if (pending.size === 0) return null;
  return priorResult.data.messages.slice(0, -1);
}

function normalizeHistory(value: unknown, profileId: ChatProfileId): WireMessage[] | null {
  if (!Array.isArray(value) || value.length > MAX_CHAT_HISTORY) return null;

  const sentinelResult = parseWithSentinel(value, profileId);
  if (sentinelResult.success) {
    return sentinelResult.data.messages.slice(0, -1);
  }

  if (value.length === MAX_CHAT_HISTORY) {
    const directResult = chatRequestSchema.safeParse({
      profileId: profileForHistory(profileId),
      messages: value,
    });
    if (directResult.success) return directResult.data.messages;

    const finalMessage = finalAssistantMessageSchema.safeParse(value.at(-1));
    if (finalMessage.success) {
      const prior = value.slice(0, -1);
      const priorLast = prior.at(-1);
      if (isRecord(priorLast) && priorLast.role === "assistant") return null;
      const priorResult = parseWithSentinel(prior, profileId);
      if (!priorResult.success) return null;
      const totalContent = priorResult.data.messages
        .slice(0, -1)
        .reduce((total, message) => total + message.content.length, finalMessage.data.content.length);
      if (totalContent > 30_000) return null;
      return [...priorResult.data.messages.slice(0, -1), finalMessage.data];
    }
  }

  return salvageInterruptedToolExchange(value, profileId);
}

function activeProposalIsUsable(
  messages: ChatMessage[],
  activeProposal: string | null,
  now: Date,
): boolean {
  if (activeProposal === null) return false;
  return messages.some(({ proposal }) =>
    proposal?.id === activeProposal
    && proposal.status === "pending"
    && Date.parse(proposal.expiresAt) > now.getTime(),
  );
}

function parseSnapshot(value: unknown, options: { trimMessages: boolean; now: Date }): ChatSnapshot | null {
  const trimmed = truncateDisplayMessages(value, options.trimMessages);
  const parsed = snapshotEnvelopeSchema.safeParse(trimmed.value);
  if (!parsed.success) return null;

  const history = normalizeHistory(parsed.data.history, parsed.data.profileId);
  if (history === null) return null;

  const activeProposal = activeProposalIsUsable(
    parsed.data.messages,
    parsed.data.activeProposal,
    options.now,
  ) ? parsed.data.activeProposal : null;

  return {
    ...parsed.data,
    history,
    activeProposal,
    messagesTruncated: parsed.data.messagesTruncated || trimmed.truncated,
  };
}

function cleanTitle(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  let title = "";
  for (const character of normalized) {
    if (title.length + character.length > 64) break;
    title += character;
  }
  return title;
}

function automaticTitle(messages: ChatMessage[]): string | null {
  const firstUserMessage = messages.find(({ role }) => role === "user");
  if (!firstUserMessage) return null;
  return cleanTitle(firstUserMessage.text) || null;
}

function getDefaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function serializedSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeWorkspace(value: unknown, expectedOwnerId: string, now: Date): ChatWorkspace | null {
  const parsedWorkspace = workspaceEnvelopeSchema.safeParse(value);
  if (!parsedWorkspace.success || parsedWorkspace.data.ownerId !== expectedOwnerId) return null;

  const sessions: ChatSession[] = [];
  const ids = new Set<string>();
  for (const rawSession of parsedWorkspace.data.sessions) {
    const parsedSession = sessionEnvelopeSchema.safeParse(rawSession);
    if (!parsedSession.success || ids.has(parsedSession.data.id)) return null;
    if (Date.parse(parsedSession.data.updatedAt) < Date.parse(parsedSession.data.createdAt)) return null;

    const snapshot = parseSnapshot(parsedSession.data.snapshot, { trimMessages: false, now });
    if (snapshot === null) return null;

    ids.add(parsedSession.data.id);
    sessions.push({ ...parsedSession.data, snapshot });
  }

  if (!ids.has(parsedWorkspace.data.activeId)) return null;
  return {
    version: 1,
    ownerId: parsedWorkspace.data.ownerId,
    activeId: parsedWorkspace.data.activeId,
    sessions,
  };
}

export function chatStorageKey(ownerId: string): string {
  const owner = ownerIdSchema.parse(ownerId);
  return `${STORAGE_PREFIX}${encodeURIComponent(owner)}`;
}

export function createChatSession(
  profileId: ChatProfileId = DEFAULT_PROFILE,
  now = new Date(),
): ChatSession {
  const profile = z.enum([...MODEL_PROFILE_IDS, "offline"]).parse(profileId);
  const createdAt = timestamp(now);
  return {
    id: generateId(),
    title: DEFAULT_TITLE,
    titleSource: "auto",
    createdAt,
    updatedAt: createdAt,
    snapshot: emptySnapshot(profile),
  };
}

export function createChatWorkspace(ownerId: string): ChatWorkspace {
  const owner = ownerIdSchema.parse(ownerId);
  const session = createChatSession();
  return { version: 1, ownerId: owner, activeId: session.id, sessions: [session] };
}

export function loadChatWorkspace(
  ownerId: string,
  storage?: ChatStorageReader,
): { workspace: ChatWorkspace; notice: string | null } {
  const owner = ownerIdSchema.parse(ownerId);
  const resolvedStorage = storage ?? getDefaultStorage();
  if (resolvedStorage === null) {
    return { workspace: createChatWorkspace(owner), notice: storageUnavailableNotice };
  }

  let serialized: string | null;
  try {
    serialized = resolvedStorage.getItem(chatStorageKey(owner));
  } catch {
    return { workspace: createChatWorkspace(owner), notice: storageUnavailableNotice };
  }
  if (serialized === null) return { workspace: createChatWorkspace(owner), notice: null };
  if (serializedSize(serialized) > MAX_CHAT_WORKSPACE_BYTES) {
    return { workspace: createChatWorkspace(owner), notice: freshWorkspaceNotice };
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return { workspace: createChatWorkspace(owner), notice: freshWorkspaceNotice };
  }

  const workspace = normalizeWorkspace(value, owner, new Date());
  return workspace === null
    ? { workspace: createChatWorkspace(owner), notice: freshWorkspaceNotice }
    : { workspace, notice: null };
}

export function saveChatWorkspace(
  workspace: ChatWorkspace,
  storage?: ChatStorageWriter,
): boolean {
  const resolvedStorage = storage ?? getDefaultStorage();
  if (resolvedStorage === null) return false;

  try {
    const normalized = normalizeWorkspace(workspace, workspace.ownerId, new Date());
    if (normalized === null) return false;
    const serialized = JSON.stringify(normalized);
    if (serializedSize(serialized) > MAX_CHAT_WORKSPACE_BYTES) return false;
    resolvedStorage.setItem(chatStorageKey(normalized.ownerId), serialized);
    return true;
  } catch {
    return false;
  }
}

export function updateChatSnapshot(
  workspace: ChatWorkspace,
  sessionId: string,
  snapshot: ChatSnapshot,
  now = new Date(),
): ChatWorkspace {
  const sessionIndex = workspace.sessions.findIndex(({ id }) => id === sessionId);
  if (sessionIndex < 0) return workspace;

  const normalizedSnapshot = parseSnapshot(snapshot, { trimMessages: true, now });
  if (normalizedSnapshot === null) {
    throw new TypeError("The chat snapshot does not match the persistence contract.");
  }

  const sessions = workspace.sessions.slice();
  const session = sessions[sessionIndex]!;
  const title = session.titleSource === "auto"
    ? automaticTitle(normalizedSnapshot.messages) ?? session.title
    : session.title;
  sessions[sessionIndex] = {
    ...session,
    title,
    updatedAt: timestamp(now),
    snapshot: normalizedSnapshot,
  };
  return { ...workspace, sessions };
}

export function selectChat(workspace: ChatWorkspace, id: string): ChatWorkspace {
  if (!workspace.sessions.some((session) => session.id === id) || workspace.activeId === id) {
    return workspace;
  }
  return { ...workspace, activeId: id };
}

export function renameChat(workspace: ChatWorkspace, id: string, title: string): ChatWorkspace {
  const sessionIndex = workspace.sessions.findIndex((session) => session.id === id);
  if (sessionIndex < 0) return workspace;
  const normalizedTitle = cleanTitle(title);
  if (normalizedTitle.length === 0) return workspace;

  const sessions = workspace.sessions.slice();
  sessions[sessionIndex] = {
    ...sessions[sessionIndex]!,
    title: normalizedTitle,
    titleSource: "manual",
  };
  return { ...workspace, sessions };
}

export function deleteChat(workspace: ChatWorkspace, id: string, now = new Date()): ChatWorkspace {
  const removed = workspace.sessions.find((session) => session.id === id);
  if (!removed) return workspace;

  const sessions = workspace.sessions.filter((session) => session.id !== id);
  if (sessions.length === 0) {
    const freshSession = createChatSession(removed.snapshot.profileId, now);
    return { ...workspace, activeId: freshSession.id, sessions: [freshSession] };
  }

  if (workspace.activeId !== id) return { ...workspace, sessions };
  const nextActive = sessions.reduce((latest, session) =>
    Date.parse(session.updatedAt) > Date.parse(latest.updatedAt) ? session : latest,
  );
  return { ...workspace, activeId: nextActive.id, sessions };
}
