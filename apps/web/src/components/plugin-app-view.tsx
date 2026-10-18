'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppBridge, PostMessageTransport, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  createPluginAppFrameDocument,
  getAllowedPluginAppToolNames,
  isAllowedPluginAppToolCall,
  isApprovedPluginAppResource,
  isBoundedPluginAppResult,
  type PluginAppCsp,
  type PluginAppToolGrant,
} from '@/lib/plugin-app-policy';

const TOOL_CALL_TIMEOUT_MS = 10_000;
const APP_INITIALIZATION_TIMEOUT_MS = 8_000;
const MAX_ACTIVE_TOOL_CALLS = 2;

type AppToolResult = Parameters<AppBridge['sendToolResult']>[0];
type AppToolCallHandler = NonNullable<AppBridge['oncalltool']>;

export type PluginAppOnToolCall = (
  toolName: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
) => ReturnType<AppToolCallHandler>;

export interface PluginAppViewProps {
  resourceHtml: string;
  resourceSha256: string;
  csp: PluginAppCsp;
  initialToolArguments?: Record<string, unknown>;
  initialToolResult?: AppToolResult;
  allowedToolNames: readonly string[];
  toolGrants: readonly PluginAppToolGrant[];
  onToolCall: PluginAppOnToolCall;
  title?: string;
  className?: string;
}

