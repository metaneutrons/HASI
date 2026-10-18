import { setTimeout as pause } from 'node:timers/promises';
import { createPluginFetch, type PluginFetch } from './network-policy.js';
import type { PluginSecretCustody } from './plugin-secrets.js';

// Structural port: acquisition packages do not depend on the core application.
export interface ContentHttpResponse { status: number; contentType: string; body: string; lastModified?: string }
export interface ContentHttpClient {
  get(url: URL, accept: 'json' | 'html', signal: AbortSignal): Promise<ContentHttpResponse>;
  close(): Promise<void>;
}
export interface ContentHttpOptions {
  origin: string;
  /** Exact inventory URLs and approved API endpoint; only API may have query parameters. */
  pageUrls: readonly string[];
  apiUrls?: readonly string[];
  credential?: { custody: PluginSecretCustody; slot: string; mode: 'bearer' | 'cookie' };
  allowedPrivateCidrs?: readonly string[];
  timeoutMs?: number;
  minIntervalMs?: number;
  fetch?: typeof fetch;
}
const MAX_BYTES = 2 * 1024 * 1024;
function unavailable(): Error { return new Error('Content source transport unavailable.'); }

export function createContentHttpClient(options: ContentHttpOptions): ContentHttpClient {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new TypeError('Content transport requires a fixed HTTPS origin.');
  const pages = new Set(options.pageUrls);
  const apis = new Set(options.apiUrls ?? []);
  for (const raw of [...pages, ...apis]) {
    const url = new URL(raw);
    if (url.origin !== origin.origin || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href !== raw)
      throw new TypeError('Content transport requires an exact source inventory.');
  }
  if (pages.size === 0 || pages.size > 1000 || apis.size > 8) throw new TypeError('Invalid content inventory.');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const interval = options.minIntervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(interval) || interval < 100 || interval > 10_000)
    throw new TypeError('Invalid content transport limits.');
  if (options.fetch && process.env.NODE_ENV !== 'test') throw new TypeError('Injected content fetch is restricted to tests.');
  const owned: PluginFetch | undefined = options.fetch ? undefined : createPluginFetch({ origins: [origin.origin],
    ...(options.allowedPrivateCidrs ? { allowedPrivateCidrs: options.allowedPrivateCidrs } : {}), maxResponseBytes: MAX_BYTES,
    bodyTimeoutMs: timeoutMs, headersTimeoutMs: Math.min(5000, timeoutMs) });
  const fetcher = options.fetch ?? owned;
  if (!fetcher) throw new TypeError('Content transport missing.');
  const controllers = new Set<AbortController>();
  let queue: Promise<void> = Promise.resolve();
  let lastStart = 0;
  let closed = false;
  const client: ContentHttpClient = {
    get(inputUrl, accept, signal) {
      const url = new URL(inputUrl);
      const operation = async (): Promise<ContentHttpResponse> => {
        if (closed || signal.aborted || url.origin !== origin.origin || url.username || url.password || url.hash
          || !(pages.has(url.href) || apis.has(`${url.origin}${url.pathname}`))) throw unavailable();
        const controller = new AbortController();
        const stopped = () => closed || controller.signal.aborted;
        const callerAborted = () => signal.aborted;
        const abort = () => { controller.abort(); };
        controllers.add(controller);
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, timeoutMs);
        let response: Response | undefined;
        try {
          if (callerAborted()) controller.abort();
          const delay = interval - (Date.now() - lastStart);
          if (delay > 0) await pause(delay, undefined, { signal: controller.signal });
          if (stopped()) throw unavailable();
          const headers = new Headers({ accept: accept === 'json' ? 'application/json' : 'text/html',
            'user-agent': 'HASI-content/1.0 (approved source inventory; read-only)' });
          const request = () => {
            if (stopped()) throw unavailable();
            lastStart = Date.now();
            return fetcher(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error', cache: 'no-store' });
          };
          const binding = options.credential;
          response = binding ? await binding.custody.use(binding.slot, async value => {
            if (!value.trim() || /[\r\n\0]/u.test(value)) throw unavailable();
            headers.set(binding.mode === 'cookie' ? 'cookie' : 'authorization', binding.mode === 'cookie' ? value : `Bearer ${value}`);
            return request();
          }) : await request();
          if (response.redirected || (response.url && response.url !== url.href) || !response.body) throw unavailable();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              if (stopped()) throw unavailable();
              const chunk = await reader.read();
              if (chunk.done) break;
              const value: unknown = chunk.value;
              if (!(value instanceof Uint8Array)) throw unavailable();
              bytes += value.byteLength;
              if (bytes > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw unavailable(); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          if (stopped()) throw unavailable();
          const modified = response.headers.get('last-modified');
          return { status: response.status, contentType: response.headers.get('content-type') ?? '',
            body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), ...(modified ? { lastModified: modified } : {}) };
        } catch {
          await response?.body?.cancel().catch(() => undefined);
          throw unavailable();
        } finally {
          clearTimeout(timer); signal.removeEventListener('abort', abort); controllers.delete(controller);
        }
      };
      const result = queue.then(operation);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await queue;
      await owned?.close();
    },
  };
  return client;
}
