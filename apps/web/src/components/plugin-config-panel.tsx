'use client';

import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { PluginConfigFields } from '@/components/plugin-config-fields';
import { useActionFocusRecovery } from '@/lib/use-action-focus-recovery';
import {
  configurationRequestError,
  getConfigurationFieldSet,
  getVisibleConfigurationErrorPaths,
  getUnmappedConfigurationServerErrors,
  hasPendingConfiguration,
  parseConfigurationRevisionResult,
  parseConfigurationServerErrors,
  parsePluginConnectionTestResult,
  parsePluginConfigurationResponse,
  validateConfigurationDraft,
  setConfigurationPointer,
  type ConfigurationJson,
  type ConfigurationToolOption,
  type PluginConfigurationDetails,
  type PluginConnectionTestResult,
  type PluginConnectionTestRemedy,
} from '@/lib/plugin-configuration';

type Action = 'load' | 'draft' | 'activate' | 'update' | 'test' | null;
type UpdateStatus = 'current' | 'available' | 'blocked';

export interface PluginConfigPanelProps {
  pluginId: string;
  name: string;
  tools: ConfigurationToolOption[];
  /** API resource root. By default this is the existing remote-plugin admin path. */
  apiBase?: string;
  mode?: 'remote' | 'managed';
  onChanged?: () => void | Promise<void>;
}

const panelStyle = {
  marginTop: 12,
  borderTop: '1px solid var(--line)',
  color: 'var(--ink)',
} as const;

const summaryStyle = {
  display: 'flex',
  minHeight: 52,
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  cursor: 'pointer',
  listStyle: 'none',
} as const;

