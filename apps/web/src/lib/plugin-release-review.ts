import type { ManagedPluginReview } from '@hasi/plugin-sdk/deployment-admin';

export interface ReleaseReviewChange { id: string; label: string; before: unknown; after: unknown }
export interface ReleaseReviewSection { id: string; label: string; changes: ReleaseReviewChange[] }

/** Stable comparison only; displayed plugin declarations never become HTML or authority. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function releaseReviewKey(view: { stateToken: string; current: { digest: string } | null; candidate: { digest: string } | null }): string {
  return `${view.stateToken}:${view.current?.digest ?? ''}:${view.candidate?.digest ?? ''}`;
}

export function reviewMatchesView(review: ManagedPluginReview, view: { id: string; stateToken: string; current: { digest: string } | null; candidate: { digest: string } | null }): boolean {
  return view.candidate !== null && review.installationId === view.id && review.stateToken === view.stateToken
    && review.currentDigest === (view.current?.digest ?? null) && review.candidateDigest === view.candidate.digest;
}

export function releaseReviewSections(review: ManagedPluginReview): ReleaseReviewSection[] {
  const sections: ReleaseReviewSection[] = [
    { id: 'metadata', label: 'Funktionen und Modellhinweise', changes: [] },
    { id: 'schemas', label: 'Ein- und Ausgaben', changes: [] },
    { id: 'effects', label: 'Wirkungen', changes: [] },
    { id: 'permissions', label: 'Berechtigungen und Kontozugriff', changes: [] },
    { id: 'network', label: 'Netzwerkzugriff', changes: [] },
    { id: 'presentations', label: 'Ergebnisansichten', changes: [] },
    { id: 'configuration', label: 'Konfiguration und gespeicherte Daten', changes: [] },
  ];
  const add = (section: string, id: string, label: string, before: unknown, after: unknown) => {
    if (canonical(before) !== canonical(after)) sections.find(item => item.id === section)?.changes.push({ id, label, before, after });
  };
  const oldTools = new Map(review.current?.tools.map(tool => [tool.name, tool]) ?? []);
  const newTools = new Map(review.candidate.tools.map(tool => [tool.name, tool]));
  const effects = { read: 'Lesen', prepare: 'Vorbereiten', execute: 'Ausführen' } as const;
  for (const name of [...new Set([...oldTools.keys(), ...newTools.keys()])].sort()) {
    const before = oldTools.get(name), after = newTools.get(name);
    const title = after?.title ?? before?.title ?? name;
    add('metadata', name, name, before ? { title: before.title, description: before.description } : null, after ? { title: after.title, description: after.description } : null);
    add('presentations', name + ':semantics', `${title}: Ergebnisart`, before?.resultSemantics ?? null, after?.resultSemantics ?? null);
    add('schemas', name + ':input', `${title}: Eingabe`, before?.inputSchema ?? null, after?.inputSchema ?? null);
    add('schemas', name + ':output', `${title}: Ergebnis`, before?.outputSchema ?? null, after?.outputSchema ?? null);
    add('effects', name, title, before ? effects[before.effect] : null, after ? effects[after.effect] : null);
    add('permissions', name, title, before ? { permissions: [...before.requiredPermissions].sort(), visibility: [...before.visibility].sort(), presentationId: before.presentationId } : null,
      after ? { permissions: [...after.requiredPermissions].sort(), visibility: [...after.visibility].sort(), presentationId: after.presentationId } : null);
  }
  add('permissions', 'identity', 'Übermittelte Kontomerkmale', review.current ? [...review.current.identityClaims].sort() : null, [...review.candidate.identityClaims].sort());
  const secretRequirements = (items: ManagedPluginReview['candidate']['secretRequirements']) => [...items].sort((a, b) => a.name.localeCompare(b.name));
  add('permissions', 'secrets', 'Benötigte Zugangsdaten: Bezeichnungen', review.current ? secretRequirements(review.current.secretRequirements) : null, secretRequirements(review.candidate.secretRequirements));
  add('network', 'network', 'Netzwerkverbindung', review.current?.network ?? null, review.candidate.network);
  add('network', 'ingress', 'Lokaler Dienstzugang', review.current?.ingress ?? null, review.candidate.ingress);
  const oldViews = new Map(review.current?.presentations.map(view => [view.id, view]) ?? []);
  const newViews = new Map(review.candidate.presentations.map(view => [view.id, view]));
  for (const id of [...new Set([...oldViews.keys(), ...newViews.keys()])].sort()) {
    add('presentations', id, id, oldViews.get(id) ?? null, newViews.get(id) ?? null);
  }
  add('configuration', 'schema', 'Konfigurationsschema', review.current?.configurationSchema ?? null, review.candidate.configurationSchema);
  add('configuration', 'state', 'Gespeicherte Plugin-Daten', review.current?.managedState ?? null, review.candidate.managedState);
  return sections;
}
