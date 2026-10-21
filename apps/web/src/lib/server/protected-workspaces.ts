import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@hasi/plugin-sdk";
import type { JsonStore } from "@hasi/state";
import { z } from "zod";
import {
  createChatWorkspace,
  parseChatWorkspace,
  type ChatMessage,
  type ChatWorkspace,
} from "../chat-sessions";
import type { NativeHistoryAccess, NativeHistoryResolver } from "./native-history";
import { actionReferenceKey, actionReferencesSchema, retainedActionReferences, updatedActionReferences,
  UNAVAILABLE_ANSWER, type ActionHistoryReference } from "./action-history-references";
import { createHostDialogueSigner } from "./host-dialogue";
import { proposalPresentation } from "../proposal-presentation";
import { compactPluginToolResult, MODEL_PLUGIN_TOOL_NAME } from "../plugin-tools";
import { knowledgeDocumentSchema, knowledgeSourceSummary, type KnowledgeDocument } from "../knowledge";
import type { KnowledgeEvidence, WireMessage } from "../chat-contract";
import {
  createKnowledgeEvidence,
  rebuildKnowledgeContext,
  type KnowledgeContextResolver,
  type PluginResultContextResolver,
  type ResolvedKnowledgeContext,
} from "./knowledge-evidence";
import type { PluginResultContext } from "./plugin-result-context";

const WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONTEXTS_PER_SESSION = 32;
const MAX_CONTEXT_DOCUMENTS = 5;
const MAX_CONTEXT_DOCUMENT_BYTES = 64 * 1024;
const WORKSPACE_KEY_INFO = "hasi-protected-chat-workspace-v1";
const UNAVAILABLE_SOURCES = "Diese frühere Quellenkarte ist nicht mehr verfügbar. Bitte suche erneut.";
const UNAVAILABLE_PLUGIN_RESULT = "Dieses frühere Plugin-Ergebnis ist nicht mehr verfügbar. Bitte frage erneut.";

const storedWorkspaceSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.string().min(1).max(256),
  scope: z.string().min(1).max(512),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  workspace: z.unknown(),
  actionReferences: actionReferencesSchema.optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
type SafeResolvedContext = ResolvedKnowledgeContext & { documents: KnowledgeDocument[] };
type SignedAssistantMessage = Extract<WireMessage, { role: "assistant" }> & { evidence: KnowledgeEvidence };

export interface ProtectedWorkspaceSnapshot {
  readonly revision: string | null;
  readonly workspace: ChatWorkspace;
}

export interface ProtectedWorkspaceOptions {
  readonly store: Pick<JsonStore, "read" | "compareAndSet">;
  readonly ownerId: string;
  readonly scope: string;
  readonly secret: string;
  readonly resolve: KnowledgeContextResolver;
  readonly clock?: () => number;
  readonly resolveNative?: NativeHistoryResolver;
  readonly authority?: () => Promise<string>;
  readonly resolvePluginResults?: PluginResultContextResolver;
}

export class ProtectedWorkspaceError extends Error {
  constructor() {
    super("The protected chat workspace is unavailable.");
    this.name = "ProtectedWorkspaceError";
  }
}

