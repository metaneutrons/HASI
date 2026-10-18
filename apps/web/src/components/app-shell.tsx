"use client";

import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  MessageCircle,
  LaptopMinimal,
  LogOut,
  Moon,
  PanelTop,
  Sun,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChatSessionList } from "@/components/chat-session-list";
import { useChatWorkspaceStore } from "@/components/chat-sidebar-context";
import { useSession } from "@/components/session-provider";
import { PublicDemoNotice } from "@/components/public-demo-notice";
import { useChatViewport } from "@/components/use-chat-viewport";
import { useTheme, type Theme } from "@/components/theme-provider";
import type { ChatWorkspaceStore } from "@/lib/chat-workspace-store";
import type { Role } from "@/lib/types";

const navItems = [
  { href: "/", label: "Chats", icon: MessageCircle, key: "assistant" },
  { href: "/bookings", label: "Buchungen", icon: PanelTop, key: "bookings" },
];
const prototypeLabel = process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO === "1" ? "Prototyp" : "Lokaler Prototyp";

const roleLabel: Record<Role, string> = {
  student: "Studentisches Konto",
  employee: "Beschäftigtenkonto",
  admin: "Administration",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("de-DE") ?? "")
    .join("");
}

function HasiMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand-lockup${compact ? " brand-lockup--compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="M7 9.25A3.25 3.25 0 0 1 10.25 6h11.5A3.25 3.25 0 0 1 25 9.25v13.5A3.25 3.25 0 0 1 21.75 26h-11.5A3.25 3.25 0 0 1 7 22.75V9.25Z" stroke="currentColor" strokeWidth="2.2" />
          <path d="M12 20V12m8 8v-4.2a3.8 3.8 0 0 0-7.6 0V20m-1.1-4h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="22.3" cy="9.7" r="2.2" fill="currentColor" />
        </svg>
      </span>
      <span className="brand-name">hasi</span>
    </span>
  );
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const options: Record<Theme, { value: Theme; label: string; icon: typeof Sun }> = {
    light: { value: "light", label: "Hell", icon: Sun },
    dark: { value: "dark", label: "Dunkel", icon: Moon },
    system: { value: "system", label: "System", icon: LaptopMinimal },
  };
  const current = options[theme];
  const Icon = current.icon;

  return (
    <details className="theme-control" ref={detailsRef}>
      <summary className="icon-button" aria-label={`Darstellung: ${current.label}`}>
        <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
      </summary>
      <div className="theme-menu" aria-label="Darstellung wählen">
        <p className="theme-menu-label">Darstellung</p>
        {Object.values(options).map((option) => {
          const OptionIcon = option.icon;
          return (
            <button
              className="theme-option"
              type="button"
              key={option.value}
              aria-pressed={theme === option.value}
              onClick={() => {
                setTheme(option.value);
                if (detailsRef.current) detailsRef.current.open = false;
              }}
            >
              <OptionIcon size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>{option.label}</span>
              {theme === option.value && <Check size={15} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function AccountMenu({
  user,
  mode,
  loggingOut,
  error,
  onLogout,
}: {
  user: { displayName: string; role: Role };
  mode: string;
  loggingOut: boolean;
  error: string | null;
  onLogout: () => Promise<boolean>;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details className="account-control" ref={detailsRef}>
      <summary className={`topbar-avatar topbar-avatar--${user.role}`} aria-label={`Konto: ${user.displayName}`}>
        {initials(user.displayName)}
      </summary>
      <div className="account-menu">
        <span className={`account-avatar account-avatar--${user.role}`}>{initials(user.displayName)}</span>
        <span className="account-name">{user.displayName}</span>
        <span className="account-role">{mode === "mock" || mode === "public-demo" ? "Testkonto" : roleLabel[user.role]}</span>
        {error && <span className="account-error" role="alert">{error}</span>}
        <button
          className="account-logout"
          type="button"
          disabled={loggingOut}
          onClick={() => { void onLogout().then((loggedOut) => { if (loggedOut && detailsRef.current) detailsRef.current.open = false; }); }}
        >
          <LogOut size={16} aria-hidden="true" />
          <span>{loggingOut ? "Wird abgemeldet …" : "Abmelden"}</span>
        </button>
      </div>
    </details>
  );
}

function WordmarkLink() {
  return (
    <Link className="brand-link" href="/" aria-label="HASI, zum Assistenten">
      <HasiMark />
      <span className="brand-caption">Hochschule Hannover</span>
    </Link>
  );
}

function LoginScreen() {
  const pathname = usePathname();
  const {
    mode,
    error,
    login,
    personas,
    personasError,
    personasLoading,
    refresh,
  } = useSession();
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  async function choosePersona(role: Role) {
    setPendingRole(role);
    setLoginError(null);
    try {
      await login(role);
    } catch (cause) {
      setLoginError(cause instanceof Error ? cause.message : "Die Anmeldung ist fehlgeschlagen.");
    } finally {
      setPendingRole(null);
    }
  }

  return (
    <div className="welcome-page">
      <div className="welcome-nav">
        <WordmarkLink />
        <div className="welcome-nav-actions">
          <span className="prototype-label"><span className="status-dot" /> {prototypeLabel}</span>
          <ThemeControl />
        </div>
      </div>
      <PublicDemoNotice />

      <main className="welcome-main">
        <section className="welcome-copy">
          <div className="eyebrow"><span className="eyebrow-rule" /> CAMPUS, KLARER ORGANISIERT</div>
          <h1>Was steht<br /><span>heute an?</span></h1>
          <p className="welcome-lede">
            Frag HASI. Finde Informationen, plane deinen nächsten Schritt und erledige
            Aufgaben direkt im Gespräch. Raumsuche und Buchung kannst du bereits ausprobieren.
          </p>
          <div className="welcome-note">
            <span className="welcome-note-icon"><UserRound size={17} strokeWidth={1.8} /></span>
            <span>{mode === "oidc" ? "Anmeldung über den konfigurierten Identitätsdienst." : "Zum Ausprobieren einfach ein Testkonto auswählen."}</span>
          </div>
          <div className="welcome-orbit" aria-hidden="true">
            <div className="orbit-ring orbit-ring--one" />
            <div className="orbit-ring orbit-ring--two" />
            <span className="orbit-core"><HasiMark compact /></span>
            <span className="orbit-spark orbit-spark--one" />
            <span className="orbit-spark orbit-spark--two" />
          </div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card-top">
            <div>
              <span className="login-kicker">TESTUMGEBUNG</span>
              <h2 id="login-title">Anmelden und loslegen</h2>
            </div>
            <span className="login-lock"><UserRound size={19} strokeWidth={1.7} aria-hidden="true" /></span>
          </div>
          <p className="login-intro">{mode === "oidc" ? "Dein Konto und deine Freigaben werden vom Identitätsdienst bestätigt." : "Wähle die Perspektive, die du ausprobieren möchtest."}</p>

          {(error ?? loginError ?? personasError) && (
            <div className="inline-alert" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              <span>{loginError ?? personasError ?? error}</span>
            </div>
          )}

          {mode === "oidc" ? <form action="/api/auth/login" method="get"><input type="hidden" name="returnTo" value={pathname} /><button className="button button--primary button--wide" type="submit">Mit SSO anmelden <ArrowRight size={18} aria-hidden="true" /></button></form> : personasLoading && personas.length === 0 ? (
            <div className="persona-skeletons" aria-label="Testkonten werden geladen" aria-busy="true">
              {[0, 1, 2].map((item) => <div className="persona-skeleton" key={item} />)}
            </div>
          ) : personas.length > 0 ? (
            <div className="persona-list">
              {personas.map((persona) => (
                <button
                  className="persona-choice"
                  type="button"
                  key={persona.id}
                  disabled={pendingRole !== null}
                  onClick={() => void choosePersona(persona.role)}
                >
                  <span className={`persona-avatar persona-avatar--${persona.role}`}>{initials(persona.displayName)}</span>
                  <span className="persona-copy">
                    <span className="persona-name">{persona.displayName}</span>
                    <span className="persona-role">{roleLabel[persona.role]}</span>
                  </span>
                  {pendingRole === persona.role ? (
                    <span className="spinner" aria-label="Anmeldung läuft" />
                  ) : (
                    <ArrowRight className="persona-arrow" size={18} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          ) : (
            <button
              className="button button--secondary button--wide"
              type="button"
              onClick={() => {
                void refresh();
              }}
              disabled={personasLoading}
            >
              {personasLoading ? <span className="spinner" /> : "Verbindung erneut prüfen"}
            </button>
          )}

          <div className="login-card-foot">
            <span className="live-dot" />
            <span>Demo-Zugang · keine echten Kontodaten</span>
          </div>
        </section>
      </main>

      <footer className="welcome-footer">
        <span>Hochschule Hannover</span>
        <span className="footer-divider" />
        <span>HASI · Hochschulassistent</span>
        <span className="welcome-footer-right">Ein Prototyp für den Campusalltag</span>
      </footer>
    </div>
  );
}

function SessionLoading() {
  return (
    <main className="session-loading" aria-busy="true" aria-label="HASI wird geladen">
      <HasiMark />
      <span className="loading-line" />
    </main>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  count,
}: {
  href: string;
  label: string;
  icon: typeof MessageCircle;
  active: boolean;
  count?: number;
}) {
  return (
    <Link className={`nav-link${active ? " is-active" : ""}`} href={href} aria-label={count !== undefined && count > 1 ? `${label}, ${String(count)} Unterhaltungen` : undefined} aria-current={active ? "page" : undefined}>
      <Icon size={19} strokeWidth={active ? 2 : 1.8} aria-hidden="true" />
      <span>{label}</span>
      {count !== undefined && count > 1 && <small className="chat-count-badge" aria-hidden="true">{count}</small>}
    </Link>
  );
}

function ChatSessionsInSidebar({ store, onOpenChat }: { store: ChatWorkspaceStore; onOpenChat: () => void }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <ChatSessionList view={view} store={store} onOpenChat={onOpenChat} variant="embedded" />;
}

function ChatNavigation({ active, store, onOpenChat }: { active: boolean; store: ChatWorkspaceStore; onOpenChat: () => void }) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [expanded, setExpanded] = useState(true);
  return (
    <div className={`primary-nav-chat${expanded ? " is-expanded" : " is-collapsed"}`}>
      <div className={`primary-nav-chat-row${active ? " is-active" : ""}`}>
        <NavLink href="/" label="Chats" icon={MessageCircle} active={active} count={view.workspace.sessions.length} />
        <button
          className="primary-nav-chat-toggle"
          type="button"
          aria-label={expanded ? "Unterhaltungen ausblenden" : "Unterhaltungen einblenden"}
          aria-expanded={expanded}
          aria-controls="primary-chat-sessions"
          onClick={() => { setExpanded((value) => !value); }}
        >
          <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <div className="primary-nav-chat-sessions" id="primary-chat-sessions" hidden={!expanded}>
        <ChatSessionsInSidebar store={store} onOpenChat={onOpenChat} />
      </div>
    </div>
  );
}

function AppFrame({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, mode, logout } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const chatStore = useChatWorkspaceStore();
  const activeKey = pathname === "/bookings" ? "bookings" : pathname === "/admin" ? "admin" : "assistant";
  const frameRef = useChatViewport(activeKey === "assistant");
  const initial = user ? initials(user.displayName) : "H";

  async function handleLogout(): Promise<boolean> {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      return true;
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : "Die Abmeldung ist fehlgeschlagen.");
      return false;
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div ref={frameRef} className={`app-frame${activeKey === "assistant" ? " app-frame--chat" : ""}`}>
      <aside className="side-nav" aria-label="HASI Navigation">
        <WordmarkLink />
        <div className="side-nav-label">CAMPUS</div>
        <nav className="primary-nav" aria-label="Hauptnavigation">
          <ChatNavigation active={activeKey === "assistant"} store={chatStore} onOpenChat={() => { if (activeKey !== "assistant") router.push("/"); }} />
          <NavLink href="/bookings" label="Buchungen" icon={PanelTop} active={activeKey === "bookings"} />
          {user?.role === "admin" && (
            <NavLink href="/admin" label="Verwaltung" icon={PanelTop} active={activeKey === "admin"} />
          )}
        </nav>

        <div className="side-nav-spacer" />
        <div className="side-prototype-card">
          <span className="prototype-card-icon"><span className="status-dot" /></span>
          <span><strong>{prototypeLabel}</strong><small>HASI Testumgebung</small></span>
        </div>
        <div className="side-profile">
          <span className={`profile-avatar profile-avatar--${user?.role ?? "student"}`}>{initial}</span>
          <span className="profile-copy">
            <strong>{user?.displayName}</strong>
            <small>{mode === "mock" || mode === "public-demo" ? "Testkonto" : roleLabel[user?.role ?? "student"]}</small>
          </span>
          <button className="icon-button profile-logout" type="button" aria-label="Abmelden" onClick={() => void handleLogout()} disabled={loggingOut}>
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
        {logoutError && <p className="nav-error" role="alert">{logoutError}</p>}
      </aside>

      <div className="app-main">
        <PublicDemoNotice />
        <header className="app-topbar">
          <div className="mobile-brand"><HasiMark compact /></div>
          <div className="topbar-context">
            <span className="context-campus">HOCHSCHULE HANNOVER</span>
            <span className="topbar-separator" />
            <span className="prototype-label"><span className="status-dot" /> {prototypeLabel}</span>
          </div>
          <div className="topbar-actions">
            <ThemeControl />
            {user && <AccountMenu user={user} mode={mode} loggingOut={loggingOut} error={logoutError} onLogout={handleLogout} />}
          </div>
        </header>

        <div className="app-content">{children}</div>

        <nav className="mobile-nav" aria-label="Hauptnavigation">
          {navItems.map((item) => (
            <NavLink key={item.key} href={item.href} label={item.label} icon={item.icon} active={activeKey === item.key} />
          ))}
          {user?.role === "admin" && (
            <NavLink href="/admin" label="Verwaltung" icon={PanelTop} active={activeKey === "admin"} />
          )}
        </nav>
      </div>
    </div>
  );
}

export function WorkspaceShell({ children }: Readonly<{ children: ReactNode }>) {
  const { user, loading } = useSession();
  const pathname = usePathname();
  if (loading) return <SessionLoading />;
  if (!user) return <LoginScreen />;
  if (pathname === "/admin" && user.role !== "admin") {
    return (
      <AppFrame key={user.id}>
        <div className="access-denied">
          <span className="access-icon"><CircleAlert size={23} aria-hidden="true" /></span>
          <p className="eyebrow">KEIN ZUGRIFF</p>
          <h1>Diese Ansicht ist der Verwaltung vorbehalten.</h1>
          <Link className="button button--primary" href="/">Zum Assistenten <ArrowRight size={17} /></Link>
        </div>
      </AppFrame>
    );
  }
  return <AppFrame key={user.id}>{children}</AppFrame>;
}
