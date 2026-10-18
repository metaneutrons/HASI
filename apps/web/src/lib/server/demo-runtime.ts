import 'server-only';

import { createDemoRuntime } from '@hasi/demo-runtime';
import { hshDemoCatalog } from '@hasi/demo-fixtures/catalog';
import { PostgresJsonStore } from '@hasi/state';
import { resolveDemoStateNamespace } from './demo-runtime-namespace';

let pending: Promise<ReturnType<typeof createDemoRuntime>> | undefined;

function requiredSecret(name: 'DATABASE_URL' | 'HASI_DEMO_SECRET'): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Demo server configuration is missing.');
  return value;
}

export function getDemoRuntime() {
  pending ??= initialize().catch(() => { pending = undefined; throw new Error('Demo backend unavailable.'); });
  return pending;
}

function configuredOrigin(): string {
  if (!process.env.VERCEL) return process.env.HASI_DEMO_ORIGIN ?? 'http://127.0.0.1:3001';
  return process.env.VERCEL_ENV === 'preview' ? `https://${process.env.VERCEL_URL ?? ''}` : 'https://hasi.metaneutrons.cc';
}

async function initialize() {
  if (process.env.HASI_DEMO_MODE !== '1') throw new Error('Explicit server demo mode is required.');
  const preview = process.env.VERCEL_ENV === 'preview';
  const origin = configuredOrigin();
  const namespace = resolveDemoStateNamespace(process.env);
  const store = new PostgresJsonStore(namespace, { poolConfig: { connectionString: requiredSecret('DATABASE_URL'), max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 20000, allowExitOnIdle: true } });
  try { await store.initialize(); await store.deleteExpired(); } catch { await store.close(); throw new Error('Demo state unavailable.'); }
  const internalFetch: typeof fetch = (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => { headers.set(key, value); });
    // This credential is sent only by the origin-pinned integration transport.
    if (preview && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers.set('x-vercel-protection-bypass', process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  return createDemoRuntime({ origin, store, secret: requiredSecret('HASI_DEMO_SECRET'), fetch: internalFetch, catalog: hshDemoCatalog,
    ...(process.env.HASI_DEMO_SERVICE_IT_ORIGIN !== undefined ? { serviceItContentOrigin: process.env.HASI_DEMO_SERVICE_IT_ORIGIN } : {}) });
}

export function canonicalDemoRequest(request: Request): Request | null {
  const origin = new URL(configuredOrigin());
  // Next.js may use an internal origin in request.url. Only the configured
  // public Host can cross this boundary; forwarded host headers cannot select it.
  if (request.headers.get('host') !== origin.host) return null;
  const incoming = new URL(request.url);
  return new Request(new URL(`${incoming.pathname}${incoming.search}`, origin), request);
}

export async function demoResponse(request: Request, target: 'handleCore' | 'handlePlugin' | 'handleMock' | 'handleKnowledgePlugin'): Promise<Response> {
  try {
    const canonical = canonicalDemoRequest(request);
    if (!canonical) return Response.json({ error: 'Unzulässiger Host.' }, { status: 403, headers: { 'cache-control': 'private, no-store' } });
    return await (await getDemoRuntime())[target](canonical);
  }
  catch { return Response.json({ error: 'Der HASI-Dienst ist vorübergehend nicht verfügbar. Bitte versuche es erneut.' }, { status: 503, headers: { 'cache-control': 'private, no-store' } }); }
}
