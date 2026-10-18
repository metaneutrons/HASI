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
import { apiRequest, postJson } from "@/lib/api";
import type { Persona, Role, User } from "@/lib/types";

interface SessionState {
  user: User | null;
  mode: string;
}

interface SessionContextValue {
  user: User | null;
  mode: string;
  loading: boolean;
  error: string | null;
  personas: Persona[];
  personasLoading: boolean;
  personasError: string | null;
  login: (personaId: Role) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshPersonas: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState("mock");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personasLoading, setPersonasLoading] = useState(false);
  const [personasError, setPersonasError] = useState<string | null>(null);

  const refreshPersonas = useCallback(async () => {
    setPersonasLoading(true);
    setPersonasError(null);
    try {
      const result = await apiRequest<{ personas: Persona[] }>("/api/dev/personas");
      setPersonas(result.personas);
    } catch (cause) {
      setPersonasError(cause instanceof Error ? cause.message : "Testkonten konnten nicht geladen werden.");
    } finally {
      setPersonasLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<SessionState>("/api/session");
      setUser(result.user);
      setMode(result.mode);
      if (!result.user && result.mode !== "oidc") void refreshPersonas();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Sitzung konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [refreshPersonas]);

  useEffect(() => {
    let active = true;
    apiRequest<SessionState>("/api/session")
      .then((result) => {
        if (!active) return;
        setUser(result.user);
        setMode(result.mode);
        if (!result.user && result.mode !== "oidc") void refreshPersonas();
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Die Sitzung konnte nicht geladen werden.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshPersonas]);

  const login = useCallback(async (personaId: Role) => {
    const result = await postJson<SessionState>("/api/dev/login", { personaId });
    setUser(result.user);
    setMode(result.mode);
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    await postJson<unknown>("/api/logout", {});
    setUser(null);
    await refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      mode,
      loading,
      error,
      personas,
      personasLoading,
      personasError,
      login,
      logout,
      refresh,
      refreshPersonas,
    }),
    [
      user,
      mode,
      loading,
      error,
      personas,
      personasLoading,
      personasError,
      login,
      logout,
      refresh,
      refreshPersonas,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession muss innerhalb des SessionProvider verwendet werden.");
  return context;
}
