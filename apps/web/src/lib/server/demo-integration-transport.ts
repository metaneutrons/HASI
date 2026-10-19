import 'server-only';

import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface DemoIntegrationTransportOptions {
  publicOrigin: string;
  port: string | undefined;
}

const manifestPaths = new Set([
  '/.well-known/hasi-plugin.json',
  '/hasi/manifest',
  '/plugins/knowledge/.well-known/hasi-plugin.json',
  '/plugins/knowledge/hasi/manifest',
]);

const mcpPaths = new Set([
  '/mcp',
  '/plugins/knowledge/mcp',
]);

const actionStatusPaths = new Set([
  '/hasi/actions/status',
  '/plugins/knowledge/hasi/actions/status',
]);

function configuredPublicOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('Invalid demo integration transport configuration.');
  }

  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.origin !== value || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
    throw new Error('Invalid demo integration transport configuration.');
  }
  return origin;
}

function configuredPort(value: string | undefined): string {
  if (!value || !/^\d+$/u.test(value)) throw new Error('Invalid demo integration transport configuration.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid demo integration transport configuration.');
  }
  return String(port);
}

function approvedPath(pathname: string): boolean {
  return manifestPaths.has(pathname) || mcpPaths.has(pathname) || actionStatusPaths.has(pathname)
    || pathname.startsWith('/api/v1/');
}

/** Reaches only the demo's own HTTP integration handlers over container loopback. */
export function createDemoIntegrationTransport(options: DemoIntegrationTransportOptions): typeof fetch {
  const publicOrigin = configuredPublicOrigin(options.publicOrigin);
  const port = configuredPort(options.port);

  return async (input, init) => {
    let target: URL;
    try {
      target = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      throw new Error('Unapproved demo integration destination.');
    }
    if (target.origin !== publicOrigin.origin || target.username || target.password || target.hash || !approvedPath(target.pathname)) {
      throw new Error('Unapproved demo integration destination.');
    }

    // Let Request apply Fetch's normal init semantics. Reading its body through
    // Node streams preserves backpressure without relying on fetch's Host rules.
    const request = new Request(input, init);
    const loopbackUrl = new URL(request.url);
    loopbackUrl.protocol = 'http:';
    loopbackUrl.hostname = '127.0.0.1';
    loopbackUrl.port = port;
    loopbackUrl.username = '';
    loopbackUrl.password = '';

    const outgoingHeaders: Record<string, string> = {};
    request.headers.forEach((value, name) => { outgoingHeaders[name] = value; });
    outgoingHeaders.host = publicOrigin.host;
    outgoingHeaders['accept-encoding'] = 'identity';

    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(loopbackUrl, {
        method: request.method,
        headers: outgoingHeaders,
        signal: request.signal,
      }, incoming => {
        try {
          const status = incoming.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) {
            incoming.destroy();
            reject(new TypeError('Redirects are not allowed.'));
            return;
          }
          const encoding = incoming.headers['content-encoding'];
          if (encoding && (Array.isArray(encoding) ? encoding.join(',') : encoding).toLowerCase() !== 'identity') {
            incoming.destroy();
            reject(new TypeError('Compressed demo integration responses are unsupported.'));
            return;
          }

          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach(entry => {
              responseHeaders.append(name, entry);
            });
            else if (typeof value === 'string') responseHeaders.append(name, value);
          }
          const body = [204, 205, 304].includes(status) || request.method === 'HEAD'
            ? null
            : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          resolve(new Response(body, {
            status,
            ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
            headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          outgoing.destroy();
          reject(error instanceof Error ? error : new Error('Invalid demo integration response.'));
        }
      });
      outgoing.on('error', reject);
      if (request.body) {
        const source = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>);
        void pipeline(source, outgoing).catch((error: unknown) => {
          outgoing.destroy(error instanceof Error ? error : new Error('Demo integration request failed.'));
        });
      } else outgoing.end();
    });
  };
}
