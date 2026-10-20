import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { startJourneyReferenceProxy } from '../scripts/plugin-journey-proxy.js';

const servers: Server[] = [];
const proxies: Awaited<ReturnType<typeof startJourneyReferenceProxy>>[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  }
});

async function startBackend(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address.');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function startProxy(targetOrigin: string, requestTimeoutMs?: number): Promise<Awaited<ReturnType<typeof startJourneyReferenceProxy>>> {
  const proxy = await startJourneyReferenceProxy({ targetOrigin, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
  proxies.push(proxy);
  return proxy;
}

function rpc(name: string, id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
}

async function postRpc(origin: string, name: string, id: number): Promise<Response> {
  return await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: rpc(name, id),
  });
}

async function rawExchangeUntilClose(origin: string, requestBytes: Buffer): Promise<string> {
  const port = Number(new URL(origin).port);
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Raw proxy socket did not close promptly.'));
    }, 1_000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
  socket.write(requestBytes);
  await closed;
  return Buffer.concat(chunks).toString('latin1');
}

describe('closed synthetic reference plugin loss proxy', () => {
  it('forwards only fixed routes and opaque protocol headers to the startup target', async () => {
    let received: {
      path?: string | undefined; host?: string | undefined; authorization?: string | string[] | undefined;
      invocation?: string | string[] | undefined; contentType?: string | string[] | undefined;
    } = {};
    let upstreamCalls = 0;
    const target = await startBackend((request, response) => {
      upstreamCalls++;
      received = {
        path: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        invocation: request.headers['x-hasi-invocation'],
        contentType: request.headers['content-type'],
      };
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'mcp-session-id': 'synthetic-session' });
      response.end('{"ok":true}');
    });
    const proxy = await startProxy(target);
    const response = await fetch(`${proxy.origin}/.well-known/hasi-plugin.json`, {
      headers: { authorization: 'Bearer opaque-test-value', 'x-hasi-invocation': 'opaque-invocation-value' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('mcp-session-id')).toBe('synthetic-session');
    expect(await response.text()).toBe('{"ok":true}');
    expect(received).toEqual({
      path: '/.well-known/hasi-plugin.json',
      host: new URL(target).host,
      authorization: 'Bearer opaque-test-value',
      invocation: 'opaque-invocation-value',
      contentType: undefined,
    });
    expect(proxy.stats()).toEqual({ armed: false, droppedReplies: 0, observedExecutions: 0 });
    expect(JSON.stringify(proxy.stats())).not.toContain('opaque');

    const query = await fetch(`${proxy.origin}/mcp?target=http://127.0.0.1:1`);
    expect(query.status).toBe(404);
    expect(await query.text()).toContain('route_not_found');
    expect((await fetch(`${proxy.origin}/hasi/actions/status`)).status).toBe(404);
    expect(upstreamCalls).toBe(1);
  });

  it('streams ordinary SSE responses without changing their content type or data', async () => {
    const streamText = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"status":"ready"}}}\n\n';
    const target = await startBackend((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      response.write(streamText.slice(0, 17));
      setTimeout(() => { response.end(streamText.slice(17)); }, 5);
    });
    const proxy = await startProxy(target);
    const response = await fetch(`${proxy.origin}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toBe(streamText);
  });

  it('returns upstream redirects without following them and hides transport error details', async () => {
    let upstreamCalls = 0;
    const target = await startBackend((_request, response) => {
      upstreamCalls++;
      response.writeHead(302, { location: 'http://127.0.0.1:9/private-path' });
      response.end('redirect');
    });
    const proxy = await startProxy(target);
    const redirect = await fetch(`${proxy.origin}/healthz`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('http://127.0.0.1:9/private-path');
    expect(upstreamCalls).toBe(1);

    const closedTarget = await startBackend((_request, response) => { response.end('unused'); });
    const backend = servers.pop();
    if (backend) await new Promise<void>(resolve => { backend.close(() => { resolve(); }); });
    const unavailableProxy = await startProxy(closedTarget);
    const unavailable = await fetch(`${unavailableProxy.origin}/healthz`);
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({ error: 'upstream_failed' });
  });

  it('drops one confirmed execution reply after it reaches the proxy and never retries the write', async () => {
    const calls: string[] = [];
    const target = await startBackend((request, response) => {
      if (request.url === '/hasi/actions/status') {
        calls.push('actions_status');
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ready"}');
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params?: { name?: string } };
        if (body.method === 'initialize') {
          calls.push('initialize');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'reference' } } }));
          return;
        }
        const name = body.params?.name ?? 'unknown';
        calls.push(name);
        response.setHeader('content-type', 'application/json');
        response.writeHead(200);
        if (name === 'execute_mark' && body.id === 2) {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'synthetic failure' } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: name === 'execute_mark' ? { confirmed: true } : { status: 'read' } } }));
      });
    });
    const proxy = await startProxy(target);

    proxy.armNextExecutionReplyDrop();
    const initialization = await fetch(`${proxy.origin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    });
    expect(initialization.status).toBe(200);
    const status = await fetch(`${proxy.origin}/hasi/actions/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"read"}',
    });
    expect(status.status).toBe(200);
    const read = await postRpc(proxy.origin, 'read_status', 1);
    expect(read.status).toBe(200);
    expect(proxy.stats()).toEqual({ armed: true, droppedReplies: 0, observedExecutions: 0 });

    const error = await postRpc(proxy.origin, 'execute_mark', 2);
    expect(error.status).toBe(200);
    expect(proxy.stats()).toMatchObject({ armed: true, droppedReplies: 0, observedExecutions: 1 });

    await expect(postRpc(proxy.origin, 'execute_mark', 3)).rejects.toThrow();
    expect(proxy.stats()).toEqual({ armed: false, droppedReplies: 1, observedExecutions: 2 });
    expect(calls).toEqual(['initialize', 'actions_status', 'read_status', 'execute_mark', 'execute_mark']);

    const next = await postRpc(proxy.origin, 'execute_mark', 4);
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ result: { structuredContent: { confirmed: true } } });
    expect(calls).toEqual(['initialize', 'actions_status', 'read_status', 'execute_mark', 'execute_mark', 'execute_mark']);
    expect(proxy.stats()).toEqual({ armed: false, droppedReplies: 1, observedExecutions: 3 });
  });

  it('recognizes a confirmed JSON-RPC result inside an SSE data frame', async () => {
    let writes = 0;
    const target = await startBackend((request, response) => {
      writes++;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { confirmed: true } } })}\n\n`);
      });
    });
    const proxy = await startProxy(target);
    proxy.armNextExecutionReplyDrop();

    await expect(postRpc(proxy.origin, 'execute_mark', 9)).rejects.toThrow();
    expect(proxy.stats()).toEqual({ armed: false, droppedReplies: 1, observedExecutions: 1 });
    expect(writes).toBe(1);
  });

  it('rejects oversized bodies before contacting upstream and returns a generic timeout error', async () => {
    let upstreamCalls = 0;
    const target = await startBackend((_request, response) => {
      upstreamCalls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const proxy = await startProxy(target);
    const oversized = await fetch(`${proxy.origin}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"payload":"${'x'.repeat(65_536)}"}`,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'request_too_large' });
    expect(upstreamCalls).toBe(0);

    await proxy.close();
    proxies.splice(proxies.indexOf(proxy), 1);
    const hangingTarget = await startBackend((_request, _response) => { /* The test timeout owns cleanup. */ });
    const shortProxy = await startProxy(hangingTarget, 50);
    const timedOut = await postRpc(shortProxy.origin, 'read_status', 10);
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({ error: 'proxy_timeout' });
  });

  it('closes incomplete oversized uploads and slow unknown routes promptly', async () => {
    let upstreamCalls = 0;
    const target = await startBackend((_request, response) => {
      upstreamCalls++;
      response.end('unexpected upstream call');
    });
    const proxy = await startProxy(target);
    const oversizedData = Buffer.from('x'.repeat(65_537));
    const oversized = Buffer.concat([
      Buffer.from('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n10001\r\n'),
      oversizedData,
      Buffer.from('\r\n'),
    ]);
    const oversizedReply = await rawExchangeUntilClose(proxy.origin, oversized);
    expect(oversizedReply).toContain('HTTP/1.1 413');
    expect(oversizedReply).toContain('{"error":"request_too_large"}');
    expect(upstreamCalls).toBe(0);

    const incompleteUnknownRoute = Buffer.from(
      'POST /not-allowed HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\npartial',
    );
    const unknownReply = await rawExchangeUntilClose(proxy.origin, incompleteUnknownRoute);
    expect(unknownReply).toContain('HTTP/1.1 404');
    expect(unknownReply).toContain('{"error":"route_not_found"}');
    expect(upstreamCalls).toBe(0);
  });

  it('validates the target origin and closes owned sockets and listeners', async () => {
    for (const target of [
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.2:3000',
      'https://127.0.0.1:3000',
      'http://user@127.0.0.1:3000',
      'http://127.0.0.1:3000/mcp',
      'http://127.0.0.1:3000?x=1',
      'http://127.0.0.1:3000#fragment',
    ]) await expect(startJourneyReferenceProxy({ targetOrigin: target })).rejects.toThrow();

    const target = await startBackend((_request, response) => { response.end('ok'); });
    const proxy = await startProxy(target);
    const port = Number(new URL(proxy.origin).port);
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    socket.on('error', () => { /* Closing an accepted raw socket may reset its empty read side. */ });
    await once(socket, 'connect');
    const socketClosed = new Promise<void>(resolve => { socket.once('close', () => { resolve(); }); });
    await Promise.all([proxy.close(), proxy.close()]);
    proxies.splice(proxies.indexOf(proxy), 1);
    await socketClosed;
    await expect(fetch(`${proxy.origin}/healthz`)).rejects.toThrow();
  });
});
