"use client";

import type { ReactNode } from "react";
import { SessionProvider } from "@/components/session-provider";
import { ThemeProvider } from "@/components/theme-provider";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ThemeProvider>
      <SessionProvider>{children}</SessionProvider>
    </ThemeProvider>
  );
}
