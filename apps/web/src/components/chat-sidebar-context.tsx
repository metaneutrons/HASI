"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/session-provider";
import { browserChatStorage, createChatWorkspaceStore, type ChatWorkspaceStore } from "@/lib/chat-workspace-store";

const ChatWorkspaceStoreContext = createContext<ChatWorkspaceStore | null>(null);

export function ChatWorkspaceStoreProvider({ store, children }: { store: ChatWorkspaceStore; children: ReactNode }) {
  return <ChatWorkspaceStoreContext.Provider value={store}>{children}</ChatWorkspaceStoreContext.Provider>;
}

/** One draft store spans route-level AppFrame mounts and is scoped to one account. */
export function ChatWorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return user ? <AccountChatWorkspaceProvider key={user.id} ownerId={user.id}>{children}</AccountChatWorkspaceProvider> : children;
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

export function useChatWorkspaceStore() {
  const store = useContext(ChatWorkspaceStoreContext);
  if (!store) throw new Error("Chat workspace store is unavailable outside the app shell.");
  return store;
}
