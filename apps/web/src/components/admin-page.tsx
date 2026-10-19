"use client";

import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, postJson } from "@/lib/api";
import type { Plugin, PluginTool } from "@/lib/types";
import { PluginConfigPanel } from "./plugin-config-panel";
import { PluginSourcePanel } from "./plugin-source-panel";
import { ManagedPluginPanel } from "./managed-plugin-panel";

interface UpdateState { status: "current" | "available" | "blocked"; message: string }
type PendingById = Record<string, "toggle" | "check" | "activate" | undefined>;

const effectLabels: Record<PluginTool["effect"], string> = {
  read: "Lesen",
  prepare: "Vorbereiten",
  execute: "Ausführen",
};

function ToolEffectMark({ effect }: { effect: PluginTool["effect"] }) {
  return <span className={`tool-effect tool-effect--${effect}`} aria-label={`Wirkung: ${effectLabels[effect]}`}>{effectLabels[effect]}</span>;
}

function PluginCard({
  plugin,
  pending,
  updateState,
  onToggle,
  onCheck,
  onActivate,
}: {
  plugin: Plugin;
  pending: PendingById[string];
  updateState?: UpdateState;
  onToggle: (plugin: Plugin) => void;
  onCheck: (plugin: Plugin) => void;
  onActivate: (plugin: Plugin) => void;
}) {
  const statusText = plugin.healthy ? "Verbindung aktiv" : "Verbindung prüfen";
  return (
    <article className={`plugin-card${plugin.enabled ? " plugin-card--enabled" : " plugin-card--disabled"}`}>
      <div className="plugin-card-head">
        <div className={`plugin-icon${plugin.enabled ? " plugin-icon--enabled" : ""}`} aria-hidden="true">
          {plugin.enabled ? <PlugZap size={21} strokeWidth={1.7} /> : <Unplug size={21} strokeWidth={1.7} />}
        </div>
        <div className="plugin-title-wrap">
          <div className="plugin-title-row"><h3>{plugin.name}</h3><span className="plugin-version">v{plugin.version}</span></div>
          <span className={`plugin-health${plugin.healthy ? " is-healthy" : " is-unhealthy"}`}>
            {plugin.healthy
                ? <CircleCheck size={14} aria-hidden="true" />
                : <CircleAlert size={14} aria-hidden="true" />}
            {statusText}
          </span>
        </div>
        <button
          className={`toggle-switch${plugin.enabled ? " is-on" : ""}`}
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`${plugin.enabled ? "Deaktivieren" : "Aktivieren"}: ${plugin.name}`}
          disabled={pending !== undefined}
          onClick={() => { onToggle(plugin); }}
        >
          <span className="toggle-thumb" />
        </button>
      </div>

      <p className="plugin-description">{plugin.description}</p>

      <div className="plugin-permissions">
        <div className="plugin-section-title"><span>FREIGEGEBENE FUNKTIONEN</span><span>{plugin.tools.length}</span></div>
        {plugin.tools.length > 0 ? (
          <ul className="tool-list">
            {plugin.tools.map((tool) => (
              <li className="tool-item" key={tool.name}>
                <span className="tool-check"><Check size={13} aria-hidden="true" /></span>
                <span className="tool-name" title={tool.name}>{tool.title}<small>{tool.name}</small></span>
                <ToolEffectMark effect={tool.effect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="tool-empty">Für dieses Plug-in sind keine Funktionen hinterlegt.</p>
        )}
      </div>

      <div className="plugin-card-footer">
        <span className="plugin-install-label"><ShieldCheck size={15} aria-hidden="true" /> Installiert · {plugin.version}</span>
        <button className="text-button" type="button" onClick={() => { onCheck(plugin); }} disabled={pending !== undefined}>
          {pending === "check" ? <><span className="spinner" /> Prüfen</> : <>Updates prüfen <ArrowDownToLine size={14} aria-hidden="true" /></>}
        </button>
      </div>

      {updateState && (
        <div className={`update-result update-result--${updateState.status}`} role="status">
          <span className="update-message">
            {updateState.status === "current" ? <CircleCheck size={16} aria-hidden="true" /> : updateState.status === "available" ? <ArrowDownToLine size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
            <span><strong>{updateState.status === "current" ? "Aktuell" : updateState.status === "available" ? "Update verfügbar" : "Update blockiert"}</strong><small>{updateState.message}</small></span>
          </span>
          {updateState.status === "available" && (
            <button className="button button--secondary button--wide update-activate" type="button" disabled={pending !== undefined} onClick={() => { onActivate(plugin); }}>
              {pending === "activate" ? <><span className="spinner" /> Version wird aktiviert</> : <>Version aktivieren <Check size={15} aria-hidden="true" /></>}
            </button>
          )}
        </div>
      )}
      <PluginConfigPanel pluginId={plugin.id} name={plugin.name} tools={plugin.tools} />
    </article>
  );
}

export function AdminPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingById>({});
  const [updateStates, setUpdateStates] = useState<Record<string, UpdateState>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<{ plugins: Plugin[] }>("/api/admin/plugins");
      setPlugins(result.plugins);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Plug-ins konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<{ plugins: Plugin[] }>("/api/admin/plugins")
      .then((result) => {
        if (active) setPlugins(result.plugins);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Plug-ins konnten nicht geladen werden.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function togglePlugin(plugin: Plugin) {
    setPending((current) => ({ ...current, [plugin.id]: "toggle" }));
    setNotice(null);
    try {
      const enabled = !plugin.enabled;
      await postJson<{ plugin?: Plugin }>(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/enabled`, { enabled });
      setPlugins((current) => current.map((item) => item.id === plugin.id ? { ...item, enabled } : item));
      setNotice(`${plugin.name} wurde ${enabled ? "aktiviert" : "deaktiviert"}.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Die Einstellung konnte nicht gespeichert werden.");
    } finally {
      setPending((current) => ({ ...current, [plugin.id]: undefined }));
    }
  }

  async function checkUpdate(plugin: Plugin) {
    setPending((current) => ({ ...current, [plugin.id]: "check" }));
    setNotice(null);
    try {
      const result = await postJson<UpdateState>(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/check-update`, {});
      setUpdateStates((current) => ({ ...current, [plugin.id]: result }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Der Update-Status konnte nicht geladen werden.");
    } finally {
      setPending((current) => ({ ...current, [plugin.id]: undefined }));
    }
  }

  async function activateUpdate(plugin: Plugin) {
    setPending((current) => ({ ...current, [plugin.id]: "activate" }));
    setNotice(null);
    try {
      await postJson<{ ok: true }>(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/activate-update`, {});
      const result = await apiRequest<{ plugins: Plugin[] }>("/api/admin/plugins");
      setPlugins(result.plugins);
      const updatedPlugin = result.plugins.find((item) => item.id === plugin.id);
      setUpdateStates((current) => ({
        ...current,
        [plugin.id]: {
          status: "current",
          message: updatedPlugin ? `Version ${updatedPlugin.version} wurde aktiviert.` : "Die neue Version wurde aktiviert.",
        },
      }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Die Version konnte nicht aktiviert werden.");
    } finally {
      setPending((current) => ({ ...current, [plugin.id]: undefined }));
    }
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className="admin-page page-enter">
      <section className="admin-hero">
        <div className="admin-hero-copy">
          <div className="eyebrow"><span className="eyebrow-rule" /> VERWALTUNG</div>
          <h1>Alles im<br /><span>Überblick.</span></h1>
          <p>Verbundene Dienste und ihre freigegebenen Funktionen auf einen Blick.</p>
        </div>
        <div className="admin-hero-status">
          <span className="admin-status-icon"><ShieldCheck size={21} strokeWidth={1.7} aria-hidden="true" /></span>
          <span><strong>Systemübersicht</strong><small><span className="status-dot" /> Testdaten</small></span>
          <button className="icon-button" type="button" aria-label="Übersicht aktualisieren" onClick={() => void loadPlugins()} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="admin-summary" aria-label="Zusammenfassung der Plug-ins">
        <div className="admin-summary-main">
          <span className="summary-label">PLUG-INS</span>
          <span className="summary-value">{loading ? "–" : String(plugins.length).padStart(2, "0")}</span>
          <span className="summary-caption">Installiert</span>
        </div>
        <span className="summary-divider" />
        <div className="admin-summary-state">
          <span className="summary-label">AKTIV</span>
          <span className="summary-state-value"><span className="status-dot" />{loading ? "Wird geladen" : `${String(enabledCount)} von ${String(plugins.length)}`}</span>
          <span className="summary-caption">Freigeschaltet</span>
        </div>
        <div className="admin-summary-note"><Clock3 size={16} aria-hidden="true" /><span>Änderungen werden direkt gespeichert.</span></div>
      </section>

      <div className="admin-section-heading">
        <div><span className="section-kicker">INTEGRATIONEN</span><h2>Verbundene Plug-ins</h2></div>
        <span className="environment-badge"><span className="status-dot" /> Testdaten</span>
      </div>
      <PluginSourcePanel onChanged={loadPlugins} />
      <ManagedPluginPanel onChanged={loadPlugins} />

      {notice && <div className="admin-notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="Meldung schließen" onClick={() => { setNotice(null); }}><CircleAlert size={16} /></button></div>}

      {loading ? (
        <div className="plugin-grid" aria-label="Plug-ins werden geladen" aria-busy="true">
          {[0, 1].map((item) => <div className="plugin-skeleton" key={item}><span /><i /><i /><i /><i /></div>)}
        </div>
      ) : error ? (
        <div className="state-card state-card--error" role="alert">
          <span className="state-icon"><CircleAlert size={20} aria-hidden="true" /></span>
          <div><strong>Verbundene Plug-ins gerade nicht erreichbar</strong><p>{error}</p></div>
          <button className="button button--secondary" type="button" onClick={() => void loadPlugins()}>Erneut laden</button>
        </div>
      ) : plugins.length === 0 ? (
        <div className="state-card state-card--empty">
          <span className="state-icon"><Unplug size={20} aria-hidden="true" /></span>
          <div><strong>Keine Plug-ins registriert.</strong><p>Installierte Integrationen werden hier angezeigt.</p></div>
        </div>
      ) : (
        <div className="plugin-grid">
          {plugins.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} pending={pending[plugin.id]} {...(updateStates[plugin.id] !== undefined ? { updateState: updateStates[plugin.id] } : {})} onToggle={(plugin) => { void togglePlugin(plugin); }} onCheck={(plugin) => { void checkUpdate(plugin); }} onActivate={(plugin) => { void activateUpdate(plugin); }} />
          ))}
        </div>
      )}

      <section className="admin-boundary-note">
        <span className="boundary-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
        <p><strong>Freigaben mit Augenmaß.</strong> Jede Integration zeigt nur die Funktionen, die ihr explizit zugewiesen wurden.</p>
        <span className="boundary-mark"><ExternalLink size={15} aria-hidden="true" /></span>
      </section>
    </div>
  );
}
