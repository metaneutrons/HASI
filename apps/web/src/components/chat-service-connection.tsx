"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import {
  parsePluginAccountBegin,
  parsePluginAccountList,
  type PluginAccountPanelAccount,
} from "@/lib/plugin-accounts";

const connectionsHref = "/account/connections?returnTo=%2F";

function httpStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : -1;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function failureMessage(error: unknown): string {
  const status = httpStatus(error);
  if (status === 0 || status === -1) return "Der Verbindungsdienst ist gerade nicht erreichbar. Aktualisiere den Status und versuche es erneut.";
  if (status === 401) return "Deine Sitzung ist abgelaufen. Melde dich an und öffne den Chat erneut.";
  if (status === 403) return "Dieses Dienstkonto ist für dein Konto nicht freigegeben. Öffne die verbundenen Dienste.";
  if (status === 404) return "Dieses Dienstkonto ist nicht mehr verfügbar. Prüfe die verbundenen Dienste.";
  if (status === 409) return "Der Kontostatus hat sich geändert. Aktualisiere ihn, bevor du fortfährst.";
  return "Die Verbindung konnte nicht geprüft werden. Aktualisiere den Status oder öffne die verbundenen Dienste.";
}

function demoConsentState(authorizationUrl: string, installationId: string): string | null {
  if (!authorizationUrl.startsWith("/") || authorizationUrl.startsWith("//")) return null;
  let url: URL;
  try { url = new URL(authorizationUrl, "https://hasi.invalid"); }
  catch { return null; }

  const keys = Array.from(url.searchParams.keys()).sort();
  const stateValues = url.searchParams.getAll("state");
  const installationValues = url.searchParams.getAll("installationId");
  if (url.origin !== "https://hasi.invalid"
    || url.pathname !== "/account/connections/consent"
    || url.hash
    || url.username
    || url.password
    || keys.length !== 2
    || keys[0] !== "installationId"
    || keys[1] !== "state"
    || installationValues.length !== 1
    || installationValues[0] !== installationId
    || stateValues.length !== 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(stateValues[0] ?? "")) return null;
  return stateValues[0] ?? null;
}

function accountIsReady(account: PluginAccountPanelAccount | null): account is PluginAccountPanelAccount {
  return account?.status === "linked"
    && account.adapterTrust !== "missing"
    && account.flow === "idle"
    && account.revocationStatus !== "pending";
}

function statusText(account: PluginAccountPanelAccount): string {
  if (account.status === "linked") return "Verbunden";
  if (account.status === "expired") return "Zugriff abgelaufen";
  if (account.status === "revoked") return "Zugriff widerrufen";
  if (account.status === "disconnected") return "Getrennt";
  if (account.status === "unavailable") return "Status nicht prüfbar";
  return "Nicht verbunden";
}

