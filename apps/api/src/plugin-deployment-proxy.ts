import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DockerPluginActiveEndpointResolver } from './docker-plugin-driver.js';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'x-hasi-invocation',
] as const;
const RESPONSE_HEADERS = ['cache-control', 'content-type', 'mcp-protocol-version', 'mcp-session-id'] as const;

export interface PluginDeploymentProxyOptions {
  /** Resolver is a configured Docker driver; it inspects route and container on every request. */
  readonly endpointResolver: DockerPluginActiveEndpointResolver;
  /** Must compare the service credential against server-owned installation data. */
  readonly authorize: (input: { readonly installationId: string; readonly authorization: string | undefined }) => boolean | Promise<boolean>;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function header(headers: IncomingHttpHeaders, name: string, maxLength: number): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\0]/u.test(value)) throw new Error('invalid header');
  return value;
}

function pluginPath(path: string, method: string): string | undefined {
  const allowed = new Map<string, readonly string[]>([
    ['/mcp', ['GET', 'POST', 'DELETE']],
    ['/.well-known/hasi-plugin.json', ['GET']],
    ['/hasi/actions/status', ['POST']],
    ['/health', ['GET']],
    ['/healthz', ['GET']],
  ]);
  return allowed.get(path)?.includes(method) ? path : undefined;
}

function jsonBody(body: unknown, maxBytes: number, method: string): Buffer | undefined {
  if (method === 'GET') return undefined;
  if (body === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new Error('invalid JSON body');
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('request body too large');
  return Buffer.from(serialized, 'utf8');
}

async function forward(input: {
  readonly port: number;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: Buffer;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): Promise<{ readonly statusCode: number; readonly headers: Record<string, string>; readonly body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const outbound = httpRequest({
      hostname: '127.0.0.1',
      port: input.port,
      method: input.method,
      path: input.path,
      headers: input.headers,
      agent: false,
    }, response => {
      const statusCode = response.statusCode ?? 502;
      if (statusCode >= 300 && statusCode < 400) {
        response.destroy();
        reject(new Error('redirect rejected'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Buffer)) {
          response.destroy(new Error('invalid response chunk'));
          return;
        }
        size += chunk.byteLength;
        if (size > input.maxResponseBytes) {
          response.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const headers: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/u.test(value)) headers[name] = value;
        }
        resolve({ statusCode, headers, body: Buffer.concat(chunks, size) });
      });
    });
    const timer = setTimeout(() => outbound.destroy(new Error('upstream timeout')), input.timeoutMs);
    outbound.once('close', () => { clearTimeout(timer); });
    outbound.once('error', reject);
    if (input.body) outbound.write(input.body);
    outbound.end();
  });
}

/**
 * Registers the internal, service-authenticated path used as plugin endpoint
 * by the registry. It resolves the active managed container afresh per request
 * and exposes only the protocol routes needed by the host.
 */
export function registerPluginDeploymentProxyRoutes(app: FastifyInstance, options: PluginDeploymentProxyOptions): void {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > MAX_REQUEST_BYTES
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new TypeError('Plugin deployment proxy limits are invalid.');
  }

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/plugin-deployments/:installationId/*',
    bodyLimit: maxRequestBytes,
    handler: async (request, reply) => {
      const params = request.params as { readonly installationId?: unknown; readonly '*': string };
      const installationId = params.installationId;
      if (typeof installationId !== 'string' || !OPAQUE_ID.test(installationId)) return reply.code(404).send({ error: 'Plugin route not found.' });
      if (request.url.includes('?')) return reply.code(400).send({ error: 'Query parameters are not accepted.' });
      if (request.headers.cookie !== undefined) return reply.code(400).send({ error: 'Cookies are not accepted.' });
      const path = pluginPath(`/${params['*']}`, request.method);
      if (!path) return reply.code(404).send({ error: 'Plugin route not found.' });

      const authorization = request.headers.authorization;
      let authorized = false;
      try {
        authorized = await options.authorize({
          installationId,
          authorization: typeof authorization === 'string' ? authorization : undefined,
        });
      } catch {
        authorized = false;
      }
      if (!authorized) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Plugin service authentication failed.' });

      let body: Buffer | undefined;
      let headers: Record<string, string>;
      try {
        body = jsonBody(request.body, maxRequestBytes, request.method);
        headers = {};
        for (const name of REQUEST_HEADERS) {
          const value = header(request.headers, name, name === 'x-hasi-invocation' ? 8192 : name === 'authorization' ? 4096 : 1024);
          if (value !== undefined) headers[name] = value;
        }
        if (body && !headers['content-type']?.toLowerCase().startsWith('application/json')) {
          return await reply.code(415).send({ error: 'Plugin requests must use JSON.' });
        }
        if (body) headers['content-length'] = String(body.byteLength);
      } catch {
        return reply.code(400).send({ error: 'Plugin request is invalid or too large.' });
      }

      let endpoint;
      try {
        endpoint = await options.endpointResolver.resolveActiveEndpoint({ installationId });
      } catch {
        return reply.code(503).header('retry-after', '1').send({ error: 'Active plugin deployment is unavailable.' });
      }
      if (!endpoint) return reply.code(503).header('retry-after', '1').send({ error: 'No plugin deployment is active.' });
      // Host-owned control header is never forwarded to the executable plugin.
      // A managed call prepared before update/rollback/restart cannot reach a new route.
      if (endpoint.deploymentRevision !== undefined && request.headers['x-hasi-deployment-revision'] !== endpoint.deploymentRevision) {
        return reply.code(409).send({ error: 'The approved plugin deployment changed.' });
      }

      try {
        if (!await options.endpointResolver.assertActiveEndpoint({ installationId, endpoint })) {
          return await reply.code(503).header('retry-after', '1').send({ error: 'Active plugin deployment changed before dispatch.' });
        }
        const result = await forward({
          port: endpoint.port,
          path,
          method: request.method,
          headers,
          ...(body ? { body } : {}),
          timeoutMs,
          maxResponseBytes,
        });
        reply.code(result.statusCode);
        for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
        reply.header('content-length', String(result.body.byteLength));
        reply.header('cache-control', 'no-store');
        return await reply.send(result.body);
      } catch {
        return await reply.code(502).send({ error: 'Plugin deployment request failed.' });
      }
    },
  });
}

export interface PluginDeploymentGateway {
  /** HTTP origin bound exclusively to 127.0.0.1. */
  readonly origin: string;
  close(): Promise<void>;
}

/** Creates and starts an operator-only proxy, separate from the public API listener. */
export async function createPluginDeploymentGateway(options: PluginDeploymentProxyOptions & { readonly port: number }): Promise<PluginDeploymentGateway> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError('Plugin deployment gateway port is invalid.');
  }
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: options.maxRequestBytes ?? MAX_REQUEST_BYTES });
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));
  registerPluginDeploymentProxyRoutes(app, options);
  try {
    const address = await app.listen({ host: '127.0.0.1', port: options.port });
    const url = new URL(address);
    if (url.hostname !== '127.0.0.1' || !url.port) throw new Error('Plugin deployment gateway bound to an unexpected address.');
    return Object.freeze({ origin: url.origin, close: async () => { await app.close(); } });
  } catch {
    await app.close().catch(() => undefined);
    throw new Error('Plugin deployment gateway could not bind to loopback.');
  }
}
