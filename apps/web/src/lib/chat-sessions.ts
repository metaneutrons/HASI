import { hostDialogueReceiptSchema, type HostDialogueReceipt } from "./host-dialogue";
import { actionPreviewSchema, type ActionPreview } from "./action-preview";
import { z } from "zod";
import {
  chatToolCallNameSchema,
  isChatToolName,
  chatProfileIdSchema,
  messageMetadataShape,
  knowledgeEvidenceSchema,
  type KnowledgeEvidence,
  messageTimestampSchema,
  type MessageTimestamp,
  chatRequestSchema,
  chatToolSchemas,
  type ChatToolCallName,
  type ModelProfileId,
  type WireMessage,
} from "./chat-contract";
import { knowledgeDocumentSchema, type KnowledgeDocument } from "./knowledge";
import type { RoomRequest } from "./chat-demo";
import type { Booking, Resource, TimeInterval } from "./types";
import { boundedPluginToolResult, type PluginToolProposal } from "./plugin-tools";

export const MAX_CHAT_SESSIONS = 20;
export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_HISTORY = 64;
export const MAX_CHAT_WORKSPACE_BYTES = 2 * 1024 * 1024;

export interface AnnyChatProposal {
  preview?: ActionPreview | undefined;
  action?: "book" | "cancel_booking";
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "executing" | "confirmed" | "outcome_unknown" | "failed" | "invalidated";
  expiresAt: string;
}

export type ChatProposal = AnnyChatProposal | PluginToolProposal;

export interface ChatRoomOption {
  requestedStartDate?: string;
  requestedEndDate?: string;
  resource: Resource;
  intervals: TimeInterval[];
  checked: boolean;
}

export interface ChatMessage {
  id: string;
  timestamp?: MessageTimestamp;
  role: "user" | "assistant";
  text: string;
  tool?: string;
  rooms?: ChatRoomOption[];
  sources?: KnowledgeDocument[];
  sourceContextId?: string;
  pluginResultContextId?: string;
  evidence?: KnowledgeEvidence;
  hostDialogue?: HostDialogueReceipt;
  proposal?: ChatProposal;
  bookings?: Booking[];
  confirmed?: boolean;
  model?: string;
  interactionId?: string;
  serviceConnection?: { installationId: string; label: string; requestId: string };
}

export type ChatProfileId = z.infer<typeof chatProfileIdSchema>;

export interface ChatSnapshot {
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
}

export interface ChatSession {
  id: string;
  title: string;
  titleSource: "auto" | "manual";
  createdAt: string;
  updatedAt: string;
  snapshot: ChatSnapshot;
}

export interface ChatWorkspace {
  version: 1;
  ownerId: string;
  activeId: string;
  sessions: ChatSession[];
}

export interface ChatStorageReader { getItem(key: string): string | null }
export interface ChatStorageWriter { setItem(key: string, value: string): void }

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

export const resourceSchema = z.strictObject({
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
  officeWorkplaceCount: z.number().int().min(1).max(10_000).nullable().optional(),
});

