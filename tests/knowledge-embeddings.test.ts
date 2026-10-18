import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginSecretCustody } from '../apps/api/src/plugin-secrets.js';
import {
  createKnowledgeEmbeddingClient,
  type CreateKnowledgeEmbeddingClientOptions,
  type KnowledgeEmbeddingBudget,
  type KnowledgeEmbeddingUsage,
} from '../apps/api/src/knowledge-embeddings.js';

const endpoint = 'https://embeddings.example/v1/embeddings';
const modelId = 'fixture/multilingual-e5';
const dimensions = 3;
const token = 'operator-only-test-token';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function response(body: unknown, status = 200, headers: ConstructorParameters<typeof Headers>[0] = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function embedding(overrides: Record<string, unknown> = {}) {
  return {
    model: modelId,
    data: [{ index: 0, embedding: [0.2, -0.3, 0.4] }],
    usage: { prompt_tokens: 23, total_tokens: 23 },
    ...overrides,
  };
}

function defaults(overrides: Partial<CreateKnowledgeEmbeddingClientOptions> = {}): CreateKnowledgeEmbeddingClientOptions {
  const custody: PluginSecretCustody = {
    status: () => ({ configured: true, revision: 'test-r1' }),
    use: <T>(_slot: string, operation: (credential: string) => Promise<T>) => operation(token),
  };
  const budget: KnowledgeEmbeddingBudget = {
    reserve: () => Promise.resolve({ settle: () => Promise.resolve(undefined) }),
  };
  const fetch: typeof globalThis.fetch = () => Promise.resolve(response(embedding()));
  return {
    endpoint,
    modelId,
    dimensions,
    custody,
    slot: 'embedding-provider',
    allowedDataClasses: ['public', 'internal'],
    budget,
    fetch,
    ...overrides,
  };
}

function defaultsWithoutFetch(overrides: Partial<CreateKnowledgeEmbeddingClientOptions> = {}): CreateKnowledgeEmbeddingClientOptions {
  const options = defaults(overrides);
  return {
    endpoint: options.endpoint,
    modelId: options.modelId,
    dimensions: options.dimensions,
    custody: options.custody,
    slot: options.slot,
    allowedDataClasses: options.allowedDataClasses,
    budget: options.budget,
  };
}

function parsedJsonBody(init: RequestInit | undefined): unknown {
  if (!init || typeof init.body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(init.body) as unknown;
}

describe('operator-pinned knowledge embedding client', () => {
  it('reserves before HTTP, sends only the fixed request fields and settles actual usage', async () => {
    const events: string[] = [];
    const settlements: (KnowledgeEmbeddingUsage | undefined)[] = [];
    const query = 'Hochschulzugang für Gäste';
    const reservedTokens = Buffer.byteLength(query, 'utf8') + 512;
    const custody: PluginSecretCustody = {
      status: () => ({ configured: true, revision: 'r1' }),
      use: <T>(slot: string, operation: (credential: string) => Promise<T>) => {
        expect(slot).toBe('embedding-provider');
        return operation(token);
      },
    };
    const budget: KnowledgeEmbeddingBudget = {
      reserve: inputTokens => {
        events.push('reserve');
        expect(inputTokens).toBe(reservedTokens);
        return Promise.resolve({
          settle: usage => {
            events.push('settle');
            settlements.push(usage);
            return Promise.resolve(undefined);
          },
        });
      },
    };
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const fetch: typeof globalThis.fetch = (input, init) => {
      events.push('http');
      request = { url: inputUrl(input), init };
      return Promise.resolve(response(embedding()));
    };
    const client = createKnowledgeEmbeddingClient(defaults({ custody, budget, fetch }));
    try {
      expect(client.modelId).toBe(modelId);
      expect(client.dimensions).toBe(dimensions);
      expect(client.allowedDataClasses).toEqual(['public', 'internal']);
      expect(Object.isFrozen(client.allowedDataClasses)).toBe(true);
      const vector = await client.embedQuery(query);
      expect(vector).toEqual([0.2, -0.3, 0.4]);
      expect(events).toEqual(['reserve', 'http', 'settle']);
      expect(settlements).toEqual([{ inputTokens: 23, outputTokens: 0 }]);
      expect(request?.url).toBe(endpoint);
      expect(request?.init?.method).toBe('POST');
      expect(request?.init?.redirect).toBe('error');
      expect(new Headers(request?.init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(parsedJsonBody(request?.init)).toEqual({ model: modelId, input: query, encoding_format: 'float' });
      expect(JSON.stringify(vector)).not.toContain(token);
    } finally {
      await client.close();
    }
  });

  it('retains the budget hold and fails closed when usage is missing or invalid', async () => {
    const settlements: (KnowledgeEmbeddingUsage | undefined)[] = [];
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => Promise.resolve({
        settle: usage => {
          settlements.push(usage);
          return Promise.resolve(undefined);
        },
      }),
    };
    const fetch: typeof globalThis.fetch = () => Promise.resolve(response({
      model: modelId,
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }));
    const client = createKnowledgeEmbeddingClient(defaults({ budget, fetch }));
    try {
      await expect(client.embedQuery('query')).rejects.toThrow('Knowledge embedding unavailable.');
      expect(settlements).toEqual([undefined]);
    } finally {
      await client.close();
    }
  });

  it('does not reserve or call the provider when the operator credential is missing', async () => {
    let reserveCalls = 0;
    const custody: PluginSecretCustody = {
      status: () => ({ configured: false, revision: null }),
      use: () => Promise.reject(new Error('credential unavailable')),
    };
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => {
        reserveCalls += 1;
        return Promise.resolve({ settle: () => Promise.resolve(undefined) });
      },
    };
    const fetch = vi.fn(() => Promise.resolve(response(embedding()))) as unknown as typeof globalThis.fetch;
    const client = createKnowledgeEmbeddingClient(defaults({ custody, budget, fetch }));
    try {
      await expect(client.embedQuery('query')).rejects.toThrow('Knowledge embedding unavailable.');
      expect(reserveCalls).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('requires a budget and rejects invalid provider configuration before any request', () => {
    const fetch = vi.fn(() => Promise.resolve(response(embedding()))) as unknown as typeof globalThis.fetch;
    expect(() => createKnowledgeEmbeddingClient(defaults({ budget: undefined as unknown as KnowledgeEmbeddingBudget }))).toThrow();
    for (const invalidEndpoint of [
      'http://embeddings.example/v1/embeddings',
      'https://user:pass@embeddings.example/v1/embeddings',
      'https://embeddings.example/v1/embeddings?model=untrusted',
      'https://embeddings.example/v1/auth/embeddings',
      'https://embeddings.example/v1/%65mbeddings',
    ]) {
      expect(() => createKnowledgeEmbeddingClient(defaults({ endpoint: invalidEndpoint, fetch }))).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong model', { model: 'other/model' }],
    ['wrong dimensions', { data: [{ index: 0, embedding: [0.1, 0.2] }] }],
    ['zero vector', { data: [{ index: 0, embedding: [0, 0, 0] }] }],
    ['non-finite vector', { data: [{ index: 0, embedding: [0.1, Number.NaN, 0.3] }] }],
    ['over-reserved usage', { usage: { prompt_tokens: 900, total_tokens: 900 } }],
  ])('rejects %s and retains the reservation', async (_label, overrides) => {
    const settlements: (KnowledgeEmbeddingUsage | undefined)[] = [];
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => Promise.resolve({
        settle: usage => {
          settlements.push(usage);
          return Promise.resolve(undefined);
        },
      }),
    };
    const fetch: typeof globalThis.fetch = () => Promise.resolve(response(embedding(overrides)));
    const client = createKnowledgeEmbeddingClient(defaults({ budget, fetch }));
    try {
      await expect(client.embedQuery('query')).rejects.toThrow('Knowledge embedding unavailable.');
      expect(settlements).toEqual([undefined]);
    } finally {
      await client.close();
    }
  });

  it('denies redirects and oversized JSON without returning provider details', async () => {
    const settlements: (KnowledgeEmbeddingUsage | undefined)[] = [];
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => Promise.resolve({ settle: usage => { settlements.push(usage); return Promise.resolve(undefined); } }),
    };
    const redirectFetch = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return Promise.resolve(new Response('', { status: 302, headers: { location: 'https://other.example/v1/embeddings' } }));
    }) as unknown as typeof globalThis.fetch;
    const redirectClient = createKnowledgeEmbeddingClient(defaults({ budget, fetch: redirectFetch }));
    try {
      await expect(redirectClient.embedQuery('query')).rejects.toThrow('Knowledge embedding unavailable.');
      expect(settlements).toEqual([undefined]);
      expect(redirectFetch).toHaveBeenCalledTimes(1);
    } finally {
      await redirectClient.close();
    }

    settlements.length = 0;
    const oversized = { ...embedding(), padding: 'x'.repeat(140 * 1024) };
    const oversizedClient = createKnowledgeEmbeddingClient(defaults({
      budget,
      fetch: () => Promise.resolve(response(oversized)),
    }));
    try {
      await expect(oversizedClient.embedQuery('query')).rejects.toThrow('Knowledge embedding unavailable.');
      expect(settlements).toEqual([undefined]);
    } finally {
      await oversizedClient.close();
    }
  });

  it('validates query size before reserving and uses no user-controlled endpoint or model fields', async () => {
    let reserveCalls = 0;
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => {
        reserveCalls += 1;
        return Promise.resolve({ settle: () => Promise.resolve(undefined) });
      },
    };
    const requests: { url: string; body: string }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (!init || typeof init.body !== 'string') throw new Error('Expected a JSON request body.');
      requests.push({ url: inputUrl(input), body: init.body });
      return Promise.resolve(response(embedding()));
    };
    const client = createKnowledgeEmbeddingClient(defaults({ budget, fetch }));
    try {
      await expect(client.embedQuery('x'.repeat(501))).rejects.toThrow('Knowledge embedding unavailable.');
      expect(reserveCalls).toBe(0);
      await client.embedQuery('query');
      expect(requests).toEqual([{ url: endpoint, body: JSON.stringify({ input: 'query', encoding_format: 'float', model: modelId }) }]);
    } finally {
      await client.close();
    }
  });

  it('combines caller abort and deadline with the request, then retains the reservation', async () => {
    let observedSignal: AbortSignal | undefined;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { requestStarted = () => { resolve(); }; });
    const fetch: typeof globalThis.fetch = (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      requestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => { reject(new DOMException('private provider detail', 'AbortError')); }, { once: true });
      });
    };
    const settlements: (KnowledgeEmbeddingUsage | undefined)[] = [];
    const budget: KnowledgeEmbeddingBudget = {
      reserve: () => Promise.resolve({ settle: usage => { settlements.push(usage); return Promise.resolve(undefined); } }),
    };
    const client = createKnowledgeEmbeddingClient(defaults({ budget, fetch }));
    const caller = new AbortController();
    try {
      const pending = client.embedQuery('query', caller.signal);
      await started;
      caller.abort();
      await expect(pending).rejects.toThrow('Knowledge embedding unavailable.');
      expect(observedSignal?.aborted).toBe(true);
      expect(settlements).toEqual([undefined]);
    } finally {
      await client.close();
    }
  });

  it('closes owned transport, blocks loopback in production and restricts injected fetch to tests', async () => {
    const client = createKnowledgeEmbeddingClient(defaultsWithoutFetch());
    await client.close();
    await client.close();

    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createKnowledgeEmbeddingClient(defaults({ fetch: globalThis.fetch }))).toThrow();
    expect(() => createKnowledgeEmbeddingClient(defaultsWithoutFetch({ endpoint: 'https://127.0.0.1/v1/embeddings' }))).toThrow();
  });
});
