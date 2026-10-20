import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginDeploymentGateway, registerPluginDeploymentProxyRoutes } from '../apps/api/src/plugin-deployment-proxy.js';

const SERVICE_AUTHORIZATION = 'Bearer host-service-token';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Backend test server did not bind a TCP port.');
  return address.port;
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  const closed = new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  server.closeAllConnections();
  return closed;
}

async function waitForEffect(effect: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      effect,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Timed out waiting for the upstream stream to close.')); }, 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function activeEndpointResolver(port: number) {
  return {
    resolveActiveEndpoint: () => Promise.resolve({
      deploymentId: '0123456789abcdef01234567',
      relayDeploymentId: 'd'.repeat(64),
      releaseDigest: 'a'.repeat(64),
      host: '127.0.0.1',
      port,
      containerPort: 3000,
    }),
    assertActiveEndpoint: () => Promise.resolve(true),
  };
}

function decodeChunk(chunk: unknown): string {
  if (!(chunk instanceof Uint8Array)) throw new Error('Expected a byte chunk from the stream.');
  return new TextDecoder().decode(chunk);
}

async function startTestGateway(port: number, limits: { readonly maxResponseBytes?: number; readonly requestTimeoutMs?: number } = {}) {
  return await createPluginDeploymentGateway({
    port: 0,
    endpointResolver: activeEndpointResolver(port),
    authorize: () => true,
    ...limits,
  });
}

