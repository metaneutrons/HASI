import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createInvocationToken, type ActorContext } from '@hasi/plugin-sdk';
import type { ContentResponse, ContentTransport } from '../apps/knowledge-plugin/src/content/contracts.js';
import { ContentAcquisitionError } from '../apps/knowledge-plugin/src/content/contracts.js';
import { createKnowledgePlugin, knowledgeManifest, SERVICE_IT_DEMO_ORIGIN } from '../apps/knowledge-plugin/src/index.js';
import { createDemoContentAcquirer, createServiceItDemoTransport } from '../apps/knowledge-plugin/src/demo-content.js';
import { knowledgeCreatedAt, knowledgeDocuments } from '../fixtures/knowledge-catalog.js';
import { createServiceItDemo } from '../apps/service-it-demo/src/index.js';
import { createApi, PluginRegistry } from '../apps/api/src/index.js';
import { digest } from '@hasi/plugin-sdk';

const keys = generateKeyPairSync('ed25519');
const serviceToken = 'demo-content-test-service-token';
const timestamp = '2026-10-18T12:30:00.000Z';
const serviceDocuments = knowledgeDocuments
  .filter((document) => document.sourceSystem === 'service_it');
const fixtureById = new Map(serviceDocuments.map((document) => [document.id, document]));
const plugins: ReturnType<typeof createKnowledgePlugin>[] = [];

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()));
});

