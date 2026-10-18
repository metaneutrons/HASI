import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginSecretCustody } from '../apps/api/src/plugin-secrets.js';
import { KnowledgeIngestionWorker, type KnowledgeSourceRegistration, type KnowledgeSourceSystem } from '../apps/api/src/knowledge-worker.js';

const serviceExportUrl = 'https://service-export.example/v1/signed-export';
const intranetExportUrl = 'https://intranet-export.example/v1/signed-export';
const configuredSources: KnowledgeSourceRegistration[] = [
  { id: 'service_it', exportUrl: serviceExportUrl },
  { id: 'intranet', exportUrl: intranetExportUrl },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeWorker(options: {
  sources?: readonly KnowledgeSourceRegistration[];
  fetch: typeof fetch;
  ingest?: (source: KnowledgeSourceSystem, signedExport: unknown) => Promise<unknown>;
  clock?: () => Date;
  maxResponseBytes?: number;
  timeoutMs?: number;
}) {
  const ingested: { source: KnowledgeSourceSystem; value: unknown }[] = [];
  const worker = new KnowledgeIngestionWorker({
    sources: options.sources ?? configuredSources,
    repository: {
      ingest: (source, signedExport) => {
        ingested.push({ source, value: signedExport });
        return options.ingest ? options.ingest(source, signedExport) : Promise.resolve({ accepted: true });
      },
    },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    fetch: options.fetch,
  });
  return { worker, ingested };
}

describe('permission-aware knowledge export worker', () => {
  it('reads both fixed JSON exports and lends a credential only inside its fixed bearer header', async () => {
    const token = 'operator-only-test-credential';
    const custody: PluginSecretCustody = {
      status: slot => ({ configured: slot === 'service-export', revision: slot === 'service-export' ? 'r1' : null }),
      use: <T>(slot: string, operation: (credential: string) => Promise<T>) => {
        expect(slot).toBe('service-export');
        return operation(token);
      },
    };
    const sources: KnowledgeSourceRegistration[] = [
      { id: 'service_it', exportUrl: serviceExportUrl, credential: { custody, slot: 'service-export' } },
      { id: 'intranet', exportUrl: intranetExportUrl },
    ];
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const payloads = new Map([
      [serviceExportUrl, { source: 'service_it', signature: 'fixture-signature', revision: 12 }],
      [intranetExportUrl, { source: 'intranet', signature: 'fixture-signature', revision: 3 }],
    ]);
    const fakeFetch: typeof fetch = (input, init) => {
      const url = inputUrl(input);
      requests.push({ url, init });
      return Promise.resolve(jsonResponse(payloads.get(url)));
    };
    const { worker, ingested } = makeWorker({ sources, fetch: fakeFetch });

    try {
      const result = await worker.runOnce();
      expect(result.sources.map(item => [item.sourceSystem, item.status])).toEqual([
        ['service_it', 'ingested'], ['intranet', 'ingested'],
      ]);
      expect(result.sources.every(item => Number.isFinite(Date.parse(item.timestamp)))).toBe(true);
      expect(ingested.map(item => item.source)).toEqual(['service_it', 'intranet']);
      expect(ingested.map(item => item.value)).toEqual([...payloads.values()]);
      expect(requests.map(item => item.url)).toEqual([serviceExportUrl, intranetExportUrl]);
      expect(requests[0]?.init?.method).toBe('GET');
      expect(requests[0]?.init?.redirect).toBe('error');
      expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(new Headers(requests[1]?.init?.headers).has('authorization')).toBe(false);
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await worker.close();
    }
  });

  it('requires both sources exactly once and rejects duplicate or unsafe fixed URLs', () => {
    const repo = { ingest: () => Promise.resolve(undefined) };
    const fetch = globalThis.fetch;
    expect(() => new KnowledgeIngestionWorker({ sources: [configuredSources[0]!], repository: repo, fetch })).toThrow();
    expect(() => new KnowledgeIngestionWorker({ sources: [configuredSources[0]!, configuredSources[0]!], repository: repo, fetch })).toThrow();
    expect(() => new KnowledgeIngestionWorker({
      sources: [{ id: 'service_it', exportUrl: serviceExportUrl }, { id: 'intranet', exportUrl: serviceExportUrl }],
      repository: repo,
      fetch,
    })).toThrow();
    for (const exportUrl of [
      'http://source.example/export',
      'https://user:password@source.example/export',
      'https://source.example/export?token=private',
      'https://source.example/export#fragment',
      'https://source.example/%61uth/login',
      'https://source.example/auth/login',
      'https://source.example/sso/export',
    ]) {
      expect(() => new KnowledgeIngestionWorker({
        sources: [{ id: 'service_it', exportUrl }, configuredSources[1]!], repository: repo, fetch,
      })).toThrow();
    }
  });

  it('does not follow redirects or ingest redirect responses', async () => {
    const fetch = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return Promise.resolve(new Response('', { status: 302, headers: { location: 'https://attacker.example/export' } }));
    }) as unknown as typeof globalThis.fetch;
    const { worker, ingested } = makeWorker({
      fetch,
    });
    try {
      const result = await worker.runOnce();
      expect(result.sources.map(item => item.status)).toEqual(['http_error', 'http_error']);
      expect(ingested).toEqual([]);
    } finally {
      await worker.close();
    }
  });

  it('bounds streamed response bytes and accepts only JSON objects', async () => {
    const fetch: typeof globalThis.fetch = input => Promise.resolve(inputUrl(input) === serviceExportUrl
      ? jsonResponse({ signed: 'a payload larger than the configured limit' })
      : jsonResponse({}));
    const { worker, ingested } = makeWorker({ fetch, maxResponseBytes: 16 });
    try {
      const result = await worker.runOnce();
      expect(result.sources.map(item => item.status)).toEqual(['invalid_export', 'ingested']);
      expect(ingested.map(item => item.source)).toEqual(['intranet']);
    } finally {
      await worker.close();
    }

    const scalar: typeof globalThis.fetch = input => Promise.resolve(inputUrl(input) === serviceExportUrl
      ? jsonResponse(['not', 'an', 'export'])
      : jsonResponse({}));
    const second = makeWorker({ fetch: scalar });
    try {
      expect((await second.worker.runOnce()).sources.map(item => item.status)).toEqual(['invalid_export', 'ingested']);
      expect(second.ingested.map(item => item.source)).toEqual(['intranet']);
    } finally {
      await second.worker.close();
    }
  });

  it('fails closed when an operator credential is unavailable and does not make the request', async () => {
    const custody: PluginSecretCustody = {
      status: () => ({ configured: false, revision: null }),
      use: () => Promise.reject(new Error('secret value must not escape')),
    };
    const fetch = vi.fn(() => Promise.resolve(jsonResponse({ signature: 'unused' }))) as unknown as typeof globalThis.fetch;
    const { worker, ingested } = makeWorker({
      sources: [{ ...configuredSources[0]!, credential: { custody, slot: 'service-export' } }, configuredSources[1]!],
      fetch,
    });
    try {
      const result = await worker.runOnce();
      expect(result.sources.map(item => item.status)).toEqual(['failed', 'ingested']);
      expect(JSON.stringify(result)).not.toContain('secret value');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(inputUrl(vi.mocked(fetch).mock.calls[0]![0])).toBe(intranetExportUrl);
      expect(ingested.map(item => item.source)).toEqual(['intranet']);
    } finally {
      await worker.close();
    }
  });

  it.each([429, 503])('applies a bounded Retry-After delay per source after HTTP %s', async status => {
    let now = Date.parse('2026-10-18T12:00:00.000Z');
    const counts = new Map<string, number>();
    const fetch: typeof globalThis.fetch = input => {
      const url = inputUrl(input);
      const count = (counts.get(url) ?? 0) + 1;
      counts.set(url, count);
      if (url === serviceExportUrl && count === 1) return Promise.resolve(new Response('', { status, headers: { 'retry-after': '86400' } }));
      return Promise.resolve(jsonResponse({ source: url, signature: 'fixture' }));
    };
    const { worker } = makeWorker({ fetch, clock: () => new Date(now) });
    try {
      const first = await worker.runOnce();
      expect(first.sources.find(item => item.sourceSystem === 'service_it')?.status).toBe('deferred');
      expect(first.sources.find(item => item.sourceSystem === 'intranet')?.status).toBe('ingested');
      const second = await worker.runOnce();
      expect(second.sources.find(item => item.sourceSystem === 'service_it')?.status).toBe('deferred');
      expect(counts.get(serviceExportUrl)).toBe(1);
      expect(counts.get(intranetExportUrl)).toBe(2);

      now += 5 * 60 * 1_000;
      const afterBound = await worker.runOnce();
      expect(afterBound.sources.find(item => item.sourceSystem === 'service_it')?.status).toBe('ingested');
      expect(counts.get(serviceExportUrl)).toBe(2);
    } finally {
      await worker.close();
    }
  });

  it('aborts in-flight fetches on close and reports only a sanitized status', async () => {
    let signal: AbortSignal | undefined;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { requestStarted = () => { resolve(); }; });
    const fetch: typeof globalThis.fetch = (_input, init) => {
      signal = init?.signal ?? undefined;
      requestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new DOMException('private detail', 'AbortError')); }, { once: true });
      });
    };
    const { worker } = makeWorker({ fetch });
    const running = worker.runOnce();
    await started;
    await worker.close();
    const result = await running;
    expect(signal?.aborted).toBe(true);
    expect(result.sources.map(item => item.status)).toEqual(['aborted', 'closed']);
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('waits for an active repository ingest to settle before close completes', async () => {
    let markIngestStarted: (() => void) | undefined;
    const ingestStarted = new Promise<void>(resolve => { markIngestStarted = resolve; });
    let finishIngest: (() => void) | undefined;
    const ingestGate = new Promise<void>(resolve => { finishIngest = resolve; });
    const { worker } = makeWorker({
      fetch: () => Promise.resolve(jsonResponse({ signed: 'fixture-export' })),
      ingest: async source => {
        if (source === 'service_it') {
          markIngestStarted?.();
          await ingestGate;
        }
        return { accepted: true };
      },
    });
    const running = worker.runOnce();
    await ingestStarted;
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishIngest?.();
    await Promise.all([closing, running]);
    expect(closed).toBe(true);
  });

  it('serializes the polling loop and rejects test fetch injection or loopback destinations in production', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise<Response>((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      setTimeout(() => {
        active -= 1;
        resolve(jsonResponse({ signature: 'fixture' }));
      }, 3_000);
    });
    const { worker } = makeWorker({ fetch, timeoutMs: 10_000 });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxActive).toBe(1);
    await worker.close();

    vi.stubEnv('NODE_ENV', 'development');
    expect(() => new KnowledgeIngestionWorker({ sources: configuredSources, repository: { ingest: () => Promise.resolve(undefined) }, fetch })).toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new KnowledgeIngestionWorker({ sources: configuredSources, repository: { ingest: () => Promise.resolve(undefined) }, fetch })).toThrow();
    expect(() => new KnowledgeIngestionWorker({
      sources: [{ id: 'service_it', exportUrl: 'https://127.0.0.1/export' }, configuredSources[1]!],
      repository: { ingest: () => Promise.resolve(undefined) },
    })).toThrow();
  });
});
