'use client';

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Database,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ManagedPluginCommand,
  ManagedPluginCommandResult,
  ManagedPluginView,
} from '@hasi/plugin-sdk/deployment-admin';
import { managedPluginCatalogSchema, managedPluginCommandResultSchema } from '@hasi/plugin-sdk/deployment-admin';
import { apiRequest, postJson } from '@/lib/api';
import { PluginConfigPanel } from '@/components/plugin-config-panel';
import styles from './managed-plugin-panel.module.css';

type Operation = ManagedPluginCommand['operation'];
type BusyKind = 'command' | 'status' | undefined;
interface CommandAttempt {
  command: ManagedPluginCommand;
  operationLabel: string;
  status: 'running' | 'check-required';
}
interface Feedback { kind: 'info' | 'error'; message: string }

const operationLabels: Record<Operation, string> = {
  stage: 'Staging',
  approve: 'Prüfung',
  activate: 'Aktivieren',
  cancel: 'Verwerfen',
  rollback: 'Rollback',
  reconcile: 'Status klären',
  synchronize: 'Konfiguration abgleichen',
};

const statusLabels: Record<ManagedPluginView['status'], string> = {
  empty: 'Nicht installiert',
  active: 'Aktiv',
  staging: 'Wird bereitgestellt',
  'stage-unknown': 'Bereitstellung ungeklärt',
  'candidate-ready': 'Zur Aktivierung freigegeben',
  'review-required': 'Prüfung erforderlich',
  activating: 'Wird aktiviert',
  'activation-unknown': 'Aktivierung ungeklärt',
  'rolling-back': 'Rollback läuft',
  'rollback-unknown': 'Rollback ungeklärt',
  discarding: 'Release wird verworfen',
  'discard-unknown': 'Verwerfen ungeklärt',
};

const recoverableStatuses = new Set<ManagedPluginView['status']>([
  'staging', 'stage-unknown', 'activating', 'activation-unknown',
  'rolling-back', 'rollback-unknown', 'discarding', 'discard-unknown',
]);

function isApprovedRelease(release: ManagedPluginView['releases'][number]): boolean {
  return release.approved && release.license !== null && release.inventoryDigest !== null;
}

function isValidOperatorId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function makeCommand(
  view: ManagedPluginView,
  operation: Operation,
  details?: { releaseId?: string; restorePlanId?: string },
): ManagedPluginCommand {
  const base = { commandId: crypto.randomUUID(), expectedState: view.stateToken };
  if (operation === 'stage') {
    if (!details?.releaseId) throw new Error('Kein freigegebener Release ausgewählt.');
    return { ...base, operation, releaseId: details.releaseId };
  }
  if (operation === 'approve') {
    return { ...base, operation, ...(details?.restorePlanId ? { restorePlanId: details.restorePlanId } : {}) };
  }
  return { ...base, operation };
}

function endpoint(installationId: string): string {
  return `/api/admin/managed-plugins/${encodeURIComponent(installationId)}`;
}

function getErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function joinClasses(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value.length > 0).join(' ');
}

async function notifyChanged(onChanged: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await onChanged?.();
  } catch {
    // The managed installation view is authoritative; a parent refresh is optional.
  }
}

export interface ManagedPluginPanelProps {
  onChanged?: () => void | Promise<void>;
}