describe('operator plugin deployment proxy', () => {
  let closeServer: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let closeGateway: (() => Promise<void>) | undefined;
  let abortActiveClient: (() => void) | undefined;

  afterEach(async () => {
    abortActiveClient?.();
    await closeServer?.();
    await closeApp?.();
    await closeGateway?.();
    abortActiveClient = undefined;
    closeApp = undefined;
    closeServer = undefined;
    closeGateway = undefined;
  });

  it('forwards only authenticated fixed protocol paths and strips cookies and redirects', async () => {
    let lastRequest: { method: string | undefined; url: string | undefined; cookie: string | undefined; authorization: string | undefined; body: string | undefined } = {
      method: undefined,
      url: undefined,
      cookie: undefined,
      authorization: undefined,
      body: undefined,
    };
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        lastRequest = {
          method: request.method,
          url: request.url,
          cookie: request.headers.cookie,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        if (request.url === '/healthz') {
          response.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere', 'set-cookie': 'session=bad' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=bad', 'mcp-session-id': 'session-1' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Backend test server did not bind a TCP port.');
    closeServer = () => new Promise<void>(resolve => {
      server.close(() => { resolve(); });
    });

    const app = Fastify({ logger: false });
    closeApp = () => app.close();
    registerPluginDeploymentProxyRoutes(app, {
      endpointResolver: {
        resolveActiveEndpoint: () => Promise.resolve({
          deploymentId: '0123456789abcdef01234567',
          relayDeploymentId: 'd'.repeat(64),
          releaseDigest: 'a'.repeat(64),
          host: '127.0.0.1',
          port: address.port,
          containerPort: 3000,
        }),
        assertActiveEndpoint: () => Promise.resolve(true),
      },
      authorize: ({ authorization }) => authorization === 'Bearer host-service-token',
    });

    const forwarded = await app.inject({
      method: 'GET',
      url: '/api/plugin-deployments/installation-1/.well-known/hasi-plugin.json',
      headers: { authorization: 'Bearer host-service-token' },
    });
    expect(forwarded.statusCode).toBe(200);
    expect(forwarded.json()).toEqual({ ok: true });
    expect(forwarded.headers['set-cookie']).toBeUndefined();
    expect(forwarded.headers['mcp-session-id']).toBe('session-1');
    expect(lastRequest).toMatchObject({ method: 'GET', url: '/.well-known/hasi-plugin.json', cookie: undefined, authorization: 'Bearer host-service-token' });

    const denied = await app.inject({ method: 'GET', url: '/api/plugin-deployments/installation-1/healthz' });
    expect(denied.statusCode).toBe(401);
    const query = await app.inject({ method: 'GET', url: '/api/plugin-deployments/installation-1/mcp?target=http://127.0.0.1:9', headers: { authorization: 'Bearer host-service-token' } });
    expect(query.statusCode).toBe(400);
    const cookie = await app.inject({ method: 'GET', url: '/api/plugin-deployments/installation-1/mcp', headers: { authorization: 'Bearer host-service-token', cookie: 'browser=session' } });
    expect(cookie.statusCode).toBe(400);
    const arbitrary = await app.inject({ method: 'GET', url: '/api/plugin-deployments/installation-1/admin', headers: { authorization: 'Bearer host-service-token' } });
    expect(arbitrary.statusCode).toBe(404);
    const redirect = await app.inject({ method: 'GET', url: '/api/plugin-deployments/installation-1/healthz', headers: { authorization: 'Bearer host-service-token' } });
    expect(redirect.statusCode).toBe(502);
    expect(redirect.headers.location).toBeUndefined();
  });

  it('starts the gateway on loopback in a separate minimal listener', async () => {
    const gateway = await createPluginDeploymentGateway({
      port: 0,
      endpointResolver: {
        resolveActiveEndpoint: () => Promise.resolve(null),
        assertActiveEndpoint: () => Promise.resolve(false),
      },
      authorize: () => false,
    });
    closeGateway = () => gateway.close();
    expect(new URL(gateway.origin).hostname).toBe('127.0.0.1');
    const health = await fetch(`${gateway.origin}/healthz`, { signal: AbortSignal.timeout(1_000) });
    expect(health.status).toBe(200);
    await health.body?.cancel();
    const denied = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, { signal: AbortSignal.timeout(1_000) });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
  });

  it('requires the exact private lifecycle fence and strips it before plugin I/O', async () => {
    let calls = 0; let receivedFence: unknown = 'not-called';
    const server = createServer((request, response) => {
      calls++; receivedFence = request.headers['x-hasi-deployment-revision'];
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    closeServer = () => new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
    let revision = 'a'.repeat(64);
    const app = Fastify({ logger: false }); closeApp = () => app.close();
    registerPluginDeploymentProxyRoutes(app, { authorize: () => true, endpointResolver: {
      resolveActiveEndpoint: () => Promise.resolve({ deploymentId: 'b'.repeat(64), relayDeploymentId: 'c'.repeat(64), releaseDigest: 'd'.repeat(64), host: '127.0.0.1', port: address.port, containerPort: 3000, deploymentRevision: revision }),
      assertActiveEndpoint: () => Promise.resolve(true),
    } });
    const url = '/api/plugin-deployments/installation/health';
    expect((await app.inject({ url })).statusCode).toBe(409);
    expect((await app.inject({ url, headers: { 'x-hasi-deployment-revision': 'e'.repeat(64) } })).statusCode).toBe(409);
    expect(calls).toBe(0);
    expect((await app.inject({ url, headers: { 'x-hasi-deployment-revision': revision } })).statusCode).toBe(200);
    expect(calls).toBe(1); expect(receivedFence).toBeUndefined();
    revision = 'f'.repeat(64);
    expect((await app.inject({ url, headers: { 'x-hasi-deployment-revision': 'a'.repeat(64) } })).statusCode).toBe(409);
    expect(calls).toBe(1);
  });

  it('streams SSE frames while the upstream stays open and serves a concurrent MCP POST', async () => {
    let postFinished = false;
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    const server = createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'mcp-session-id': 'mcp-session-1' });
        response.write('event: message\ndata: first-frame\n\n');
        response.once('close', () => { resolveStreamClosed?.(); });
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        postFinished = true;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: Buffer.concat(chunks).toString('utf8') === '{"jsonrpc":"2.0"}' }));
      });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort);
    closeGateway = () => gateway.close();

    const controller = new AbortController();
    abortActiveClient = () => { controller.abort(); };
    const streamResponse = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(streamResponse.headers.get('mcp-session-id')).toBe('mcp-session-1');
    expect(streamResponse.headers.get('cache-control')).toBe('no-store');
    const reader = streamResponse.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body.');
    const firstFrame = await reader.read();
    expect(decodeChunk(firstFrame.value)).toContain('data: first-frame');
    expect(postFinished).toBe(false);

    const postResponse = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      method: 'POST',
      headers: { authorization: SERVICE_AUTHORIZATION, 'content-type': 'application/json', 'mcp-session-id': 'mcp-session-1' },
      body: '{"jsonrpc":"2.0"}',
      signal: AbortSignal.timeout(3_000),
    });
    expect(postResponse.status).toBe(200);
    expect(await postResponse.json()).toEqual({ accepted: true });
    expect(postFinished).toBe(true);

    await reader.cancel();
    await waitForEffect(streamClosed);
  });

  it('resumes a real backpressured downstream after drain and preserves all bytes', async () => {
    const payload = Buffer.from(`data: ${'x'.repeat(512 * 1024)}\n\n`);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(payload);
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    let drains = 0;
    const app = Fastify({ logger: false, serverFactory: handler => createServer({ highWaterMark: 1024 }, handler) });
    closeApp = () => app.close();
    app.addHook('onRequest', (_request, reply, done) => {
      reply.raw.on('drain', () => { drains++; });
      done();
    });
    registerPluginDeploymentProxyRoutes(app, { authorize: () => true,
      endpointResolver: activeEndpointResolver(upstreamPort), requestTimeoutMs: 3000 });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/plugin-deployments/installation-1/mcp`, { signal: AbortSignal.timeout(4000) });
    const received = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(received.equals(payload)).toBe(true);
    expect(drains).toBeGreaterThan(0);
  });

  it('terminates the downstream when an upstream SSE response aborts after headers', async () => {
    let upstream: ServerResponse | undefined;
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    const server = createServer((_request, response) => {
      upstream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      response.once('close', () => { resolveStreamClosed?.(); });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort);
    closeGateway = () => gateway.close();
    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body?.getReader();
    if (!reader || !upstream) throw new Error('Missing live SSE fixture');
    expect(decodeChunk((await reader.read()).value)).toContain('data: ready');
    upstream.destroy();
    let aborted = false;
    try { while (!(await reader.read()).done) { /* a partial SSE response must not become success */ } }
    catch { aborted = true; }
    expect(aborted).toBe(true);
    await waitForEffect(streamClosed);
  });

  it('cuts off oversized SSE responses and closes the upstream stream', async () => {
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: this-event-exceeds-the-limit\n\n');
      response.once('close', () => { resolveStreamClosed?.(); });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort, { maxResponseBytes: 8 });
    closeGateway = () => gateway.close();

    const controller = new AbortController();
    abortActiveClient = () => { controller.abort(); };
    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body.');
    let streamWasCutOff = false;
    try {
      while (!(await reader.read()).done) { /* consume until the gateway enforces its byte limit */ }
    } catch {
      streamWasCutOff = true;
    }
    expect(streamWasCutOff).toBe(true);
    await waitForEffect(streamClosed);
  });

  it('closes an open SSE stream at the total request deadline', async () => {
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    let writes = 0;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      const heartbeat = setInterval(() => { writes++; response.write('data: heartbeat\n\n'); }, 10);
      response.once('close', () => { clearInterval(heartbeat); resolveStreamClosed?.(); });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort, { requestTimeoutMs: 100 });
    closeGateway = () => gateway.close();

    const controller = new AbortController();
    abortActiveClient = () => { controller.abort(); };
    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body.');
    expect(decodeChunk((await reader.read()).value)).toContain('data: ready');
    let timedOut = false;
    try {
      while (!(await reader.read()).done) { /* traffic must not extend the total deadline */ }
    } catch {
      timedOut = true;
    }
    expect(timedOut).toBe(true);
    await waitForEffect(streamClosed);
    expect(writes).toBeGreaterThan(0);
  });

  it('propagates downstream SSE cancellation to the upstream request', async () => {
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      response.once('close', () => { resolveStreamClosed?.(); });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort);
    closeGateway = () => gateway.close();

    const controller = new AbortController();
    abortActiveClient = () => { controller.abort(); };
    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body.');
    expect(decodeChunk((await reader.read()).value)).toContain('data: ready');
    await reader.cancel();
    await waitForEffect(streamClosed);
  });

  it('aborts gateway-owned upstream streams during gateway shutdown', async () => {
    let resolveStreamClosed: (() => void) | undefined;
    const streamClosed = new Promise<void>(resolve => { resolveStreamClosed = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      response.once('close', () => { resolveStreamClosed?.(); });
    });
    const upstreamPort = await listen(server);
    closeServer = () => closeHttpServer(server);
    const gateway = await startTestGateway(upstreamPort);
    closeGateway = () => gateway.close();
    const controller = new AbortController();
    abortActiveClient = () => { controller.abort(); };

    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/mcp`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected an SSE response body.');
    expect(decodeChunk((await reader.read()).value)).toContain('data: ready');

    const closing = gateway.close();
    await waitForEffect(streamClosed);
    await closing;
    closeGateway = undefined;
  });

  it('returns 502 and closes cleanly when the upstream request cannot be constructed', async () => {
    const gateway = await startTestGateway(-1, { requestTimeoutMs: 100 });
    closeGateway = () => gateway.close();
    const response = await fetch(`${gateway.origin}/api/plugin-deployments/installation-1/health`, {
      headers: { authorization: SERVICE_AUTHORIZATION },
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Plugin deployment request failed.' });
    await gateway.close();
    closeGateway = undefined;
  });
});
