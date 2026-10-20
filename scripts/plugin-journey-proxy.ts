import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_INSPECTED_RESPONSE_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_OPERATIONS = 32;
const DEFAULT_TIMEOUT_MS = 45_000;
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'x-hasi-invocation',
] as const;
const ROUTES = new Map<string, ReadonlySet<string>>([
  ['/mcp', new Set(['GET', 'POST'])],
  ['/.well-known/hasi-plugin.json', new Set(['GET'])],
  ['/health', new Set(['GET'])],
  ['/healthz', new Set(['GET'])],
  ['/hasi/actions/status', new Set(['POST'])],
]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface JourneyReferenceProxyOptions {
  /** A fixed, explicit loopback HTTP origin. Incoming requests cannot change it. */
  readonly targetOrigin: string;
  /** A shorter timeout is useful for focused tests; production default is 45 seconds. */
  readonly requestTimeoutMs?: number;
}

export interface JourneyReferenceProxy {
  readonly origin: string;
  armNextExecutionReplyDrop(): void;
  stats(): { readonly armed: boolean; readonly droppedReplies: number; readonly observedExecutions: number };
  close(): Promise<void>;
}

interface FixedTarget {
  readonly port: number;
  readonly hostHeader: string;
}

interface ExecutionRequest {
  readonly id: string | number;
}

interface BoundedBody {
  readonly body: Buffer;
  readonly tooLarge: boolean;
}

interface OperationState {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  upstreamRequest?: ReturnType<typeof httpRequest>;
  finished: boolean;
  timedOut: boolean;
}

function fixedTarget(targetOrigin: string): FixedTarget {
  if (typeof targetOrigin !== 'string') throw new TypeError('Journey proxy target must be an explicit loopback HTTP origin.');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(targetOrigin);
  if (!match) throw new TypeError('Journey proxy target must be an explicit loopback HTTP origin.');
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Journey proxy target port is invalid.');
  }
  let parsed: URL;
  try {
    parsed = new URL(targetOrigin);
  } catch {
    throw new TypeError('Journey proxy target must be an explicit loopback HTTP origin.');
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('Journey proxy target must be an explicit loopback HTTP origin.');
  }
  return { port, hostHeader: `127.0.0.1:${String(port)}` };
}

function executionRequest(body: Buffer): ExecutionRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || parsed.method !== 'tools/call' || !isRecord(parsed.params)
    || parsed.params.name !== 'execute_mark' || (typeof parsed.id !== 'string' && typeof parsed.id !== 'number')
    || (typeof parsed.id === 'number' && !Number.isFinite(parsed.id))) return undefined;
  return { id: parsed.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchingConfirmation(value: unknown, requestId: string | number): boolean {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== requestId || !isRecord(value.result)
    || Object.hasOwn(value, 'error') || value.result.isError === true || !isRecord(value.result.structuredContent)) return false;
  return value.result.structuredContent.confirmed === true;
}

function isJsonResponse(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

function isEventStream(contentType: string | string[] | undefined): boolean {
  return typeof contentType === 'string' && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

function sseConfirms(body: Buffer, requestId: string | number): boolean {
  const text = body.toString('utf8').replace(/^\uFEFF/u, '');
  for (const frame of text.split(/\r\n\r\n|\r\r|\n\n/u)) {
    const data = frame.split(/\r\n|\r|\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /u, ''))
      .join('\n');
    if (!data) continue;
    try {
      if (matchingConfirmation(JSON.parse(data) as unknown, requestId)) return true;
    } catch {
      // Invalid SSE data is passed through unchanged and cannot confirm an execution.
    }
  }
  return false;
}

function responseConfirmsExecution(body: Buffer, contentType: string | string[] | undefined, requestId: string | number): boolean {
  if (isEventStream(contentType)) return sseConfirms(body, requestId);
  if (!isJsonResponse(contentType)) return false;
  try {
    return matchingConfirmation(JSON.parse(body.toString('utf8')) as unknown, requestId);
  } catch {
    return false;
  }
}

function sendError(response: ServerResponse, status: number, code: string, request?: IncomingMessage): void {
  const closeIncompleteRequest = () => {
    if (request && !request.complete) request.socket.destroy();
  };
  if (response.destroyed || response.headersSent) {
    response.destroy();
    closeIncompleteRequest();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: code }), 'utf8');
  if (request && !request.complete) response.once('finish', closeIncompleteRequest);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), connection: 'close' });
  response.end(body);
}

function readBoundedBody(request: IncomingMessage): Promise<BoundedBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        request.pause();
        request.off('data', onData);
        resolve({ body: Buffer.alloc(0), tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve({ body: Buffer.concat(chunks, size), tooLarge: false });
    });
    request.once('aborted', () => {
      if (!settled) { settled = true; reject(new Error('request_aborted')); }
    });
    request.once('error', () => {
      if (!settled) { settled = true; reject(new Error('request_read_failed')); }
    });
  });
}

function requestHeaders(headers: IncomingHttpHeaders, hostHeader: string): Record<string, string> | undefined {
  const result: Record<string, string> = { host: hostHeader, 'accept-encoding': 'identity' };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/u.test(value)) return undefined;
    result[name] = value;
  }
  return result;
}

