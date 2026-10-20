'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { useSession } from './session-provider';
import { revalidateProtectedChatWorkspace, useChatWorkspaceStore } from './chat-sidebar-context';
import {
  getPluginAccountHistoryLabel,
  parsePluginAccountBegin,
  parsePluginAccountList,
  parsePluginAccountRevoke,
  type PluginAccountPanelAccount,
} from '@/lib/plugin-accounts';

type Action = { installationId: string; operation: 'authorize' | 'disconnect' | 'retry' } | null;

function httpStatus(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : -1;
}

function requestFailureMessage(error: unknown): string {
  const status = httpStatus(error);
  if (status === 0 || status === -1) return 'Der Kontodienst ist derzeit nicht erreichbar. Bitte versuche es erneut.';
  if (status === 401) return 'Deine Sitzung ist abgelaufen. Melde dich an und lade diese Seite neu.';
  if (status === 403) return 'Diese Kontoverbindung ist für dein Konto nicht freigegeben.';
  if (status === 409) return 'Der Kontostatus hat sich geändert. Lade ihn neu und prüfe die Angaben.';
  return 'Die Kontoverbindung konnte nicht geändert werden. Aktualisiere den Status und prüfe die Angaben, bevor du es erneut versuchst.';
}

function statusLabel(status: PluginAccountPanelAccount['status']): string {
  switch (status) {
    case 'unlinked': return 'Nicht verbunden';
    case 'linked': return 'Verbunden';
    case 'expired': return 'Zugriff abgelaufen';
    case 'revoked': return 'Zugriff widerrufen';
    case 'disconnected': return 'Getrennt';
    case 'unavailable': return 'Status nicht prüfbar';
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unbekannt';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(date);
}

/** Personal provider consent is separate from centrally managed service setup. */
export function PluginAccountPanel() {
  const { mode } = useSession();
  const store = useChatWorkspaceStore();
  const [accounts, setAccounts] = useState<PluginAccountPanelAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Action>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    const controller = new AbortController();
    activeControllers.add(controller);
    void apiRequest<unknown>('/api/plugin-accounts', { signal: controller.signal })
      .then((value) => {
        const next = parsePluginAccountList(value);
        if (mounted.current) {
          setAccounts(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!mounted.current || cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(requestFailureMessage(cause));
      })
      .finally(() => {
        activeControllers.delete(controller);
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    };
  }, []);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try { return await apiRequest<T>(path, { ...init, signal: controller.signal }); }
    finally { controllers.current.delete(controller); }
  }, []);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading && mounted.current) setLoading(true);
    try {
      const next = parsePluginAccountList(await request<unknown>('/api/plugin-accounts'));
      if (!mounted.current) return;
      setAccounts(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current || cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(requestFailureMessage(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [request]);

  async function authorize(account: PluginAccountPanelAccount) {
    setBusy({ installationId: account.installationId, operation: 'authorize' });
    setError(null);
    setNotice(null);
    try {
      const operation = account.status === 'linked' || account.status === 'expired' ? 'renewal' : 'consent';
      const requestedReturnTo = new URLSearchParams(window.location.search).get('returnTo');
      const returnTo = requestedReturnTo === '/' || requestedReturnTo === '/bookings' || requestedReturnTo === '/admin' ? requestedReturnTo : '/account/connections';
      const response = parsePluginAccountBegin(await request<unknown>(`/api/plugin-accounts/${encodeURIComponent(account.installationId)}/authorization`, {
        method: 'POST',
        body: JSON.stringify({ operation, returnTo }),
      }));
      window.location.assign(response.authorizationUrl);
    } catch (cause) {
      if (mounted.current) setError(requestFailureMessage(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function disconnect(account: PluginAccountPanelAccount) {
    if (confirmingDisconnect !== account.installationId) {
      setConfirmingDisconnect(account.installationId);
      setNotice(null);
      return;
    }
    setBusy({ installationId: account.installationId, operation: 'disconnect' });
    setError(null);
    const release = mode === 'oidc'
      ? store.beginAuthorityChange('Kontorechte werden aktualisiert. Geschützte Antworten sind vorübergehend ausgeblendet.')
      : () => undefined;
    try {
      const result = parsePluginAccountRevoke(await request<unknown>(`/api/plugin-accounts/${encodeURIComponent(account.installationId)}/disconnect`, {
        method: 'POST',
        body: JSON.stringify({ expectedAuthorityRevision: account.authorityRevision }),
      }));
      release();
      if (mode === 'oidc') await revalidateProtectedChatWorkspace(store);
      if (!mounted.current) return;
      setConfirmingDisconnect(null);
      setNotice(result.revocationStatus === 'confirmed'
        ? 'HASI hat den Zugriff sofort gesperrt und der Anmeldedienst hat den Widerruf bestätigt.'
        : 'HASI hat den Zugriff sofort gesperrt. Der externe Widerruf steht noch aus; du kannst ihn erneut versuchen.');
      await load();
    } catch (cause) {
      if (mounted.current) setError(requestFailureMessage(cause));
    } finally {
      release();
      if (mounted.current) setBusy(null);
    }
  }

  async function retryRevocation(account: PluginAccountPanelAccount) {
    setBusy({ installationId: account.installationId, operation: 'retry' });
    setError(null);
    const release = mode === 'oidc'
      ? store.beginAuthorityChange('Kontorechte werden aktualisiert. Geschützte Antworten sind vorübergehend ausgeblendet.')
      : () => undefined;
    try {
      const result = parsePluginAccountRevoke(await request<unknown>(`/api/plugin-accounts/${encodeURIComponent(account.installationId)}/revocation/retry`, {
        method: 'POST',
        body: JSON.stringify({ expectedAuthorityRevision: account.authorityRevision }),
      }));
      release();
      if (mode === 'oidc') await revalidateProtectedChatWorkspace(store);
      if (!mounted.current) return;
      setNotice(result.revocationStatus === 'confirmed'
        ? 'Der Anmeldedienst hat den Widerruf bestätigt.'
        : 'Der externe Widerruf ist noch nicht bestätigt. HASI-Zugriffe bleiben gesperrt.');
      await load();
    } catch (cause) {
      if (mounted.current) setError(requestFailureMessage(cause));
    } finally {
      release();
      if (mounted.current) setBusy(null);
    }
  }

  return <section aria-labelledby="plugin-account-panel-title" className="state-card" style={{ display: 'block', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <h2 id="plugin-account-panel-title" style={{ margin: 0, fontSize: 20 }}>Persönliche Dienstkonten</h2>
      <button type="button" className="text-button" disabled={loading || busy !== null} onClick={() => { void load(true); }}>Status aktualisieren</button>
    </div>
    <p>Die Hochschuladministration richtet freigegebene Dienste und Zieladressen zentral ein. Hier verwaltest du nur deine persönliche Zustimmung und dein Konto. Passwörter und Zugangsdaten werden in HASI nicht abgefragt.</p>
    {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    {loading && <p role="status">Kontostatus wird geladen …</p>}
    {!loading && !error && accounts.length === 0 && <p>Für dein Konto sind derzeit keine persönlichen Dienstverbindungen eingerichtet.</p>}
    {!loading && accounts.map((account) => {
      const actionBusy = busy?.installationId === account.installationId;
      const unavailable = account.status === 'unavailable' || account.adapterTrust === 'missing';
      const canConnect = !unavailable && account.adapterTrust !== 'missing' && ['unlinked', 'expired', 'revoked', 'disconnected'].includes(account.status);
      const canRenew = !unavailable && account.status === 'linked';
      const canDisconnect = account.authorityRevision > 0 && ['linked', 'expired', 'unavailable'].includes(account.status);
      return <article key={account.installationId} style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ minWidth: 0, flex: '1 1 220px' }}>
            <h3 style={{ margin: 0, fontSize: 17 }}>{account.label}</h3>
            <p style={{ margin: '4px 0 0' }}><strong>{statusLabel(account.status)}</strong>{account.adapterTrust === 'demo-only' && <span> · Demo-Verbindung</span>}</p>
            {account.expiresAt && <p>Gültig bis {formatDate(account.expiresAt)}</p>}
            {account.flow !== 'idle' && <p role="status">Ein Anmeldevorgang wurde gestartet. Schließe ihn im Anmeldefenster ab oder starte die Verbindung erneut.</p>}
            {account.status === 'unavailable' && <p role="alert">HASI kann die aktuellen Rechte nicht prüfen und gibt den Dienst bis zur erfolgreichen Prüfung nicht frei.</p>}
            {account.adapterTrust === 'demo-only' && <p>Diese Verbindung dient ausschließlich der Demo. Sie bestätigt keine institutionelle Identität und keine echten Dienstrechte.</p>}
            {account.revocationStatus === 'pending' && <p role="status">HASI-Zugriffe sind gesperrt. Der externe Widerruf muss noch bestätigt werden.</p>}
            {account.remedies.includes('configure_adapter') && <p>Die Hochschule muss zuerst den Anmeldedienst für dieses Konto einrichten.</p>}
            {account.remedies.includes('retry_status') && <p>Der Anmeldedienst ist nicht erreichbar. Aktualisiere den Status, bevor du den Dienst erneut verwendest.</p>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            {(canConnect || canRenew) && <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => { void authorize(account); }}>
              {actionBusy && busy.operation === 'authorize' ? 'Anmeldung wird geöffnet …' : account.status === 'linked' ? 'Zugriff erneuern' : account.status === 'expired' ? 'Erneut anmelden' : 'Konto verbinden'}
            </button>}
            {canDisconnect && !confirmingDisconnect && <button type="button" className="text-button" disabled={busy !== null} onClick={() => { void disconnect(account); }}>Verbindung trennen</button>}
            {account.revocationStatus === 'pending' && <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => { void retryRevocation(account); }}>
              {actionBusy && busy.operation === 'retry' ? 'Widerruf wird wiederholt …' : 'Externen Widerruf erneut versuchen'}
            </button>}
          </div>
        </div>
        {confirmingDisconnect === account.installationId && <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-raised)' }}>
          <p><strong>Persönlichen Zugriff trennen?</strong></p>
          <p>Neue Aufrufe werden gesperrt und offene Bestätigungen ungültig. Eine bereits an den externen Dienst gesendete Aktion kann dort noch abgeschlossen werden. Abgeschlossene externe Änderungen werden nicht zurückgenommen. Der Chat-Verlauf bleibt nach den geltenden Aufbewahrungsregeln erhalten.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => { void disconnect(account); }}>
              {actionBusy && busy.operation === 'disconnect' ? 'Zugriff wird gesperrt …' : 'Verbindung endgültig trennen'}
            </button>
            <button type="button" className="text-button" disabled={busy !== null} onClick={() => { setConfirmingDisconnect(null); }}>Abbrechen</button>
          </div>
        </div>}
        {account.history.length > 0 && <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Letzte Änderungen</summary>
          <ul style={{ marginTop: 0, paddingLeft: 20 }}>
            {[...account.history].reverse().slice(0, 5).map((entry, index) => <li key={`${entry.operation}-${entry.at}-${String(index)}`}>{getPluginAccountHistoryLabel(entry.operation)} · {formatDate(entry.at)}</li>)}
          </ul>
        </details>}
      </article>;
    })}
  </section>;
}
