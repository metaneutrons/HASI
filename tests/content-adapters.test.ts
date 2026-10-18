import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ContentAdapterChain,
  ContentAdapterRegistry,
  MediaWikiContentAdapter,
  WebContentAdapter,
} from '../apps/knowledge-plugin/src/content/adapters.js';
import {
  ContentAcquisitionError,
  type ContentAdapter,
  type ContentPage,
  type ContentResponse,
  type ContentTransport,
} from '../apps/knowledge-plugin/src/content/contracts.js';

const origin = 'https://wiki.example.edu';
const page: ContentPage = {
  url: `${origin}/wiki/WLAN`,
  title: 'WLAN',
};
const apiUrl = `${origin}/w/api.php`;
const revisionTimestamp = '2026-10-17T08:15:00Z';

function jsonResponse(value: unknown, status = 200): ContentResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) };
}

function response(body: string, options: Partial<ContentResponse> = {}): ContentResponse {
  return {
    status: options.status ?? 200,
    contentType: options.contentType ?? 'application/json',
    body,
    ...(options.lastModified ? { lastModified: options.lastModified } : {}),
  };
}

function capabilities(overrides: { omitModule?: string; omitParameter?: string } = {}) {
  const modules = [
    { path: 'parse', prefix: '', parameters: [{ name: 'oldid' }, { name: 'prop' }] },
    { path: 'query+info', prefix: 'in', parameters: [{ name: 'prop' }] },
    { path: 'query+revisions', prefix: 'rv', parameters: [{ name: 'prop' }, { name: 'limit' }] },
  ];
  return {
    paraminfo: {
      modules: modules.filter(({ path }) => path !== overrides.omitModule).map(module => ({
        ...module,
        parameters: module.parameters.filter(({ name }) => name !== overrides.omitParameter),
      })),
    },
  };
}

function pageInfo(revid = 71) {
  return {
    query: {
      pages: [{
        pageid: 42,
        ns: 0,
        title: 'WLAN',
        fullurl: page.url,
        revisions: [{ revid, timestamp: revisionTimestamp }],
      }],
    },
  };
}

function successTransport(options: { secondInfoRevision?: number } = {}) {
  const calls: { url: URL; accept: 'json' | 'html' }[] = [];
  let infoCalls = 0;
  const transport: ContentTransport = {
    get: vi.fn((url: URL, accept: 'json' | 'html') => {
      calls.push({ url: new URL(url), accept });
      const query = url.searchParams;
      if (accept === 'html') {
        return Promise.resolve(response('<!doctype html><html><head><title>WLAN</title></head><body><main><p>Web fallback text.</p></main></body></html>', {
          contentType: 'text/html; charset=utf-8',
        }));
      }
      if (query.get('action') === 'paraminfo') return Promise.resolve(jsonResponse(capabilities()));
      if (query.get('action') === 'query') {
        infoCalls += 1;
        return Promise.resolve(jsonResponse(pageInfo(infoCalls === 2 ? options.secondInfoRevision ?? 71 : 71)));
      }
      if (query.get('action') === 'parse') {
        return Promise.resolve(jsonResponse({ parse: {
          title: 'WLAN', pageid: 42, revid: Number(query.get('oldid')),
          templates: [], text: '<h1>WLAN</h1><p>Eduroam campus access information.</p>',
        } }));
      }
      return Promise.reject(new Error('Unexpected request in test transport.'));
    }),
  };
  return { transport, calls };
}

function mediaWiki(transport: ContentTransport, requireAuthenticated = false) {
  return new MediaWikiContentAdapter({
    origin,
    apiUrl,
    transport,
    requireAuthenticated,
    clock: () => new Date('2026-10-18T10:00:00.000Z'),
  });
}

function web(transport: ContentTransport) {
  return new WebContentAdapter({
    origin,
    transport,
    clock: () => new Date('2026-10-18T10:00:00.000Z'),
  });
}

