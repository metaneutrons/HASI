import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginDeploymentGateway, registerPluginDeploymentProxyRoutes } from '../apps/api/src/plugin-deployment-proxy.js';

describe('operator plugin deployment proxy', () => {
  let closeServer: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let closeGateway: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeApp?.();
    await closeServer?.();
    await closeGateway?.();
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
});
