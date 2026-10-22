import {
  MAX_CHAT_SESSIONS,
  createChatSession,
  deleteChat,
  loadChatWorkspace,
  parseChatWorkspace,
  renameChat,
  saveChatWorkspace,
  selectChat,
  updateChatSnapshot,
  type ChatSnapshot,
  type ChatWorkspace,
} from "./chat-sessions";
import { modelProfileIdSchema, type ModelProfileId } from "./chat-contract";
import { MODEL_PLUGIN_TOOL_NAME } from "./plugin-tools";
import { LiveRoomAvailability } from "./live-room-availability";
import { forwardProposalStatus, proposalPresentation, sameProposalDetails } from "./proposal-presentation";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
export interface ProtectedWorkspaceResult {
  readonly revision: string | null;
  readonly workspace: ChatWorkspace;
}
export type ProtectedWorkspaceSave = (workspace: ChatWorkspace, expectedRevision: string | null) => Promise<ProtectedWorkspaceResult>;

interface ProtectedPersistenceOptions {
  readonly revision: string | null;
  readonly save: ProtectedWorkspaceSave;
}

interface ProtectedPersistenceState {
  readonly state: "saved" | "saving" | "unsaved" | "conflict";
  readonly message: string | null;
}

interface View {
  workspace: ChatWorkspace;
  busy: Readonly<Record<string, boolean>>;
  notice: string | null;
  accessEpoch: number;
  sessionEpochs: Readonly<Record<string, number>>;
  protectedPersistence: ProtectedPersistenceState | null;
}

function unusedChat(view: View) {
  const empty = (session: ChatWorkspace["sessions"][number]) => !view.busy[session.id]
    && !session.snapshot.messages.length && !session.snapshot.history.length && !session.snapshot.input.trim();
  const active = view.workspace.sessions.find(session => session.id === view.workspace.activeId);
  return active && empty(active) ? active : view.workspace.sessions.find(empty);
}

/** Shared admission for the toolbar, sidebar, drawer and store mutation. */
export function canStartNewChat(view: View): boolean {
  const unused = unusedChat(view);
  return unused ? unused.id !== view.workspace.activeId : view.workspace.sessions.length < MAX_CHAT_SESSIONS;
}

export function browserChatStorage(): StorageLike | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}


function preserveDrafts(remote: ChatWorkspace, local: ChatWorkspace, ownerId: string): ChatWorkspace {
  const localById = new Map(local.sessions.map(session => [session.id, session]));
  const remoteIds = new Set(remote.sessions.map(session => session.id));
  const sessions = remote.sessions.map(session => {
    const current = localById.get(session.id);
    return current && current.snapshot.input !== session.snapshot.input
      ? { ...session, snapshot: { ...session.snapshot, input: current.snapshot.input } }
      : session;
  });
  for (const current of local.sessions) {
    if (remoteIds.has(current.id) || !current.snapshot.input) continue;
    sessions.push({
      ...current,
      snapshot: { ...current.snapshot, messages: [], history: [], activeResult: null, activeProposal: null },
    });
  }
  // Revalidation owns protected content, not the user's newer navigation.
  const activeId = sessions.some(session => session.id === local.activeId)
    ? local.activeId : remoteIds.has(remote.activeId) ? remote.activeId : sessions[0]?.id;
  return parseChatWorkspace({ version: 1, ownerId, activeId, sessions }, ownerId);
}

