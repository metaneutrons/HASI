import { createPluginFetch, type PluginFetch } from './network-policy.js';
import type { PluginSecretCustody } from './plugin-secrets.js';

export type KnowledgeEmbeddingDataClass = 'public' | 'internal' | 'confidential';

export interface KnowledgeEmbeddingUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface KnowledgeEmbeddingReservation {
  /** Omit usage to retain the reservation when the provider outcome is uncertain. */
  settle(usage?: KnowledgeEmbeddingUsage): Promise<unknown>;
}

export interface KnowledgeEmbeddingBudget {
  reserve(inputTokens: number): Promise<KnowledgeEmbeddingReservation>;
}

export interface CreateKnowledgeEmbeddingClientOptions {
  /** Fixed operator-configured HTTPS OpenAI-compatible `/embeddings` endpoint. */
  endpoint: string;
  /** Operator-approved provider model identifier. */
  modelId: string;
  dimensions: number;
  custody: PluginSecretCustody;
  slot: string;
  allowedPrivateCidrs?: readonly string[];
  allowedDataClasses: readonly KnowledgeEmbeddingDataClass[];
  budget: KnowledgeEmbeddingBudget;
  /** Test injection only. Runtime environments always use createPluginFetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface KnowledgeEmbeddingClient {
  readonly modelId: string;
  readonly dimensions: number;
  readonly allowedDataClasses: readonly KnowledgeEmbeddingDataClass[];
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
  embedDocument(text: string, signal?: AbortSignal): Promise<number[]>;
  close(): Promise<void>;
}

interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

const MAX_DIMENSIONS = 2_048;
const MAX_QUERY_CHARACTERS = 500;
const PROTOCOL_TOKEN_OVERHEAD = 512;
const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_DATA_CLASSES: readonly KnowledgeEmbeddingDataClass[] = ['public', 'internal', 'confidential'];

function invalidConfiguration(): TypeError {
  return new TypeError('Invalid operator knowledge embedding configuration.');
}

function unavailable(): Error {
  return new Error('Knowledge embedding unavailable.');
}

function requestAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

function validateEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfiguration();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname.includes('%') || !url.pathname.endsWith('/v1/embeddings') || url.href !== value) {
    throw invalidConfiguration();
  }
  return url;
}

function validateDataClasses(values: readonly KnowledgeEmbeddingDataClass[]): readonly KnowledgeEmbeddingDataClass[] {
  const candidate: unknown = values;
  if (!Array.isArray(candidate)) throw invalidConfiguration();
  const entries: unknown[] = Array.from(candidate, (value: unknown) => value);
  if (entries.length === 0
    || entries.some(value => typeof value !== 'string' || !ALLOWED_DATA_CLASSES.includes(value as KnowledgeEmbeddingDataClass))
    || new Set(entries).size !== entries.length) {
    throw invalidConfiguration();
  }
  return Object.freeze(entries as KnowledgeEmbeddingDataClass[]);
}

function validateUsage(value: unknown, reservedTokens: number): EmbeddingUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const usage = value as Record<string, unknown>;
  const promptTokens = usage.prompt_tokens;
  const totalTokens = usage.total_tokens;
  if (typeof promptTokens !== 'number' || !Number.isSafeInteger(promptTokens) || promptTokens < 0 || promptTokens > reservedTokens
    || typeof totalTokens !== 'number' || !Number.isSafeInteger(totalTokens) || totalTokens < promptTokens || totalTokens > reservedTokens) {
    throw unavailable();
  }
  return { promptTokens, totalTokens };
}

function parseEmbedding(value: unknown, modelId: string, dimensions: number, reservedTokens: number): { vector: number[]; usage: KnowledgeEmbeddingUsage } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const response = value as Record<string, unknown>;
  if (response.model !== modelId || !Array.isArray(response.data) || response.data.length !== 1) throw unavailable();
  const item: unknown = response.data[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw unavailable();
  const record = item as Record<string, unknown>;
  if (record.index !== 0 || !Array.isArray(record.embedding) || record.embedding.length !== dimensions) throw unavailable();
  const vector: number[] = [];
  let normSquared = 0;
  for (const component of record.embedding) {
    if (typeof component !== 'number' || !Number.isFinite(component)) throw unavailable();
    vector.push(component);
    normSquared += component * component;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) throw unavailable();
  const parsedUsage = validateUsage(response.usage, reservedTokens);
  return {
    vector,
    usage: { inputTokens: parsedUsage.promptTokens, outputTokens: parsedUsage.totalTokens - parsedUsage.promptTokens },
  };
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(value.trim());
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!isJsonContentType(response.headers.get('content-type'))) throw unavailable();
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) throw unavailable();
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), received))) as unknown;
  } catch {
    throw unavailable();
  }
}

function validateInput(text: string, maximum: number): { reservedTokens: number; payload: { input: string; encoding_format: 'float' } } {
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > maximum * 2
    || Array.from(text).length > maximum) throw unavailable();
  const reservedTokens = Buffer.byteLength(text, 'utf8') + PROTOCOL_TOKEN_OVERHEAD;
  return { reservedTokens, payload: { input: text, encoding_format: 'float' } };
}

/** Creates one operator-pinned, budgeted embedding client. It never selects or falls back to another model. */
export function createKnowledgeEmbeddingClient(options: CreateKnowledgeEmbeddingClientOptions): KnowledgeEmbeddingClient {
  const endpoint = validateEndpoint(options.endpoint);
  const custody: unknown = options.custody;
  const budget: unknown = options.budget;
  if (typeof options.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(options.modelId)
    || !Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > MAX_DIMENSIONS
    || !custody || typeof custody !== 'object'
    || typeof (custody as PluginSecretCustody).use !== 'function' || typeof (custody as PluginSecretCustody).status !== 'function'
    || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(options.slot)
    || !budget || typeof budget !== 'object' || typeof (budget as KnowledgeEmbeddingBudget).reserve !== 'function') {
    throw invalidConfiguration();
  }
  const allowedDataClasses = validateDataClasses(options.allowedDataClasses);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw invalidConfiguration();
  if (options.fetch && process.env.NODE_ENV !== 'test') throw new TypeError('Injected embedding fetch is restricted to tests.');

  let transport: PluginFetch | undefined;
  if (!options.fetch) {
    try {
      transport = createPluginFetch({
        origins: [endpoint.origin],
        allowLoopback: false,
        ...(options.allowedPrivateCidrs ? { allowedPrivateCidrs: options.allowedPrivateCidrs } : {}),
        maxResponseBytes: MAX_RESPONSE_BYTES,
        connectTimeoutMs: Math.min(timeoutMs, 5_000),
        headersTimeoutMs: Math.min(timeoutMs, 5_000),
        bodyTimeoutMs: timeoutMs,
      });
    } catch {
      throw invalidConfiguration();
    }
  }

  const dataClasses = allowedDataClasses;
  const clientModelId = options.modelId;
  const clientDimensions = options.dimensions;
  const secretCustody = options.custody;
  const tokenBudget = options.budget;
  const controllers = new Set<AbortController>();
  let closed = false;
  const isClosed = (): boolean => closed;

  async function embed(text: string, maximum: number, signal?: AbortSignal): Promise<number[]> {
      if (closed) throw unavailable();
      const query = validateInput(text, maximum);
      let configured: boolean;
      try {
        configured = secretCustody.status(options.slot).configured;
      } catch {
        throw unavailable();
      }
      if (!configured || signal?.aborted) throw unavailable();

      let reservation: KnowledgeEmbeddingReservation;
      try {
        reservation = await tokenBudget.reserve(query.reservedTokens);
      } catch {
        throw unavailable();
      }
      const reservationValue: unknown = reservation;
      if (!reservationValue || typeof reservationValue !== 'object'
        || typeof (reservationValue as KnowledgeEmbeddingReservation).settle !== 'function') throw unavailable();

      const controller = new AbortController();
      controllers.add(controller);
      const abortFromCaller = () => { controller.abort(); };
      if (signal) signal.addEventListener('abort', abortFromCaller, { once: true });
      const timeout = setTimeout(() => { controller.abort(); }, timeoutMs);
      let settlementAttempted = false;
      try {
        if (isClosed() || signal?.aborted) throw unavailable();
        const payload = { ...query.payload, model: clientModelId };
        const request = async (credential: string): Promise<Response> => {
          if (!credential.trim() || isClosed() || controller.signal.aborted) throw unavailable();
          const fetcher = options.fetch ?? transport;
          if (!fetcher) throw unavailable();
          return fetcher(endpoint.href, {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        };
        const response = await secretCustody.use(options.slot, request);
        if (isClosed() || controller.signal.aborted) {
          await cancelBody(response);
          throw unavailable();
        }
        if (response.redirected || (response.url && response.url !== endpoint.href) || !response.ok) {
          await cancelBody(response);
          throw unavailable();
        }

        let parsed: unknown;
        try {
          parsed = await readBoundedJson(response);
        } catch {
          await cancelBody(response);
          throw unavailable();
        }
        if (isClosed() || requestAborted(controller)) throw unavailable();
        const result = parseEmbedding(parsed, clientModelId, clientDimensions, query.reservedTokens);
        settlementAttempted = true;
        await reservation.settle(result.usage);
        return result.vector;
      } catch {
        if (!settlementAttempted) {
          settlementAttempted = true;
          await reservation.settle().catch(() => undefined);
        }
        throw unavailable();
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromCaller);
        controllers.delete(controller);
      }
    }
  return {
    modelId: clientModelId,
    dimensions: clientDimensions,
    allowedDataClasses: dataClasses,
    embedQuery: (text, signal) => embed(text, MAX_QUERY_CHARACTERS, signal),
    embedDocument: (text, signal) => embed(text, 4000, signal),
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      await transport?.close().catch(() => undefined);
      transport = undefined;
    },
  };
}
