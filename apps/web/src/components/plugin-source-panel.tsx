"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { apiRequest, postJson } from "@/lib/api";

const catalogSchema = z.strictObject({ sources: z.array(z.strictObject({ id: z.string().max(128), label: z.string().max(200), connected: z.boolean() })).max(32) });
type Source = z.infer<typeof catalogSchema>["sources"][number];

/** The operator supplies this catalogue. A browser never supplies an endpoint or credential. */
export function PluginSourcePanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removal, setRemoval] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSources(catalogSchema.parse(await apiRequest<unknown>("/api/admin/plugin-catalog")).sources); setError(null); }
    catch { setError("Der Katalog freigegebener Dienste ist nicht erreichbar."); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<unknown>("/api/admin/plugin-catalog", { signal: controller.signal }).then(payload => {
      if (!controller.signal.aborted) setSources(catalogSchema.parse(payload).sources);
    }).catch(() => { if (!controller.signal.aborted) setError("Der Katalog freigegebener Dienste ist nicht erreichbar."); });
    return () => { controller.abort(); };
  }, []);

  async function change(source: Source) {
    setBusy(source.id);
    setError(null);
    try {
      if (source.connected) await postJson(`/api/admin/plugins/${encodeURIComponent(source.id)}/remove`, { confirm: true });
      else await postJson("/api/admin/plugin-catalog/connect", { sourceId: source.id });
      setRemoval(null);
      await load();
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Die Verbindung konnte nicht geändert werden."); }
    finally { setBusy(null); }
  }

  return <details className="state-card" style={{ display: "block", marginBottom: 20, minWidth: 0 }}>
    <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>Freigegebene Dienste verbinden</summary>
    <p>Die Hochschuladministration gibt Dienste und Zieladressen vor. Persönliche Kontoverbindungen werden getrennt verwaltet.</p>
    {error && <p role="alert">{error} <button type="button" className="text-button" onClick={() => { void load(); }}>Erneut laden</button></p>}
    {!error && sources.length === 0 && <p>Aktuell sind keine zusätzlichen Dienste zur Verbindung freigegeben.</p>}
    {sources.map(source => <div key={source.id} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
      <span style={{ flex: "1 1 160px", overflowWrap: "anywhere" }}><strong>{source.label}</strong><br /><small>{source.connected ? "Verbunden" : "Zur Verbindung freigegeben"}</small></span>
      {source.connected && removal !== source.id
        ? <button type="button" className="text-button" disabled={busy !== null} onClick={() => { setRemoval(source.id); }}>Verbindung entfernen …</button>
        : <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => { void change(source); }}>{busy === source.id ? "Wird gespeichert …" : source.connected ? "Entfernen bestätigen" : "Verbinden"}</button>}
      {removal === source.id && <div style={{ flexBasis: "100%" }}><p>Neue Aufrufe und offene Bestätigungen werden gesperrt. Der bisherige Verlauf und gespeicherte Einstellungen bleiben erhalten. Bestehende Buchungen werden dadurch nicht storniert.</p><button type="button" className="text-button" disabled={busy !== null} onClick={() => { setRemoval(null); }}>Abbrechen</button></div>}
    </div>)}
  </details>;
}
