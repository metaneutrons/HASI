"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [theme, updateTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("hasi-theme-v1");
      if (isTheme(saved)) {
        const frame = window.requestAnimationFrame(() => updateTheme(saved));
        return () => window.cancelAnimationFrame(frame);
      }
    } catch {
      // The current system theme remains available when storage is disabled.
    }
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    updateTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem("hasi-theme-v1", nextTheme);
    } catch {
      // Applying the selected theme does not depend on persistent storage.
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme muss innerhalb des ThemeProvider verwendet werden.");
  return context;
}
