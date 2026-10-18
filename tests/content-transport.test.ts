import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentHttpClient } from '../apps/api/src/content-transport.js';
import type { PluginSecretCustody } from '../apps/api/src/plugin-secrets.js';

const origin = 'https://content.example.edu';
const page = `${origin}/wiki/Guide`;
const api = `${origin}/w/api.php`;
const clients: ReturnType<typeof createContentHttpClient>[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
function client(fetcher: typeof fetch, credential?: { custody: PluginSecretCustody; slot: string; mode: 'bearer' | 'cookie' }) {
  const value = createContentHttpClient({ origin, pageUrls: [page], apiUrls: [api], minIntervalMs: 100, fetch: fetcher,
    ...(credential ? { credential } : {}) }); clients.push(value); return value;
}
const signal = () => new AbortController().signal;

describe('operator-owned content transport', () => {
  it('uses exact inventory/API destinations and source-only custody without following redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('<main>Guide</main>', {
      headers: { 'content-type': 'text/html', 'last-modified': 'Sun, 18 Oct 2026 08:00:00 GMT' },
    })));
    const custody: PluginSecretCustody = { status: () => ({ configured: true, revision: 'test' }),
      use: (_slot, operation) => operation('fictional-cookie=value') };
    const transport = client(fetcher, { custody, slot: 'wiki', mode: 'cookie' });
    const result = await transport.get(new URL(page), 'html', signal());
    expect(result).toMatchObject({ status: 200, body: '<main>Guide</main>', lastModified: 'Sun, 18 Oct 2026 08:00:00 GMT' });
    expect(JSON.stringify(result)).not.toContain('fictional-cookie');
    const init = fetcher.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('cookie')).toBe('fictional-cookie=value');
    expect(init.redirect).toBe('error');
    for (const raw of ['https://elsewhere.example/wiki/Guide', `${page}?action=delete`, `${origin}/wiki/Unapproved`, `${page}#part`, `${origin}/login`]) {
      await expect(transport.get(new URL(raw), 'html', signal())).rejects.toThrow('Content source transport unavailable');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('permits fixed API query parameters, but rejects changed response destinations and oversized bodies', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })));
    await expect(client(fetcher).get(new URL(`${api}?action=query&format=json`), 'json', signal())).resolves.toMatchObject({ body: '{"ok":true}' });
    const changed = new Response('must not be used');
    Object.defineProperty(changed, 'url', { value: 'https://login.example.edu/' });
    const redirect = vi.fn<typeof fetch>(() => Promise.resolve(changed));
    await expect(client(redirect).get(new URL(page), 'html', signal())).rejects.toThrow();
    const large = vi.fn<typeof fetch>(() => Promise.resolve(new Response('x'.repeat(2 * 1024 * 1024 + 1))));
    await expect(client(large).get(new URL(page), 'html', signal())).rejects.toThrow();
  });
  it('fails before network on missing/bad source custody and after shutdown or caller abort', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('not reached')));
    const custody: PluginSecretCustody = { status: () => ({ configured: false, revision: null }), use: () => Promise.reject(new Error('fictional secret error')) };
    const transport = client(fetcher, { custody, slot: 'wiki', mode: 'bearer' });
    await expect(transport.get(new URL(page), 'html', signal())).rejects.toThrow('Content source transport unavailable');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(client(fetcher).get(new URL(page), 'html', controller.signal)).rejects.toThrow();
    await transport.close();
    await expect(transport.get(new URL(page), 'html', signal())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the core network guard in production composition and rejects unsafe configuration', async () => {
    expect(() => createContentHttpClient({ origin: 'http://content.example.edu', pageUrls: [page] })).toThrow();
    expect(() => createContentHttpClient({ origin, pageUrls: ['https://elsewhere.example/'] })).toThrow();
    expect(() => createContentHttpClient({ origin: 'https://127.0.0.1', pageUrls: ['https://127.0.0.1/wiki/Guide'] })).toThrow();
    const transport = createContentHttpClient({ origin, pageUrls: [page] }); clients.push(transport);
    await expect(transport.get(new URL('https://elsewhere.example/'), 'html', signal())).rejects.toThrow();
  });
});