describe('synthetic ServiceIT HTML demo acquisition', () => {
  it('reads every deployed portal article through the real HTML adapter without importing page chrome', async () => {
    const portal = createServiceItDemo();
    try {
      const acquirer = createDemoContentAcquirer({ transport: {
        async get(url) {
          const reply = await portal.inject({ url: url.pathname });
          return { status: reply.statusCode, contentType: String(reply.headers['content-type']), body: reply.body };
        },
      } });
      for (const document of serviceDocuments) {
        const acquired = await acquirer.read(document.id);
        expect(acquired.text, document.id).toBe(document.text);
        expect(acquired.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
      }
    } finally { await portal.close(); }
  });

  it('reauthorizes source redirects through signed MCP and rejects foreign origins and stale revisions', async () => {
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken,
      allowedHosts: ['knowledge.example.invalid'], demoContent: { transport: htmlTransport(url => response(article(fixtureForUrl(url)))) } });
    plugins.push(plugin);
    const registry = new PluginRegistry(keys.privateKey, { fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'https://knowledge.example.invalid') throw new Error('Unexpected test origin');
      const headers = Object.fromEntries(request.headers); headers.host = url.host;
      const result = await plugin.inject({ method: request.method, url: url.pathname,
        headers, ...(request.method === 'GET' ? {} : { payload: await request.text() }) });
      return new Response([204, 205, 304].includes(result.statusCode) ? null : result.body,
        { status: result.statusCode, headers: { 'content-type': result.headers['content-type'] ?? '' } });
    } });
    await registry.install({ endpoint: 'https://knowledge.example.invalid/mcp', serviceToken,
      expectedManifestDigest: digest(knowledgeManifest), allowLoopback: false });
    await expect(createApi({ mode: 'test', registry, knowledgeDemoServiceItOrigin: 'https://attacker.invalid' }))
      .rejects.toThrow('Unapproved synthetic source origin');
    const api = await createApi({ mode: 'test', registry, knowledgeDemoServiceItOrigin: SERVICE_IT_DEMO_ORIGIN });
    const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
    try {
      const sourcePath = '/api/knowledge/documents/svc-001/demo-source';
      expect((await api.inject({ url: sourcePath, headers })).statusCode).toBe(401);
      const login = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId: 'student' } });
      const session = login.cookies.find(cookie => cookie.name === 'hasi-session');
      expect(session).toBeDefined();
      const authenticated = { ...headers, cookie: `hasi-session=${session!.value}` };
      const allowed = await api.inject({ url: `${sourcePath}?revision=2`, headers: authenticated });
      expect(allowed.statusCode, allowed.body).toBe(302);
      expect(allowed.headers.location).toBe(`${SERVICE_IT_DEMO_ORIGIN}/de/faqs/svc-001/`);
      expect(allowed.headers['cache-control']).toBe('private, no-store');
      for (const path of [ `${sourcePath}?revision=1`, '/api/knowledge/documents/int-013/demo-source',
        '/api/knowledge/documents/svc-missing/demo-source' ]) {
        const denied = await api.inject({ url: path, headers: authenticated });
        expect(denied.statusCode, path).toBe(404);
        expect(denied.headers.location).toBeUndefined();
      }
      expect((await api.inject({ url: `${sourcePath}?url=https://attacker.invalid`, headers: authenticated })).statusCode).toBe(400);
    } finally { await api.close(); }
  });
  it('verifies only the requested top ServiceIT hit and caches its acquired body', async () => {
    const requests: string[] = [];
    const transport = htmlTransport((url) => {
      requests.push(url.href);
      const id = /\/de\/faqs\/([^/]+)\/$/u.exec(url.pathname)?.[1];
      const document = id ? fixtureById.get(id) : undefined;
      if (!document) return response('', 404);
      return response(article(document));
    });
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken,
      demoContent: { transport, clock: () => new Date(timestamp) } });
    plugins.push(plugin);

    const search = await callAs(plugin, student, 'knowledge.search', { query: 'Morgenstern-Lab', sourceSystem: 'service_it', limit: 1 });
    expect(search.isError).not.toBe(true);
    const result = (search.structuredContent as { documents: Record<string, unknown>[] }).documents[0];
    expect(result).toMatchObject({
      id: 'svc-001',
      title: 'WLAN-Verbindung prüfen',
      revision: 2,
      synthetic: true,
      text: fixtureById.get('svc-001')?.text,
      fetchedAt: timestamp,
      acquisition: { adapter: 'web' },
    });
    const acquisition = result?.acquisition as Record<string, unknown> | undefined;
    expect(acquisition?.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).not.toHaveProperty('canonicalUrl');
    expect(requests).toHaveLength(1);
    expect(requests.every((url) => url.startsWith(`${SERVICE_IT_DEMO_ORIGIN}/de/faqs/`))).toBe(true);

    const get = await callAs(plugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect((get.structuredContent as { document: Record<string, unknown> }).document).toMatchObject({
      id: 'svc-001', text: fixtureById.get('svc-001')?.text, revision: 2, fetchedAt: timestamp,
      acquisition: { adapter: 'web' },
    });
    expect(requests).toHaveLength(1);
  });

  it('limits ServiceIT reads to the ranked result count, even when many local fixtures match', async () => {
    const requests: string[] = [];
    const transport = htmlTransport((url) => {
      requests.push(url.href);
      return response(article(fixtureForUrl(url)));
    });
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport } });
    plugins.push(plugin);

    const result = await callAs(plugin, student, 'knowledge.search', { query: 'WLAN', sourceSystem: 'service_it', limit: 3 });
    expect(result.isError).not.toBe(true);
    const documents = (result.structuredContent as { documents: Record<string, unknown>[] }).documents;
    expect(documents).toHaveLength(3);
    expect(requests).toHaveLength(3);
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(serviceDocuments.length).toBeGreaterThan(requests.length);
  });

  it('does not fetch ServiceIT for an intranet-only match or a zero-result query', async () => {
    const get = vi.fn<ContentTransport['get']>(() => Promise.resolve(response('must not be fetched')));
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport: { get } } });
    plugins.push(plugin);

    const intranet = await callAs(plugin, admin, 'knowledge.search', { query: 'Gremientagesordnung', limit: 5 });
    expect(intranet.isError).not.toBe(true);
    const intranetDocuments = (intranet.structuredContent as { documents: Record<string, unknown>[] }).documents;
    expect(intranetDocuments.length).toBeGreaterThan(0);
    expect(intranetDocuments.every((document) => document.sourceSystem === 'intranet')).toBe(true);
    expect(get).not.toHaveBeenCalled();

    const empty = await callAs(plugin, student, 'knowledge.search', { query: 'zzqzxvvn-92831' });
    expect(empty.isError, JSON.stringify(empty)).not.toBe(true);
    expect((empty.structuredContent as { documents: unknown[] }).documents).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('checks the synthetic role before fetching a denied ServiceIT document', async () => {
    const get = vi.fn<ContentTransport['get']>(() => Promise.resolve(response('unused')));
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport: { get } } });
    plugins.push(plugin);

    const denied = await callAs(plugin, { ...student, claims: { 'knowledge.demoAudience': 'visitor' } },
      'knowledge.get_document', { documentId: 'svc-001' });
    expect(denied.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('leaves intranet fixture reads local and does not acquire ServiceIT pages', async () => {
    const get = vi.fn<ContentTransport['get']>(() => Promise.resolve(response('should not be fetched')));
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport: { get } } });
    plugins.push(plugin);

    const result = await callAs(plugin, admin, 'knowledge.get_document', { documentId: 'int-013' });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { document: Record<string, unknown> }).document).toMatchObject({
      id: 'int-013', revision: 2, fetchedAt: `${knowledgeCreatedAt}T00:00:00Z`,
    });
    expect((result.structuredContent as { document: Record<string, unknown> }).document).not.toHaveProperty('acquisition');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects changed HTML and source failures without returning embedded fixture text', async () => {
    const changedTransport = htmlTransport((url) => {
      const document = fixtureForUrl(url);
      return response(article({ ...document, text: `${document.text} CHANGED BY SOURCE` }));
    });
    const changedPlugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken,
      demoContent: { transport: changedTransport } });
    plugins.push(changedPlugin);
    const changed = await callAs(changedPlugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).not.toContain(fixtureById.get('svc-001')?.text);

    const failedTransport = vi.fn<ContentTransport['get']>(() => Promise.reject(new Error('private transport detail')));
    const failedPlugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport: { get: failedTransport } } });
    plugins.push(failedPlugin);
    const failed = await callAs(failedPlugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('private transport detail');
    expect(JSON.stringify(failed)).not.toContain(fixtureById.get('svc-001')?.text);
  });

  it('uses only the fixed HTTPS inventory and rejects wrong origins and redirects', async () => {
    const requests: string[] = [];
    const redirect = vi.fn<ContentTransport['get']>((url) => {
      requests.push(url.href);
      return Promise.resolve(response('', 302));
    });
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken, demoContent: { transport: { get: redirect } } });
    plugins.push(plugin);

    const result = await callAs(plugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([`${SERVICE_IT_DEMO_ORIGIN}/de/faqs/svc-001/`]);
    expect(redirect).toHaveBeenCalledTimes(1);

    const noArbitraryUrl = vi.fn<ContentTransport['get']>(() => Promise.resolve(response('unused')));
    const fixedTransport = createServiceItDemoTransport({ get: noArbitraryUrl });
    await expect(fixedTransport.get(new URL('https://attacker.example/de/faqs/svc-001/'), 'html', new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_content' });
    const acquirer = createDemoContentAcquirer({ transport: { get: noArbitraryUrl } });
    await expect(acquirer.read('https://attacker.example/de/faqs/svc-001/')).rejects.toBeInstanceOf(ContentAcquisitionError);
    expect(noArbitraryUrl).not.toHaveBeenCalled();
  });

  it('bounds waits and refreshes a successful body after its cache expires', async () => {
    let now = new Date(timestamp);
    const get = vi.fn<ContentTransport['get']>((url) => Promise.resolve(response(article(fixtureForUrl(url)))));
    const plugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken,
      demoContent: { transport: { get }, timeoutMs: 100, cacheTtlMs: 1_000, clock: () => now } });
    plugins.push(plugin);

    const first = await callAs(plugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    const repeated = await callAs(plugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(first.isError).not.toBe(true);
    expect(repeated.isError).not.toBe(true);
    expect(get).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 1_001);
    await callAs(plugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(get).toHaveBeenCalledTimes(2);

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const slowPlugin = createKnowledgePlugin({ publicKey: keys.publicKey, serviceToken,
      demoContent: { timeoutMs: 100, transport: { get: (_url, _accept, signal) => new Promise<ContentResponse>((_resolve, reject) => {
        markStarted?.();
        signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      }) } } });
    plugins.push(slowPlugin);
    const pending = callAs(slowPlugin, student, 'knowledge.get_document', { documentId: 'svc-001' });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 125));
    const timedOut = await pending;
    expect(timedOut.isError).toBe(true);
    expect(JSON.stringify(timedOut)).not.toContain(fixtureById.get('svc-001')?.text);
  });

  it('keeps simultaneous transport reads within the configured concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const transport: ContentTransport = {
      get(url, _accept, signal) {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            active -= 1;
            resolve(response(article(fixtureForUrl(url))));
          }, 10);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            active -= 1;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    };
    const acquirer = createDemoContentAcquirer({ transport, timeoutMs: 1_000, maxConcurrentReads: 2 });

    const results = await Promise.all(serviceDocuments.slice(0, 12).map((document) => acquirer.read(document.id)));
    expect(results).toHaveLength(12);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});

