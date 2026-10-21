'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { managedPluginReviewSchema, type ManagedPluginReview, type ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import { apiRequest } from '@/lib/api';
import { useActionFocusRecovery } from '@/lib/use-action-focus-recovery';
import { releaseReviewKey, releaseReviewSections, reviewMatchesView } from '@/lib/plugin-release-review';
import styles from './plugin-release-review.module.css';

type ReviewState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; review: ManagedPluginReview };

export function PluginReleaseReview({ view, onVerified }: Readonly<{ view: ManagedPluginView; onVerified: (id: string, key: string | null) => void }>) {
  const [state, setState] = useState<ReviewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const key = releaseReviewKey(view);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const focusToken = useRef<symbol | null>(null);
  const { beginFocusRecovery, completeFocusRecovery, flushFocusRecovery } = useActionFocusRecovery();
  useLayoutEffect(() => { flushFocusRecovery(); }, [state, flushFocusRecovery]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    onVerified(view.id, null);
    void apiRequest<unknown>(`/api/admin/managed-plugins/${encodeURIComponent(view.id)}/review`, { signal: controller.signal })
      .then(raw => {
        const review = managedPluginReviewSchema.parse(raw);
        if (!reviewMatchesView(review, view)) throw new Error('Review changed');
        if (current) { setState({ status: 'ready', review }); onVerified(view.id, key); }
      }).catch(() => { if (current) { setState({ status: 'error' }); onVerified(view.id, null); } })
      .finally(() => {
        if (current) { completeFocusRecovery(focusToken.current, () => reloadRef.current); focusToken.current = null; }
      });
    return () => { current = false; controller.abort(); };
  }, [view, key, attempt, onVerified, completeFocusRecovery]);

  let content: ReactNode;
  if (state.status === 'loading') content = <p className={styles.notice} role="status">Änderungsübersicht wird geladen …</p>;
  else if (state.status === 'error' || !reviewMatchesView(state.review, view)) content = (
    <p className={styles.error} role="alert">Die Änderungen konnten nicht aktuell geprüft werden. Eine Freigabe ist noch nicht möglich.</p>
  );
  else content = <>
    <p className={styles.notice} role="status">{state.review.current ? 'Änderungen gegenüber der aktiven Version.' : 'Erste Installation: Prüfe die angeforderten Funktionen und Zugriffe.'}</p>
    {releaseReviewSections(state.review).map(section => (
      <details className={styles.section} key={section.id} open={section.changes.length > 0}>
        <summary><span>{section.label}</span><span className={styles.count}>{section.changes.length ? `${String(section.changes.length)} ${section.changes.length === 1 ? 'Änderung' : 'Änderungen'}` : 'Unverändert'}</span></summary>
        {section.changes.length === 0 ? <p className={styles.notice}>In diesem Bereich gibt es keine Änderungen.</p> : section.changes.map(change => (
          <div className={styles.change} key={change.id}>
            <h4>{change.label}</h4>
            <div className={styles.comparison}>
              <ReviewValue label="Bisher" value={change.before} />
              <ReviewValue label="Kandidat" value={change.after} />
            </div>
          </div>
        ))}
      </details>
    ))}
    <p className={styles.notice}>Zugangsdatenwerte und gespeicherte Konfigurationswerte werden hier nicht angezeigt. Die Freigabe gilt ausschließlich für diesen geprüften Stand.</p>
  </>;
  return (
    <section className={styles.review} aria-label="Änderungen vor der Freigabe" aria-busy={state.status === 'loading'}>
      <div className={styles.content}>{content}</div>
      <button ref={reloadRef} className={styles.reload} type="button" disabled={state.status === 'loading'} onClick={event => {
        focusToken.current = beginFocusRecovery(event.currentTarget);
        onVerified(view.id, null);
        setState({ status: 'loading' });
        setAttempt(value => value + 1);
      }}>Übersicht neu laden</button>
    </section>
  );
}

function ReviewValue({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return <div className={styles.value}><strong>{label}</strong>{value === null ? <p>Nicht vorhanden</p> : typeof value === 'string' ? <p>{value}</p> : <pre tabIndex={0} role="region" aria-label={`${label}: Details`}>{JSON.stringify(value, null, 2)}</pre>}</div>;
}
