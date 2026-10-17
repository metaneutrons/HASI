import {
  MAX_CHAT_SESSIONS, createChatSession, deleteChat, loadChatWorkspace,
  renameChat, saveChatWorkspace, selectChat, updateChatSnapshot,
  type ChatSnapshot, type ChatWorkspace,
} from "./chat-sessions";
import { modelProfileIdSchema, type ModelProfileId } from "./chat-contract";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type View = { workspace: ChatWorkspace; busy: Readonly<Record<string, boolean>>; notice: string | null };

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

/** Each mounted account owns one store; late responses address a chat by ID. */
export function createChatWorkspaceStore(ownerId: string, storage?: StorageLike) {
  const loaded = loadChatWorkspace(ownerId, storage);
  let view: View = { workspace: loaded.workspace, busy: {}, notice: loaded.notice };
  let configuredDefault: ModelProfileId = "groq-oss-120b";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const saved = saveChatWorkspace(view.workspace, storage);
    if (!saved) {
      const notice = "Die Chats können gerade nicht gespeichert werden. Sie bleiben bis zum Schließen dieser Seite verfügbar.";
      if (view.notice !== notice) { view = { ...view, notice }; emit(); }
    }
  }

  function publish(workspace: ChatWorkspace, busy = view.busy) {
    if (workspace === view.workspace && busy === view.busy) return;
    const changed = workspace !== view.workspace;
    view = { ...view, workspace, busy };
    emit();
    if (changed) { clearTimeout(timer); timer = setTimeout(flush, 180); }
  }

  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush,
    dismissNotice() { view = { ...view, notice: null }; emit(); },
    update(sessionId: string, snapshot: ChatSnapshot, busy: boolean) {
      const session = view.workspace.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      let next: ChatWorkspace;
      try {
        const candidate = updateChatSnapshot(view.workspace, sessionId, snapshot);
        const normalized = candidate.sessions.find((item) => item.id === sessionId)!.snapshot;
        next = JSON.stringify(session.snapshot) === JSON.stringify(normalized) ? view.workspace : candidate;
      } catch {
        view = { ...view, busy: { ...view.busy, [sessionId]: busy }, notice: "Dieser Chat überschreitet die Speichergrenzen und kann gerade nicht gespeichert werden. Beginne für weitere Fragen einen neuen Chat." }; emit(); return;
      }
      publish(next, Boolean(view.busy[sessionId]) === busy ? view.busy : { ...view.busy, [sessionId]: busy });
    },
    setDefaultProfile(profileId: ModelProfileId) {
      const nextDefault = modelProfileIdSchema.parse(profileId);
      let workspace = view.workspace;
      // The sidebar can create empty chats before the server policy arrives.
      // Move all untouched default sessions together; preserve selected models
      // and any session with conversation content or an unsent draft.
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
        view = { ...view, notice: `Du kannst bis zu ${MAX_CHAT_SESSIONS} Chats speichern. Lösche einen nicht mehr benötigten Verlauf, um einen neuen Chat zu beginnen.` }; emit(); return;
      }
      const session = createChatSession(modelProfileIdSchema.parse(defaultProfileId));
      publish({ ...view.workspace, activeId: session.id, sessions: [...view.workspace.sessions, session] });
    },
    select(sessionId: string) { publish(selectChat(view.workspace, sessionId)); },
    rename(sessionId: string, title: string) { publish(renameChat(view.workspace, sessionId, title)); },
    remove(sessionId: string) {
      if (view.busy[sessionId]) return;
      const busy = { ...view.busy }; delete busy[sessionId];
      publish(deleteChat(view.workspace, sessionId, new Date(), configuredDefault), busy);
    },
  };
}

export type ChatWorkspaceStore = ReturnType<typeof createChatWorkspaceStore>;