interface DemoFixture {
  id: string;
  sourceSystem: 'service_it' | 'intranet';
  title: string;
  text: string;
}

const student: ActorContext = {
  subject: 'demo-student', claims: { 'knowledge.demoAudience': 'student' }, customerId: 'demo-student-customer',
  resourceIds: [], permissions: ['knowledge:read', 'knowledge:audience:student'],
};
const admin: ActorContext = {
  subject: 'demo-admin', claims: { 'knowledge.demoAudience': 'admin' }, customerId: 'demo-admin-customer',
  resourceIds: [], permissions: ['knowledge:read', 'knowledge:audience:admin'],
};

function response(body: string, status = 200): ContentResponse {
  return { status, contentType: 'text/html; charset=utf-8', body };
}

function htmlTransport(render: (url: URL) => ContentResponse): ContentTransport {
  return { get: (url, accept, signal) => {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (accept !== 'html') return Promise.resolve({ status: 406, contentType: 'text/plain', body: '' });
    return Promise.resolve(render(url));
  } };
}

function fixtureForUrl(url: URL): DemoFixture {
  const id = /\/de\/faqs\/([^/]+)\/$/u.exec(url.pathname)?.[1];
  const document = id ? fixtureById.get(id) : undefined;
  if (!document) throw new Error('Unexpected fixture URL.');
  return document;
}

function article(document: DemoFixture): string {
  return `<!doctype html><html lang="de"><head><title>Untrusted page metadata</title></head><body><nav>Navigation is excluded</nav><main><div id="service-it-document"><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.text)}</p></div></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function callAs(plugin: ReturnType<typeof createKnowledgePlugin>, actor: ActorContext, tool: string, args: Record<string, unknown>) {
  const invocation = await createInvocationToken({
    actor, pluginId: knowledgeManifest.id, pluginVersion: knowledgeManifest.version, tool, args,
    context: { installationId: knowledgeManifest.id, configurationRevision: 0, configuration: {} },
  }, keys.privateKey);
  const response = await plugin.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${serviceToken}`, 'x-hasi-invocation': invocation,
      accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const line = response.body.split('\n').find((entry) => entry.startsWith('data: '));
  const decoded: unknown = JSON.parse(line ? line.slice('data: '.length) : response.body);
  if (decoded === null || typeof decoded !== 'object' || !('result' in decoded)) throw new Error('Missing MCP result.');
  return decoded.result as {
    structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown[];
  };
}
