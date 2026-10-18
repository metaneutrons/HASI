import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryJsonStore } from '@hasi/state';
import { createDemoRuntime } from '@hasi/demo-runtime';

type Runtime = ReturnType<typeof createDemoRuntime>;
const runtimes: Runtime[] = [];
const origin = 'http://127.0.0.1:3001';

function recordSetCookie(jar: Map<string, string>, setCookie: string): void {
  const [pair, ...attributes] = setCookie.split(';');
  if (!pair) return;
  const separator = pair.indexOf('=');
  if (separator < 1) return;
  const name = pair.slice(0, separator).trim();
  const maxAge = attributes.find((attribute) => attribute.trim().toLowerCase().startsWith('max-age='));
  if (maxAge && Number(maxAge.trim().slice('max-age='.length)) <= 0) jar.delete(name);
  else jar.set(name, pair.trim());
}

function createHarness(options: { rejectToolsListWithStatus?: number } = {}) {
  const cookies = new Map<string, string>();
  const upstreamPaths: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const routedRequest = new Request(request, { redirect: 'error' });
    const url = new URL(routedRequest.url);
    if (url.pathname.startsWith('/api/v1/')) upstreamPaths.push(url.pathname);
    if (url.pathname === '/mcp' && options.rejectToolsListWithStatus !== undefined) {
      const payload = await routedRequest.clone().json() as { method?: unknown };
      if (payload.method === 'tools/list') return new Response(null, { status: options.rejectToolsListWithStatus });
    }
    const response = url.pathname.startsWith('/plugins/knowledge/')
      ? await runtime.handleKnowledgePlugin(routedRequest)
      : url.pathname === '/mcp' || url.pathname.startsWith('/.well-known/')
      ? await runtime.handlePlugin(routedRequest)
      : url.pathname.startsWith('/api/v1/')
        ? await runtime.handleMock(routedRequest)
        : await runtime.handleCore(routedRequest);
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/.well-known/') && !url.pathname.startsWith('/api/v1/')) {
      for (const value of response.headers.getSetCookie()) recordSetCookie(cookies, value);
    }
    return response;
  };
  const runtime = createDemoRuntime({
    origin,
    store: new MemoryJsonStore(`plugin-connection-${randomUUID()}`),
    secret: randomBytes(32).toString('base64url'),
    fetch: transport,
  });
  runtimes.push(runtime);

  async function request(path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const url = new URL(path, origin);
    const headers = new Headers();
    headers.set('origin', origin);
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (cookies.size > 0) headers.set('cookie', [...cookies.values()].join('; '));
    const response = await transport(new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, payload: await response.json() as unknown };
  }

  return { request, upstreamPaths };
}

describe('admin plugin connection test', () => {
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it('requires an administrator, rejects extra request fields, and probes without invoking business tools', async () => {
    const harness = createHarness();

    expect((await harness.request('/api/admin/plugins/de.hsh.hasi.anny/test-connection', {})).status).toBe(401);
    expect((await harness.request('/api/dev/login', { personaId: 'student' })).status).toBe(200);
    expect((await harness.request('/api/admin/plugins/de.hsh.hasi.anny/test-connection', {})).status).toBe(403);
    expect((await harness.request('/api/dev/login', { personaId: 'admin' })).status).toBe(200);
    expect((await harness.request('/api/admin/plugins/de.hsh.hasi.anny/test-connection', { force: true })).status).toBe(400);

    harness.upstreamPaths.length = 0;
    const response = await harness.request('/api/admin/plugins/de.hsh.hasi.anny/test-connection', {});
    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      instanceId: 'de.hsh.hasi.anny',
      configured: 'ready',
      reachable: 'verified',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      userReady: 'not_assessed',
      remedies: [],
    });
    expect(harness.upstreamPaths).toEqual([]);
    expect(JSON.stringify(response.payload)).not.toMatch(/serviceToken|credential:\/\/|Bearer /iu);
  });

  it('does not treat an upstream HTTP 403 as proof that service authentication was rejected', async () => {
    const harness = createHarness({ rejectToolsListWithStatus: 403 });
    expect((await harness.request('/api/dev/login', { personaId: 'admin' })).status).toBe(200);

    const response = await harness.request('/api/admin/plugins/de.hsh.hasi.anny/test-connection', {});

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      instanceId: 'de.hsh.hasi.anny',
      reachable: 'failed',
      authenticated: 'not_verified',
      authorized: 'not_assessed',
      remedies: [expect.objectContaining({ code: 'connection_failed' })],
    });
    expect(response.payload).not.toMatchObject({
      authenticated: 'rejected',
      remedies: [expect.objectContaining({ code: 'authentication_rejected' })],
    });
  });
});
