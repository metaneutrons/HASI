import { createPluginFetch, type PluginFetch } from './network-policy.js';
import type { PluginSecretCustody } from './plugin-secrets.js';

export type KnowledgeSourceSystem = 'service_it' | 'intranet';

export interface KnowledgeSourceRegistration {
  id: KnowledgeSourceSystem;
  /** Fixed, operator-configured HTTPS URL for a signed JSON export. */
  exportUrl: string;
  /** Operator-approved private ranges; loopback and protected ranges remain denied. */
  allowedPrivateCidrs?: readonly string[];
  /** Optional operator-owned bearer credential binding for this source. */
  credential?: { custody: PluginSecretCustody; slot: string };
}

export interface KnowledgeIngestionRepository {
  /** Must verify the export signature and apply it atomically using shared CAS state. */
  ingest(sourceSystem: KnowledgeSourceSystem, signedExport: unknown): Promise<unknown>;
}

export interface KnowledgeIngestionWorkerOptions {
  sources: readonly KnowledgeSourceRegistration[];
  repository: KnowledgeIngestionRepository;
  intervalMs?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  clock?: () => Date;
  /** Test injection only. Runtime environments always use createPluginFetch. */
  fetch?: typeof fetch;
}

export type KnowledgeIngestionStatus =
  | 'ingested'
  | 'deferred'
  | 'http_error'
  | 'invalid_export'
  | 'failed'
  | 'aborted'
  | 'closed';

export interface KnowledgeSourceOutcome {
  sourceSystem: KnowledgeSourceSystem;
  timestamp: string;
  status: KnowledgeIngestionStatus;
}

export interface KnowledgeIngestionRun {
  timestamp: string;
  sources: KnowledgeSourceOutcome[];
}

const SOURCE_SYSTEMS: readonly KnowledgeSourceSystem[] = ['service_it', 'intranet'];
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ALLOWED_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;

class InvalidKnowledgeExportError extends Error {
  constructor() {
    super('Invalid signed export response.');
    this.name = 'InvalidKnowledgeExportError';
  }
}

interface ConfiguredSource {
  id: KnowledgeSourceSystem;
  url: URL;
  allowedPrivateCidrs?: readonly string[];
  credential?: { custody: PluginSecretCustody; slot: string };
}

function isSourceSystem(value: unknown): value is KnowledgeSourceSystem {
  return value === 'service_it' || value === 'intranet';
}

function validateInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new TypeError(`Invalid knowledge worker ${label}.`);
  return resolved;
}

function validateExportUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Invalid operator-configured knowledge export URL.');
  }
  const forbiddenPathSegment = /(?:^|\/)(?:auth|login|log-in|logout|sign-in|signin|sso|oauth|saml|admin)(?:\/|$)/i;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.includes('%')
    || url.href !== value || forbiddenPathSegment.test(url.pathname)) {
    throw new TypeError('Invalid operator-configured knowledge export URL.');
  }
  return url;
}

function validateSources(sources: readonly KnowledgeSourceRegistration[]): ConfiguredSource[] {
  if (sources.length !== SOURCE_SYSTEMS.length) throw new TypeError('Both approved knowledge sources must be configured exactly once.');
  const seenIds = new Set<KnowledgeSourceSystem>();
  const seenUrls = new Set<string>();
  const validated: ConfiguredSource[] = [];
  for (const source of sources) {
    if (!isSourceSystem(source.id) || seenIds.has(source.id)) throw new TypeError('Both approved knowledge sources must be configured exactly once.');
    const url = validateExportUrl(source.exportUrl);
    if (seenUrls.has(url.href)) throw new TypeError('Knowledge export URLs must be unique.');
    if (source.credential && !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(source.credential.slot)) {
      throw new TypeError('Invalid operator credential binding for knowledge export.');
    }
    seenIds.add(source.id);
    seenUrls.add(url.href);
    validated.push({
      id: source.id,
      url,
      ...(source.allowedPrivateCidrs ? { allowedPrivateCidrs: [...source.allowedPrivateCidrs] } : {}),
      ...(source.credential ? { credential: source.credential } : {}),
    });
  }
  if (SOURCE_SYSTEMS.some(id => !seenIds.has(id))) throw new TypeError('Both approved knowledge sources must be configured exactly once.');
  return validated;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(value.trim());
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readSignedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!isJsonContentType(response.headers.get('content-type'))) throw new InvalidKnowledgeExportError();
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) throw new InvalidKnowledgeExportError();
  if (!response.body) throw new InvalidKnowledgeExportError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) throw new InvalidKnowledgeExportError();
      const chunk = value;
      received += chunk.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidKnowledgeExportError();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), received);
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new InvalidKnowledgeExportError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidKnowledgeExportError();
  return parsed;
}