const intervalSchema = z
  .strictObject({
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    available: z.boolean(),
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

export const proposalSchema = z
  .strictObject({
    preview: actionPreviewSchema.optional(),
    action: z.enum(["book", "cancel_booking"]).optional(),
    id: idSchema,
    resourceName: plainTextSchema(160),
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    status: z.enum(["pending", "executing", "confirmed", "outcome_unknown", "failed", "invalidated"]),
    expiresAt: offsetDateTimeSchema,
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

const pluginProposalArgumentsSchema = z.record(z.string().max(256), z.unknown()).superRefine((value, context) => {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > 8_000 || JSON.stringify(boundedPluginToolResult(value)) !== serialized) {
      context.addIssue({ code: "custom", message: "Plugin proposal arguments exceed the storage bounds." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Plugin proposal arguments are not valid JSON." });
  }
});

const pluginToolProposalSchema = z.strictObject({
  preview: actionPreviewSchema.optional(),
  action: z.literal("execute_tool"),
  id: z.uuid(),
  pluginId: z.string().min(1).max(128),
  executionTool: z.string().min(1).max(128),
  executionTitle: plainTextSchema(256).optional(),
  executionDescription: plainTextSchema(4_096).optional(),
  toolName: z.string().min(1).max(128),
  title: plainTextSchema(256),
  arguments: pluginProposalArgumentsSchema,
  resourceName: plainTextSchema(200),
  startDate: z.string().max(64),
  endDate: z.string().max(64),
  status: z.enum(["pending", "executing", "confirmed", "outcome_unknown", "failed", "invalidated"]),
  expiresAt: offsetDateTimeSchema,
});

export const bookingSchema = z
  .strictObject({
    id: idSchema,
    resourceName: plainTextSchema(160),
    startDate: offsetDateTimeSchema,
    endDate: offsetDateTimeSchema,
    status: plainTextSchema(64),
  })
  .refine(({ startDate, endDate }) => Date.parse(endDate) > Date.parse(startDate));

const chatMessageSchema = z.strictObject({
  timestamp: messageTimestampSchema.optional(),
  id: idSchema,
  role: z.enum(["user", "assistant"]),
  text: plainTextSchema(8_000),
  tool: plainTextSchema(128).optional(),
  rooms: z
    .array(
      z.strictObject({
        requestedStartDate: offsetDateTimeSchema.optional(),
        requestedEndDate: offsetDateTimeSchema.optional(),
        resource: resourceSchema,
        intervals: z.array(intervalSchema).max(8),
        checked: z.boolean(),
      }),
    )
    .max(8)
    .optional(),
  sources: z.array(knowledgeDocumentSchema).max(5).optional(),
  sourceContextId: z.uuid().optional(),
  pluginResultContextId: z.uuid().optional(),
  evidence: knowledgeEvidenceSchema.optional(),
  hostDialogue: hostDialogueReceiptSchema.optional(),
  proposal: z.union([proposalSchema, pluginToolProposalSchema]).optional(),
  bookings: z.array(bookingSchema).max(10).optional(),
  confirmed: z.boolean().optional(),
  model: plainTextSchema(128).optional(),
  interactionId: idSchema.optional(),
  serviceConnection: z.strictObject({ installationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), label: plainTextSchema(200), requestId: z.uuid() }).optional(),
});

export const roomRequestSchema = z.strictObject({
  kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']).optional(),
  officeType: z.enum(["single", "shared", "any"]).optional(),
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
  profileId: chatProfileIdSchema,
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
  name: chatToolCallNameSchema,
  arguments: z.record(z.string(), z.unknown()),
});

const incompleteAssistantToolMessageSchema = z.strictObject({
  evidence: knowledgeEvidenceSchema.optional(),
  ...messageMetadataShape,
  role: z.literal("assistant"),
  content: plainTextSchema(4_000),
  toolCalls: z.array(incompleteToolCallSchema).min(1).max(4),
});

const incompleteToolResultSchema = z.strictObject({
  ...messageMetadataShape,
  role: z.literal("tool"),
  content: plainTextSchema(8_000),
  toolCallId: z.string().trim().min(1).max(128),
  name: chatToolCallNameSchema,
  toolContextId: z.uuid().optional(),
});

const finalAssistantMessageSchema = z.strictObject({
  evidence: knowledgeEvidenceSchema.optional(),
  ...messageMetadataShape,
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

  const pending = new Map<string, ChatToolCallName>();
  for (const [index, call] of assistantResult.toolCalls.entries()) {
    if (pending.has(call.id) || isChatToolName(call.name) && !chatToolSchemas[call.name].safeParse(call.arguments).success) {
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
  const entries: unknown[] = value;

  const sentinelResult = parseWithSentinel(entries, profileId);
  if (sentinelResult.success) {
    return sentinelResult.data.messages.slice(0, -1);
  }

  if (entries.length === MAX_CHAT_HISTORY) {
    const directResult = chatRequestSchema.safeParse({
      profileId: profileForHistory(profileId),
      messages: entries,
    });
    if (directResult.success) return directResult.data.messages;

    const finalMessage = finalAssistantMessageSchema.safeParse(entries.at(-1));
    if (finalMessage.success) {
      const prior = entries.slice(0, -1);
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

export function normalizeRoomRequest(request: z.infer<typeof roomRequestSchema>): RoomRequest {
  return {
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.officeType === undefined ? {} : { officeType: request.officeType }),
    ...(request.date === undefined ? {} : { date: request.date }),
    ...(request.time === undefined ? {} : { time: request.time }),
    ...(request.durationMinutes === undefined ? {} : { durationMinutes: request.durationMinutes }),
    ...(request.capacity === undefined ? {} : { capacity: request.capacity }),
    ...(request.features === undefined ? {} : { features: request.features }),
    ...(request.location === undefined ? {} : { location: request.location }),
    ...(request.query === undefined ? {} : { query: request.query }),
  };
}

export function normalizeResource(resource: z.infer<typeof resourceSchema>): Resource {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    capacity: resource.capacity,
    location: resource.location,
    features: resource.features,
    serviceId: resource.serviceId,
    ...(resource.kind === undefined ? {} : { kind: resource.kind }),
    ...(resource.parentId === undefined ? {} : { parentId: resource.parentId }),
    ...(resource.parentName === undefined ? {} : { parentName: resource.parentName }),
    ...(resource.officeWorkplaceCount === undefined ? {} : { officeWorkplaceCount: resource.officeWorkplaceCount }),
  };
}

function normalizeChatMessage(message: z.infer<typeof chatMessageSchema>): ChatMessage {
  const proposal: ChatProposal | undefined = message.proposal === undefined
    ? undefined
    : message.proposal.action === "execute_tool"
      ? {
          action: "execute_tool",
          ...(message.proposal.preview === undefined ? {} : { preview: message.proposal.preview }),
          id: message.proposal.id,
          pluginId: message.proposal.pluginId,
          executionTool: message.proposal.executionTool,
          ...(message.proposal.executionTitle === undefined ? {} : { executionTitle: message.proposal.executionTitle }),
          ...(message.proposal.executionDescription === undefined ? {} : { executionDescription: message.proposal.executionDescription }),
          toolName: message.proposal.toolName,
          title: message.proposal.title,
          arguments: message.proposal.arguments,
          resourceName: message.proposal.resourceName,
          startDate: message.proposal.startDate,
          endDate: message.proposal.endDate,
          status: message.proposal.status,
          expiresAt: message.proposal.expiresAt,
        }
      : {
          ...(message.proposal.action === undefined ? {} : { action: message.proposal.action }),
          ...(message.proposal.preview === undefined ? {} : { preview: message.proposal.preview }),
          id: message.proposal.id,
          resourceName: message.proposal.resourceName,
          startDate: message.proposal.startDate,
          endDate: message.proposal.endDate,
          status: message.proposal.status,
          expiresAt: message.proposal.expiresAt,
        };
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.tool === undefined ? {} : { tool: message.tool }),
    ...(message.rooms === undefined ? {} : {
      rooms: message.rooms.map((room) => ({
        ...(room.requestedStartDate === undefined ? {} : { requestedStartDate: room.requestedStartDate }),
        ...(room.requestedEndDate === undefined ? {} : { requestedEndDate: room.requestedEndDate }),
        resource: normalizeResource(room.resource),
        intervals: room.intervals,
        checked: room.checked,
      })),
    }),
    ...(message.sources === undefined ? {} : { sources: message.sources }),
    ...(message.sourceContextId === undefined ? {} : { sourceContextId: message.sourceContextId }),
    ...(message.pluginResultContextId === undefined ? {} : { pluginResultContextId: message.pluginResultContextId }),
    ...(message.evidence === undefined ? {} : { evidence: message.evidence }),
    ...(message.hostDialogue === undefined ? {} : { hostDialogue: message.hostDialogue }),
    ...(proposal === undefined ? {} : { proposal }),
    ...(message.bookings === undefined ? {} : { bookings: message.bookings }),
    ...(message.confirmed === undefined ? {} : { confirmed: message.confirmed }),
    ...(message.model === undefined ? {} : { model: message.model }),
    ...(message.interactionId === undefined ? {} : { interactionId: message.interactionId }),
    ...(message.serviceConnection === undefined ? {} : { serviceConnection: message.serviceConnection }),
  };
}

function parseSnapshot(value: unknown, options: { trimMessages: boolean; now: Date }): ChatSnapshot | null {
  const trimmed = truncateDisplayMessages(value, options.trimMessages);
  const parsed = snapshotEnvelopeSchema.safeParse(trimmed.value);
  if (!parsed.success) return null;

  const history = normalizeHistory(parsed.data.history, parsed.data.profileId);
  if (history === null) return null;
  const messages = parsed.data.messages.map(normalizeChatMessage);

  const activeProposal = activeProposalIsUsable(
    messages,
    parsed.data.activeProposal,
    options.now,
  ) ? parsed.data.activeProposal : null;

  return {
    ...parsed.data,
    messages,
    request: normalizeRoomRequest(parsed.data.request),
    chosenRoom: parsed.data.chosenRoom === null ? null : normalizeResource(parsed.data.chosenRoom),
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
  const profile = chatProfileIdSchema.parse(profileId);
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
  const session = sessions[sessionIndex];
  if (!session) return workspace;
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
  const session = sessions[sessionIndex];
  if (!session) return workspace;
  sessions[sessionIndex] = {
    ...session,
    title: normalizedTitle,
    titleSource: "manual",
  };
  return { ...workspace, sessions };
}

export function deleteChat(workspace: ChatWorkspace, id: string, now = new Date(), defaultProfileId: ChatProfileId = DEFAULT_PROFILE): ChatWorkspace {
  const removed = workspace.sessions.find((session) => session.id === id);
  if (!removed) return workspace;

  const sessions = workspace.sessions.filter((session) => session.id !== id);
  if (sessions.length === 0) {
    const freshSession = createChatSession(defaultProfileId, now);
    return { ...workspace, activeId: freshSession.id, sessions: [freshSession] };
  }

  if (workspace.activeId !== id) return { ...workspace, sessions };
  const nextActive = sessions.reduce((latest, session) =>
    Date.parse(session.updatedAt) > Date.parse(latest.updatedAt) ? session : latest,
  );
  return { ...workspace, activeId: nextActive.id, sessions };
}

/** Strict owner-bound parser for the production workspace boundary; never silently resets invalid writes. */
export function parseChatWorkspace(value: unknown, ownerId: string): ChatWorkspace {
  const owner = ownerIdSchema.parse(ownerId);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CHAT_WORKSPACE_BYTES) throw new Error("Oversized chat workspace");
  const normalized = normalizeWorkspace(value, owner, new Date());
  if (!normalized) throw new Error("Invalid chat workspace");
  return normalized;
}
