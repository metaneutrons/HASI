"use client";

import type { ReactNode } from "react";
import { ChatWorkspaceProvider } from "@/components/chat-sidebar-context";
import { SessionProvider } from "@/components/session-provider";
import { ThemeProvider } from "@/components/theme-provider";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ThemeProvider>
      <SessionProvider>
        <ChatWorkspaceProvider>{children}</ChatWorkspaceProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
