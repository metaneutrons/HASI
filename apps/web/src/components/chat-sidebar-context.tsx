"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSession } from "@/components/session-provider";
import {
  browserChatStorage,
  createChatWorkspaceStore,
  RemoteWorkspaceConflict,
  type ChatWorkspaceStore,
  type ProtectedWorkspaceResult,
} from "@/lib/chat-workspace-store";
import { chatStorageKey, parseChatWorkspace, type ChatWorkspace } from "@/lib/chat-sessions";

const ChatWorkspaceStoreContext = createContext<ChatWorkspaceStore | null>(null);
const WORKSPACE_ENDPOINT = "/api/chat/workspace";

export function ChatWorkspaceStoreProvider({ store, children }: { store: ChatWorkspaceStore; children: ReactNode }) {
  return <ChatWorkspaceStoreContext.Provider value={store}>{children}</ChatWorkspaceStoreContext.Provider>;
}

function resultFromPayload(value: unknown, ownerId: string): ProtectedWorkspaceResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid workspace response");
  const record = value as Record<string, unknown>;
  const revision = record.revision;
  if (revision !== null && (typeof revision !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(revision))) {
    throw new Error("invalid workspace revision");
  }
  return { revision, workspace: parseChatWorkspace(record.workspace, ownerId) };
}

async function readProtectedWorkspace(ownerId: string): Promise<ProtectedWorkspaceResult> {
  const response = await fetch(WORKSPACE_ENDPOINT, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("protected workspace unavailable");
  return resultFromPayload(payload, ownerId);
}

async function writeProtectedWorkspace(workspace: ChatWorkspace, expectedRevision: string | null, ownerId: string): Promise<ProtectedWorkspaceResult> {
  const response = await fetch(WORKSPACE_ENDPOINT, {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision, workspace }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 409) throw new RemoteWorkspaceConflict(resultFromPayload(payload, ownerId));
  if (!response.ok) throw new Error("protected workspace save failed");
  return resultFromPayload(payload, ownerId);
}

function memoryStorage(initial: ChatWorkspace) {
  let serialized = JSON.stringify(initial);
  return {
    getItem(key: string) { return key === chatStorageKey(initial.ownerId) ? serialized : null; },
    setItem(key: string, value: string) { if (key === chatStorageKey(initial.ownerId)) serialized = value; },
  };
}

function createProtectedStore(ownerId: string, initial: ProtectedWorkspaceResult): ChatWorkspaceStore {
  const storage = memoryStorage(initial.workspace);
  return createChatWorkspaceStore(ownerId, storage, {
    revision: initial.revision,
    save: (workspace, expectedRevision) => writeProtectedWorkspace(workspace, expectedRevision, ownerId),
  });
}

/** One draft store spans route-level AppFrame mounts and is scoped to one account. */
export function ChatWorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, mode } = useSession();
  if (!user) return children;
  return mode === "oidc"
    ? <ProtectedAccountChatWorkspaceProvider key={`${user.id}:oidc`} ownerId={user.id}>{children}</ProtectedAccountChatWorkspaceProvider>
    : <AccountChatWorkspaceProvider key={`${user.id}:local`} ownerId={user.id}>{children}</AccountChatWorkspaceProvider>;
}

function AccountChatWorkspaceProvider({ ownerId, children }: { ownerId: string; children: ReactNode }) {
  const [store] = useState(() => createChatWorkspaceStore(ownerId, browserChatStorage()));

  useEffect(() => {
    const flush = () => { store.flush(); };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      store.flush();
    };
  }, [store]);

  return <ChatWorkspaceStoreProvider store={store}>{children}</ChatWorkspaceStoreProvider>;
}

function ProtectedAccountChatWorkspaceProvider({ ownerId, children }: { ownerId: string; children: ReactNode }) {
  const [store, setStore] = useState<ChatWorkspaceStore | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void readProtectedWorkspace(ownerId)
      .then(initial => { if (active) setStore(createProtectedStore(ownerId, initial)); })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ownerId]);

  async function retryInitialLoad() {
    setLoading(true);
    setLoadError(false);
    try {
      setStore(createProtectedStore(ownerId, await readProtectedWorkspace(ownerId)));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  if (!store) {
    return <section className="chat-storage-notice" role="status">
      <span>{loading ? "Geschützte Chats werden geladen …" : "Geschützte Chats konnten nicht geladen werden."}</span>
      {!loading && loadError && <button type="button" onClick={() => { void retryInitialLoad(); }}>Erneut versuchen</button>}
    </section>;
  }

  return <ProtectedStoreWorkspaceProvider store={store}>{children}</ProtectedStoreWorkspaceProvider>;
}

function ProtectedStoreWorkspaceProvider({ store, children }: { store: ChatWorkspaceStore; children: ReactNode }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [retrying, setRetrying] = useState(false);
  const refreshing = useRef(false);
  const ownerId = view.workspace.ownerId;

  const refreshRemote = useCallback(async () => {
    if (refreshing.current || store.hasPendingWrites() || store.hasBusyChats()) return;
    refreshing.current = true;
    try {
      const remote = await readProtectedWorkspace(ownerId);
      store.applyRemoteWorkspace(remote.workspace, remote.revision);
    } catch {
      store.redactProtectedContent("Die Quellenfreigabe konnte nicht geprüft werden. Geschützte Antworten wurden ausgeblendet.");
    } finally {
      refreshing.current = false;
    }
  }, [ownerId, store]);

  const retry = useCallback(async () => {
    if (retrying || store.hasBusyChats()) return;
    setRetrying(true);
    try {
      const remote = await readProtectedWorkspace(ownerId);
      store.retryWithRemoteWorkspace(remote.workspace, remote.revision);
    } catch {
      store.redactProtectedContent("Der geschützte Chat-Speicher ist weiterhin nicht erreichbar. Geschützte Antworten wurden ausgeblendet.");
    } finally {
      setRetrying(false);
    }
  }, [ownerId, retrying, store]);

  useEffect(() => {
    const onFocus = () => { void refreshRemote(); };
    const interval = window.setInterval(() => { void refreshRemote(); }, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      store.flush();
    };
  }, [refreshRemote, store]);

  return <ChatWorkspaceStoreProvider store={store}>
    {view.protectedPersistence && view.protectedPersistence.state !== "saved" && <div className="chat-storage-notice" role="status">
      <span>{view.protectedPersistence.message ?? "Der geschützte Chat-Speicher ist nicht synchronisiert."}</span>
      <button type="button" disabled={retrying || store.hasBusyChats()} onClick={() => { void retry(); }}>{retrying ? "Wird erneut versucht …" : "Erneut versuchen"}</button>
    </div>}
    {children}
  </ChatWorkspaceStoreProvider>;
}

export function useChatWorkspaceStore() {
  const store = useContext(ChatWorkspaceStoreContext);
  if (!store) throw new Error("Chat workspace store is unavailable outside the app shell.");
  return store;
}