export function ManagedPluginPanel({ onChanged }: ManagedPluginPanelProps) {
  const [installations, setInstallations] = useState<ManagedPluginView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, BusyKind>>({});
  const [attempts, setAttempts] = useState<Record<string, CommandAttempt | undefined>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({});
  const [selectedRelease, setSelectedRelease] = useState<Record<string, string | undefined>>({});
  const [restorePlanId, setRestorePlanId] = useState<Record<string, string | undefined>>({});
  const busyIds = useRef(new Set<string>());

  const adoptInstallations = useCallback((next: ManagedPluginView[]) => {
    setInstallations(next);
    setSelectedRelease((current) => {
      const selected = { ...current };
      for (const installation of next) {
        const eligible = installation.releases.filter(isApprovedRelease);
        if (!eligible.some((release) => release.id === selected[installation.id])) {
          selected[installation.id] = eligible[0]?.id;
        }
      }
      return selected;
    });
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);
    try {
      const result = managedPluginCatalogSchema.parse(await apiRequest<unknown>('/api/admin/managed-plugins'));
      adoptInstallations(result.installations);
    } catch (cause) {
      setLoadError(getErrorMessage(cause, 'Die verwalteten Installationen konnten nicht geladen werden.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [adoptInstallations]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  function replaceInstallation(next: ManagedPluginView) {
    setInstallations((current) => current.map((item) => item.id === next.id ? next : item));
    setSelectedRelease((current) => {
      const eligible = next.releases.filter(isApprovedRelease);
      return eligible.some((release) => release.id === current[next.id])
        ? current
        : { ...current, [next.id]: eligible[0]?.id };
    });
  }

  function setBusyFor(id: string, kind: BusyKind) {
    setBusy((current) => ({ ...current, [id]: kind }));
    if (kind === undefined) busyIds.current.delete(id);
    else busyIds.current.add(id);
  }

  function setAttempt(id: string, attempt: CommandAttempt | undefined) {
    setAttempts((current) => ({ ...current, [id]: attempt }));
  }

  async function completeResult(id: string, result: ManagedPluginCommandResult, label: string, command: ManagedPluginCommand) {
    replaceInstallation(result.view);
    if (result.status === 'running') {
      setAttempt(id, {
        command,
        operationLabel: label,
        status: 'running',
      });
      setFeedback((current) => ({ ...current, [id]: { kind: 'info', message: `${label}: Der Befehl läuft. Prüfe den Status bei Bedarf manuell.` } }));
      return;
    }

    setAttempt(id, undefined);
    setFeedback((current) => ({
      ...current,
      [id]: {
        kind: result.status === 'uncertain' ? 'error' : 'info',
        message: result.status === 'uncertain'
          ? `${label}: Der Ausgang ist noch unklar. Die aktuelle Ansicht wurde neu geladen; bitte den angezeigten Zustand prüfen.`
          : `${label}: Abgeschlossen. Die aktuelle Ansicht wurde neu geladen.`,
      },
    }));
    await refresh(false);
    await notifyChanged(onChanged);
  }

  async function runCommand(
    view: ManagedPluginView,
    operation: Operation,
    details?: { releaseId?: string; restorePlanId?: string },
  ) {
    const id = view.id;
    if (busyIds.current.has(id) || attempts[id]) return;
    let command: ManagedPluginCommand;
    try {
      command = makeCommand(view, operation, details);
    } catch (cause) {
      setFeedback((current) => ({ ...current, [id]: { kind: 'error', message: getErrorMessage(cause, 'Der Befehl konnte nicht vorbereitet werden.') } }));
      return;
    }

    const label = operationLabels[operation];
    setBusyFor(id, 'command');
    setFeedback((current) => ({ ...current, [id]: undefined }));
    // Keep this exact command ID if the response is lost. Status checks reuse it.
    setAttempt(id, { command, operationLabel: label, status: 'running' });
    try {
      const result = managedPluginCommandResultSchema.parse(await postJson<unknown>(`${endpoint(id)}/commands`, command));
      if (result.commandId !== command.commandId || result.view.id !== id) throw new Error('Die Befehlskennung stimmt nicht überein.');
      await completeResult(id, result, label, command);
    } catch (cause) {
      setAttempt(id, { command, operationLabel: label, status: 'check-required' });
      setFeedback((current) => ({
        ...current,
        [id]: {
          kind: 'error',
          message: `${getErrorMessage(cause, 'Die Antwort auf den Befehl fehlt.')} Prüfe den Status mit derselben Befehlskennung.`,
        },
      }));
    } finally {
      setBusyFor(id, undefined);
    }
  }

  async function checkCommandStatus(id: string) {
    const attempt = attempts[id];
    if (!attempt || busyIds.current.has(id)) return;
    setBusyFor(id, 'status');
    setFeedback((current) => ({ ...current, [id]: undefined }));
    try {
      const result = managedPluginCommandResultSchema.parse(await apiRequest<unknown>(
        `${endpoint(id)}/commands/${encodeURIComponent(attempt.command.commandId)}`,
      ));
      if (result.commandId !== attempt.command.commandId || result.view.id !== id) throw new Error('Die Befehlskennung stimmt nicht überein.');
      await completeResult(id, result, attempt.operationLabel, attempt.command);
    } catch (cause) {
      setAttempt(id, { ...attempt, status: 'check-required' });
      setFeedback((current) => ({
        ...current,
        [id]: {
          kind: 'error',
          message: `${getErrorMessage(cause, 'Der Status konnte nicht geprüft werden.')} Die Befehlskennung bleibt gespeichert; du kannst denselben Status erneut prüfen.`,
        },
      }));
    } finally {
      setBusyFor(id, undefined);
    }
  }

  const stageable = (view: ManagedPluginView) => view.releases.filter(isApprovedRelease);

  return (
    <section className={styles.panel} aria-labelledby="managed-plugin-heading">
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.kicker}>CONTAINER-BETRIEB</span>
          <h2 id="managed-plugin-heading">Verwaltete Plugin-Installationen</h2>
          <p>Release, Prüfung und Aktivierung für verwaltete Installationen. Diese Ansicht ist vom Plugin-Katalog getrennt.</p>
        </div>
        <button className={styles.iconButton} type="button" onClick={() => void refresh(false)} disabled={loading || refreshing} aria-label="Verwaltete Installationen aktualisieren">
          <RefreshCw size={16} aria-hidden="true" className={refreshing ? styles.spinning : undefined} />
        </button>
      </div>

      {loadError && (
        <div className={styles.loadError} role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>{loadError}</span>
          <button className={styles.secondaryButton} type="button" onClick={() => void refresh(true)} disabled={loading}>
            Erneut laden
          </button>
        </div>
      )}

      {loading ? (
        <div className={styles.loading} aria-live="polite"><span className={styles.spinner} aria-hidden="true" /> Installationen werden geladen …</div>
      ) : installations.length === 0 ? (
        <div className={styles.empty}>
          <Database size={19} aria-hidden="true" />
          <div><strong>Keine verwalteten Installationen gemeldet.</strong><span>Der Plugin-Katalog und seine Remote-Verbindungen erscheinen getrennt davon.</span></div>
        </div>
      ) : (
        <div className={styles.installationGrid}>
          {installations.map((view) => {
            const pending = attempts[view.id];
            const releaseOptions = stageable(view);
            const release = releaseOptions.find((item) => item.id === selectedRelease[view.id]);
            const busyKind = busy[view.id];
            const locked = busyKind !== undefined || pending !== undefined;
            const restoreId = restorePlanId[view.id] ?? '';
            const candidateIsIrreversible = view.candidate?.migration === 'irreversible';
            const canStage = (view.status === 'empty' || view.status === 'active')
              && view.candidate === null
              && view.configurationReady
              && release !== undefined;
            const canReview = view.status === 'review-required' && view.candidate !== null;
            const canActivate = view.status === 'candidate-ready' && view.candidate !== null && view.configurationReady;
            const canCancel = (view.status === 'review-required' || view.status === 'candidate-ready') && view.candidate !== null;
            const canRollback = view.status === 'active' && view.previous !== null;
            const canSynchronize = view.status === 'empty' || view.status === 'active';
            const canReconcile = recoverableStatuses.has(view.status);
            const allReleases = [
              ...(view.current ? [{ key: 'current', title: 'Aktuell', release: view.current }] : []),
              ...(view.previous ? [{ key: 'previous', title: 'Vorherige', release: view.previous }] : []),
              ...(view.candidate ? [{ key: 'candidate', title: 'Kandidat', release: view.candidate }] : []),
            ];

            return (
              <article className={styles.installation} key={view.id}>
                <div className={styles.cardHeader}>
                  <div className={styles.installationIcon} aria-hidden="true"><TerminalSquare size={19} /></div>
                  <div className={styles.installationName}>
                    <h3>{view.label}</h3>
                    <code>{view.id}</code>
                  </div>
                  <span className={joinClasses(styles.status, view.status === 'active' || view.status === 'candidate-ready' ? styles.statusGood : recoverableStatuses.has(view.status) || view.status === 'review-required' ? styles.statusWarning : undefined)}>
                    {view.status === 'active' || view.status === 'candidate-ready'
                      ? <CircleCheck size={14} aria-hidden="true" />
                      : recoverableStatuses.has(view.status) || view.status === 'review-required'
                        ? <AlertTriangle size={14} aria-hidden="true" />
                        : <Clock3 size={14} aria-hidden="true" />}
                    {statusLabels[view.status]}
                  </span>
                </div>

                <dl className={styles.configuration}>
                  <div><dt>Konfiguration</dt><dd>{view.configurationReady ? 'Einsatzbereit' : 'Nicht einsatzbereit'}</dd></div>
                  <div><dt>Revision</dt><dd><code>{view.configurationRevision}</code></dd></div>
                </dl>
                {!view.configurationReady && (
                  <p className={styles.configurationNote}>
                    Stage und Aktivieren sind gesperrt. Bitte die Konfiguration im bestehenden Plugin-Konfigurationsbereich prüfen.
                  </p>
                )}

                <PluginConfigPanel
                  pluginId={view.id}
                  name={view.label}
                  tools={view.tools ?? []}
                  apiBase={endpoint(view.id)}
                  mode="managed"
                  onChanged={() => refresh(false)}
                />

                {allReleases.length > 0 && (
                  <div className={styles.releaseStates} aria-label="Installierte Release-Zustände">
                    {allReleases.map(({ key, title, release: item }) => (
                      <section className={styles.releaseState} key={key}>
                        <div className={styles.releaseStateHeading}>
                          <strong>{title}</strong>
                          <span className={isApprovedRelease(item) ? styles.approvedTag : styles.revokedTag}>
                            {isApprovedRelease(item) ? <Check size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}
                            {isApprovedRelease(item) ? 'Freigegeben' : 'Nicht freigegeben'}
                          </span>
                        </div>
                        <ReleaseDetails release={item} />
                      </section>
                    ))}
                  </div>
                )}

                {(view.status === 'empty' || view.status === 'active') && (
                  <div className={styles.stageControls}>
                    <label htmlFor={`release-${view.id}`} className={styles.fieldLabel}>Freigegebenen Release auswählen</label>
                    <select
                      id={`release-${view.id}`}
                      className={styles.select}
                      value={release?.id ?? ''}
                      disabled={locked || releaseOptions.length === 0}
                      onChange={(event) => { setSelectedRelease((current) => ({ ...current, [view.id]: event.target.value })); }}
                    >
                      {releaseOptions.length === 0
                        ? <option value="">Kein vollständig freigegebener Release</option>
                        : releaseOptions.map((item) => <option key={item.id} value={item.id}>{item.version} · {item.publisher}</option>)}
                    </select>
                    {release && <ReleaseDetails release={release} expanded />}
                    <div className={styles.actionRow}>
                      <ActionButton variant="primary" disabled={locked || !canStage} onClick={() => { if (release) void runCommand(view, 'stage', { releaseId: release.id }); }}>
                        {busyKind === 'command' && attempts[view.id]?.command.operation === 'stage' ? <><span className={styles.spinner} /> Wird bereitgestellt</> : <>Release bereitstellen</>}
                      </ActionButton>
                      <ActionButton variant="secondary" disabled={locked || !canSynchronize} onClick={() => void runCommand(view, 'synchronize')}>
                        <RefreshCw size={15} aria-hidden="true" /> Konfiguration abgleichen
                      </ActionButton>
                    </div>
                    {!view.configurationReady && <p className={styles.gateNote}>Eine gültige Konfiguration ist Voraussetzung für Stage und Aktivieren.</p>}
                    {releaseOptions.length === 0 && <p className={styles.gateNote}>Es liegt kein Release mit vollständiger Freigabe und Inventarprüfung vor.</p>}
                  </div>
                )}

                {view.status === 'review-required' && view.candidate && (
                  <div className={styles.reviewBox}>
                    <div className={styles.reviewHeading}><ShieldCheck size={17} aria-hidden="true" /><strong>Explizite Prüfung erforderlich</strong></div>
                    <p>Die Kandidatenversion wird erst nach deiner Prüfung für die Aktivierung freigegeben.</p>
                    {candidateIsIrreversible && (
                      <>
                        <label htmlFor={`restore-${view.id}`} className={styles.fieldLabel}>ID des genehmigten Wiederherstellungsplans</label>
                        <input
                          id={`restore-${view.id}`}
                          className={styles.input}
                          value={restoreId}
                          maxLength={128}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="z. B. restore-plan-2026-04"
                          disabled={locked}
                          onChange={(event) => { setRestorePlanId((current) => ({ ...current, [view.id]: event.target.value })); }}
                        />
                        <p className={styles.gateNote}>Für irreversible Migrationen ist eine gültige Plan-ID erforderlich. Freier Code wird hier nicht angenommen.</p>
                      </>
                    )}
                    <div className={styles.actionRow}>
                      <ActionButton
                        variant="primary"
                        disabled={locked || !canReview || (candidateIsIrreversible && !isValidOperatorId(restoreId))}
                        onClick={() => void runCommand(view, 'approve', { ...(restoreId ? { restorePlanId: restoreId } : {}) })}
                      >
                        {busyKind === 'command' && attempts[view.id]?.command.operation === 'approve' ? <><span className={styles.spinner} /> Prüfung läuft</> : <>Prüfung bestätigen</>}
                      </ActionButton>
                      <ActionButton variant="danger" disabled={locked || !canCancel} onClick={() => void runCommand(view, 'cancel')}>
                        <Trash2 size={15} aria-hidden="true" /> Kandidat verwerfen
                      </ActionButton>
                    </div>
                  </div>
                )}

                {view.status === 'candidate-ready' && view.candidate && (
                  <div className={styles.reviewBox}>
                    <div className={styles.reviewHeading}><CircleCheck size={17} aria-hidden="true" /><strong>Prüfung abgeschlossen</strong></div>
                    <p>Der Kandidat ist freigegeben und kann aktiviert oder verworfen werden.</p>
                    <div className={styles.actionRow}>
                      <ActionButton variant="primary" disabled={locked || !canActivate} onClick={() => void runCommand(view, 'activate')}>
                        {busyKind === 'command' && attempts[view.id]?.command.operation === 'activate' ? <><span className={styles.spinner} /> Wird aktiviert</> : <>Version aktivieren</>}
                      </ActionButton>
                      <ActionButton variant="danger" disabled={locked || !canCancel} onClick={() => void runCommand(view, 'cancel')}>
                        <Trash2 size={15} aria-hidden="true" /> Kandidat verwerfen
                      </ActionButton>
                    </div>
                    {!view.configurationReady && <p className={styles.gateNote}>Aktivieren ist gesperrt, bis die Konfiguration einsatzbereit ist.</p>}
                  </div>
                )}

                {view.status === 'active' && view.previous && (
                  <div className={styles.actionRow}>
                    <ActionButton variant="secondary" disabled={locked || !canRollback} onClick={() => void runCommand(view, 'rollback')}>
                      <RotateCcw size={15} aria-hidden="true" /> Zur vorherigen Version zurückkehren
                    </ActionButton>
                  </div>
                )}

                {canReconcile && (
                  <div className={styles.reconcileBox}>
                    <p><AlertTriangle size={15} aria-hidden="true" /> Ein Vorgang ist noch nicht abschließend geklärt.</p>
                    <ActionButton variant="secondary" disabled={locked} onClick={() => void runCommand(view, 'reconcile')}>
                      {busyKind === 'command' && attempts[view.id]?.command.operation === 'reconcile' ? <><span className={styles.spinner} /> Status wird geklärt</> : <>Vorgangsstatus klären</>}
                    </ActionButton>
                  </div>
                )}

                {pending && (
                  <div className={styles.pendingBox} role="status" aria-live="polite">
                    <div><Clock3 size={15} aria-hidden="true" /><span>
                      {pending.status === 'check-required'
                        ? `${pending.operationLabel}: Antwort fehlt. Die Befehlskennung ${pending.command.commandId} bleibt für die Statusprüfung gespeichert.`
                        : `${pending.operationLabel}: Der Vorgang läuft unter ${pending.command.commandId}.`}
                    </span></div>
                    <button className={styles.secondaryButton} type="button" onClick={() => void checkCommandStatus(view.id)} disabled={busyKind !== undefined}>
                      {busyKind === 'status' ? <><span className={styles.spinner} /> Status wird geprüft</> : <>Status prüfen</>}
                    </button>
                  </div>
                )}

                {feedback[view.id] && (
                  <p className={joinClasses(styles.feedback, feedback[view.id]?.kind === 'error' ? styles.feedbackError : styles.feedbackInfo)} role={feedback[view.id]?.kind === 'error' ? 'alert' : 'status'}>
                    {feedback[view.id]?.kind === 'error' ? <CircleAlert size={15} aria-hidden="true" /> : <CircleCheck size={15} aria-hidden="true" />}
                    {feedback[view.id]?.message}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ReleaseDetails({ release, expanded = false }: { release: ManagedPluginView['releases'][number]; expanded?: boolean }) {
  return (
    <dl className={joinClasses(styles.releaseDetails, expanded ? styles.releaseDetailsExpanded : undefined)}>
      <div><dt>Version</dt><dd>{release.version}</dd></div>
      <div><dt>Publisher</dt><dd>{release.publisher}</dd></div>
      <div><dt>Lizenz</dt><dd>{release.license ?? 'Nicht freigegeben'}</dd></div>
      <div><dt>Inventar-Digest</dt><dd>{release.inventoryDigest ? <code>{release.inventoryDigest}</code> : 'Nicht freigegeben'}</dd></div>
      {expanded && <div><dt>Release-Digest</dt><dd><code>{release.digest}</code></dd></div>}
      <div><dt>Migration</dt><dd>{release.migration === 'none' ? 'Keine' : release.migration === 'reversible' ? 'Umkehrbar' : 'Irreversibel'}</dd></div>
    </dl>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  variant,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  variant: 'primary' | 'secondary' | 'danger';
}) {
  const className = variant === 'primary' ? styles.primaryButton : variant === 'danger' ? styles.dangerButton : styles.secondaryButton;
  return <button className={className} type="button" onClick={onClick} disabled={disabled}>{children}</button>;
}
