import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createDemoIntegrationTransport } from '../src/lib/server/demo-integration-transport';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error: Error | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

async function startLoopbackServer() {
  const received: { host: string | undefined; method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      received.push({
        host: request.headers.host,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.url?.includes('redirect=1')) {
        response.writeHead(302, { location: '/mcp' }).end();
        return;
      }
      if (request.url?.includes('compressed=1')) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync('{}'));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received.at(-1)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not bind a TCP port.');
  return { port: String(address.port), received };
}

describe('demo integration loopback transport', () => {
  it('uses the configured public Host and preserves a read request, query and headers', async () => {
    const loopback = await startLoopbackServer();
    const fetcher = createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: loopback.port });

    const response = await fetcher('https://demo.example.test/.well-known/hasi-plugin.json?workspace=abc', {
      headers: {
        authorization: 'Bearer service-jwt',
        cookie: 'hasi-session=session-value',
        'x-hasi-demo-workspace': 'workspace-id',
      },
    });

    expect(response.url).toBe('');
    const received = await response.json() as (typeof loopback.received)[number];
    expect(received.host).toBe('demo.example.test');
    expect(received.method).toBe('GET');
    expect(received.url).toBe('/.well-known/hasi-plugin.json?workspace=abc');
    expect(received.headers.authorization).toBe('Bearer service-jwt');
    expect(received.headers.cookie).toBe('hasi-session=session-value');
    expect(received.headers['x-hasi-demo-workspace']).toBe('workspace-id');
    expect(received.headers['accept-encoding']).toBe('identity');
  });

  it('preserves a streamed MCP body and Request signal through Node HTTP', async () => {
    const loopback = await startLoopbackServer();
    const fetcher = createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: loopback.port });
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1}'));
        stream.close();
      },
    });
    const request = new Request('https://demo.example.test/mcp?session=streamed', {
      method: 'POST',
      headers: { authorization: 'Bearer service-jwt', 'content-type': 'application/json', 'x-hasi-invocation': 'signed-token', 'x-hasi-demo-workspace': 'workspace-id' },
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' });

    const response = await fetcher(request, { headers: {
      authorization: 'Bearer service-jwt',
      'content-type': 'application/json',
      'x-hasi-invocation': 'signed-token',
      'x-hasi-demo-workspace': 'workspace-id',
    } });
    expect(response.status).toBe(200);
    const received = await response.json() as (typeof loopback.received)[number];
    expect(received.host).toBe('demo.example.test');
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/mcp?session=streamed');
    expect(received.body).toBe('{"jsonrpc":"2.0","id":1}');
    expect(received.headers.authorization).toBe('Bearer service-jwt');
    expect(received.headers['x-hasi-invocation']).toBe('signed-token');
    expect(received.headers['x-hasi-demo-workspace']).toBe('workspace-id');

    const aborted = new AbortController();
    aborted.abort();
    const abortedRequest = new Request('https://demo.example.test/mcp', {
      method: 'POST', body: 'cancel me', duplex: 'half', signal: aborted.signal,
    } as RequestInit & { duplex: 'half' });
    await expect(fetcher(abortedRequest)).rejects.toThrow();
    expect(loopback.received).toHaveLength(1);
  });

  it('uses standard Request init header replacement semantics', async () => {
    const loopback = await startLoopbackServer();
    const fetcher = createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: loopback.port });
    const request = new Request('https://demo.example.test/mcp', {
      method: 'POST', headers: { authorization: 'Bearer original', cookie: 'original-cookie' }, body: '{}',
    });

    const response = await fetcher(request, { headers: { 'x-request-override': 'replacement' } });
    const received = await response.json() as (typeof loopback.received)[number];
    expect(received.headers.authorization).toBeUndefined();
    expect(received.headers.cookie).toBeUndefined();
    expect(received.headers['x-request-override']).toBe('replacement');
  });

  it('rejects foreign origins, credentials, fragments and unapproved paths before fetch', async () => {
    const loopback = await startLoopbackServer();
    const fetcher = createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: loopback.port });

    await expect(fetcher('https://other.example.test/mcp')).rejects.toThrow('Unapproved demo integration destination.');
    await expect(fetcher('https://user:password@demo.example.test/mcp')).rejects.toThrow('Unapproved demo integration destination.');
    await expect(fetcher('https://demo.example.test/mcp#fragment')).rejects.toThrow('Unapproved demo integration destination.');
    await expect(fetcher('https://demo.example.test/api/chat')).rejects.toThrow('Unapproved demo integration destination.');
    await expect(fetcher('https://demo.example.test/mcp/extra')).rejects.toThrow('Unapproved demo integration destination.');
    await expect(fetcher('not-a-url')).rejects.toThrow('Unapproved demo integration destination.');
    expect(loopback.received).toHaveLength(0);
  });

  it('keeps redirects disabled, rejects compressed responses and forwards abort signals', async () => {
    const loopback = await startLoopbackServer();
    const fetcher = createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: loopback.port });
    await expect(fetcher('https://demo.example.test/mcp?redirect=1')).rejects.toThrow();
    expect(loopback.received).toHaveLength(1);

    await expect(fetcher('https://demo.example.test/mcp?compressed=1')).rejects.toThrow('Compressed demo integration responses are unsupported.');
    expect(loopback.received).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    await expect(fetcher('https://demo.example.test/mcp', { signal: controller.signal })).rejects.toThrow();
    expect(loopback.received).toHaveLength(2);
  });

  it('fails closed when the configured origin or listen port is invalid', () => {
    expect(() => createDemoIntegrationTransport({ publicOrigin: 'http://demo.example.test', port: '3000' })).toThrow('Invalid demo integration transport configuration.');
    expect(() => createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test/path', port: '3000' })).toThrow('Invalid demo integration transport configuration.');
    expect(() => createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: '3000junk' })).toThrow('Invalid demo integration transport configuration.');
    expect(() => createDemoIntegrationTransport({ publicOrigin: 'https://demo.example.test', port: '80' })).toThrow('Invalid demo integration transport configuration.');
  });
});