function compatibleOwnProjection(before: ChatSnapshot, approved: ChatSnapshot): boolean {
  const approvedMessages = new Map(approved.messages.map(message => [message.id, message]));
  const progressed = new Set<string>();
  const messages = before.messages.map(message => {
    const projected = approvedMessages.get(message.id);
    if (message.role === "assistant" && message.pluginResultContextId !== undefined) {
      const allowedFields = new Set(["id", "role", "text", "timestamp", "tool", "pluginResultContextId"]);
      if (projected?.role === "assistant" && projected.pluginResultContextId === message.pluginResultContextId
        && Object.keys(message).every(key => allowedFields.has(key))
        && Object.keys(projected).every(key => allowedFields.has(key))) {
        const withoutPresentation = (value: typeof message) => Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "text" && key !== "tool"),
        );
        if (JSON.stringify(withoutPresentation(message)) === JSON.stringify(withoutPresentation(projected))) return projected;
      }
      return message;
    }
    if (message.role === "assistant" && message.proposal && projected?.proposal
      && projected.tool === "Aktion · Aktueller Beleg" && projected.text === proposalPresentation(projected.proposal).summary
      && sameProposalDetails(message.proposal, projected.proposal)
      && forwardProposalStatus(message.proposal.status, projected.proposal.status)) {
      // Generic action cards are reconstructed by the host, not model answers.
      // Discard cosmetic model attribution with the rest of their presentation;
      // every action-defining value and all other message fields still match.
      const presentationFields = message.proposal.action === "execute_tool"
        ? ["proposal", "text", "tool", "model"] : ["proposal", "text", "tool"];
      const remaining = (value: typeof message) => Object.fromEntries(Object.entries(value).filter(([key]) => !presentationFields.includes(key)));
      if (JSON.stringify(remaining(message)) === JSON.stringify(remaining(projected))) {
        if (projected.proposal.status !== "pending") progressed.add(message.proposal.id);
        return projected;
      }
    }
    if (message.role === "assistant" && message.bookings?.length && projected?.bookings?.length
      && !message.evidence && !message.sources && !message.rooms && !message.proposal
      && projected.tool === "anny · Eigene Buchungen"
      && JSON.stringify(message.bookings) === JSON.stringify(projected.bookings)) {
      // The host may refresh copy/attribution while the exact booking records
      // remain current. Status, interval, ownership filtering and other fields
      // must still match; an ID match alone cannot retain cancellation controls.
      const remaining = (value: typeof message) => Object.fromEntries(Object.entries(value)
        .filter(([key]) => !["text", "tool", "model", "interactionId"].includes(key)));
      if (JSON.stringify(remaining(message)) === JSON.stringify(remaining(projected))) return projected;
    }
    if (message.role !== "assistant" || !message.rooms || !projected?.rooms
      || message.evidence || message.sources || message.proposal || message.bookings
      || message.rooms.length !== projected.rooms.length) return message;
    // Historical availability formatting alone does not revoke a live result.
    // Every resource, its metadata and requested window must still match.
    const sameTargets = message.rooms.every((room, index) => {
      const current = projected.rooms?.[index];
      return current && JSON.stringify(room.resource) === JSON.stringify(current.resource)
        && room.requestedStartDate === current.requestedStartDate && room.requestedEndDate === current.requestedEndDate;
    });
    return sameTargets ? projected : message;
  });
  const history = before.history.map((message, index) => {
    const projected = approved.history[index];
    if (message.role !== "tool" || projected?.role !== "tool" || !message.toolContextId
      || !MODEL_PLUGIN_TOOL_NAME.test(message.name) || message.toolCallId !== projected.toolCallId
      || message.name !== projected.name || message.toolContextId !== projected.toolContextId) return message;
    const withoutContent = (value: typeof message) => Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "content"),
    );
    return JSON.stringify(withoutContent(message)) === JSON.stringify(withoutContent(projected)) ? projected : message;
  });
  const activeProposal = before.activeProposal && approved.activeProposal === null && progressed.has(before.activeProposal)
    ? null : before.activeProposal;
  return JSON.stringify({ ...before, activeProposal, input: "", messages, history }) === JSON.stringify({ ...approved, input: "" });
}

