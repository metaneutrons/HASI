"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatWorkspaceStore } from "@/lib/chat-workspace-store";

const ChatWorkspaceStoreContext = createContext<ChatWorkspaceStore | null>(null);

export function ChatWorkspaceStoreProvider({ store, children }: { store: ChatWorkspaceStore; children: ReactNode }) {
  return <ChatWorkspaceStoreContext.Provider value={store}>{children}</ChatWorkspaceStoreContext.Provider>;
}

export function useChatWorkspaceStore() {
  const store = useContext(ChatWorkspaceStoreContext);
  if (!store) throw new Error("Chat workspace store is unavailable outside the app shell.");
  return store;
}