export function PluginAppView({
  resourceHtml,
  resourceSha256,
  csp,
  initialToolArguments,
  initialToolResult,
  allowedToolNames,
  toolGrants,
  onToolCall,
  title = 'Plugin application',
  className,
}: PluginAppViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeCalls = useRef(new Set<AbortController>());
  const allowedNamesRef = useRef<ReadonlySet<string>>(new Set());
  const onToolCallRef = useRef(onToolCall);
  const initialArgumentsRef = useRef(initialToolArguments);
  const initialResultRef = useRef(initialToolResult);
  const [verification, setVerification] = useState<{
    html: string;
    sha256: string;
    cspKey: string;
    status: 'ready' | 'error';
    error?: string;
  } | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<{
    html: string;
    sha256: string;
    cspKey: string;
    message: string;
  } | null>(null);
  const connectDomainsKey = csp.connectDomains.join(',');
  const resourceDomainsKey = csp.resourceDomains.join(',');
  const cspKey = `${connectDomainsKey}|${resourceDomainsKey}`;
  const safeCsp = useMemo<PluginAppCsp>(() => ({
    connectDomains: connectDomainsKey ? connectDomainsKey.split(',') : [],
    resourceDomains: resourceDomainsKey ? resourceDomainsKey.split(',') : [],
  }), [connectDomainsKey, resourceDomainsKey]);
  const resourceState = verification?.html === resourceHtml &&
    verification.sha256 === resourceSha256 && verification.cspKey === cspKey
    ? verification.status
    : 'checking';
  const verificationError = resourceState === 'error' ? verification?.error : null;
  const runtimeError = runtimeFailure?.html === resourceHtml &&
    runtimeFailure.sha256 === resourceSha256 && runtimeFailure.cspKey === cspKey
    ? runtimeFailure.message
    : null;

  useEffect(() => {
    onToolCallRef.current = onToolCall;
    initialArgumentsRef.current = initialToolArguments;
    initialResultRef.current = initialToolResult;
  }, [onToolCall, initialToolArguments, initialToolResult]);

  useEffect(() => {
    allowedNamesRef.current = getAllowedPluginAppToolNames(allowedToolNames, toolGrants);
  }, [allowedToolNames, toolGrants]);

  useEffect(() => {
    let active = true;
    const verify = async () => {
      try {
        if (!isApprovedPluginAppResource(resourceHtml, resourceSha256, safeCsp)) {
          throw new Error('This application resource is not approved.');
        }
        const bytes = new TextEncoder().encode(resourceHtml);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (!active) return;
        if (actual.toLowerCase() !== resourceSha256.toLowerCase()) {
          setVerification({ html: resourceHtml, sha256: resourceSha256, cspKey, status: 'error', error: 'The application resource failed integrity verification.' });
          return;
        }
        setVerification({ html: resourceHtml, sha256: resourceSha256, cspKey, status: 'ready' });
      } catch (error) {
        if (active) {
          const message = error instanceof Error && error.message === 'This application resource is not approved.'
            ? error.message
            : 'The application resource could not be verified.';
          setVerification({ html: resourceHtml, sha256: resourceSha256, cspKey, status: 'error', error: message });
        }
      }
    };
    void verify();
    return () => { active = false; };
  }, [resourceHtml, resourceSha256, safeCsp, cspKey]);

  useEffect(() => {
    if (resourceState !== 'ready') return;
    const frame = frameRef.current;
    const container = containerRef.current;
    const contentWindow = frame?.contentWindow;
    if (!frame || !contentWindow || !container) {
      queueMicrotask(() => {
        setRuntimeFailure({
          html: resourceHtml,
          sha256: resourceSha256,
          cspKey,
          message: 'The application could not be started.',
        });
      });
      return;
    }

    let mounted = true;
    let transport: PostMessageTransport | undefined;
    let initializationTimer: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    const mountedCalls = activeCalls.current;
    const bridge = new AppBridge(
      null,
      { name: 'HASI Plugin App Host', version: '2.0.0' },
      {
        serverTools: {},
        sandbox: {
          permissions: {},
          csp: {
            connectDomains: safeCsp.connectDomains.map((domain) => `https://${domain}`),
            resourceDomains: safeCsp.resourceDomains.map((domain) => `https://${domain}`),
          },
        },
      },
      { hostContext: getSafeHostContext(container) },
    );

    const cleanupBridge = () => {
      if (!mounted) return;
      mounted = false;
      if (initializationTimer !== undefined) window.clearTimeout(initializationTimer);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      for (const controller of mountedCalls) controller.abort();
      mountedCalls.clear();
      void bridge.close().catch(() => undefined);
      void transport?.close().catch(() => undefined);
    };
    const fail = (message: string) => {
      if (!mounted) return;
      cleanupBridge();
      setRuntimeFailure({ html: resourceHtml, sha256: resourceSha256, cspKey, message });
    };

    bridge.oncalltool = async (params, extra) => {
      if (!mounted) return toolCallError('The application is no longer active.');
      if (!isAllowedPluginAppToolCall(params.name, params.arguments ?? {}, allowedNamesRef.current)) {
        return toolCallError('Tool call is not permitted.');
      }
      if (mountedCalls.size >= MAX_ACTIVE_TOOL_CALLS) {
        return toolCallError('Too many application requests are active.');
      }

      const controller = new AbortController();
      mountedCalls.add(controller);
      const requestSignal = extra.mcpReq.signal;
      const abort = () => { controller.abort(); };
      const timer = window.setTimeout(() => {
        controller.abort();
      }, TOOL_CALL_TIMEOUT_MS);
      if (requestSignal.aborted) controller.abort();
      else requestSignal.addEventListener('abort', abort, { once: true });

      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => { reject(new Error('aborted')); };
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });

      try {
        const result = await Promise.race([
          onToolCallRef.current(params.name, params.arguments ?? {}, controller.signal),
          aborted,
        ]);
        return isBoundedPluginAppResult(result) ? result : toolCallError('Tool result exceeded the application limit.');
      } catch {
        return toolCallError('The application request timed out, was cancelled, or failed.');
      } finally {
        window.clearTimeout(timer);
        requestSignal.removeEventListener('abort', abort);
        mountedCalls.delete(controller);
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => { bridge.setHostContext(getSafeHostContext(container)); });
      resizeObserver.observe(container);
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => { bridge.setHostContext(getSafeHostContext(container)); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }

    bridge.addEventListener('initialized', () => {
      if (!mounted) return;
      if (initializationTimer !== undefined) window.clearTimeout(initializationTimer);
      const args = initialArgumentsRef.current;
      if (args && isBoundedPluginAppResult(args)) {
        void bridge.sendToolInput({ arguments: args }).catch(() => {
          fail('The application could not receive its tool arguments.');
        });
      }
      const result = initialResultRef.current;
      if (result && isBoundedPluginAppResult(result)) {
        void bridge.sendToolResult(result).catch(() => {
          fail('The application could not receive its tool result.');
        });
      }
    });

    const connect = async () => {
      try {
        transport = new PostMessageTransport(contentWindow, contentWindow);
        transport.onerror = () => {
          fail('The application sent an invalid message.');
        };
        await bridge.connect(transport);
        if (!mounted) return;
        frame.srcdoc = createPluginAppFrameDocument(resourceHtml, safeCsp);
        initializationTimer = window.setTimeout(() => {
          fail('The application did not finish starting.');
        }, APP_INITIALIZATION_TIMEOUT_MS);
      } catch {
        fail('The application could not be started.');
      }
    };
    void connect();

    return cleanupBridge;
  }, [resourceState, resourceHtml, resourceSha256, safeCsp, cspKey]);

  return (
    <div ref={containerRef} className={className}>
      {resourceState === 'error' || runtimeError !== null ? (
        <div role="alert" className="rounded-xl border border-[var(--line-strong)] bg-[var(--surface-soft)] p-4 text-sm text-[var(--ink)]">
          {verificationError ?? runtimeError ?? 'The application could not be shown.'}
        </div>
      ) : (
        <>
          {resourceState === 'checking' && (
            <p role="status" className="mb-2 text-sm text-[var(--muted)]">Verifying application resource …</p>
          )}
          <iframe
            ref={frameRef}
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc=""
            className="block min-h-[360px] w-full rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]"
            style={{ height: 'min(620px, 72vh)' }}
          />
        </>
      )}
    </div>
  );
}

function getSafeHostContext(container: HTMLElement): McpUiHostContext {
  const root = document.documentElement;
  const themeAttribute = root.getAttribute('data-theme');
  const theme: 'dark' | 'light' = themeAttribute === 'dark' || themeAttribute === 'light'
    ? themeAttribute
    : root.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  const rect = container.getBoundingClientRect();
  const width = Math.max(240, Math.min(1_280, Math.round(rect.width || window.innerWidth)));
  const height = Math.max(240, Math.min(760, Math.round(rect.height || window.innerHeight)));
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const locale = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(navigator.language)
    ? navigator.language
    : 'de-DE';
  return {
    theme,
    displayMode: 'inline' as const,
    availableDisplayModes: ['inline' as const],
    locale,
    timeZone: 'Europe/Berlin',
    platform: touch && width < 900 ? 'mobile' as const : 'web' as const,
    deviceCapabilities: { touch, hover: !touch },
    containerDimensions: { width, height },
  };
}

function toolCallError(message: string): AppToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