export function PluginConfigPanel({
  pluginId,
  name,
  tools,
  apiBase = `/api/admin/plugins/${encodeURIComponent(pluginId)}`,
  mode = 'remote',
  onChanged,
}: PluginConfigPanelProps) {
  const panelRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const activateButtonRef = useRef<HTMLButtonElement>(null);
  const reloadConflictButtonRef = useRef<HTMLButtonElement>(null);
  const keepInputsButtonRef = useRef<HTMLButtonElement>(null);
  const retryLoadButtonRef = useRef<HTMLButtonElement>(null);
  const testConnectionButtonRef = useRef<HTMLButtonElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef<boolean>(false);
  const controllers = useRef(new Set<AbortController>());
  const fieldElements = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const { beginFocusRecovery, completeFocusRecovery, cancelFocusRecovery, flushFocusRecovery } = useActionFocusRecovery();
  const id = useId();
  const [pluginDetails, setPluginDetails] = useState<PluginConfigurationDetails | null>(null);
  const [rawValues, setRawValues] = useState<Record<string, unknown>>({});
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [busy, setBusy] = useState<Action>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{ status: UpdateStatus; message: string } | null>(null);
  const [connectionTest, setConnectionTest] = useState<PluginConnectionTestResult | null>(null);
  const [connectionTestError, setConnectionTestError] = useState<string | null>(null);

  const toolNames = useMemo(() => new Set(tools.map((tool) => tool.name)), [tools]);
  const fieldSet = useMemo(
    () => getConfigurationFieldSet(pluginDetails?.schema, pluginDetails?.secrets),
    [pluginDetails?.schema, pluginDetails?.secrets],
  );
  const validation = useMemo(() => validateConfigurationDraft(
    pluginDetails?.schema,
    rawValues,
    disabledTools,
    tools,
    pluginDetails?.secrets,
  ), [pluginDetails?.schema, pluginDetails?.secrets, rawValues, disabledTools, tools]);
  const fieldErrors = { ...validation.errors, ...serverFieldErrors };
  const unknownDisabledTools = disabledTools.filter((toolName) => !toolNames.has(toolName));
  const comparableValues = validation.valid && validation.payload ? validation.payload.values : rawValues;
  const comparableDisabledTools = validation.valid && validation.payload ? validation.payload.disabledTools : disabledTools;
  const localChanges = pluginDetails !== null && hasPendingConfiguration(
    pluginDetails.draft,
    comparableValues,
    pluginDetails.draftDisabledTools,
    comparableDisabledTools,
  ) || unknownDisabledTools.length > 0;
  const draftPending = pluginDetails !== null && hasPendingConfiguration(
    pluginDetails.configuration,
    pluginDetails.draft,
    pluginDetails.disabledTools,
    pluginDetails.draftDisabledTools,
  );
  const missingSecrets = pluginDetails?.secrets.filter((secret) => secret.required && !secret.configured) ?? [];
  const unmappedServerFieldErrors = getUnmappedConfigurationServerErrors(
    serverFieldErrors,
    fieldSet.root ? getVisibleConfigurationErrorPaths(fieldSet.root, rawValues) : new Set(),
  );
  const fieldId = (fieldName: string) => `${id}-${encodeURIComponent(fieldName)}`;

  useEffect(() => {
    const activeControllers = controllers.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    };
  }, []);

  function isStillMounted(): boolean {
    return mounted.current;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await apiRequest<T>(path, { ...init, signal: controller.signal });
    } finally {
      controllers.current.delete(controller);
    }
  }

  function endpoint(suffix = ''): string {
    return `${apiBase}/configuration${suffix}`;
  }

  async function notifyConfigurationChanged(): Promise<void> {
    try {
      await onChanged?.();
    } catch {
      // A parent refresh must not make a saved configuration look unsuccessful.
    }
  }

  function adoptDetails(next: PluginConfigurationDetails) {
    setPluginDetails(next);
    setRawValues(next.draft);
    setServerFieldErrors({});
    setDisabledTools(next.draftDisabledTools);
    setConflict(false);
    setConfirmReload(false);
    setLoadError(null);
  }

  async function fetchDetails(): Promise<PluginConfigurationDetails> {
    const response = await request<unknown>(endpoint());
    return parsePluginConfigurationResponse(response);
  }

  async function testConnection(origin: HTMLElement) {
    if (!pluginDetails) return;
    const focusToken = beginFocusRecovery(origin);
    const secrets = pluginDetails.secrets;
    setBusy('test');
    setConnectionTestError(null);
    setConnectionTest(null);
    try {
      const response = await request<unknown>(`${apiBase}/test-connection`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const result = parsePluginConnectionTestResult(response, secrets);
      if (result.instanceId !== pluginId) throw new TypeError('Invalid plugin connection test response');
      if (!isStillMounted()) return;
      setConnectionTest(result);
      completeFocusRecovery(focusToken, () => testConnectionButtonRef.current);
    } catch (cause) {
      if (!isStillMounted()) return;
      const status = getHttpStatus(cause);
      setConnectionTestError(status === 0
        ? 'Der Verbindungstest ist derzeit nicht erreichbar. Deine Eingaben bleiben erhalten.'
        : status === 401 || status === 403
          ? 'Du bist nicht berechtigt, diesen Verbindungstest auszuführen.'
          : 'Der Verbindungstest konnte nicht abgeschlossen werden. Deine Eingaben bleiben erhalten.');
      completeFocusRecovery(focusToken, () => testConnectionButtonRef.current);
    } finally {
      if (isStillMounted()) setBusy(null);
    }
  }

  async function loadDetails(focusToken: symbol | null = null) {
    setBusy('load');
    setLoadError(null);
    setNotice(null);
    try {
      const next = await fetchDetails();
      if (!isStillMounted()) return;
      adoptDetails(next);
      completeFocusRecovery(focusToken, firstEnabledConfigurationField);
    } catch (cause) {
      if (!isStillMounted()) return;
      setLoadError(configurationRequestError(getHttpStatus(cause)));
      completeFocusRecovery(focusToken, () => keepInputsButtonRef.current ?? retryLoadButtonRef.current ?? summaryRef.current);
    } finally {
      if (isStillMounted()) setBusy(null);
    }
  }

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open && pluginDetails === null && busy === null) {
      void loadDetails();
    }
  }

  function focusFirstError(errors: Record<string, string>) {
    const firstField = Object.keys(errors).find((key) => fieldElements.current.has(key));
    if (firstField) {
      queueMicrotask(() => fieldElements.current.get(firstField)?.focus());
      return;
    }
    queueMicrotask(() => panelRef.current?.querySelector<HTMLElement>('summary')?.focus());
  }

  function firstEnabledConfigurationField(): HTMLElement | null {
    for (const element of fieldElements.current.values()) {
      if (element.isConnected && !element.disabled) return element;
    }
    return summaryRef.current;
  }

  useLayoutEffect(() => {
    if (busy === null) flushFocusRecovery();
  }, [busy, conflict, confirmReload, pluginDetails?.revision, localChanges, draftPending, loadError, flushFocusRecovery]);

  async function saveDraft(origin: HTMLElement) {
    if (!pluginDetails) return;
    const payload = validation.payload;
    if (!validation.valid || payload === undefined) {
      focusFirstError(validation.errors);
      setNotice('Bitte prüfe die markierten Felder. Der Server kontrolliert die Konfiguration zusätzlich.');
      return;
    }
    const focusToken = beginFocusRecovery(origin);
    setBusy('draft');
    setLoadError(null);
    setNotice(null);
    try {
      const result = parseConfigurationRevisionResult(await request<unknown>(endpoint('/draft'), {
        method: 'POST',
        body: JSON.stringify({
          revision: pluginDetails.revision,
          values: payload.values,
          disabledTools: payload.disabledTools,
        }),
      }));
      if (!isStillMounted()) return;
      setPluginDetails((current) => current ? {
        ...current,
        revision: result.revision,
        activeRevision: result.activeRevision,
        draft: payload.values,
        draftDisabledTools: payload.disabledTools,
      } : current);
      setDisabledTools(payload.disabledTools);
      setServerFieldErrors({});
      setConflict(false);
      setNotice('Entwurf gespeichert. Er wird erst nach der getrennten Aktivierung wirksam.');
      completeFocusRecovery(focusToken, () => {
        const activateButton = activateButtonRef.current;
        return activateButton && !activateButton.disabled ? activateButton : summaryRef.current;
      });
      await notifyConfigurationChanged();
    } catch (cause) {
      if (!isStillMounted()) return;
      const status = getHttpStatus(cause);
      setLoadError(configurationRequestError(status));
      const serverErrors = parseConfigurationServerErrors(cause);
      if (Object.keys(serverErrors).length > 0) {
        setServerFieldErrors(serverErrors);
        focusFirstError(serverErrors);
      }
      if (status === 409) {
        setConflict(true);
        completeFocusRecovery(focusToken, () => reloadConflictButtonRef.current);
      } else if (Object.keys(serverErrors).length === 0) {
        completeFocusRecovery(focusToken, () => saveButtonRef.current);
      } else {
        cancelFocusRecovery(focusToken);
      }
    } finally {
      if (isStillMounted()) setBusy(null);
    }
  }

  async function activateDraft(origin: HTMLElement) {
    if (!pluginDetails || !draftPending || localChanges) return;
    if (missingSecrets.length > 0) {
      setLoadError('Erforderliche Zugangsdaten fehlen. Sie müssen serverseitig eingerichtet werden, bevor der Entwurf aktiviert werden kann.');
      return;
    }
    const focusToken = beginFocusRecovery(origin);
    setBusy('activate');
    setLoadError(null);
    setNotice(null);
    try {
      const result = parseConfigurationRevisionResult(await request<unknown>(endpoint('/activate'), {
        method: 'POST',
        body: JSON.stringify({ revision: pluginDetails.revision }),
      }));
      if (!isStillMounted()) return;
      setPluginDetails((current) => current ? {
        ...current,
        revision: result.revision,
        activeRevision: result.activeRevision,
        configuration: current.draft,
        disabledTools: current.draftDisabledTools,
      } : current);
      setNotice('Der gespeicherte Entwurf wurde aktiviert. Aktionen mit einer älteren Revision sind ungültig.');
      try {
        const refreshed = await fetchDetails();
      if (isStillMounted()) adoptDetails(refreshed);
      } catch {
        if (isStillMounted()) setLoadError('Der Entwurf wurde aktiviert, aber der aktuelle Status konnte nicht neu geladen werden. Bitte aktualisiere die Ansicht.');
      }
      await notifyConfigurationChanged();
      completeFocusRecovery(focusToken, () => summaryRef.current);
    } catch (cause) {
      if (!isStillMounted()) return;
      const status = getHttpStatus(cause);
      setLoadError(configurationRequestError(status));
      if (status === 409) {
        setConflict(true);
        completeFocusRecovery(focusToken, () => reloadConflictButtonRef.current ?? summaryRef.current);
      } else {
        completeFocusRecovery(focusToken, () => {
          const activateButton = activateButtonRef.current;
          return activateButton && !activateButton.disabled ? activateButton : summaryRef.current;
        });
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function checkUpdate(origin: HTMLElement) {
    if (conflict) return;
    const focusToken = beginFocusRecovery(origin);
    const stateBeforeCheck = pluginDetails;
    const hadLocalChanges = localChanges;
    const hadPendingDraft = draftPending;
    setBusy('update');
    setLoadError(null);
    setNotice(null);
    setUpdateStatus(null);
    try {
      const response = await request<unknown>(`${apiBase}/check-update`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const update = parseUpdateStatus(response);
      if (!isStillMounted()) return;
      setUpdateStatus(update);
      const refreshed = await fetchDetails();
      if (!isStillMounted()) return;
      if (hadLocalChanges && stateBeforeCheck && refreshed.revision !== stateBeforeCheck.revision) {
        setConflict(true);
        setLoadError(configurationRequestError(409));
        setNotice('Die Updateprüfung hat einen neuen Serverstand ergeben. Deine lokalen Eingaben sind erhalten; lade den neuen Stand bewusst, bevor du weiterarbeitest.');
      } else if (hadLocalChanges) {
        setPluginDetails((current) => current ? {
          ...current,
          ready: refreshed.ready,
          secrets: refreshed.secrets,
          audit: refreshed.audit,
        } : current);
      } else {
        adoptDetails(refreshed);
        setNotice(stateBeforeCheck && refreshed.revision !== stateBeforeCheck.revision && hadPendingDraft
          ? 'Der Serverstand wurde aktualisiert. Aktionen mit der früheren Revision sind ungültig; der aktuelle Entwurf wurde neu geladen.'
          : null);
      }
      completeFocusRecovery(focusToken, () => reloadConflictButtonRef.current ?? updateButtonRef.current);
    } catch (cause) {
      if (!isStillMounted()) return;
      setLoadError(configurationRequestError(getHttpStatus(cause)));
      completeFocusRecovery(focusToken, () => reloadConflictButtonRef.current ?? updateButtonRef.current);
    } finally {
      if (isStillMounted()) setBusy(null);
    }
  }

  function updateConfigurationValue(path: string, value: ConfigurationJson) {
    setRawValues((current) => setConfigurationPointer(current as Record<string, ConfigurationJson>, path, value));
    setServerFieldErrors({});
    setLoadError(null);
    setNotice(null);
  }

  function removeConfigurationValue(path: string) {
    setRawValues((current) => setConfigurationPointer(current as Record<string, ConfigurationJson>, path, undefined));
    setServerFieldErrors({});
    setLoadError(null);
    setNotice(null);
  }

  return (
    <details ref={panelRef} className="plugin-config-panel" style={panelStyle} onToggle={handleToggle}>
      <summary ref={summaryRef} style={summaryStyle}>
        <span className="sr-only">{name}: </span>
        <span style={{ display: 'grid', minWidth: 0, gap: 3 }}>
          <strong style={{ fontSize: 14, fontWeight: 650 }}>Einstellungen und Funktionsfreigaben</strong>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>Konfiguration, Zugangsdatenstatus und deaktivierte Funktionen</span>
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>

      <div style={{ display: 'grid', minWidth: 0, gap: 14, padding: '6px 0 2px' }}>
        {busy === 'load' && !pluginDetails ? (
          <p role="status" style={{ margin: 0, color: 'var(--muted)' }}>Konfiguration wird geladen …</p>
        ) : loadError && !pluginDetails ? (
          <div role="alert" style={noticeStyle('error')}>
            <span>{loadError}</span>
            <button
              ref={retryLoadButtonRef}
              className="button button--secondary"
              type="button"
              disabled={busy !== null}
              onClick={(event) => {
                const focusToken = beginFocusRecovery(event.currentTarget);
                void loadDetails(focusToken);
              }}
              style={buttonStyle}
            >
              Erneut laden
            </button>
          </div>
        ) : pluginDetails ? (
          <>
            <section aria-label="Serverseitiger Konfigurationsstatus" style={noticeStyle(pluginDetails.ready ? 'success' : 'warning')}>
              {pluginDetails.ready ? <CircleCheck size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
              <div style={{ minWidth: 0 }}>
                <strong>{pluginDetails.ready ? 'Serverseitige Konfiguration bereit' : 'Serverseitige Konfiguration benötigt Aufmerksamkeit'}</strong>
                <p style={{ margin: '3px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
                  Dieser Status betrifft öffentliche Konfiguration und erforderliche Zugangsdaten. Erreichbarkeit, Nutzerrechte und Werkzeugfreigaben werden getrennt geprüft.
                </p>
              </div>
            </section>

            {mode === 'remote' && <section aria-label="Verbindungstest" style={sectionStyle}>
              <div style={sectionHeadingStyle}>
                <h4 style={headingStyle}><RefreshCw size={15} aria-hidden="true" /> Verbindungstest</h4>
                <button
                  ref={testConnectionButtonRef}
                  className="button button--secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={(event) => { void testConnection(event.currentTarget); }}
                  style={buttonStyle}
                >
                  {busy === 'test' ? <><span className="spinner" /> Verbindung wird geprüft</> : <>Aktive Verbindung testen <RefreshCw size={14} aria-hidden="true" /></>}
                </button>
              </div>
              <p style={quietTextStyle}>Geprüft wird die aktive serverseitige Konfiguration. Nicht gespeicherte Eingaben bleiben erhalten und werden nicht getestet.</p>
              {connectionTestError && <div role="alert" style={{ ...noticeStyle('error'), marginTop: 8 }}>{connectionTestError}</div>}
              <div role="status" aria-live="polite" aria-atomic="true">
                {busy === 'test' ? <span className="sr-only">Verbindung wird geprüft.</span> : connectionTest && (
                  <div style={{ display: 'grid', minWidth: 0, gap: 8, marginTop: 9 }}>
                    <div style={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', gap: '4px 14px', color: 'var(--muted)', fontSize: 12 }}>
                      <span>Instanz <strong style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{connectionTest.instanceId}</strong></span>
                      <span>Zuletzt geprüft <time dateTime={connectionTest.checkedAt}>{formatAuditTime(connectionTest.checkedAt)}</time></span>
                    </div>
                    <ul style={listStyle}>
                      <ConnectionDiagnostic label="Konfiguration" value={connectionTest.configured === 'ready' ? 'Bereit' : 'Unvollständig'} tone={connectionTest.configured === 'ready' ? 'success' : 'warning'} />
                      <ConnectionDiagnostic label="Erreichbarkeit und freigegebener MCP-Vertrag" value={connectionTest.reachable === 'verified' ? 'Bestätigt' : 'Fehlgeschlagen'} tone={connectionTest.reachable === 'verified' ? 'success' : 'error'} />
                      <ConnectionDiagnostic label="Dienstanmeldung" value={connectionTest.authenticated === 'rejected' ? 'Abgelehnt' : 'Nicht nachgewiesen'} tone={connectionTest.authenticated === 'rejected' ? 'error' : 'neutral'} />
                      <ConnectionDiagnostic label="Nutzerberechtigung" value="Nicht geprüft" tone="neutral" />
                      <ConnectionDiagnostic label="Nutzungsbereitschaft" value={connectionTest.userReady === 'blocked' ? 'Blockiert' : 'Nicht geprüft'} tone={connectionTest.userReady === 'blocked' ? 'warning' : 'neutral'} />
                    </ul>
                    <p style={{ ...quietTextStyle, fontSize: 12 }}>
                      Ein erfolgreicher MCP-Test bestätigt weder die Prüfung des Diensttokens noch die Rechte eines konkreten Endnutzers.
                    </p>
                    {connectionTest.remedies.length > 0 && (
                      <div style={noticeStyle(connectionTest.reachable === 'failed' || connectionTest.authenticated === 'rejected' ? 'warning' : 'neutral')}>
                        <div style={{ minWidth: 0 }}>
                          <strong>Nächste Schritte</strong>
                          <ul style={{ ...listStyle, marginTop: 5 }}>
                            {connectionTest.remedies.map((remedy, index) => (
                              <li key={`${remedy.code}-${remedy.field ?? ''}-${String(index)}`} style={{ padding: '4px 0' }}>
                                <strong>{remedy.field ? `Zugangsdaten: ${remedy.field}` : connectionRemedyTitle(remedy.code)}</strong>
                                <span>: {remedy.message}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>}

            <div style={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', gap: '6px 16px', color: 'var(--muted)', fontSize: 13 }}>
              <span>Serverrevision <strong style={{ color: 'var(--ink)' }}>{pluginDetails.revision}</strong></span>
              <span>Aktive Revision <strong style={{ color: 'var(--ink)' }}>{pluginDetails.activeRevision}</strong></span>
              {localChanges && <span role="status" style={{ color: 'var(--accent-deep)' }}>Lokale Änderungen noch nicht gespeichert</span>}
              {!localChanges && draftPending && <span role="status" style={{ color: 'var(--accent-deep)' }}>Gespeicherter Entwurf wartet auf Aktivierung</span>}
            </div>

            {loadError && <div role="alert" style={noticeStyle('error')}>
              <span>{loadError}</span>
              {conflict && !confirmReload && (
                <button
                  ref={reloadConflictButtonRef}
                  className="button button--secondary"
                  type="button"
                  onClick={(event) => {
                    const token = beginFocusRecovery(event.currentTarget);
                    completeFocusRecovery(token, () => keepInputsButtonRef.current);
                    setConfirmReload(true);
                  }}
                  style={buttonStyle}
                >
                  Serverstand neu laden
                </button>
              )}
              {conflict && confirmReload && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <span>Beim Neuladen werden deine lokalen Eingaben verworfen.</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={(event) => {
                        const token = beginFocusRecovery(event.currentTarget);
                        void loadDetails(token);
                      }}
                      style={buttonStyle}
                    >
                      {busy === 'load' ? 'Wird geladen …' : 'Verwerfen und neu laden'}
                    </button>
                    <button
                      ref={keepInputsButtonRef}
                      className="button button--secondary"
                      type="button"
                      onClick={(event) => {
                        const token = beginFocusRecovery(event.currentTarget);
                        completeFocusRecovery(token, () => reloadConflictButtonRef.current);
                        setConfirmReload(false);
                      }}
                      style={buttonStyle}
                    >Eingaben behalten</button>
                  </div>
                </div>
              )}
            </div>}
            {notice && <div role="status" aria-live="polite" style={noticeStyle('neutral')}>{notice}</div>}

            <section aria-labelledby={`${id}-secrets-heading`} style={sectionStyle}>
              <div style={sectionHeadingStyle}>
                <h4 id={`${id}-secrets-heading`} style={headingStyle}><KeyRound size={16} aria-hidden="true" /> Zugangsdaten</h4>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Serverseitig verwaltet</span>
              </div>
              {pluginDetails.secrets.length === 0 ? (
                <p style={quietTextStyle}>Dieses Plug-in deklariert keine Zugangsdaten.</p>
              ) : (
                <ul style={listStyle}>
                  {pluginDetails.secrets.map((secret) => (
                    <li key={secret.name} style={rowStyle}>
                      <span style={{ display: 'grid', minWidth: 0, gap: 2 }}>
                        <strong style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{secret.name}</strong>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{secret.required ? 'Erforderlich' : 'Optional'} · serverseitig verwaltet</span>
                      </span>
                      <span style={{ color: secret.configured ? 'var(--green)' : secret.required ? 'var(--red)' : 'var(--muted)', fontSize: 13, fontWeight: 620 }}>
                        {secret.configured ? 'Hinterlegt' : secret.required ? 'Fehlt' : 'Nicht hinterlegt'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {missingSecrets.length > 0 && (
                <p role="status" style={{ margin: '8px 0 0', color: 'var(--red)', fontSize: 13 }}>
                  Erforderliche Zugangsdaten fehlen. Hier werden weder Werte noch Secret-Referenzen eingegeben.
                </p>
              )}
            </section>

            <section aria-labelledby={`${id}-configuration-heading`} style={sectionStyle}>
              <div style={sectionHeadingStyle}>
                <h4 id={`${id}-configuration-heading`} style={headingStyle}>Öffentliche Konfiguration</h4>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Entwurf</span>
              </div>
              {!pluginDetails.schema ? (
                <p style={quietTextStyle}>Dieses Plug-in deklariert keine öffentlichen Konfigurationsfelder.</p>
              ) : !fieldSet.supported ? (
                <div role="status" style={noticeStyle('warning')}>{fieldSet.reason}</div>
              ) : fieldSet.fields.length === 0 ? (
                <p style={quietTextStyle}>Dieses Plug-in deklariert keine bearbeitbaren öffentlichen Felder.</p>
              ) : fieldSet.root ? (
                <PluginConfigFields
                  root={fieldSet.root}
                  values={rawValues as Record<string, ConfigurationJson>}
                  errors={fieldErrors}
                  disabled={busy !== null || conflict}
                  onChange={updateConfigurationValue}
                  onRemove={removeConfigurationValue}
                  onRef={(path, element) => {
                    if (element) fieldElements.current.set(path, element);
                    else fieldElements.current.delete(path);
                  }}
                />
              ) : <div role="status" style={noticeStyle('warning')}>Das Konfigurationsschema konnte nicht geladen werden.</div>}
              {pluginDetails.schema && !validation.valid && Object.entries(validation.errors).some(([key]) => key.startsWith('_')) && (
                <p role="alert" style={{ margin: '10px 0 0', color: 'var(--red)', fontSize: 13 }}>
                  {validation.errors._schema ?? validation.errors._configuration}
                </p>
              )}
              {Object.keys(unmappedServerFieldErrors).length > 0 && (
                <div role="alert" style={{ display: 'grid', gap: 6, marginTop: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 10, color: 'var(--red)', fontSize: 13 }}>
                  <strong>Weitere serverseitige Feldhinweise</strong>
                  <span>Mindestens ein Feld ist in der aktuellen Ansicht nicht sichtbar. Prüfe den angegebenen Pfad oder wechsle die Variante.</span>
                  <ul style={{ ...listStyle, color: 'var(--red)' }}>
                    {Object.entries(unmappedServerFieldErrors).map(([path, message]) => (
                      <li key={path} style={{ padding: '3px 0', overflowWrap: 'anywhere' }}>
                        <code>{path || '/'}</code>: {message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section aria-labelledby={`${id}-tools-heading`} style={sectionStyle}>
              <div style={sectionHeadingStyle}>
                <h4 id={`${id}-tools-heading`} style={headingStyle}>Funktionsfreigaben</h4>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Sperren werden serverseitig erzwungen</span>
              </div>
              {tools.length === 0 ? (
                <p style={quietTextStyle}>Für dieses Plug-in sind keine Funktionen registriert.</p>
              ) : (
                <ul style={listStyle}>
                  {tools.map((tool) => {
                    const isDisabled = disabledTools.includes(tool.name);
                    const checkboxId = fieldId(`tool-${tool.name}`);
                    return (
                      <li key={tool.name} style={rowStyle}>
                        <label htmlFor={checkboxId} style={{ display: 'flex', minWidth: 0, minHeight: 44, flex: 1, alignItems: 'center', gap: 10, cursor: busy || conflict ? 'default' : 'pointer' }}>
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={isDisabled}
                            disabled={busy !== null || conflict}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setDisabledTools((current) => checked
                                ? [...new Set([...current, tool.name])]
                                : current.filter((name) => name !== tool.name));
                            }}
                            style={{ width: 20, height: 20, flex: '0 0 auto', accentColor: 'var(--accent)' }}
                          />
                          <span style={{ display: 'grid', minWidth: 0, gap: 1 }}>
                            <strong style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{tool.title}</strong>
                            <span style={{ color: 'var(--muted)', overflowWrap: 'anywhere', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>{tool.name}</span>
                          </span>
                        </label>
                        <span className={`tool-effect tool-effect--${tool.effect}`} style={{ minHeight: 28, flex: '0 0 auto' }}>{effectLabel(tool.effect)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
                Markiere eine Funktion, um sie zu sperren. Sichtbarkeit im Modell oder in der App erteilt keine Nutzerberechtigung.
              </p>
              {unknownDisabledTools.length > 0 && (
                <div role="alert" style={{ display: 'grid', gap: 8, marginTop: 7, color: 'var(--red)', fontSize: 13 }}>
                  <span>Der Entwurf enthält Sperren für entfernte Funktionen. Sie werden nicht übermittelt; entferne sie ausdrücklich, bevor du den Entwurf speicherst.</span>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={busy !== null || conflict}
                    onClick={() => { setDisabledTools((current) => current.filter((toolName) => toolNames.has(toolName))); }}
                    style={{ ...buttonStyle, justifySelf: 'start' }}
                  >
                    Entfernte Funktionssperren entfernen
                  </button>
                </div>
              )}
            </section>

            {validation.valid && validation.payload && (
              <div style={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', justifyContent: 'flex-end', gap: 9 }}>
                <button
                  ref={saveButtonRef}
                  className="button button--secondary"
                  type="button"
                  disabled={busy !== null || conflict || !localChanges || unknownDisabledTools.length > 0}
                  onClick={(event) => { void saveDraft(event.currentTarget); }}
                  style={buttonStyle}
                >
                  {busy === 'draft' ? <><span className="spinner" /> Entwurf wird gespeichert</> : <>Entwurf speichern <Save size={15} aria-hidden="true" /></>}
                </button>
                <button
                  ref={activateButtonRef}
                  className="button button--secondary"
                  type="button"
                  disabled={busy !== null || conflict || localChanges || !draftPending || missingSecrets.length > 0 || unknownDisabledTools.length > 0}
                  onClick={(event) => { void activateDraft(event.currentTarget); }}
                  style={{ ...buttonStyle, borderColor: 'var(--accent)', color: 'var(--accent-deep)' }}
                >
                  {busy === 'activate' ? <><span className="spinner" /> Wird aktiviert</> : <>Entwurf aktivieren <Check size={15} aria-hidden="true" /></>}
                </button>
              </div>
            )}
            {!validation.valid && localChanges && (
              <p role="status" style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
                Der Entwurf kann erst gespeichert werden, wenn die markierten Felder gültig sind und alle Pflichtfelder in unterstützter Form vorliegen.
              </p>
            )}

            {mode === 'remote' && <section aria-label="Updateprüfung" style={sectionStyle}>
              <div style={{ display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--ink-soft)', fontSize: 13, fontWeight: 620 }}><RefreshCw size={15} aria-hidden="true" /> Updateprüfung</span>
                <button
                  ref={updateButtonRef}
                  className="text-button"
                  type="button"
                  disabled={busy !== null || conflict}
                  onClick={(event) => { void checkUpdate(event.currentTarget); }}
                  style={{ minHeight: 44 }}
                >
                  {busy === 'update' ? <><span className="spinner" /> Prüfen</> : <>Updates prüfen <RefreshCw size={14} aria-hidden="true" /></>}
                </button>
              </div>
              <div role="status" aria-live="polite" aria-atomic="true">
                {busy === 'update' ? <span className="sr-only">Update wird geprüft.</span> : updateStatus && (
                  <div style={{ ...noticeStyle(updateStatus.status === 'current' ? 'success' : updateStatus.status === 'blocked' ? 'warning' : 'neutral'), marginTop: 6 }}>
                    {updateStatus.status === 'current' ? <CircleCheck size={16} aria-hidden="true" /> : updateStatus.status === 'available' ? <Clock3 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
                    <span>{updateStatus.message}</span>
                  </div>
                )}
              </div>
            </section>}

            {pluginDetails.audit.length > 0 && (
              <section aria-labelledby={`${id}-audit-heading`} style={sectionStyle}>
                <div style={sectionHeadingStyle}><h4 id={`${id}-audit-heading`} style={headingStyle}>Letzte Änderungen</h4></div>
                <ol style={listStyle}>
                  {[...pluginDetails.audit].reverse().slice(0, 5).map((entry, index) => (
                    <li key={`${entry.at}-${entry.operation}-${String(index)}`} style={rowStyle}>
                      <span style={{ display: 'grid', minWidth: 0, gap: 2 }}>
                        <strong style={{ fontSize: 13 }}>{entry.operation === 'draft' ? 'Entwurf gespeichert' : 'Konfiguration aktiviert'}</strong>
                        <span style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>{entry.subject}</span>
                      </span>
                      <time dateTime={entry.at} style={{ flex: '0 0 auto', color: 'var(--muted)', fontSize: 12 }}>{formatAuditTime(entry.at)}</time>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <p style={{ display: 'flex', alignItems: 'flex-start', gap: 7, margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
              <ShieldCheck size={15} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 1 }} />
              <span>Änderungen werden zuerst als Entwurf gespeichert. Erst die separate Aktivierung setzt sie für den Dienst um.</span>
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}

function noticeStyle(kind: 'success' | 'warning' | 'error' | 'neutral') {
  const color = kind === 'success' ? 'var(--green)' : kind === 'error' ? 'var(--red)' : kind === 'warning' ? 'var(--accent-deep)' : 'var(--ink-soft)';
  return {
    display: 'flex',
    minWidth: 0,
    alignItems: 'flex-start',
    gap: 9,
    padding: 10,
    border: `1px solid ${kind === 'error' ? 'color-mix(in srgb, var(--red) 30%, var(--line))' : 'var(--line)'}`,
    borderRadius: 11,
    background: kind === 'error' ? 'color-mix(in srgb, var(--red) 6%, var(--surface))' : 'var(--surface-soft)',
    color,
    fontSize: 13,
    lineHeight: 1.45,
    overflowWrap: 'anywhere' as const,
  };
}

const sectionStyle = { minWidth: 0, paddingTop: 11, borderTop: '1px solid var(--line)' } as const;
const sectionHeadingStyle = { display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 } as const;
const headingStyle = { display: 'inline-flex', minWidth: 0, alignItems: 'center', gap: 7, margin: 0, color: 'var(--ink)', fontSize: 14, fontWeight: 650 } as const;
const quietTextStyle = { margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 } as const;
const listStyle = { display: 'grid', gap: 3, margin: 0, padding: 0, listStyle: 'none' } as const;
const rowStyle = { display: 'flex', minWidth: 0, minHeight: 44, alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--line)' } as const;
const buttonStyle = { minHeight: 44, gap: 7 } as const;

function ConnectionDiagnostic({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
}) {
  const color = tone === 'success' ? 'var(--green)' : tone === 'error' ? 'var(--red)' : tone === 'warning' ? 'var(--accent-deep)' : 'var(--muted)';
  return (
    <li style={rowStyle}>
      <span style={{ minWidth: 0, color: 'var(--ink-soft)', fontSize: 13 }}>{label}</span>
      <strong style={{ flex: '0 0 auto', color, fontSize: 13 }}>{value}</strong>
    </li>
  );
}

function connectionRemedyTitle(code: PluginConnectionTestRemedy['code']): string {
  switch (code) {
    case 'secret_missing': return 'Erforderliche Zugangsdaten';
    case 'configuration_incomplete': return 'Aktive Konfiguration';
    case 'disabled': return 'Plug-in';
    case 'authentication_rejected': return 'Dienstanmeldung';
    case 'contract_changed': return 'Freigegebene Schnittstelle';
    case 'connection_failed': return 'Verbindung';
  }
}

function effectLabel(effect: ConfigurationToolOption['effect']): string {
  if (effect === 'read') return 'Lesen';
  if (effect === 'prepare') return 'Vorbereiten';
  return 'Ausführen';
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function parseUpdateStatus(value: unknown): { status: UpdateStatus; message: string } {
  if (typeof value !== 'object' || value === null || !('status' in value)) throw new TypeError('Invalid update response');
  if (value.status === 'current') return { status: 'current', message: 'Das Plug-in ist aktuell.' };
  if (value.status === 'available') return { status: 'available', message: 'Ein Update ist verfügbar. Prüfe Konfiguration und Berechtigungen vor einer Aktivierung.' };
  if (value.status === 'blocked') return { status: 'blocked', message: 'Das Update kann derzeit nicht aktiviert werden.' };
  throw new TypeError('Invalid update response');
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