function reconcileOwnSave(remote: ChatWorkspace, submitted: ChatWorkspace, current: ChatWorkspace): ChatWorkspace | undefined {
  const previous = new Map(submitted.sessions.map(session => [session.id, session]));
  const projected = new Map(remote.sessions.map(session => [session.id, session]));
  const sessions = [];
  for (const session of current.sessions) {
    const before = previous.get(session.id);
    if (!before) {
      // Only an unsent chat has no protected result requiring a fresh write.
      const snapshot = session.snapshot;
      if (snapshot.messages.length || snapshot.history.length || snapshot.chosenRoom || snapshot.activeProposal || snapshot.activeResult) return undefined;
      sessions.push(session);
      continue;
    }
    const content = (snapshot: ChatSnapshot) => JSON.stringify({ ...snapshot, input: "" });
    const approved = projected.get(session.id);
    if (!approved) return undefined;
    if (content(before.snapshot) !== content(session.snapshot)) {
      return undefined;
    }
    // Drafts, local navigation and a rename/delete during the save do not
    // authorize protected content; the server projection owns that content.
    sessions.push({ ...session, snapshot: { ...approved.snapshot, input: session.snapshot.input } });
  }
  return { ...current, sessions };
}

/** Each mounted account owns one store; production can supply an in-memory writer and remote CAS. */
export function createChatWorkspaceStore(
  ownerId: string,
  storage?: StorageLike,
  protectedPersistence?: ProtectedPersistenceOptions,
) {
  const loaded = loadChatWorkspace(ownerId, storage);
  let view: View = {
    workspace: loaded.workspace,
    busy: {},
    notice: loaded.notice,
    accessEpoch: 0,
    sessionEpochs: {},
    protectedPersistence: protectedPersistence ? { state: "saved", message: null } : null,
  };
  let configuredDefault: ModelProfileId = "groq-oss-120b";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remoteRevision = protectedPersistence?.revision ?? null;
  let remoteChain: Promise<void> = Promise.resolve();
  let remotePendingCount = 0;
  let remoteBlocked = false;
  let remoteGeneration = 0;
  let authorityChanges = 0;
  let workspaceVersion = 0;
  const liveAvailability = new LiveRoomAvailability();
  let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => { listeners.forEach((listener) => { listener(); }); };
  const saveGenerationIsCurrent = (generation: number) => !remoteBlocked && generation === remoteGeneration;

  function setPersistence(state: ProtectedPersistenceState["state"], message: string | null) {
    if (!view.protectedPersistence || (view.protectedPersistence.state === state && view.protectedPersistence.message === message)) return;
    view = { ...view, protectedPersistence: { state, message } };
    emit();
  }

  function replaceWorkspace(workspace: ChatWorkspace, bumpAccessEpoch: boolean, retainBusyFormatting = false) {
    const normalized = parseChatWorkspace(workspace, ownerId);
    if (JSON.stringify(view.workspace) === JSON.stringify(normalized)) return false;
    workspaceVersion += 1;
    const previous = new Map(view.workspace.sessions.map(session => [session.id, session.snapshot]));
    const sessionEpochs = Object.fromEntries(normalized.sessions.map(session => {
      const before = previous.get(session.id);
      // Authorized own-save formatting/status progress must not abort a confirmation.
      // Revocation, changed action details/history and status reversal still remount.
      const sameAuthorizedContent = retainBusyFormatting && view.busy[session.id] && before
        && compatibleOwnProjection(before, session.snapshot);
      const remount = bumpAccessEpoch && !sameAuthorizedContent
        && JSON.stringify(before) !== JSON.stringify(session.snapshot);
      return [session.id, (view.sessionEpochs[session.id] ?? 0) + (remount ? 1 : 0)];
    }));
    view = {
      ...view,
      workspace: normalized,
      accessEpoch: bumpAccessEpoch ? view.accessEpoch + 1 : view.accessEpoch,
      sessionEpochs,
    };
    saveChatWorkspace(normalized, storage);
    emit();
    return true;
  }

  function redactProtectedContent(message: string) {
    clearTimeout(availabilityTimer);
    liveAvailability.clear();
    if (protectedPersistence) {
      remoteGeneration += 1;
      remoteBlocked = true;
    }
    const sessions = view.workspace.sessions.map(session => ({
      ...session,
      snapshot: {
        ...session.snapshot,
        history: [],
        chosenRoom: null,
        activeProposal: null,
        activeResult: null,
        messages: session.snapshot.messages.map(item => {
          if (item.role !== "assistant") return { id: item.id, role: "user" as const, text: item.text,
            ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }) };
          return {
            id: item.id,
            role: "assistant" as const,
            text: item.pluginResultContextId !== undefined
              ? "Dieses frühere Plugin-Ergebnis ist nicht mehr verfügbar. Bitte frage erneut."
              : item.sources !== undefined || item.sourceContextId !== undefined
                ? "Diese frühere Quellenkarte ist nicht mehr verfügbar. Bitte suche erneut."
              : "Diese frühere Antwort ist nicht mehr verfügbar. Bitte stelle die Frage erneut.",
            ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
          };
        }),
      },
    }));
    replaceWorkspace({ ...view.workspace, sessions }, true);
    setPersistence("unsaved", message);
  }

  function applyRemoteWorkspace(workspace: ChatWorkspace, revision: string | null, preserveLocalDrafts: boolean) {
    clearTimeout(availabilityTimer);
    liveAvailability.clear();
    const remote = parseChatWorkspace(workspace, ownerId);
    const next = preserveLocalDrafts ? preserveDrafts(remote, view.workspace, ownerId) : remote;
    remoteRevision = revision;
    replaceWorkspace(next, true);
    saveChatWorkspace(next, storage);
  }

  function queueRemoteSave() {
    if (!protectedPersistence || remoteBlocked) return;
    remotePendingCount += 1;
    const generation = remoteGeneration;
    setPersistence("saving", "Geschützte Chats werden gespeichert …");
    remoteChain = remoteChain.then(async () => {
      try {
        if (!saveGenerationIsCurrent(generation)) return;
        // Earlier acknowledgements may have reauthorized/projected the view
        // while this write waited. Never send a superseded queued snapshot.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const snapshot = view.workspace;
          const version = workspaceVersion;
          const result = await protectedPersistence.save(snapshot, remoteRevision);
          if (!saveGenerationIsCurrent(generation)) return;
          remoteRevision = result.revision;
          const serverChanged = JSON.stringify(result.workspace) !== JSON.stringify(snapshot);
          const projected = liveAvailability.apply(result.workspace, Date.now());
          const reconciled = reconcileOwnSave(projected, snapshot, view.workspace);
          if ((workspaceVersion === version && timer === undefined) || reconciled) {
            // Only an acknowledgement covering this conversation can retain a
            // short-lived observation intersected with authorized metadata.
            const next = reconciled ?? projected;
            const changed = replaceWorkspace(next, serverChanged, true);
            if (changed && serverChanged) saveChatWorkspace(view.workspace, storage);
            break;
          }
          const approvedById = new Map(projected.sessions.map(session => [session.id, session.snapshot]));
          const unchangedAuthority = snapshot.sessions.every(session => {
            const approved = approvedById.get(session.id);
            return approved && compatibleOwnProjection(session.snapshot, approved);
          });
          // A concurrent reply is not covered by an older acknowledgement.
          // Immediately qualify the latest view inside this serial operation;
          // do not mark it saved or remount/abort an unrelated pending action.
          // A real revoked baseline is hidden now, never deferred to a retry.
          if (!unchangedAuthority) {
            redactProtectedContent("Die Quellenfreigabe konnte nicht mit deinem aktuellen Chat abgeglichen werden. Geschützte Antworten wurden ausgeblendet.");
            break;
          }
          if (attempt === 2) {
            // A still-authorized baseline is not a revocation. Yield to the
            // debounce after three overlapping edits, keeping persistence pending
            // until a later acknowledgement covers the latest conversation.
            clearTimeout(timer);
            timer = setTimeout(flush, 180);
          }
        }
      } catch (error) {
        if (!saveGenerationIsCurrent(generation)) return;
        if (error instanceof RemoteWorkspaceConflict) {
          remoteGeneration += 1;
          remoteRevision = error.current.revision;
          remoteBlocked = true;
          applyRemoteWorkspace(error.current.workspace, error.current.revision, true);
          setPersistence("conflict", "Eine andere Sitzung hat diesen Chat geändert. Dein Entwurf bleibt erhalten; speichere ihn erneut.");
        } else {
          remoteGeneration += 1;
          remoteBlocked = true;
          redactProtectedContent("Der geschützte Chat-Speicher ist nicht erreichbar. Geschützte Antworten wurden ausgeblendet.");
        }
      } finally {
        remotePendingCount -= 1;
        if (!remoteBlocked && remotePendingCount === 0 && timer === undefined && view.protectedPersistence?.state === "saving") {
          setPersistence("saved", null);
        }
      }
    });
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!saveChatWorkspace(view.workspace, storage)) {
      const notice = "Die Chats können gerade nicht gespeichert werden. Sie bleiben bis zum Schließen dieser Seite verfügbar.";
      if (view.notice !== notice) { view = { ...view, notice }; emit(); }
      if (protectedPersistence) redactProtectedContent("Der geschützte Chat-Speicher ist nicht erreichbar. Geschützte Antworten wurden ausgeblendet.");
      return;
    }
    queueRemoteSave();
  }

  function publish(workspace: ChatWorkspace, busy = view.busy) {
    if (workspace === view.workspace && busy === view.busy) return;
    const changed = workspace !== view.workspace;
    view = { ...view, workspace, busy };
    if (changed) workspaceVersion += 1;
    if (protectedPersistence) liveAvailability.capture(workspace, Date.now());
    // Subscribers must observe pending work on the first synchronous edit,
    // including the unload guard before the debounce has fired.
    if (changed) { clearTimeout(timer); timer = setTimeout(flush, 180); }
    emit();
    expireAvailability();
  }

  function expireAvailability() {
    clearTimeout(availabilityTimer);
    availabilityTimer = undefined;
    if (!protectedPersistence) return;
    // Do not remount/abort a pending business action to update a display lease.
    // The completion snapshot immediately expires it when the chat is idle.
    replaceWorkspace(liveAvailability.expire(view.workspace, Date.now(), view.busy), true);
    const next = liveAvailability.nextExpiry(Date.now());
    if (next !== undefined) availabilityTimer = setTimeout(expireAvailability, Math.max(1, next - Date.now()));
  }

  function updateSnapshot(sessionId: string, snapshot: ChatSnapshot, busy: boolean, preserveCurrentDraft: boolean) {
    const session = view.workspace.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    let next: ChatWorkspace;
    try {
      const candidate = updateChatSnapshot(view.workspace, sessionId, preserveCurrentDraft
        ? { ...snapshot, input: session.snapshot.input }
        : snapshot);
      const updatedSession = candidate.sessions.find((item) => item.id === sessionId);
      if (!updatedSession) throw new Error("Updated chat session is missing.");
      const normalized = updatedSession.snapshot;
      next = JSON.stringify(session.snapshot) === JSON.stringify(normalized) ? view.workspace : candidate;
    } catch {
      const notice = "Dieser Chat überschreitet die Speichergrenzen und kann gerade nicht gespeichert werden. Beginne für weitere Fragen einen neuen Chat.";
      if (view.notice !== notice || Boolean(view.busy[sessionId]) !== busy) {
        view = { ...view, busy: { ...view.busy, [sessionId]: busy }, notice }; emit();
      }
      return;
    }
    publish(next, Boolean(view.busy[sessionId]) === busy ? view.busy : { ...view.busy, [sessionId]: busy });
  }

  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush,
    dismissNotice() { view = { ...view, notice: null }; emit(); },
    hasPendingWrites() { return timer !== undefined || remotePendingCount > 0; },
    flushPendingWrites() { if (timer !== undefined) flush(); },
    needsNavigationConfirmation() {
      return protectedPersistence !== undefined && (timer !== undefined || remotePendingCount > 0
        || view.protectedPersistence?.state !== "saved");
    },
    hasBusyChats() { return Object.values(view.busy).some(Boolean); },
    getAuthorityVersion() { return `${String(remoteGeneration)}:${String(view.accessEpoch)}`; },
    hasAuthorityChange() { return authorityChanges > 0; },
    beginAuthorityChange(message: string) {
      authorityChanges += 1;
      redactProtectedContent(message);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        authorityChanges -= 1;
        remoteGeneration += 1;
        view = { ...view };
        emit();
      };
    },
    applyRemoteWorkspace(workspace: ChatWorkspace, revision: string | null) {
      applyRemoteWorkspace(workspace, revision, true);
    },
    retryWithRemoteWorkspace(workspace: ChatWorkspace, revision: string | null) {
      if (!protectedPersistence) return;
      remoteGeneration += 1;
      remoteBlocked = false;
      applyRemoteWorkspace(workspace, revision, true);
      setPersistence("saved", null);
      flush();
    },
    redactProtectedContent,
    update(sessionId: string, snapshot: ChatSnapshot, busy: boolean) { updateSnapshot(sessionId, snapshot, busy, false); },
    updateConversation(sessionId: string, snapshot: ChatSnapshot, busy: boolean) { updateSnapshot(sessionId, snapshot, busy, true); },
    updateDraft(sessionId: string, input: string) {
      const session = view.workspace.sessions.find((item) => item.id === sessionId);
      if (!session || session.snapshot.input === input) return;
      try {
        // Update only the draft against the latest store snapshot. Composer
        // events must not replace messages or room state from a stale render.
        publish(updateChatSnapshot(view.workspace, sessionId, { ...session.snapshot, input }));
      } catch {
        const notice = "Dieser Chat überschreitet die Speichergrenzen und kann gerade nicht gespeichert werden. Beginne für weitere Fragen einen neuen Chat.";
        if (view.notice !== notice) { view = { ...view, notice }; emit(); }
      }
    },
    setDefaultProfile(profileId: ModelProfileId) {
      const nextDefault = modelProfileIdSchema.parse(profileId);
      let workspace = view.workspace;
      // Move untouched default sessions together; preserve selected models and any content or draft.
      for (const session of workspace.sessions) {
        const snapshot = session.snapshot;
        if (snapshot.profileId === configuredDefault && !snapshot.messages.length && !snapshot.history.length && !snapshot.input) {
          workspace = updateChatSnapshot(workspace, session.id, { ...snapshot, profileId: nextDefault });
        }
      }
      publish(workspace);
      configuredDefault = nextDefault;
    },
    create(defaultProfileId: ModelProfileId = configuredDefault) {
      const unused = unusedChat(view);
      if (unused) {
        if (unused.id !== view.workspace.activeId) publish(selectChat(view.workspace, unused.id));
        return;
      }
      if (view.workspace.sessions.length >= MAX_CHAT_SESSIONS) {
        view = { ...view, notice: `Du kannst bis zu ${String(MAX_CHAT_SESSIONS)} Chats speichern. Lösche einen nicht mehr benötigten Verlauf, um einen neuen Chat zu beginnen.` }; emit(); return;
      }
      const session = createChatSession(modelProfileIdId(defaultProfileId));
      publish({ ...view.workspace, activeId: session.id, sessions: [...view.workspace.sessions, session] });
    },
    select(sessionId: string) { publish(selectChat(view.workspace, sessionId)); },
    rename(sessionId: string, title: string) { publish(renameChat(view.workspace, sessionId, title)); },
    remove(sessionId: string) {
      if (view.busy[sessionId]) return;
      const busy = { ...view.busy }; Reflect.deleteProperty(busy, sessionId);
      publish(deleteChat(view.workspace, sessionId, new Date(), configuredDefault), busy);
    },
  };
}

function modelProfileIdId(profileId: ModelProfileId): ModelProfileId {
  return modelProfileIdSchema.parse(profileId);
}

export class RemoteWorkspaceConflict extends Error {
  constructor(readonly current: ProtectedWorkspaceResult) {
    super("The protected chat workspace changed in another session.");
    this.name = "RemoteWorkspaceConflict";
  }
}

export type ChatWorkspaceStore = ReturnType<typeof createChatWorkspaceStore>;