function responseHeaders(headers: IncomingMessage['headers']): Record<string, number | string | string[]> {
  const connectionHeader = headers.connection;
  const connectionTokens = typeof connectionHeader === 'string'
    ? connectionHeader.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    : [];
  const excluded = new Set([...HOP_BY_HOP_RESPONSE_HEADERS, ...connectionTokens]);
  const result: Record<string, number | string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!value || excluded.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function writeUpstreamHeaders(response: ServerResponse, upstream: IncomingMessage): void {
  const status = upstream.statusCode ?? 502;
  const headers = responseHeaders(upstream.headers);
  if (upstream.statusMessage) response.writeHead(status, upstream.statusMessage, headers);
  else response.writeHead(status, headers);
}

/**
 * Starts a closed local proxy for the reference plugin's synthetic journey.
 * It permits only the reference plugin protocol routes and always connects to
 * the loopback origin selected at startup.
 */
export async function startJourneyReferenceProxy(options: JourneyReferenceProxyOptions): Promise<JourneyReferenceProxy> {
  const target = fixedTarget(options.targetOrigin);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new TypeError('Journey proxy timeout must be between 10 and 45000 milliseconds.');
  }

  const server: Server = createServer();
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ReturnType<typeof httpRequest>>();
  let armed = false;
  let droppedReplies = 0;
  let observedExecutions = 0;
  let activeOperations = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  server.maxConnections = MAX_CONNECTIONS;
  server.on('error', () => { /* No request, credential, or upstream data is logged. */ });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  server.on('connection', socket => {
    if (closing || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('request', (request, response) => {
    if (closing) {
      sendError(response, 503, 'proxy_closing', request);
      return;
    }
    if (activeOperations >= MAX_OPERATIONS) {
      sendError(response, 503, 'proxy_busy', request);
      return;
    }
    const path = request.url;
    if (!path || !ROUTES.get(path)?.has(request.method ?? '')) {
      sendError(response, 404, 'route_not_found', request);
      return;
    }

    activeOperations++;
    const state: OperationState = { request, response, timer: setTimeout(() => undefined, timeoutMs), finished: false, timedOut: false };
    clearTimeout(state.timer);
    const finish = () => {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(state.timer);
      if (state.upstreamRequest) upstreamRequests.delete(state.upstreamRequest);
      activeOperations--;
    };
    state.response.once('finish', finish);
    state.response.once('close', finish);
    state.timer = setTimeout(() => {
      state.timedOut = true;
      state.upstreamRequest?.destroy();
      sendError(response, 504, 'proxy_timeout', request);
    }, timeoutMs);
    state.timer.unref();

    void (async () => {
      const bodyResult = await readBoundedBody(request);
      if (state.timedOut || response.destroyed) return;
      if (bodyResult.tooLarge) {
        sendError(response, 413, 'request_too_large', request);
        return;
      }
      if (request.method === 'GET' && bodyResult.body.byteLength !== 0) {
        sendError(response, 400, 'request_body_not_allowed');
        return;
      }

      const outboundHeaders = requestHeaders(request.headers, target.hostHeader);
      if (!outboundHeaders) {
        sendError(response, 400, 'invalid_request_headers');
        return;
      }
      if (request.method === 'POST') outboundHeaders['content-length'] = String(bodyResult.body.byteLength);
      const execution = request.method === 'POST' && path === '/mcp' ? executionRequest(bodyResult.body) : undefined;
      if (execution) observedExecutions++;

      const outbound = httpRequest({
        hostname: '127.0.0.1',
        port: target.port,
        method: request.method,
        path,
        headers: outboundHeaders,
        agent: false,
        maxHeaderSize: 16 * 1024,
      }, upstream => {
        if (state.timedOut || closing) {
          upstream.destroy();
          return;
        }
        if (!execution || !armed || upstream.statusCode !== 200
          || (!isJsonResponse(upstream.headers['content-type']) && !isEventStream(upstream.headers['content-type']))) {
          writeUpstreamHeaders(response, upstream);
          upstream.pipe(response);
          upstream.once('error', () => response.destroy());
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let inspecting = true;
        const inspectChunk = (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.byteLength;
          if (size > MAX_INSPECTED_RESPONSE_BYTES) {
            inspecting = false;
            upstream.off('data', inspectChunk);
            writeUpstreamHeaders(response, upstream);
            for (const buffered of chunks) response.write(buffered);
            chunks.length = 0;
            response.write(chunk);
            upstream.pipe(response);
            return;
          }
          chunks.push(chunk);
        };
        upstream.on('data', inspectChunk);
        upstream.once('end', () => {
          if (!inspecting) return;
          const buffered = Buffer.concat(chunks, size);
          if (armed && responseConfirmsExecution(buffered, upstream.headers['content-type'], execution.id)) {
            armed = false;
            droppedReplies++;
            response.destroy();
            return;
          }
          writeUpstreamHeaders(response, upstream);
          response.end(buffered);
        });
        upstream.once('error', () => {
          if (!response.headersSent) sendError(response, 502, 'upstream_failed');
          else response.destroy();
        });
      });
      state.upstreamRequest = outbound;
      upstreamRequests.add(outbound);
      outbound.once('error', () => {
        if (!state.timedOut && !closing) sendError(response, 502, 'upstream_failed');
      });
      response.once('close', () => {
        if (!response.writableFinished) outbound.destroy();
      });
      if (request.method === 'POST' && bodyResult.body.byteLength > 0) outbound.write(bodyResult.body);
      outbound.end();
    })().catch(() => {
      if (!state.timedOut && !closing) sendError(response, 400, 'request_failed');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    throw new Error('Journey proxy could not bind a loopback port.');
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    armNextExecutionReplyDrop() { if (!closing) armed = true; },
    stats() { return { armed, droppedReplies, observedExecutions }; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      armed = false;
      for (const outbound of upstreamRequests) outbound.destroy();
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
