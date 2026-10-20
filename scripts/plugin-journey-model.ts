import { createHash } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { Duplex } from 'node:stream';

const MODEL_ID = 'hasi-synthetic-fixture';
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_MESSAGES = 128;
const MAX_TOOLS = 128;
const TOOL_NAMES = ['read_status', 'prepare_mark'] as const;
type ToolName = typeof TOOL_NAMES[number];
const TOOL_HASHES = new Map(TOOL_NAMES.map(name => [
  name,
  `hasi_${createHash('sha256').update('hasi.reference\0').update(name).digest('hex').slice(0, 24)}`,
]));
const STATIC_TOOL_RESULT = 'Der Referenzdienst wurde über das freigegebene Werkzeug abgefragt.';
const STATIC_READ_STATUS_RESULT = 'Die Referenzstatusdaten liegen im Modellkontext vor.';
const STATIC_READ_STATUS_OMITTED = 'Die Referenzstatusdetails fehlen oder wurden ausgelassen.';
const STATIC_CONNECT_ACCOUNT = 'Bitte verbinde zuerst dein Referenzkonto unter „Verbundene Dienste“.';
const USAGE = { prompt_tokens: 4_096, completion_tokens: 64, total_tokens: 4_160 };

interface JourneyModelOptions {
  readonly key: Buffer;
  readonly cert: Buffer;
  readonly token: string;
}

type JsonRecord = Record<string, unknown>;

interface ResultObservations {
  referenceReadResults: number;
  omittedResults: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolHash(name: ToolName): string {
  const hash = TOOL_HASHES.get(name);
  if (!hash) throw new Error('The synthetic tool hash is unavailable.');
  return hash;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function reject(response: ServerResponse, status: number): void {
  const messages: Readonly<Record<number, string>> = {
    400: 'The request is invalid.',
    401: 'The request is not authorized.',
    404: 'The requested endpoint does not exist.',
    405: 'The request method is not supported.',
    413: 'The request body is too large.',
    415: 'The request content type is not supported.',
  };
  writeJson(response, status, {
    error: { message: messages[status] ?? 'The request was rejected.', type: 'invalid_request_error' },
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    if (oversized) continue;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(bytes);
  }
  return oversized ? undefined : Buffer.concat(chunks, size);
}

function lastUserIndex(messages: readonly unknown[]): number {
  let index = -1;
  for (let position = 0; position < messages.length; position += 1) {
    const message = messages[position];
    if (isRecord(message) && message.role === 'user') index = position;
  }
  return index;
}

function toolHashDeclared(tools: readonly unknown[], hash: string): boolean {
  return tools.some(tool => isRecord(tool)
    && tool.type === 'function'
    && isRecord(tool.function)
    && tool.function.name === hash);
}

function responseCompletion(requestCount: number, content: string | null, toolName?: ToolName) {
  const message = toolName
    ? {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `call_${requestCount.toString(36)}`,
        type: 'function',
        function: { name: toolHash(toolName), arguments: '{}' },
      }],
    }
    : { role: 'assistant', content };

  return {
    id: `chatcmpl-hasi-${requestCount.toString(36)}`,
    object: 'chat.completion',
    created: 1_797_136_800,
    model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: toolName ? 'tool_calls' : 'stop' }],
    usage: USAGE,
  };
}

function latestUserMentionsMark(messages: readonly unknown[], userIndex: number): boolean {
  const message = messages[userIndex];
  if (!isRecord(message) || typeof message.content !== 'string') return false;
  return /\bmark\b|\bmarkier\p{L}*/iu.test(message.content);
}

function toolResponsesAfterUser(messages: readonly unknown[], userIndex: number): JsonRecord[] {
  const results: JsonRecord[] = [];
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === 'tool') results.push(message);
  }
  return results;
}

function readStatusCallIdsAfterUser(messages: readonly unknown[], userIndex: number): Set<string> {
  const expectedName = toolHash('read_status');
  const callIds = new Set<string>();
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls.slice(0, MAX_TOOLS)) {
      if (!isRecord(call) || typeof call.id !== 'string' || call.id.length === 0 || call.id.length > 128) continue;
      const functionValue = isRecord(call.function) ? call.function : undefined;
      const name = typeof functionValue?.name === 'string' ? functionValue.name : call.name;
      if (name === expectedName) callIds.add(call.id);
    }
  }
  return callIds;
}

