'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api';
import {
  isApprovedPluginAppResource,
  isBoundedPluginAppResult,
  isSafePluginAppCsp,
  type PluginAppCsp,
  type PluginAppToolGrant,
} from '@/lib/plugin-app-policy';
import { PluginAppView, type PluginAppViewProps } from './plugin-app-view';

const MAX_APP_TOOLS = 32;

interface ApprovedResource {
  resourceHtml: string;
  resourceSha256: string;
  csp: PluginAppCsp;
  tools: PluginAppToolGrant[];
  allowedToolNames: string[];
}

export interface PluginResultAppProps {
  pluginId: string;
  presentationId: string;
  initialResult?: PluginAppInitialResult;
}

export interface PluginAppInitialResult extends Record<string, unknown> {
  resources?: unknown[];
  total?: number;
  requestedStartDate?: string;
  requestedEndDate?: string;
  availabilityChecked?: boolean;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export function PluginResultApp({ pluginId, presentationId, initialResult }: PluginResultAppProps) {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [resource, setResource] = useState<ApprovedResource | null>(null);
  const [loadError, setLoadError] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  const loadResource = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadState('loading');
    setLoadError('');
    setResource(null);
    try {
      const path = `/api/plugin-apps/${encodeURIComponent(pluginId)}/${encodeURIComponent(presentationId)}`;
      const payload = await apiRequest<unknown>(path, { signal: controller.signal });
      const approved = parseApprovedResource(payload);
      if (!approved) throw new Error('unapproved-resource');
      if (!controller.signal.aborted) {
        setResource(approved);
        setLoadState('ready');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoadError(safeLoadError(error));
      setLoadState('error');
    }
  }, [pluginId, presentationId]);

  const handleToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const shouldOpen = event.currentTarget.open;
    setOpen(shouldOpen);
    if (shouldOpen) {
      void loadResource();
      return;
    }
    requestRef.current?.abort();
    requestRef.current = null;
    setResource(null);
    setLoadState('idle');
    setLoadError('');
  }, [loadResource]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const handleAppToolCall: PluginAppViewProps['onToolCall'] = async (toolName, arguments_, signal) => {
    const current = resource;
    if (!current?.allowedToolNames.includes(toolName)) {
      return { isError: true, content: [{ type: 'text', text: 'Dieser Leseaufruf ist für die Ansicht nicht freigegeben.' }] };
    }
    try {
      const result = await apiRequest<unknown>('/api/tools/call', {
        method: 'POST',
        signal,
        body: JSON.stringify({ pluginId, name: toolName, arguments: arguments_, source: 'app' }),
      });
      if (!isPlainRecord(result) || !isBoundedPluginAppResult(result)) {
        return { isError: true, content: [{ type: 'text', text: 'Die Plugin-Antwort überschreitet die zulässige Größe.' }] };
      }
      return {
        content: [{ type: 'text', text: 'Das Plugin-Ergebnis ist in den strukturierten Daten verfügbar.' }],
        structuredContent: result,
      };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Die Plugin-Anfrage wurde abgebrochen oder ist fehlgeschlagen.' }] };
    }
  };

  // Cached display bodies carry no current account/resource authority. The
  // view performs fresh typed reads; the host separately rebuilds native cards.
  const initialToolArguments = initialResult
    ? initialPluginAppArguments(initialResult)
    : undefined;

  return (
    <details
      open={open}
      onToggle={handleToggle}
      className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink)] shadow-sm"
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
        Interaktive Plugin-Ansicht öffnen
      </summary>
      <div className="border-t border-[var(--line)] px-3 py-3">
        {loadState === 'loading' && <p role="status" className="text-sm text-[var(--muted)]">Freigegebene Ansicht wird geladen …</p>}
        {loadState === 'error' && (
          <div role="alert" className="space-y-3 text-sm">
            <p>{loadError}</p>
            <p className="text-[var(--muted)]">Bitte nutze die aktuell freigegebenen Ergebniskarten im Chat oder suche erneut.</p>
            <button type="button" onClick={() => void loadResource()} className="min-h-11 rounded-lg border border-[var(--line-strong)] px-3 font-semibold hover:bg-[var(--surface-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
              Erneut versuchen
            </button>
          </div>
        )}
        {loadState === 'ready' && resource && (
          <div className="space-y-3">
            <PluginAppView
              title="Räume und Arbeitsplätze"
              resourceHtml={resource.resourceHtml}
              resourceSha256={resource.resourceSha256}
              csp={resource.csp}
              {...(initialToolArguments ? { initialToolArguments } : {})}
              allowedToolNames={resource.allowedToolNames}
              toolGrants={resource.tools}
              onToolCall={handleAppToolCall}
            />
          </div>
        )}
      </div>
    </details>
  );
}

function parseApprovedResource(value: unknown): ApprovedResource | null {
  if (!isPlainRecord(value)) return null;
  const html = value.resourceHtml;
  const sha256 = value.resourceSha256;
  const csp = value.csp;
  const rawTools = value.tools;
  if (typeof html !== 'string' || typeof sha256 !== 'string' || !isSafePluginAppCsp(csp) || !Array.isArray(rawTools) || rawTools.length === 0 || rawTools.length > MAX_APP_TOOLS) return null;
  if (!isApprovedPluginAppResource(html, sha256, csp)) return null;

  const tools: PluginAppToolGrant[] = [];
  const allowedToolNames: string[] = [];
  const names = new Set<string>();
  for (const rawTool of rawTools) {
    if (!isPlainRecord(rawTool) || typeof rawTool.name !== 'string' || rawTool.name.length < 1 || rawTool.name.length > 128 || rawTool.effect !== 'read') return null;
    const visibility = rawTool.visibility;
    if (!Array.isArray(visibility) || visibility.length === 0 || visibility.length > 2 || !visibility.every((item) => item === 'model' || item === 'app')) return null;
    if (names.has(rawTool.name)) return null;
    names.add(rawTool.name);
    const grant: PluginAppToolGrant = { name: rawTool.name, effect: 'read', visibility };
    tools.push(grant);
    if (visibility.includes('app')) allowedToolNames.push(rawTool.name);
  }
  return allowedToolNames.length > 0 ? { resourceHtml: html, resourceSha256: sha256, csp, tools, allowedToolNames } : null;
}

function safeLoadError(error: unknown): string {
  const status = error instanceof Error && 'status' in error ? error.status : undefined;
  if (status === 401) return 'Bitte melde dich an, um die Plugin-Ansicht zu öffnen.';
  if (status === 403 || status === 404) return 'Die Plugin-Ansicht ist für dieses Konto nicht freigegeben.';
  if (status === 409) return 'Die Freigabe hat sich geändert. Bitte lade die Ansicht erneut.';
  return 'Die Plugin-Ansicht ist momentan nicht verfügbar.';
}

function initialPluginAppArguments(result: PluginAppInitialResult): Record<string, unknown> | undefined {
  const arguments_: Record<string, unknown> = {};
  if (isOffsetDateTime(result.requestedStartDate)) arguments_.requestedStartDate = result.requestedStartDate;
  if (isOffsetDateTime(result.requestedEndDate)) arguments_.requestedEndDate = result.requestedEndDate;
  // Earlier availability is never a current availability assertion.
  arguments_.chatAvailabilityChecked = false;
  return Object.keys(arguments_).length > 0 ? arguments_ : undefined;
}

function isOffsetDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