export function ChatServiceConnection({
  installationId,
  label,
  disabled,
  onReady,
}: {
  installationId: string;
  label: string;
  disabled: boolean;
  onReady: () => Promise<void>;
}) {
  const [account, setAccount] = useState<PluginAccountPanelAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const busyLock = useRef(false);
  const controllers = useRef(new Set<AbortController>());

  const readAccount = useCallback(async (signal: AbortSignal): Promise<PluginAccountPanelAccount | null> => {
    const accounts = parsePluginAccountList(await apiRequest<unknown>("/api/plugin-accounts", { signal }));
    return accounts.find(item => item.installationId === installationId) ?? null;
  }, [installationId]);

  const applyAccount = useCallback((next: PluginAccountPanelAccount | null) => {
    if (!alive.current) return;
    setAccount(next);
  }, []);

  function actionIsActive(signal: AbortSignal) { return alive.current && !signal.aborted; }

  useEffect(() => {
    alive.current = true;
    const activeControllers = controllers.current;
    const controller = new AbortController();
    activeControllers.add(controller);
    void readAccount(controller.signal)
      .then(next => {
        if (!actionIsActive(controller.signal)) return;
        applyAccount(next);
        if (!next) setError("Dieses Dienstkonto ist nicht mehr verfügbar. Prüfe die verbundenen Dienste.");
      })
      .catch((cause: unknown) => {
        if (actionIsActive(controller.signal) && !isAbort(cause)) setError(failureMessage(cause));
      })
      .finally(() => {
        activeControllers.delete(controller);
        if (actionIsActive(controller.signal)) setLoading(false);
      });
    return () => {
      alive.current = false;
      for (const active of activeControllers) active.abort();
      activeControllers.clear();
    };
  }, [applyAccount, installationId, readAccount]);

  async function exclusive(action: (signal: AbortSignal) => Promise<void>) {
    if (busyLock.current || disabled || loading) return;
    busyLock.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (actionIsActive(controller.signal) && !isAbort(cause)) setError(failureMessage(cause));
    } finally {
      controllers.current.delete(controller);
      busyLock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function refreshStatus() {
    await exclusive(async signal => {
      const next = await readAccount(signal);
      if (!actionIsActive(signal)) return;
      applyAccount(next);
      if (!next) setError("Dieses Dienstkonto ist nicht mehr verfügbar. Prüfe die verbundenen Dienste.");
    });
  }

  async function beginConnection() {
    await exclusive(async signal => {
      const current = await readAccount(signal);
      if (!actionIsActive(signal)) return;
      applyAccount(current);
      if (!current) throw Object.assign(new Error("missing"), { status: 404 });
      if (current.adapterTrust === "missing" || current.status === "unavailable" || current.revocationStatus === "pending") {
        throw Object.assign(new Error("not ready"), { status: 409 });
      }
      if (current.status === "linked" && current.flow === "idle") {
        setError("Das Konto ist bereits verbunden. Aktualisiere den Chatstatus und fahre dann ausdrücklich fort.");
        return;
      }

      const operation = current.status === "expired" || current.status === "linked" ? "renewal" : "consent";
      const remedy = operation === "renewal" ? "renew" : "connect";
      if (!current.remedies.includes(remedy)) throw Object.assign(new Error("connection unavailable"), { status: 409 });
      const begin = parsePluginAccountBegin(await apiRequest<unknown>(
        `/api/plugin-accounts/${encodeURIComponent(installationId)}/authorization`,
        { method: "POST", body: JSON.stringify({ operation, returnTo: "/" }), signal },
      ));
      if (!actionIsActive(signal)) return;

      if (current.adapterTrust === "demo-only") {
        const state = demoConsentState(begin.authorizationUrl, installationId);
        if (!state) throw new TypeError("Invalid local demo consent URL");
        try {
          await apiRequest<unknown>(`/api/plugin-accounts/${encodeURIComponent(installationId)}/consent`, {
            method: "POST",
            body: JSON.stringify({ state, approved: true }),
            signal,
          });
        } catch (cause) {
          // A lost response must not strand an already completed one-time consent.
          if (!actionIsActive(signal) || isAbort(cause)) return;
          const refreshed = await readAccount(signal);
          if (!accountIsReady(refreshed)) throw cause;
          applyAccount(refreshed);
        }
        if (!actionIsActive(signal)) return;
        const refreshed = await readAccount(signal);
        if (!actionIsActive(signal)) return;
        applyAccount(refreshed);
        if (!accountIsReady(refreshed)) throw Object.assign(new Error("consent not active"), { status: 409 });
        try {
          await onReady();
        } catch {
          if (alive.current) setError("Das Konto ist verbunden, aber die Anfrage konnte nicht fortgesetzt werden. Aktualisiere den Status und versuche es erneut.");
        }
        return;
      }
      if (!begin.authorizationUrl.startsWith("https://")) {
        throw new TypeError("Invalid provider authorization URL");
      }
      window.location.assign(begin.authorizationUrl);
    });
  }

  async function continueRequest() {
    await exclusive(async signal => {
      const current = await readAccount(signal);
      if (!actionIsActive(signal)) return;
      applyAccount(current);
      if (!accountIsReady(current)) throw Object.assign(new Error("not linked"), { status: 409 });
      try {
        await onReady();
      } catch {
        if (alive.current) setError("Das Konto ist verbunden, aber die Anfrage konnte nicht fortgesetzt werden. Aktualisiere den Status und versuche es erneut.");
      }
    });
  }

  const blocked = disabled || loading || busy;
  const hasPendingFlow = account?.flow !== undefined && account.flow !== "idle";
  const beginRemedy = account?.status === "expired" || account?.status === "linked" ? "renew" : "connect";
  const canBegin = account !== null
    && account.remedies.includes(beginRemedy)
    && (account.status !== "linked" || hasPendingFlow)
    && account.adapterTrust !== "missing"
    && account.status !== "unavailable"
    && account.revocationStatus !== "pending";
  const canContinue = accountIsReady(account);
  const needsConnectionsPage = !account
    || account.adapterTrust === "missing"
    || account.status === "unavailable"
    || account.revocationStatus === "pending"
    || hasPendingFlow
    || error !== null;

  return (
    <section className="chat-tool-card" aria-label={`Verbindung für ${label}`} style={{ minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <h3 style={{ marginTop: 0, overflowWrap: "anywhere" }}>{label}</h3>
          {loading && <p role="status">Verbindungsstatus wird geprüft …</p>}
          {!loading && account && <p><strong>{statusText(account)}</strong></p>}
          {!loading && !account && <p>HASI kann dieses Dienstkonto gerade nicht zuordnen.</p>}
          {account?.adapterTrust === "demo-only" && <p>Mit der folgenden Aktion erlaubst du HASI, freigegebene Testdaten dieses simulierten Dienstes für dieselbe Anfrage zu lesen. Es werden ausschließlich Testdaten verwendet. Eine Buchung oder andere Änderung wird dadurch nicht ausgeführt; HASI zeigt solche Schritte gesondert zur Prüfung und Bestätigung.</p>}
          {account?.adapterTrust === "trusted" && canBegin && <p>Du meldest dich beim Dienst an. Das Verbinden allein führt keine Buchung oder andere Änderung aus.</p>}
          {account?.status === "unavailable" && <p>HASI kann die aktuellen Rechte nicht prüfen und gibt den Dienst bis zur erfolgreichen Prüfung nicht frei.</p>}
          {account?.revocationStatus === "pending" && <p>HASI-Zugriffe bleiben gesperrt, bis der externe Widerruf bestätigt ist.</p>}
          {hasPendingFlow && <p>Ein früherer Anmeldevorgang ist noch offen. Ein Neustart ersetzt diesen Vorgang; sein bisheriger Bestätigungslink wird ungültig.</p>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {loading && <button type="button" className="button button--secondary" disabled style={{ minHeight: 44 }}>Status wird geprüft …</button>}
          {!loading && canBegin && <button type="button" className="button button--secondary" disabled={blocked} onClick={() => { void beginConnection(); }} style={{ minHeight: 44 }}>
            {account.adapterTrust === "demo-only"
              ? account.status === "expired" || account.status === "linked" ? "Testzugriff erneuern und fortfahren" : "Testkonto verbinden und fortfahren"
              : hasPendingFlow ? "Anmeldung neu starten" : account.status === "expired" ? "Zugriff erneuern" : "Dienstkonto verbinden"}
          </button>}
          {!loading && canContinue && <button type="button" className="button button--primary" disabled={blocked} onClick={() => { void continueRequest(); }} style={{ minHeight: 44 }}>
            Anfrage fortsetzen
          </button>}
          {!loading && needsConnectionsPage && <Link
            className="chat-card-action"
            href={connectionsHref}
            aria-disabled={blocked}
            tabIndex={blocked ? -1 : undefined}
            onClick={event => { if (blocked) event.preventDefault(); }}
          >Verbundene Dienste öffnen</Link>}
        </div>
      </div>

      {!loading && error && <p role="alert">{error}</p>}
      {!loading && (error !== null || needsConnectionsPage) && <button type="button" className="text-button" disabled={blocked} onClick={() => { void refreshStatus(); }} style={{ minHeight: 44 }}>
        Verbindungsstatus aktualisieren
      </button>}
    </section>
  );
}
