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

function isNativeHelper(message: ChatWorkspace["sessions"][number]["snapshot"]["messages"][number]): boolean {
  return message.role === "assistant"
    && message.sources === undefined && message.sourceContextId === undefined && message.evidence === undefined
    && (message.proposal !== undefined || message.rooms !== undefined || message.bookings !== undefined
      || message.tool?.startsWith("anny ·") === true || message.tool?.startsWith("Plugin ·") === true);
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
  const activeId = remoteIds.has(remote.activeId) ? remote.activeId : sessions[0]?.id;
  return parseChatWorkspace({ version: 1, ownerId, activeId, sessions }, ownerId);
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
    protectedPersistence: protectedPersistence ? { state: "saved", message: null } : null,
  };
  let configuredDefault: ModelProfileId = "groq-oss-120b";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remoteRevision = protectedPersistence?.revision ?? null;
  let remoteChain: Promise<void> = Promise.resolve();
  let remotePendingCount = 0;
  let remoteBlocked = false;
  let remoteGeneration = 0;
  let workspaceVersion = 0;
  const listeners = new Set<() => void>();
  const emit = () => { listeners.forEach((listener) => { listener(); }); };

  function setPersistence(state: ProtectedPersistenceState["state"], message: string | null) {
    if (!view.protectedPersistence || (view.protectedPersistence.state === state && view.protectedPersistence.message === message)) return;
    view = { ...view, protectedPersistence: { state, message } };
    emit();
  }

  function replaceWorkspace(workspace: ChatWorkspace, bumpAccessEpoch: boolean) {
    const normalized = parseChatWorkspace(workspace, ownerId);
    if (JSON.stringify(view.workspace) === JSON.stringify(normalized)) return false;
    workspaceVersion += 1;
    view = {
      ...view,
      workspace: normalized,
      accessEpoch: bumpAccessEpoch ? view.accessEpoch + 1 : view.accessEpoch,
    };
    saveChatWorkspace(normalized, storage);
    emit();
    return true;
  }

  function redactProtectedContent(message: string) {
    if (protectedPersistence) {
      remoteGeneration += 1;
      remoteBlocked = true;
    }
    const sessions = view.workspace.sessions.map(session => ({
      ...session,
      snapshot: {
        ...session.snapshot,
        history: [],
        messages: session.snapshot.messages.map(item => {
          if (item.role !== "assistant" || isNativeHelper(item)) return item;
          return {
            id: item.id,
            role: "assistant" as const,
            text: item.sources !== undefined || item.sourceContextId !== undefined
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
    const remote = parseChatWorkspace(workspace, ownerId);
    const next = preserveLocalDrafts ? preserveDrafts(remote, view.workspace, ownerId) : remote;
    remoteRevision = revision;
    replaceWorkspace(next, true);
    saveChatWorkspace(next, storage);
  }

  function queueRemoteSave(snapshot: ChatWorkspace, version: number) {
    if (!protectedPersistence || remoteBlocked) return;
    remotePendingCount += 1;
    const generation = remoteGeneration;
    setPersistence("saving", "Geschützte Chats werden gespeichert …");
    remoteChain = remoteChain.then(async () => {
      try {
        if (remoteBlocked || generation !== remoteGeneration) return;
        const result = await protectedPersistence.save(snapshot, remoteRevision);
        remoteRevision = result.revision;
        const serverChanged = JSON.stringify(result.workspace) !== JSON.stringify(snapshot);
        if (workspaceVersion === version && timer === undefined) {
          const changed = replaceWorkspace(result.workspace, serverChanged);
          if (changed && serverChanged) saveChatWorkspace(view.workspace, storage);
        } else if (serverChanged) {
          redactProtectedContent("Die Quellenfreigabe konnte nicht mit deinem aktuellen Chat abgeglichen werden. Geschützte Antworten wurden ausgeblendet.");
        }
      } catch (error) {
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
    queueRemoteSave(view.workspace, workspaceVersion);
  }

  function publish(workspace: ChatWorkspace, busy = view.busy) {
    if (workspace === view.workspace && busy === view.busy) return;
    const changed = workspace !== view.workspace;
    view = { ...view, workspace, busy };
    if (changed) workspaceVersion += 1;
    emit();
    if (changed) { clearTimeout(timer); timer = setTimeout(flush, 180); }
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
      view = { ...view, busy: { ...view.busy, [sessionId]: busy }, notice: "Dieser Chat überschreitet die Speichergrenzen und kann gerade nicht gespeichert werden. Beginne für weitere Fragen einen neuen Chat." }; emit(); return;
    }
    publish(next, Boolean(view.busy[sessionId]) === busy ? view.busy : { ...view.busy, [sessionId]: busy });
  }

  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush,
    dismissNotice() { view = { ...view, notice: null }; emit(); },
    hasPendingWrites() { return timer !== undefined || remotePendingCount > 0; },
    hasBusyChats() { return Object.values(view.busy).some(Boolean); },
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