describe('content adapters', () => {
  it('probes MediaWiki modules, pins parse to the observed revision, and fences the page with a second info read', async () => {
    const { transport, calls } = successTransport();
    const result = await mediaWiki(transport, true).read(page, new AbortController().signal);

    expect(result).toMatchObject({
      adapter: 'mediawiki', canonicalUrl: page.url, title: 'WLAN', sourceRevision: '71', sourceUpdatedAt: revisionTimestamp,
    });
    expect(result.text).toContain('Eduroam campus access information.');
    expect(calls.map(({ url }) => url.searchParams.get('action'))).toEqual([
      'paraminfo', 'query', 'parse', 'query',
    ]);
    expect(calls[0]?.url.searchParams.get('modules')).toBe('parse|query+info|query+revisions');
    expect(calls[0]?.url.searchParams.get('assert')).toBe('user');
    expect(calls[1]?.url.searchParams.get('prop')).toBe('info|revisions');
    expect(calls[1]?.url.searchParams.get('rvprop')).toBe('ids|timestamp');
    expect(calls[1]?.url.searchParams.get('rvlimit')).toBe('1');
    expect(calls[2]?.url.searchParams.get('oldid')).toBe('71');
    expect(calls[2]?.url.searchParams.get('prop')).toBe('text|revid|templates');
    expect(calls[3]?.url.searchParams.get('action')).toBe('query');
    expect(calls.every(({ accept }) => accept === 'json')).toBe(true);
  });

  it('rejects a page that changes between revision discovery and the final fence without trying HTML', async () => {
    const { transport, calls } = successTransport({ secondInfoRevision: 72 });
    const chain = new ContentAdapterChain([mediaWiki(transport), web(transport)]);

    await expect(chain.read(page, new AbortController().signal)).rejects.toMatchObject({ code: 'changed' });
    expect(calls.map(({ url }) => url.searchParams.get('action'))).toEqual([
      'paraminfo', 'query', 'parse', 'query',
    ]);
    expect(calls.some(({ accept }) => accept === 'html')).toBe(false);
  });

  it('falls back to the exact approved main-content page only when valid capabilities omit a required module', async () => {
    const calls: { url: URL; accept: 'json' | 'html' }[] = [];
    const transport: ContentTransport = {
      get: vi.fn((url: URL, accept: 'json' | 'html') => {
        calls.push({ url: new URL(url), accept });
        if (accept === 'html') {
          return Promise.resolve(response('<!doctype html><html lang="en"><head><title>Campus WLAN</title></head><body><main><p>Approved public fallback.</p><a href="https://wiki.example.edu/wiki/Other">Other page</a></main></body></html>', {
            contentType: 'text/html; charset=utf-8',
          }));
        }
        return Promise.resolve(jsonResponse(capabilities({ omitModule: 'query+revisions' })));
      }),
    };
    const chain = new ContentAdapterChain([mediaWiki(transport), web(transport)]);

    const result = await chain.read(page, new AbortController().signal);

    expect(result).toMatchObject({ adapter: 'web', canonicalUrl: page.url, title: 'Campus WLAN' });
    expect(result.text).toContain('Approved public fallback.');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.accept).toBe('json');
    expect(calls[0]?.url.searchParams.get('action')).toBe('paraminfo');
    expect(calls[1]?.accept).toBe('html');
    expect(calls[1]?.url.href).toBe(page.url);
    expect(calls.some(({ url }) => url.href.includes('/Other'))).toBe(false);
  });

  it.each([
    { label: 'assertuserfailed', failAt: 'paraminfo', body: { error: { code: 'assertuserfailed' } }, expectedCode: 'unauthorized', calls: 1 },
    { label: 'readapidenied', failAt: 'query', body: { error: { code: 'readapidenied' } }, expectedCode: 'unauthorized', calls: 2 },
    { label: 'rvaccessdenied', failAt: 'parse', body: { error: { code: 'rvaccessdenied' } }, expectedCode: 'unauthorized', calls: 3 },
    { label: 'HTTP 403', failAt: 'paraminfo', status: 403, expectedCode: 'unauthorized', calls: 1 },
    { label: 'HTTP 404', failAt: 'paraminfo', status: 404, expectedCode: 'not_found', calls: 1 },
    { label: 'malformed JSON', failAt: 'paraminfo', malformed: true, expectedCode: 'invalid_content', calls: 1 },
    { label: 'timed out transport', failAt: 'paraminfo', timeout: true, expectedCode: 'timeout', calls: 1 },
  ])('does not fall back to HTML after $label', async ({ failAt, body, status, malformed, timeout, expectedCode, calls: expectedCalls }) => {
    const calls: { url: URL; accept: 'json' | 'html' }[] = [];
    const transport: ContentTransport = {
      get: vi.fn((url: URL, accept: 'json' | 'html') => {
        calls.push({ url: new URL(url), accept });
        if (accept === 'html') {
          return Promise.resolve(response('<html><head><title>Fallback</title></head><body><main>Should not be fetched.</main></body></html>', {
            contentType: 'text/html',
          }));
        }
        if (timeout) return Promise.reject(new Error('synthetic network timeout'));
        if (url.searchParams.get('action') === failAt) {
          if (malformed) return Promise.resolve(response('{not json'));
          return Promise.resolve(jsonResponse(body ?? {}, status ?? 200));
        }
        if (url.searchParams.get('action') === 'paraminfo') return Promise.resolve(jsonResponse(capabilities()));
        if (url.searchParams.get('action') === 'query') return Promise.resolve(jsonResponse(pageInfo()));
        if (url.searchParams.get('action') === 'parse') return Promise.resolve(jsonResponse({ parse: {
          title: 'WLAN', pageid: 42, revid: 71, templates: [], text: '<p>Unavailable.</p>',
        } }));
        return Promise.reject(new Error('Unexpected API request.'));
      }),
    };
    const chain = new ContentAdapterChain([mediaWiki(transport, true), web(transport)]);
    const operation = chain.read(page, new AbortController().signal);

    if (expectedCode === 'timeout') await expect(operation).rejects.toThrow('synthetic network timeout');
    else await expect(operation).rejects.toMatchObject({ code: expectedCode });
    expect(calls).toHaveLength(expectedCalls);
    expect(calls.every(({ accept }) => accept === 'json')).toBe(true);
    expect(calls.some(({ accept }) => accept === 'html')).toBe(false);
  });

  it('registers independently validated adapter factories without changing retrieval or MCP tools', async () => {
    const registry = new ContentAdapterRegistry();
    const schema = z.strictObject({ type: z.literal('approved-custom'), collection: z.literal('guides') });
    registry.register('approved-custom', schema, (_config, _context) => ({ id: 'approved-custom',
      read: requested => Promise.resolve({ adapter: 'approved-custom', canonicalUrl: requested.url, title: 'Guide', text: 'Example',
        acquiredAt: revisionTimestamp, sourceRevision: '1', images: [] }) }));
    const context = { origin, transport: successTransport().transport };
    const chain = registry.create([{ type: 'approved-custom', collection: 'guides' }], context);
    await expect(chain.read(page, new AbortController().signal)).resolves.toMatchObject({ adapter: 'approved-custom' });
    expect(() => registry.create([{ type: 'approved-custom', collection: 'guides', inlineKey: 'not-accepted' }], context)).toThrow();
    expect(() => registry.create([{ type: 'unknown' }], context)).toThrow();
    expect(() => { registry.register('web', schema, () => web(context.transport)); }).toThrow();
  });

  it('runs an explicitly configured custom adapter in chain order and stops after success', async () => {
    const order: string[] = [];
    const custom: ContentAdapter = {
      id: 'approved-custom',
      read: vi.fn((requested: ContentPage) => {
        order.push('custom');
        return Promise.resolve({
          adapter: 'approved-custom', canonicalUrl: requested.url, title: 'Custom guide', text: 'Custom source text.',
          sourceRevision: 'custom-v1', acquiredAt: '2026-10-18T10:00:00.000Z', images: [],
        });
      }),
    };
    const transportGet = vi.fn((_url: URL, _accept: 'json' | 'html', _signal: AbortSignal) => Promise.reject(new Error('Unexpected web request.')));
    const transport: ContentTransport = { get: transportGet };
    const fallback = web(transport);
    const fallbackRead = vi.spyOn(fallback, 'read').mockImplementation(() => {
      order.push('web');
      return Promise.reject(new ContentAcquisitionError('unsupported'));
    });
    const chain = new ContentAdapterChain([custom, fallback]);

    const result = await chain.read(page, new AbortController().signal);

    expect(result.adapter).toBe('approved-custom');
    expect(order).toEqual(['custom']);
    expect(fallbackRead).not.toHaveBeenCalled();
    expect(transportGet).not.toHaveBeenCalled();
  });
});