export class ProtectedWorkspaceConflict extends Error {
  constructor(readonly current: ProtectedWorkspaceSnapshot) {
    super("The protected chat workspace changed in another session.");
    this.name = "ProtectedWorkspaceConflict";
  }
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isContextClass(value: unknown): value is "synthetic_demo" | "public" | "internal" | "confidential" {
  return value === "synthetic_demo" || value === "public" || value === "internal" || value === "confidential";
}

function boundedResolvedContext(value: ResolvedKnowledgeContext, expectedId: string): SafeResolvedContext | undefined {
  if (value.contextId !== expectedId || value.status !== "valid" || !Array.isArray(value.documents)
    || value.documents.length > MAX_CONTEXT_DOCUMENTS || !Array.isArray(value.dataClasses)
    || value.dataClasses.length === 0 || value.dataClasses.length > 4 || value.dataClasses.some(item => !isContextClass(item))) return undefined;
  const documents: KnowledgeDocument[] = [];
  try {
    for (const raw of value.documents) {
      const document = safeRecord(raw);
      if (!document) return undefined;
      const parsed = knowledgeDocumentSchema.safeParse(document);
      if (!parsed.success) return undefined;
      documents.push(parsed.data);
    }
    if (Buffer.byteLength(canonicalJson(documents), "utf8") > MAX_CONTEXT_DOCUMENT_BYTES) return undefined;
    const documentClasses = new Set(documents.map(document => document.synthetic ? "synthetic_demo" : document.dataClass));
    if ([...documentClasses].some(dataClass => !value.dataClasses?.includes(dataClass))) return undefined;
  } catch {
    return undefined;
  }
  return { contextId: expectedId, status: "valid", documents, dataClasses: [...new Set(value.dataClasses)] };
}

function historyContextIds(history: readonly WireMessage[], displayed: readonly ChatMessage[]): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const parsed = z.uuid().safeParse(value);
    if (parsed.success) ids.add(parsed.data);
  };
  for (const message of history) {
    if (message.role === "assistant") {
      const evidence = message.evidence;
      if (evidence) for (const contextId of evidence.contextIds) add(contextId);
    } else if (message.role === "tool" && message.name === "knowledge_search") {
      try {
        const parsed = z.object({ contextId: z.uuid() }).safeParse(JSON.parse(message.content) as unknown);
        if (parsed.success) add(parsed.data.contextId);
      } catch { /* malformed tool output contributes no source authority */ }
    }
  }
  for (const message of displayed) {
    if (message.role === "assistant") add(message.sourceContextId);
  }
  return [...ids].sort();
}

function isNativeHelperCard(message: ChatMessage): boolean {
  return message.proposal !== undefined || message.rooms !== undefined || message.bookings !== undefined
    || message.tool?.startsWith("anny ·") === true || message.tool?.startsWith("Plugin ·") === true;
}

function unavailableMessage(message: ChatMessage, text = UNAVAILABLE_ANSWER): ChatMessage {
  return {
    id: message.id,
    role: "assistant",
    text,
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
  };
}

function validModelWireMessages(history: readonly WireMessage[]): Map<string, SignedAssistantMessage> {
  const result = new Map<string, SignedAssistantMessage>();
  for (const message of history) {
    if (message.role === "assistant" && message.id && message.evidence) result.set(message.id, { ...message, evidence: message.evidence });
  }
  return result;
}

function verifiedPluginToolResults(
  history: readonly WireMessage[],
  conversationId: string,
  authority: string | undefined,
  signer: ReturnType<typeof createKnowledgeEvidence>,
  contexts: ReadonlyMap<string, PluginResultContext>,
): Map<string, PluginResultContext> {
  const matched = new Map<string, PluginResultContext>();
  const pending = new Map<string, NonNullable<SignedAssistantMessage["toolCalls"]>[number]>();
  for (const message of history) {
    if (message.role === "user") {
      pending.clear();
      continue;
    }
    if (message.role === "assistant") {
      pending.clear();
      if (signer.verify(conversationId, message, authority)) {
        message.toolCalls?.forEach(call => pending.set(call.id, call));
      }
      continue;
    }
    const call = pending.get(message.toolCallId);
    if (call?.name !== message.name) continue;
    pending.delete(message.toolCallId);
    if (!MODEL_PLUGIN_TOOL_NAME.test(message.name) || !message.toolContextId) continue;
    const context = contexts.get(message.toolContextId);
    if (context?.callId !== message.toolCallId) continue;
    if (context.modelName !== message.name || canonicalJson(context.arguments) !== canonicalJson(call.arguments)
      || message.content !== JSON.stringify(context.result)) continue;
    matched.set(context.contextId, context);
  }
  return matched;
}

function sanitizeDisplayMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
  history: readonly WireMessage[],
  contexts: ReadonlyMap<string, SafeResolvedContext>,
  pluginResults: ReadonlyMap<string, PluginResultContext>,
  native: NativeHistoryAccess,
  actionReferences: ReadonlyMap<string, ActionHistoryReference>,
  verifyHost: (message: ChatMessage) => ChatMessage | undefined,
): ChatMessage[] {
  const validWireMessages = validModelWireMessages(history);
  return messages.map((message) => {
    if (message.role === "user") {
      return { id: message.id, role: "user", text: message.text,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
    }

    const reference = actionReferences.get(actionReferenceKey(sessionId, message.id));
    if (reference) {
      const current = native.proposals.get(reference.proposalId);
      if (!current) return unavailableMessage(message);
      // Account renewal can restore a freshly authorized receipt, never its old consent.
      const proposal = reference.readOnly && current.status === "pending" ? { ...current, status: "invalidated" as const } : current;
      return { id: message.id, role: "assistant", proposal, tool: "Aktion · Aktueller Beleg",
        text: proposalPresentation(proposal).summary,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
    }

    if (message.pluginResultContextId !== undefined) {
      const allowedFields = new Set(["id", "role", "text", "timestamp", "tool", "pluginResultContextId"]);
      const context = pluginResults.get(message.pluginResultContextId);
      if (!context || Object.keys(message).some(key => !allowedFields.has(key))) {
        return unavailableMessage(message, UNAVAILABLE_PLUGIN_RESULT);
      }
      return {
        id: message.id,
        role: "assistant",
        text: compactPluginToolResult(context.result),
        tool: `Plugin · ${context.title}`,
        pluginResultContextId: context.contextId,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    }
    if (message.text === UNAVAILABLE_PLUGIN_RESULT) return unavailableMessage(message, UNAVAILABLE_PLUGIN_RESULT);

    if (message.hostDialogue !== undefined) return verifyHost(message) ?? unavailableMessage(message);
    const contextId = message.sourceContextId;
    if (message.sources !== undefined || contextId !== undefined) {
      const context = contextId ? contexts.get(contextId) : undefined;
      if (!contextId || context?.status !== "valid") return unavailableMessage(message, UNAVAILABLE_SOURCES);
      return {
        id: message.id,
        role: "assistant",
        text: knowledgeSourceSummary(context.documents),
        sources: context.documents,
        sourceContextId: contextId,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    }

    const wire = validWireMessages.get(message.id);
    if (wire?.content === message.text) {
      return {
        id: message.id,
        role: "assistant",
        text: wire.content,
        evidence: wire.evidence,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        ...(message.model === undefined ? {} : { model: message.model }),
      };
    }
    if (message.evidence !== undefined) return unavailableMessage(message);
    if (isNativeHelperCard(message)) {
      const base = { id: message.id, role: "assistant" as const,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
      if (message.rooms !== undefined) {
        const resources = new Map(native.resources.map(resource => [resource.id, resource]));
        const rooms = message.rooms.flatMap(room => {
          const resource = resources.get(room.resource.id);
          return resource ? [{ resource, intervals: [], checked: false,
            ...(room.requestedStartDate ? { requestedStartDate: room.requestedStartDate } : {}),
            ...(room.requestedEndDate ? { requestedEndDate: room.requestedEndDate } : {}) }] : [];
        });
        // This bounded correlation ID only groups host UI cards and enables
        // rechecking a selected resource. It is not model/tool/write authority.
        return rooms.length ? { ...base, ...(message.interactionId ? { interactionId: message.interactionId } : {}),
          tool: "anny · Frühere Suchergebnisse", rooms,
          text: "Aktuell freigegebene Ressourcen aus deiner früheren Suche. Prüfe die Verfügbarkeit erneut." }
          : unavailableMessage(message);
      }
      if (message.bookings !== undefined) {
        const ids = new Set(message.bookings.map(booking => booking.id));
        const bookings = native.bookings.filter(booking => ids.has(booking.id)).slice(0, 10);
        return bookings.length ? { ...base, tool: "anny · Eigene Buchungen", bookings, text: "Aktueller Stand deiner früher angezeigten Buchungen." }
          : unavailableMessage(message);
      }
      if (message.proposal !== undefined) {
        const proposal = native.proposals.get(message.proposal.id);
        return proposal ? { ...base, proposal, tool: "Aktion · Aktueller Beleg",
          text: proposalPresentation(proposal).summary } : unavailableMessage(message);
      }
      // Browser-authored labels, confirmations and free-form tool text are not evidence.
      return unavailableMessage(message);
    }
    return unavailableMessage(message);
  });
}

function safeHistoryFallback(): WireMessage[] {
  // If evidence verification itself fails, no old assistant/tool context may
  // continue to the next model call. The UI retains user-authored messages.
  return [];
}

export class ProtectedWorkspaceStore {
  private readonly clock: () => number;
  private readonly signer: ReturnType<typeof createKnowledgeEvidence>;
  private readonly key: Buffer;
  private readonly hostSigner: ReturnType<typeof createHostDialogueSigner>;

  constructor(private readonly options: ProtectedWorkspaceOptions) {
    if (!options.ownerId || options.ownerId.length > 256 || !options.scope || options.scope.length > 512 || !options.secret) {
      throw new TypeError("Protected workspace authority is incomplete.");
    }
    this.clock = options.clock ?? Date.now;
    this.signer = createKnowledgeEvidence(options.secret, options.scope, this.clock);
    this.hostSigner = createHostDialogueSigner(options.secret, options.scope, this.clock);
    this.key = Buffer.from(hkdfSync(
      "sha256",
      Buffer.from(options.secret, "utf8"),
      Buffer.from(options.scope, "utf8"),
      Buffer.from(WORKSPACE_KEY_INFO, "utf8"),
      32,
    ));
  }

  async load(): Promise<ProtectedWorkspaceSnapshot> {
    try {
      return await this.loadCurrent(0);
    } catch {
      throw new ProtectedWorkspaceError();
    }
  }

  async save(expectedRevision: string | null, value: unknown): Promise<ProtectedWorkspaceSnapshot> {
    try {
      if (expectedRevision !== null && (typeof expectedRevision !== "string" || expectedRevision.length === 0 || expectedRevision.length > 128)) {
        throw new TypeError("Invalid expected revision.");
      }
      const parsed = parseChatWorkspace(value, this.options.ownerId);
      const current = await this.options.store.read(this.storageKey());
      if ((current?.revision ?? null) !== expectedRevision) throw new ProtectedWorkspaceConflict(await this.load());
      const previous = current ? this.parseStored(current.value) : undefined;
      const sanitized = await this.sanitize(parsed, previous?.actionReferences ?? []);
      const issuedAt = this.clock();
      const expiresAt = issuedAt + WORKSPACE_RETENTION_MS;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)) throw new ProtectedWorkspaceError();
      const envelope = this.sign({ version: 1, ownerId: this.options.ownerId, scope: this.options.scope, issuedAt, expiresAt,
        ...sanitized });
      const committed = await this.options.store.compareAndSet(this.storageKey(), expectedRevision, envelope, expiresAt);
      if (!committed) throw new ProtectedWorkspaceConflict(await this.load());
      return await this.load();
    } catch (error) {
      if (error instanceof ProtectedWorkspaceConflict) throw error;
      if (error instanceof ProtectedWorkspaceError) throw error;
      throw new ProtectedWorkspaceError();
    }
  }

  private storageKey(): string {
    return `workspace:${String(this.options.ownerId.length)}:${createHmac("sha256", this.key).update(this.options.ownerId, "utf8").digest("hex")}`;
  }

  private signature(fields: Omit<z.infer<typeof storedWorkspaceSchema>, "signature">): string {
    return createHmac("sha256", this.key)
      .update(canonicalJson({ ...fields, subject: this.options.ownerId, scope: this.options.scope }), "utf8")
      .digest("base64url");
  }

  private sign(fields: Omit<z.infer<typeof storedWorkspaceSchema>, "signature">) {
    return { ...fields, signature: this.signature(fields) };
  }

  private verify(record: z.infer<typeof storedWorkspaceSchema>): boolean {
    try {
      const actual = Buffer.from(record.signature, "base64url");
      const expected = Buffer.from(this.signature({
        version: record.version,
        ownerId: record.ownerId,
        scope: record.scope,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        workspace: record.workspace,
        ...(record.actionReferences === undefined ? {} : { actionReferences: record.actionReferences }),
      }), "base64url");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private async loadCurrent(attempt: number): Promise<ProtectedWorkspaceSnapshot> {
    const stored = await this.options.store.read(this.storageKey());
    if (!stored) return { revision: null, workspace: createChatWorkspace(this.options.ownerId) };
    const record = this.parseStored(stored.value);
    const workspace = parseChatWorkspace(record.workspace, this.options.ownerId);
    const sanitized = await this.sanitize(workspace, record.actionReferences ?? []);
    if (canonicalJson(sanitized.workspace) === canonicalJson(workspace)
      && canonicalJson(sanitized.actionReferences) === canonicalJson(record.actionReferences ?? [])) {
      return { revision: stored.revision, workspace: sanitized.workspace };
    }

    // Persist the fail-closed rewrite with the original expiry. Recovery keeps
    // opaque action locations only, never revoked display text or model context.
    const rewritten = this.sign({
      version: record.version,
      ownerId: record.ownerId,
      scope: record.scope,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      ...sanitized,
    });
    if (attempt >= 2) throw new ProtectedWorkspaceError();
    const committed = await this.options.store.compareAndSet(this.storageKey(), stored.revision, rewritten, record.expiresAt);
    if (!committed) return this.loadCurrent(attempt + 1);
    return this.loadCurrent(attempt + 1);
  }

  private parseStored(value: unknown): z.infer<typeof storedWorkspaceSchema> {
    const parsed = storedWorkspaceSchema.safeParse(safeRecord(value));
    const now = this.clock();
    if (!parsed.success || parsed.data.ownerId !== this.options.ownerId || parsed.data.scope !== this.options.scope
      || parsed.data.expiresAt <= now || parsed.data.issuedAt > now
      || parsed.data.expiresAt - parsed.data.issuedAt > WORKSPACE_RETENTION_MS
      || !this.verify(parsed.data)) throw new ProtectedWorkspaceError();
    return parsed.data;
  }

  private async sanitize(workspace: ChatWorkspace, priorReferences: readonly ActionHistoryReference[]): Promise<{
    workspace: ChatWorkspace; actionReferences: ActionHistoryReference[];
  }> {
    const sessions = [];
    const references = retainedActionReferences(workspace, priorReferences);
    const referenceMap = new Map(references.map(reference => [actionReferenceKey(reference.sessionId, reference.messageId), reference]));
    let native: NativeHistoryAccess = { resources: [], bookings: [], proposals: new Map() };
    let authority: string | undefined;
    if (this.options.authority) {
      try { authority = await this.options.authority(); } catch { throw new ProtectedWorkspaceError(); }
      // An unavailable fence is not evidence that a source was revoked. Reject
      // this read/write so a transient authority outage cannot persist redaction.
      if (typeof authority !== "string" || !/^[a-f0-9]{64}$/u.test(authority)) throw new ProtectedWorkspaceError();
    }
    if (!this.options.authority || authority) {
      try { native = await this.options.resolveNative?.(workspace, [...new Set(references.map(reference => reference.proposalId))]) ?? native; } catch { /* Fail closed. */ }
    }
    for (const session of workspace.sessions) {
      const snapshot = session.snapshot;
      const contextIds = historyContextIds(snapshot.history, snapshot.messages);
      const resolved = new Map<string, SafeResolvedContext>();
      const resolvedPluginResults = new Map<string, PluginResultContext>();
      if (contextIds.length <= MAX_CONTEXTS_PER_SESSION && contextIds.length > 0) {
        try {
          const returned = await this.options.resolve(contextIds);
          for (const contextId of contextIds) {
            const raw = returned.find((candidate) => candidate.contextId === contextId);
            if (raw) {
              const safe = boundedResolvedContext(raw, contextId);
              if (safe) resolved.set(contextId, safe);
            }
          }
        } catch {
          // Missing proof resolution is treated as source revocation.
        }
      }

      let history: WireMessage[];
      try {
        const profileId = snapshot.profileId === "offline" ? "groq-oss-120b" : snapshot.profileId;
        const rebuilt = await rebuildKnowledgeContext(
          { conversationId: session.id, profileId, messages: snapshot.history },
          this.signer,
          (requestedIds) => Promise.resolve(requestedIds.map((contextId) => resolved.get(contextId) ?? { contextId, status: "unavailable" })),
          authority,
          this.options.resolvePluginResults && authority
            ? async (conversationId, ids, currentAuthority) => {
              const returned = await this.options.resolvePluginResults?.(conversationId, ids, currentAuthority) ?? [];
              return returned.map(candidate => {
                if (candidate.status !== "valid") return candidate;
                const context = candidate.context;
                if (candidate.contextId !== context.contextId || context.conversationId !== conversationId
                  || context.authorityDigest !== currentAuthority || !ids.includes(candidate.contextId)) {
                  return { contextId: candidate.contextId, status: "unavailable" as const };
                }
                resolvedPluginResults.set(candidate.contextId, context);
                return candidate;
              });
            }
            : undefined,
        );
        history = rebuilt.request.messages;
      } catch {
        history = safeHistoryFallback();
      }
      const matchedPluginResults = verifiedPluginToolResults(history, session.id, authority, this.signer, resolvedPluginResults);
      sessions.push({
        ...session,
        snapshot: {
          ...snapshot,
          history,
          messages: sanitizeDisplayMessages(session.id, snapshot.messages, history, resolved, matchedPluginResults, native, referenceMap, message => {
            // A display receipt never carries model/source/action authority. The
            // server reconstructs any candidate cards from its current catalogue.
            if (message.evidence || message.sources || message.sourceContextId || message.proposal || message.bookings
              || message.confirmed || message.model || message.serviceConnection) return undefined;
            const verified = this.hostSigner.verify(session.id, { id: message.id, role: message.role, text: message.text,
              hostDialogue: message.hostDialogue }, { authorityDigest: authority ?? "", resources: native.resources,
              ...(native.resourcesAvailable === undefined ? {} : { resourcesAvailable: native.resourcesAvailable }) });
            if (!verified) return undefined;
            const rooms = verified.hostDialogue.resourceIds.map(id => native.resources.find(resource => resource.id === id));
            if (rooms.some(resource => !resource)) return undefined;
            return { ...verified, tool: "HASI · Dialoghinweis",
              ...(rooms.length ? { rooms: rooms.flatMap(resource => resource ? [{ resource, intervals: [], checked: false }] : []) } : {}),
              ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
          }),
          chosenRoom: native.resources.find(resource => resource.id === snapshot.chosenRoom?.id) ?? null,
          activeProposal: snapshot.activeProposal && native.proposals.has(snapshot.activeProposal)
            && !references.some(reference => reference.readOnly && reference.proposalId === snapshot.activeProposal)
            ? snapshot.activeProposal : null,
        },
      });
    }
    if (this.options.authority && authority) {
      // If authority moved while rebuilding cards/sources, do not return a mixed snapshot.
      if (await this.options.authority() !== authority) throw new ProtectedWorkspaceError();
    }
    const sanitized = parseChatWorkspace({ ...workspace, sessions }, this.options.ownerId);
    return { workspace: sanitized, actionReferences: updatedActionReferences(sanitized, references) };
  }
}