function retryAfterDelay(value: string | null, nowMs: number): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  let requestedMs: number;
  if (/^\d+$/.test(value.trim())) {
    requestedMs = Number(value.trim()) * 1_000;
  } else {
    const dateMs = Date.parse(value);
    requestedMs = Number.isFinite(dateMs) ? dateMs - nowMs : DEFAULT_RETRY_AFTER_MS;
  }
  if (requestedMs === Number.POSITIVE_INFINITY) return MAX_RETRY_AFTER_MS;
  if (!Number.isFinite(requestedMs) || requestedMs < DEFAULT_RETRY_AFTER_MS) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(requestedMs, MAX_RETRY_AFTER_MS);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Operator-composed worker for fixed signed JSON exports. The repository owns
 * signature verification, source revisions, revocation and atomic shared CAS.
 */
export class KnowledgeIngestionWorker {
  private readonly sources: ConfiguredSource[];
  private readonly sourceFetchers = new Map<KnowledgeSourceSystem, PluginFetch>();
  private readonly repository: KnowledgeIngestionRepository;
  private readonly intervalMs: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private readonly clock: () => Date;
  private readonly injectedFetch: typeof fetch | undefined;
  private readonly retryNotBefore = new Map<KnowledgeSourceSystem, number>();
  private readonly activeControllers = new Set<AbortController>();
  private activeRun: Promise<KnowledgeIngestionRun> | undefined;
  private closePromise: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private closed = false;

