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
import { createHostDialogueSigner } from "./host-dialogue";
import { proposalPresentation } from "../proposal-presentation";
import { knowledgeDocumentSchema, type KnowledgeDocument } from "../knowledge";
import type { KnowledgeEvidence, WireMessage } from "../chat-contract";
import {
  createKnowledgeEvidence,
  rebuildKnowledgeContext,
  type KnowledgeContextResolver,
  type ResolvedKnowledgeContext,
} from "./knowledge-evidence";

const WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONTEXTS_PER_SESSION = 32;
const MAX_CONTEXT_DOCUMENTS = 5;
const MAX_CONTEXT_DOCUMENT_BYTES = 64 * 1024;
const WORKSPACE_KEY_INFO = "hasi-protected-chat-workspace-v1";
const UNAVAILABLE_ANSWER = "Diese frühere Antwort ist nicht mehr verfügbar. Bitte stelle die Frage erneut.";
const UNAVAILABLE_SOURCES = "Diese frühere Quellenkarte ist nicht mehr verfügbar. Bitte suche erneut.";

const storedWorkspaceSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.string().min(1).max(256),
  scope: z.string().min(1).max(512),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  workspace: z.unknown(),
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

function sanitizeDisplayMessages(
  messages: readonly ChatMessage[],
  history: readonly WireMessage[],
  contexts: ReadonlyMap<string, SafeResolvedContext>,
  native: NativeHistoryAccess,
  verifyHost: (message: ChatMessage) => ChatMessage | undefined,
): ChatMessage[] {
  const validWireMessages = validModelWireMessages(history);
  return messages.map((message) => {
    if (message.role === "user") {
      return { id: message.id, role: "user", text: message.text,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
    }

    if (message.hostDialogue !== undefined) return verifyHost(message) ?? unavailableMessage(message);
    const contextId = message.sourceContextId;
    if (message.sources !== undefined || contextId !== undefined) {
      const context = contextId ? contexts.get(contextId) : undefined;
      if (!contextId || context?.status !== "valid") return unavailableMessage(message, UNAVAILABLE_SOURCES);
      const allSynthetic = context.documents.length > 0 && context.documents.every(document => document.synthetic);
      return {
        id: message.id,
        role: "assistant",
        text: allSynthetic
          ? "Gefundene Demoquellen. Die folgende Antwort wertet diese Beispiele aus."
          : "Gefundene freigegebene Quellen. Die Antwort nennt die verwendeten Dokumentfassungen.",
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
      const workspace = await this.sanitize(parsed);
      const issuedAt = this.clock();
      const expiresAt = issuedAt + WORKSPACE_RETENTION_MS;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)) throw new ProtectedWorkspaceError();
      const envelope = this.sign({ version: 1, ownerId: this.options.ownerId, scope: this.options.scope, issuedAt, expiresAt, workspace });
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
      }), "base64url");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private async loadCurrent(attempt: number): Promise<ProtectedWorkspaceSnapshot> {
    const stored = await this.options.store.read(this.storageKey());
    if (!stored) return { revision: null, workspace: createChatWorkspace(this.options.ownerId) };
    const raw = safeRecord(stored.value);
    const parsed = storedWorkspaceSchema.safeParse(raw);
    const now = this.clock();
    if (!parsed.success || parsed.data.ownerId !== this.options.ownerId || parsed.data.scope !== this.options.scope
      || parsed.data.expiresAt <= now || parsed.data.issuedAt > now
      || parsed.data.expiresAt - parsed.data.issuedAt > WORKSPACE_RETENTION_MS
      || !this.verify(parsed.data)) throw new ProtectedWorkspaceError();
    const workspace = parseChatWorkspace(parsed.data.workspace, this.options.ownerId);
    const sanitized = await this.sanitize(workspace);
    if (canonicalJson(sanitized) === canonicalJson(workspace)) return { revision: stored.revision, workspace: sanitized };

    // Persist the fail-closed rewrite with the original expiry. A later GET
    // must not recover revoked derived text from the old signed envelope.
    const rewritten = this.sign({
      version: parsed.data.version,
      ownerId: parsed.data.ownerId,
      scope: parsed.data.scope,
      issuedAt: parsed.data.issuedAt,
      expiresAt: parsed.data.expiresAt,
      workspace: sanitized,
    });
    if (attempt >= 2) throw new ProtectedWorkspaceError();
    const committed = await this.options.store.compareAndSet(this.storageKey(), stored.revision, rewritten, parsed.data.expiresAt);
    if (!committed) return this.loadCurrent(attempt + 1);
    return this.loadCurrent(attempt + 1);
  }

  private async sanitize(workspace: ChatWorkspace): Promise<ChatWorkspace> {
    const sessions = [];
    let native: NativeHistoryAccess = { resources: [], bookings: [], proposals: new Map() };
    let authority: string | undefined;
    if (this.options.authority) {
      try { authority = await this.options.authority(); } catch { authority = ""; }
      if (!authority || !/^[a-f0-9]{64}$/u.test(authority)) {
        authority = "";
        native = { resources: [], bookings: [], proposals: new Map() };
      }
    }
    if (!this.options.authority || authority) {
      try { native = await this.options.resolveNative?.(workspace) ?? native; } catch { /* Fail closed. */ }
    }
    for (const session of workspace.sessions) {
      const snapshot = session.snapshot;
      const contextIds = historyContextIds(snapshot.history, snapshot.messages);
      const resolved = new Map<string, SafeResolvedContext>();
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
        );
        history = rebuilt.request.messages;
      } catch {
        history = safeHistoryFallback();
      }
      sessions.push({
        ...session,
        snapshot: {
          ...snapshot,
          history,
          messages: sanitizeDisplayMessages(snapshot.messages, history, resolved, native, message => {
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
          activeProposal: snapshot.activeProposal && native.proposals.has(snapshot.activeProposal) ? snapshot.activeProposal : null,
        },
      });
    }
    if (this.options.authority && authority) {
      // If authority moved while rebuilding cards/sources, do not return a mixed snapshot.
      if (await this.options.authority() !== authority) throw new ProtectedWorkspaceError();
    }
    return parseChatWorkspace({ ...workspace, sessions }, this.options.ownerId);
  }
}
