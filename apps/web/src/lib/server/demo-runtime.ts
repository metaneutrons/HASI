import 'server-only';

import { createDemoRuntime } from '@hasi/demo-runtime';
import { hshDemoCatalog } from '@hasi/demo-fixtures/catalog';
import { PostgresJsonStore } from '@hasi/state';

let pending: Promise<ReturnType<typeof createDemoRuntime>> | undefined;

function requiredSecret(name: 'DATABASE_URL' | 'HASI_DEMO_SECRET'): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Demo server configuration is missing.');
  return value;
}

export function getDemoRuntime() {
  if (!pending) pending = initialize().catch(() => { pending = undefined; throw new Error('Demo backend unavailable.'); });
  return pending;
}

function configuredOrigin(): string {
  if (!process.env.VERCEL) return process.env.HASI_DEMO_ORIGIN ?? 'http://127.0.0.1:3001';
  return process.env.VERCEL_ENV === 'preview' ? `https://${process.env.VERCEL_URL ?? ''}` : 'https://hasi.metaneutrons.cc';
}

async function initialize() {
  if (process.env.HASI_DEMO_MODE !== '1') throw new Error('Explicit server demo mode is required.');
  const deployed = Boolean(process.env.VERCEL);
  const preview = process.env.VERCEL_ENV === 'preview';
  const origin = configuredOrigin();
  const namespace = deployed ? preview ? `preview:${process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_URL ?? 'isolated'}` : 'production:v1' : 'local-demo:v1';
  const store = new PostgresJsonStore(namespace, { poolConfig: { connectionString: requiredSecret('DATABASE_URL'), max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 20000, allowExitOnIdle: true } });
  try { await store.initialize(); await store.deleteExpired(); } catch { await store.close(); throw new Error('Demo state unavailable.'); }
  const internalFetch: typeof fetch = (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    // This credential is sent only by the origin-pinned integration transport.
    if (preview && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers.set('x-vercel-protection-bypass', process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  return createDemoRuntime({ origin, store, secret: requiredSecret('HASI_DEMO_SECRET'), fetch: internalFetch, catalog: hshDemoCatalog });
}

export async function demoResponse(request: Request, target: 'handleCore' | 'handlePlugin' | 'handleMock' | 'handleKnowledgePlugin'): Promise<Response> {
  try {
    const origin = new URL(configuredOrigin());
    // Next.js may use an internal localhost origin in request.url. Only the
    // explicitly configured public Host can cross this adapter boundary.
    if (request.headers.get('host') !== origin.host) return Response.json({ error: 'Unzulässiger Host.' }, { status: 403, headers: { 'cache-control': 'private, no-store' } });
    const incoming = new URL(request.url);
    const canonical = new Request(new URL(`${incoming.pathname}${incoming.search}`, origin), request);
    return await (await getDemoRuntime())[target](canonical);
  }
  catch { return Response.json({ error: 'Der HASI-Dienst ist vorübergehend nicht verfügbar. Bitte versuche es erneut.' }, { status: 503, headers: { 'cache-control': 'private, no-store' } }); }
}