  constructor(options: KnowledgeIngestionWorkerOptions) {
    this.sources = validateSources(options.sources);
    if (typeof options.repository.ingest !== 'function') throw new TypeError('A shared knowledge repository is required.');
    if (options.fetch && process.env.NODE_ENV !== 'test') throw new TypeError('Injected knowledge fetch is restricted to tests.');
    this.repository = options.repository;
    this.intervalMs = validateInteger(options.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 'poll interval');
    this.maxResponseBytes = validateInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_ALLOWED_RESPONSE_BYTES, 'response size limit');
    this.timeoutMs = validateInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, 'request timeout');
    this.clock = options.clock ?? (() => new Date());
    this.injectedFetch = options.fetch;

    if (!this.injectedFetch) {
      try {
        for (const source of this.sources) {
          this.sourceFetchers.set(source.id, createPluginFetch({
            origins: [source.url.origin],
            allowLoopback: false,
            ...(source.allowedPrivateCidrs ? { allowedPrivateCidrs: source.allowedPrivateCidrs } : {}),
            maxResponseBytes: this.maxResponseBytes,
            connectTimeoutMs: Math.min(this.timeoutMs, 5_000),
            headersTimeoutMs: Math.min(this.timeoutMs, 5_000),
            bodyTimeoutMs: this.timeoutMs,
          }));
        }
      } catch {
        for (const fetcher of this.sourceFetchers.values()) void fetcher.close().catch(() => undefined);
        throw new TypeError('Invalid operator network policy for knowledge exports.');
      }
    }
  }

  async runOnce(): Promise<KnowledgeIngestionRun> {
    if (this.closed) return this.closedRun();
    if (this.activeRun) return this.activeRun;
    const run = this.performRun();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  /** Starts an immediate, serial poll loop. Each next poll is scheduled after the prior run finishes. */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stops future polls, aborts active reads and closes this worker's owned transports. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const controller of this.activeControllers) controller.abort();
    const activeRun = this.activeRun;
    this.closePromise = (async () => {
      await activeRun?.catch(() => undefined);
      const fetchers = [...this.sourceFetchers.values()];
      this.sourceFetchers.clear();
      await Promise.all(fetchers.map(fetcher => fetcher.close().catch(() => undefined)));
    })();
    await this.closePromise;
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runOnce().finally(() => {
        if (!this.closed) this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.pollTimer.unref();
  }

  private async performRun(): Promise<KnowledgeIngestionRun> {
    const timestamp = this.now().toISOString();
    const outcomes: KnowledgeSourceOutcome[] = [];
    for (const source of this.sources) {
      if (this.closed) {
        outcomes.push(this.outcome(source.id, 'closed'));
        continue;
      }
      const nowMs = this.now().getTime();
      const retryAt = this.retryNotBefore.get(source.id);
      if (retryAt !== undefined && nowMs < retryAt) {
        outcomes.push(this.outcome(source.id, 'deferred'));
        continue;
      }
      this.retryNotBefore.delete(source.id);
      outcomes.push(await this.ingestSource(source));
    }
    return { timestamp, sources: outcomes };
  }

  private async ingestSource(source: ConfiguredSource): Promise<KnowledgeSourceOutcome> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      const fetcher = this.injectedFetch ?? this.sourceFetchers.get(source.id);
      if (!fetcher) return this.outcome(source.id, 'closed');
      const headers = new Headers({ accept: 'application/json' });
      const request = () => {
        if (this.shouldStop(controller)) throw new DOMException('Aborted', 'AbortError');
        return fetcher(source.url.href, { method: 'GET', redirect: 'error', cache: 'no-store', headers, signal: controller.signal });
      };
      const response = source.credential
        ? await source.credential.custody.use(source.credential.slot, async credential => {
          if (!credential.trim()) throw new Error('Credential unavailable');
          headers.set('authorization', `Bearer ${credential}`);
          return request();
        })
        : await request();

      if (controller.signal.aborted || this.closed) {
        await cancelBody(response);
        return this.outcome(source.id, 'aborted');
      }
      if (response.status === 429 || response.status === 503) {
        this.retryNotBefore.set(source.id, this.now().getTime() + retryAfterDelay(response.headers.get('retry-after'), this.now().getTime()));
        await cancelBody(response);
        return this.outcome(source.id, 'deferred');
      }
      if (response.redirected || (response.url && response.url !== source.url.href)) {
        await cancelBody(response);
        return this.outcome(source.id, 'http_error');
      }
      if (!response.ok) {
        await cancelBody(response);
        return this.outcome(source.id, 'http_error');
      }

      let signedExport: unknown;
      try {
        signedExport = await readSignedJson(response, this.maxResponseBytes);
      } catch (error) {
        if (error instanceof InvalidKnowledgeExportError) {
          await cancelBody(response);
          return this.outcome(source.id, 'invalid_export');
        }
        throw error;
      }
      if (this.shouldStop(controller)) return this.outcome(source.id, 'aborted');
      await this.repository.ingest(source.id, signedExport);
      this.retryNotBefore.delete(source.id);
      return this.outcome(source.id, 'ingested');
    } catch (error) {
      return this.outcome(source.id, this.closed || controller.signal.aborted || isAbortError(error) ? 'aborted' : 'failed');
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Invalid knowledge worker clock value.');
    return value;
  }

  private shouldStop(controller: AbortController): boolean {
    return this.closed || controller.signal.aborted;
  }

  private outcome(sourceSystem: KnowledgeSourceSystem, status: KnowledgeIngestionStatus): KnowledgeSourceOutcome {
    return { sourceSystem, timestamp: this.now().toISOString(), status };
  }

  private closedRun(): KnowledgeIngestionRun {
    const timestamp = this.now().toISOString();
    return { timestamp, sources: this.sources.map(source => ({ sourceSystem: source.id, timestamp, status: 'closed' })) };
  }
}