function hasReferenceReadData(content: unknown): boolean {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TOOL_RESULT_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).length !== 3
    || parsed.historyDetailsOmitted !== false
    || parsed.requiresFreshRead !== true
    || !isRecord(parsed.untrustedPluginToolResult)) return false;

  const result = parsed.untrustedPluginToolResult;
  if (Object.keys(result).length !== 4
    || typeof result.label !== 'string'
    || result.label.trim().length === 0
    || result.label.length > 80
    || typeof result.account !== 'string'
    || !['synthetic-admin', 'synthetic-student'].includes(result.account)
    || typeof result.version !== 'string'
    || !['1.0.0', '1.0.1'].includes(result.version)
    || typeof result.actionCount !== 'number'
    || !Number.isSafeInteger(result.actionCount)
    || result.actionCount < 0) return false;

  return true;
}

function mediaType(request: IncomingMessage): string | undefined {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string') return undefined;
  return contentType.split(';', 1)[0]?.trim().toLowerCase();
}

function validMessages(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return false;
  return value.every(message => isRecord(message)
    && typeof message.role === 'string'
    && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role));
}

function validTools(value: unknown): value is unknown[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= MAX_TOOLS);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  nextRequestId: () => number,
  observations: ResultObservations,
): Promise<void> {
  if (request.url !== '/v1/chat/completions') {
    reject(response, 404);
    request.resume();
    return;
  }
  if (request.method !== 'POST') {
    reject(response, 405);
    request.resume();
    return;
  }
  if (mediaType(request) !== 'application/json') {
    reject(response, 415);
    request.resume();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    reject(response, 401);
    request.resume();
    return;
  }

  const contentLength = request.headers['content-length'];
  if (typeof contentLength === 'string' && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    reject(response, 413);
    request.resume();
    return;
  }

  const raw = await readBody(request);
  if (!raw) {
    reject(response, 413);
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    reject(response, 400);
    return;
  }
  if (!isRecord(body)
    || body.model !== MODEL_ID
    || !validMessages(body.messages)
    || !validTools(body.tools)) {
    reject(response, 400);
    return;
  }

  const userIndex = lastUserIndex(body.messages);
  if (userIndex < 0) {
    reject(response, 400);
    return;
  }

  const requestId = nextRequestId();
  const toolResults = toolResponsesAfterUser(body.messages, userIndex);
  if (toolResults.length > 0) {
    let hasReferenceReadResult = false;
    let hasOmittedReferenceReadResult = false;
    const readStatusCallIds = readStatusCallIdsAfterUser(body.messages, userIndex);
    for (const toolResult of toolResults) {
      if (typeof toolResult.tool_call_id !== 'string' || !readStatusCallIds.has(toolResult.tool_call_id)) continue;
      if (hasReferenceReadData(toolResult.content)) {
        observations.referenceReadResults += 1;
        hasReferenceReadResult = true;
      } else {
        observations.omittedResults += 1;
        hasOmittedReferenceReadResult = true;
      }
    }
    const content = hasReferenceReadResult
      ? STATIC_READ_STATUS_RESULT
      : hasOmittedReferenceReadResult ? STATIC_READ_STATUS_OMITTED : STATIC_TOOL_RESULT;
    writeJson(response, 200, responseCompletion(requestId, content));
    return;
  }

  const toolName = latestUserMentionsMark(body.messages, userIndex) ? 'prepare_mark' : 'read_status';
  const hash = toolHash(toolName);
  if (!body.tools || !toolHashDeclared(body.tools, hash)) {
    writeJson(response, 200, responseCompletion(requestId, STATIC_CONNECT_ACCOUNT));
    return;
  }
  writeJson(response, 200, responseCompletion(requestId, null, toolName));
}

export async function startJourneyModel(options: JourneyModelOptions): Promise<{
  origin: string;
  calls: () => number;
  resultObservations: () => Readonly<ResultObservations>;
  close: () => Promise<void>;
}> {
  let requestCount = 0;
  const observations: ResultObservations = { referenceReadResults: 0, omittedResults: 0 };
  const sockets = new Set<Duplex>();
  const server: Server = createServer({ key: options.key, cert: options.cert }, (request, response) => {
    void handleRequest(request, response, options.token, () => {
      requestCount += 1;
      return requestCount;
    }, observations).catch(() => {
      if (!response.headersSent) reject(response, 400);
      else response.destroy();
      request.resume();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', () => { /* Fixed protocol responses do not expose server errors. */ });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolve, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => {
      server.close(() => { resolve(); });
    });
    throw new Error('The local synthetic model fixture could not bind to loopback.');
  }

  let closed = false;
  return {
    origin: `https://127.0.0.1:${String(address.port)}`,
    calls: () => requestCount,
    resultObservations: () => ({ ...observations }),
    close: async () => {
      if (closed) return;
      closed = true;
      const closedServer = new Promise<void>((resolve, rejectClose) => {
        server.close(error => {
          if (error) rejectClose(error);
          else resolve();
        });
      });
      for (const socket of sockets) socket.destroy();
      await closedServer;
    },
  };
}
