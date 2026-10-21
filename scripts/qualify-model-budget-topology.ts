import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as httpsServer, request as httpsRequest, type Server } from 'node:https';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_BUDGET_NAMESPACE,
  ASSISTANT_BUDGET_POLICY,
  ModelBudgetError,
  ModelBudgetLedger,
  PostgresJsonStore,
  type JsonStore,
  type ModelBudgetSnapshot,
} from '@hasi/state';
import { ProductionAuthorityDirectory, createProductionRuntime, stableOidcSubject } from '../apps/api/src/production-runtime.js';
import { startTestIdp } from '../apps/api/src/test-idp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url);
const postgresImage = 'postgres@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c';
const databaseName = 'hasi_budget_topology_test';
const modelProfileId = 'budget-fixture';
const modelConnectionId = 'budget-fixture';
const modelId = 'budget-fixture-model';
const credentialRef = 'env:HASI_LLM_SECRET_BUD_A1';
const fixtureCredential = 'hasi-local-budget-fixture-only';
const inputRate = 800_000;
const outputRate = 4_000_000;
const expectedBudgetDenial = 'Das gemeinsame Tagesbudget für Modellanfragen ist ausgeschöpft. Bestehende Suchergebnisse und Buchungen kannst du weiter nutzen. Das Budget wird um 00:00 UTC erneuert.';
const expectedBudgetUnavailable = 'Die gemeinsame Budgetprüfung ist vorübergehend nicht verfügbar. Es werden keine weiteren Modellanfragen gestartet. Vorhandene Buchungskarten bleiben nutzbar.';
const raceSize = 4;
const raceDeadlineMs = 15_000;
export const BUDGET_RECOVERY_CLOCK_MARGIN_MS = 60_000;
let stage = 'preflight';
let qualificationReport: Record<string, unknown> | undefined;

export type QualificationMode = 'topology' | 'state-loss-drill';

interface ProbeResponse {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  text: string;
  elapsedMs: number;
}

interface ApiConfiguration {
  scope: string;
  webOrigin: string;
  issuer: string;
  privateKeyPath: string;
  port: number;
}

interface ChatAttempt {
  readonly index: number;
  readonly conversationId: string;
  readonly messageId: string;
  readonly content: string;
  readonly startedAt: number;
  readonly result?: ProbeResponse;
  readonly requestFailed?: boolean;
}

interface RoutedChat {
  readonly stage: string;
  readonly targetPort: number;
}

class QualificationError extends Error {}

export function parseQualificationMode(args: readonly string[]): QualificationMode {
  if (args.length === 0) return 'topology';
  if (args.length === 1 && args[0] === '--state-loss-drill') return 'state-loss-drill';
  throw new QualificationError('Use --state-loss-drill to add the optional budget-loss recovery drill.');
}

export function validateQualificationEnvironment(
  mode: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  assert(mode === 'topology' || mode === 'state-loss-drill', 'qualification_mode_invalid');
  assert(environment.HASI_BUDGET_QUALIFY === '1', 'explicit_opt_in_required');
  assert(!environment.DATABASE_URL && !environment.TEST_DATABASE_URL, 'inherited_database_url_forbidden');
}

export function budgetRecoverySafeAt(
  latestPossibleProviderDispatchAt: number,
  windowMs: number = ASSISTANT_BUDGET_POLICY.windowMs,
): number {
  if (!Number.isSafeInteger(latestPossibleProviderDispatchAt) || latestPossibleProviderDispatchAt < 0
    || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new QualificationError('budget_recovery_boundary_invalid');
  }
  const windowEnd = (Math.floor(latestPossibleProviderDispatchAt / windowMs) + 1) * windowMs;
  const safeAt = windowEnd + BUDGET_RECOVERY_CLOCK_MARGIN_MS;
  if (!Number.isSafeInteger(safeAt)) throw new QualificationError('budget_recovery_boundary_invalid');
  return safeAt;
}

/** Qualification-only gate. The production initializer remains an operator-controlled command. */
export function assertBudgetRecoveryBoundaryPassed(now: number, latestPossibleProviderDispatchAt: number): number {
  const safeAt = budgetRecoverySafeAt(latestPossibleProviderDispatchAt);
  if (!Number.isSafeInteger(now) || now < safeAt) throw new QualificationError('budget_recovery_window_not_safe');
  return safeAt;
}

export function assertOwnedBudgetLedgerRemoval(input: {
  readonly mode: QualificationMode;
  readonly namespace: string;
  readonly ledgerKey: string;
  readonly containerName: string;
  readonly expectedOwnerLabel: string;
  readonly actualOwnerLabel: string | undefined;
}): void {
  const ownedContainerName = /^hasi-m2-budget-proof-pg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const ownerLabel = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  assert(input.mode === 'state-loss-drill', 'state_loss_drill_not_enabled');
  assert(input.namespace === ASSISTANT_BUDGET_NAMESPACE, 'budget_loss_namespace_not_owned');
  assert(/^model-budget:v1:[a-f0-9]{64}$/u.test(input.ledgerKey), 'budget_loss_ledger_key_invalid');
  assert(ownedContainerName.test(input.containerName), 'budget_loss_container_name_invalid');
  assert(ownerLabel.test(input.expectedOwnerLabel)
    && input.actualOwnerLabel === input.expectedOwnerLabel, 'budget_loss_container_ownership_unverified');
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new QualificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function isExpectedBudgetError(error: unknown): error is ModelBudgetError {
  return error instanceof ModelBudgetError && error.code === 'unavailable';
}

function localDockerEndpoint(): string {
  let endpoint = process.env.DOCKER_HOST?.trim();
  if (!endpoint) {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    };
    if (process.env.DOCKER_CONTEXT) environment.DOCKER_CONTEXT = process.env.DOCKER_CONTEXT;
    if (process.env.DOCKER_CONFIG) environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
    try {
      endpoint = execFileSync('docker', [
        'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000, env: environment }).trim();
    } catch {
      throw new QualificationError('A local Docker Unix socket could not be discovered.');
    }
  }

  const socketPath = endpoint.slice('unix://'.length);
  const hasInvalidCharacter = endpoint.includes('?') || endpoint.includes('#')
    || Array.from(endpoint).some(character => character.charCodeAt(0) <= 0x20);
  assert(endpoint.startsWith('unix:///') && !hasInvalidCharacter, 'Only a local Docker Unix socket is permitted.');
  assert(isAbsolute(socketPath) && existsSync(socketPath) && statSync(socketPath).isSocket(), 'The local Docker Unix socket is unavailable.');
  return endpoint;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(done => setTimeout(done, milliseconds));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new QualificationError(message);
}

async function allocatePort(): Promise<number> {
  const listener = netServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address !== 'string', 'Loopback port allocation failed.');
  await new Promise<void>((resolveClose, reject) => listener.close(error => {
    if (error) reject(error);
    else resolveClose();
  }));
  return address.port;
}

function isolatedDatabaseUrl(value: unknown, expectedPort?: number): string {
  assert(typeof value === 'string' && value.length > 0, 'The isolated database URL is missing.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QualificationError('The isolated database URL is invalid.');
  }
  assert(
    ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1'
      && /^\d{1,5}$/u.test(url.port)
      && url.username === 'postgres'
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === '/' + databaseName
      && (expectedPort === undefined || url.port === String(expectedPort)),
    'Use only the disposable loopback PostgreSQL database with a literal host, explicit port, exact database name, and no query or fragment.',
  );
  return value;
}

function activeDatabaseUrl(): string {
  return isolatedDatabaseUrl(process.env.TEST_DATABASE_URL);
}

function startChild(command: readonly string[], environment: NodeJS.ProcessEnv, onOutput?: (chunk: Buffer) => void): ChildProcess {
  const process_ = spawn(process.execPath, [...command], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process_.on('error', () => undefined);
  process_.stdout.on('data', (chunk: Buffer) => { onOutput?.(chunk); });
  process_.stderr.on('data', (chunk: Buffer) => { onOutput?.(chunk); });
  assert(process_.pid, 'An isolated qualification child could not start.');
  return process_;
}

async function stopChild(process_: ChildProcess): Promise<void> {
  if (process_.exitCode !== null || process_.signalCode !== null) return;
  const exited = once(process_, 'exit').then(() => true);
  process_.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = await Promise.race([
      exited,
      new Promise<boolean>(done => { timer = setTimeout(() => { done(false); }, 5_000); }),
    ]);
    if (graceful) return;
    clearTimeout(timer);
    process_.kill('SIGKILL');
    const terminated = await Promise.race([
      exited,
      new Promise<boolean>(done => { timer = setTimeout(() => { done(false); }, 3_000); }),
    ]);
    assert(terminated, 'An isolated qualification child could not be terminated.');
  } finally {
    clearTimeout(timer);
  }
}

function createLogObserver() {
  let fragment = '';
  let budgetExhausted = 0;
  let budgetUnavailable = 0;
  const observeLine = (line: string) => {
    const marker = 'HASI model request failed';
    const markerAt = line.indexOf(marker);
    if (markerAt < 0) return;
    const jsonStart = line.indexOf('{', markerAt + marker.length);
    if (jsonStart < 0) return;
    try {
      const value: unknown = JSON.parse(line.slice(jsonStart));
      if (!isRecord(value) || typeof value.code !== 'string') return;
      if (value.code === 'budget_exhausted') budgetExhausted += 1;
      if (value.code === 'budget_unavailable') budgetUnavailable += 1;
    } catch {
      // Provider errors and other child output are discarded without inspection.
    }
  };
  return {
    feed(chunk: Buffer) {
      const text = fragment + chunk.toString('utf8');
      const lines = text.split(/\r?\n/u);
      fragment = lines.pop() ?? '';
      if (fragment.length > 8_192) fragment = fragment.slice(-2_048);
      for (const line of lines) observeLine(line);
    },
    exhausted: () => budgetExhausted,
    unavailable: () => budgetUnavailable,
  };
}

async function waitPostgres(containerName: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    try {
      const status = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', containerName], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        env: environment,
      }).trim();
      if (status === 'healthy') return;
    } catch {
      // Startup polling is bounded and does not emit Docker diagnostics.
    }
    await delay(250);
  }
  throw new QualificationError('The disposable PostgreSQL container did not become healthy.');
}

const postgresOwnershipLabel = 'com.hasi.model-budget-qualification-owner';

function ownedContainerLabel(containerName: string, environment: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync('docker', [
      'inspect', '--format', '{{ index .Config.Labels "' + postgresOwnershipLabel + '" }}', containerName,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env: environment }).trim();
  } catch {
    const names = execFileSync('docker', [
      'ps', '--all', '--filter', 'name=^/' + containerName + '$', '--format', '{{.Names}}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env: environment })
      .split(/\r?\n/u).map(name => name.trim()).filter(Boolean);
    if (names.includes(containerName)) throw new QualificationError('The owned PostgreSQL container could not be inspected.');
    return undefined;
  }
}

function removeOwnedContainer(containerName: string, ownershipLabel: string, environment: NodeJS.ProcessEnv): void {
  try {
    const actual = ownedContainerLabel(containerName, environment);
    if (actual === undefined) return;
    if (actual !== ownershipLabel) throw new QualificationError('The disposable PostgreSQL ownership check failed.');
    execFileSync('docker', ['rm', '--force', '--volumes', containerName], { stdio: 'ignore', timeout: 10_000, env: environment });
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    if (ownedContainerLabel(containerName, environment) === undefined) return;
    throw new QualificationError('The owned PostgreSQL container could not be removed.');
  }
}

async function createDisposableDatabase(
  environment: NodeJS.ProcessEnv,
  onOwned: (containerName: string, ownershipLabel: string) => void,
): Promise<{ containerName: string; ownershipLabel: string; port: number; connectionString: string }> {
  const port = await allocatePort();
  const containerName = 'hasi-m2-budget-proof-pg-' + randomUUID();
  const ownershipLabel = randomUUID();
  try {
    execFileSync('docker', [
      'run', '--pull=never', '--detach', '--name', containerName,
      '--label', postgresOwnershipLabel + '=' + ownershipLabel,
      '--memory=256m', '--cpus=1',
      '--publish', '127.0.0.1:' + String(port) + ':5432',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '--env', 'POSTGRES_DB=' + databaseName,
      '--health-cmd', 'pg_isready -U postgres -d ' + databaseName,
      '--health-interval', '1s', '--health-timeout', '1s', '--health-retries', '60',
      postgresImage,
    ], { stdio: 'ignore', timeout: 30_000, env: environment });
    onOwned(containerName, ownershipLabel);
    await waitPostgres(containerName, environment);
  } catch {
    try { removeOwnedContainer(containerName, ownershipLabel, environment); } catch {
      throw new QualificationError('The disposable PostgreSQL container could not be started or cleaned up.');
    }
    throw new QualificationError('The disposable PostgreSQL container did not become healthy.');
  }
  const connectionString = 'postgresql://postgres@127.0.0.1:' + String(port) + '/' + databaseName;
  isolatedDatabaseUrl(connectionString, port);
  return { containerName, ownershipLabel, port, connectionString };
}

async function apiChild(configurationPath: string): Promise<void> {
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8')) as ApiConfiguration;
  const database = activeDatabaseUrl();
  const store = new PostgresJsonStore('production:' + configuration.scope, {
    poolConfig: { connectionString: database, max: 4 },
  });
  await store.initialize();
  const runtime = await createProductionRuntime({
    privateKey: createPrivateKey(await readFile(configuration.privateKeyPath)),
    store,
    scope: configuration.scope,
    webOrigin: configuration.webOrigin,
    apiHostname: '127.0.0.1',
    plugins: [],
    identity: { issuer: configuration.issuer, clientId: 'hasi-budget-fixture' },
  });
  runtime.app.addHook('onClose', () => store.close());
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => { void runtime.app.close(); });
  }
  await runtime.app.listen({ host: '127.0.0.1', port: configuration.port });
}

async function createTlsProxy(
  key: Buffer,
  cert: Buffer,
  selectPort: () => number,
  observe?: (path: string, targetPort: number) => void,
): Promise<{ server: Server; origin: string }> {
  const server = httpsServer({ key, cert }, (incoming, outgoing) => {
    const targetPort = selectPort();
    observe?.(incoming.url ?? '', targetPort);
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: targetPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' },
      timeout: 20_000,
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.once('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    });
    upstream.once('timeout', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string', 'A TLS proxy failed to bind to loopback.');
  return { server, origin: 'https://127.0.0.1:' + String(address.port) };
}

function probe(
  url: string,
  ca: Buffer | undefined,
  input: { method?: string; cookie?: string; origin?: string; host?: string; body?: unknown } = {},
): Promise<ProbeResponse> {
  return new Promise((done, reject) => {
    const started = performance.now();
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {};
    if (input.cookie) headers.cookie = input.cookie;
    if (input.origin) headers.origin = input.origin;
    if (input.host) headers.host = input.host;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const options = {
      servername: 'localhost',
      method: input.method ?? 'GET',
      timeout: 20_000,
      headers,
      ...(ca ? { ca } : {}),
    };
    const receive = (response: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) {
          response.destroy(new Error('Oversized fixture response.'));
        } else {
          chunks.push(chunk);
        }
      });
      response.once('error', reject);
      response.once('end', () => { done({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        elapsedMs: performance.now() - started,
      }); });
    };
    const req = url.startsWith('https:')
      ? httpsRequest(url, options, receive)
      : httpRequest(url, options, receive);
    req.once('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('Qualification request timed out.')));
    req.end(body);
  });
}

async function readyApi(url: string, process_: ChildProcess): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    assert(process_.exitCode === null && process_.signalCode === null, 'A production API fixture exited before readiness.');
    try {
      if ((await probe(url, undefined)).status === 200) return;
    } catch {
      // Bounded startup polling.
    }
    await delay(100);
  }
  throw new QualificationError('The production API fixture did not become ready.');
}

async function readyWeb(url: string, ca: Buffer, process_: ChildProcess): Promise<void> {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    assert(process_.exitCode === null && process_.signalCode === null, 'A Next.js fixture exited before readiness.');
    try {
      if ((await probe(url, ca)).status === 200) return;
    } catch {
      // Bounded startup polling.
    }
    await delay(150);
  }
  throw new QualificationError('A Next.js production process did not become ready.');
}

async function readBoundedRequest(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    size += value.byteLength;
    if (size > maximumBytes) throw new QualificationError('The local provider request exceeded its bound.');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const fakeCompletion = JSON.stringify({
  id: 'chatcmpl-budget-fixture',
  object: 'chat.completion',
  created: 1_797_000_000,
  model: modelId,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic qualification completed.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

function createFakeProvider(key: Buffer, cert: Buffer) {
  let requestCount = 0;
  let completedCount = 0;
  let invalidCount = 0;
  let released = false;
  const queuedResponses: (() => void)[] = [];

  const server = httpsServer({ key, cert }, (incoming, outgoing) => {
    void (async () => {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
        invalidCount += 1;
        outgoing.writeHead(404).end();
        return;
      }
      const raw = await readBoundedRequest(incoming, 512 * 1024);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        invalidCount += 1;
        outgoing.writeHead(400).end();
        return;
      }
      if (incoming.headers.authorization !== 'Bearer ' + fixtureCredential
        || !isRecord(body) || body.model !== modelId || !Array.isArray(body.messages)) {
        invalidCount += 1;
        outgoing.writeHead(401).end();
        return;
      }

      requestCount += 1;
      await new Promise<void>(resolveResponse => {
        if (released) resolveResponse();
        else queuedResponses.push(resolveResponse);
      });
      completedCount += 1;
      outgoing.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(fakeCompletion)),
        'cache-control': 'no-store',
      }).end(fakeCompletion);
    })().catch(() => {
      invalidCount += 1;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
  });
  return {
    server,
    get requests(): number { return requestCount; },
    get completed(): number { return completedCount; },
    get invalid(): number { return invalidCount; },
    release() {
      released = true;
      for (const resolveResponse of queuedResponses.splice(0)) resolveResponse();
    },
  };
}

function fakeProviderCount(provider: ReturnType<typeof createFakeProvider>, counter: 'requests' | 'completed' | 'invalid'): number {
  return provider[counter];
}

function createBudgetConfiguration(fakeOrigin: string) {
  const configuration = {
    schemaVersion: 1,
    connections: [{
      id: modelConnectionId,
      label: 'Loopback budget fixture',
      provider: 'custom',
      credentialRef,
      endpoint: fakeOrigin + '/v1',
    }],
    profiles: [{
      id: modelProfileId,
      label: 'Synthetic budget fixture',
      connectionId: modelConnectionId,
      modelId,
      capabilities: { tools: true },
      allowedDataClasses: ['synthetic_demo', 'public', 'internal', 'confidential'],
      parameters: { temperature: 0, maxOutputTokens: 1, timeoutMs: 15_000 },
    }],
    policy: {
      defaultProfileId: modelProfileId,
      userChoice: { enabled: false, profileIds: [] },
      fallbacks: [],
      maxAttempts: 1,
      totalTimeoutMs: 20_000,
    },
  };
  const prices = [{
    provider: 'custom',
    baseURL: fakeOrigin + '/v1',
    modelId,
    inputMicroUsdPerMillion: inputRate,
    outputMicroUsdPerMillion: outputRate,
    basis: 'operator_estimate',
  }];
  return { configuration, prices };
}

function policyDigest(): string {
  return createHash('sha256').update(JSON.stringify([
    1,
    ASSISTANT_BUDGET_POLICY.scope,
    ASSISTANT_BUDGET_POLICY.windowMs,
    ASSISTANT_BUDGET_POLICY.inputTokenLimit,
    ASSISTANT_BUDGET_POLICY.outputTokenLimit,
    ASSISTANT_BUDGET_POLICY.microUsdLimit,
    inputRate,
    outputRate,
  ])).digest('hex');
}

function assertBudgetBound(snapshot: ModelBudgetSnapshot): void {
  assert(snapshot.microUsdUsed <= ASSISTANT_BUDGET_POLICY.microUsdLimit, 'The ledger exceeded the USD1 ceiling.');
  assert(snapshot.inputTokensUsed <= ASSISTANT_BUDGET_POLICY.inputTokenLimit, 'The ledger exceeded the shared input-token ceiling.');
  assert(snapshot.outputTokensUsed <= ASSISTANT_BUDGET_POLICY.outputTokenLimit, 'The ledger exceeded the shared output-token ceiling.');
  assert(snapshot.microUsdLimit === ASSISTANT_BUDGET_POLICY.microUsdLimit
    && snapshot.inputTokenLimit === ASSISTANT_BUDGET_POLICY.inputTokenLimit
    && snapshot.outputTokenLimit === ASSISTANT_BUDGET_POLICY.outputTokenLimit
    && snapshot.windowEnd - snapshot.windowStart === ASSISTANT_BUDGET_POLICY.windowMs,
  'The runtime budget policy differs from the shared production policy.');
}

function makeAttempt(index: number): Omit<ChatAttempt, 'startedAt' | 'result' | 'requestFailed'> {
  return {
    index,
    conversationId: randomUUID(),
    messageId: randomUUID(),
    content: 'synthetic-budget-case-' + String(index) + '-' + randomUUID(),
  };
}

async function stampMessage(
  webOrigin: string,
  ca: Buffer,
  cookie: string,
  attempt: Omit<ChatAttempt, 'startedAt' | 'result' | 'requestFailed'>,
): Promise<{ id: string; role: 'user'; content: string; timestamp: unknown }> {
  const message = { id: attempt.messageId, role: 'user' as const, content: attempt.content };
  const response = await probe(webOrigin + '/api/chat/timestamps', ca, {
    method: 'POST',
    cookie,
    origin: webOrigin,
    body: { messages: [message] },
  });
  assert(response.status === 200, 'The production timestamp endpoint rejected a synthetic authenticated message.');
  let payload: unknown;
  try {
    payload = JSON.parse(response.text) as unknown;
  } catch {
    throw new QualificationError('The timestamp endpoint returned an invalid response.');
  }
  assert(isRecord(payload) && Array.isArray(payload.timestamps), 'The timestamp response did not match its contract.');
  const entry = (payload.timestamps as unknown[])[0];
  assert(isRecord(entry) && entry.id === attempt.messageId && isRecord(entry.timestamp)
    && typeof entry.timestamp.createdAt === 'string' && typeof entry.timestamp.receipt === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(entry.timestamp.receipt),
  'The timestamp receipt was not server-generated in the expected shape.');
  return { ...message, timestamp: entry.timestamp };
}

function budgetDenial(response: ProbeResponse | undefined): boolean {
  if (response?.status !== 429) return false;
  try {
    const payload: unknown = JSON.parse(response.text) as unknown;
    return isRecord(payload) && payload.error === expectedBudgetDenial;
  } catch {
    return false;
  }
}

function budgetUnavailable(response: ProbeResponse | undefined): boolean {
  if (response?.status !== 503) return false;
  try {
    const payload: unknown = JSON.parse(response.text) as unknown;
    return isRecord(payload) && payload.error === expectedBudgetUnavailable;
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => {
    if (error) reject(error);
    else done();
  }));
}

async function main(mode: QualificationMode): Promise<void> {
  validateQualificationEnvironment(mode, process.env);

  const dockerHost = localDockerEndpoint();
  const directory = await mkdtemp(join(tmpdir(), 'hasi-m2-budget-proof-'));
  const commandEnvironment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: directory };
  const dockerEnvironment: NodeJS.ProcessEnv = { ...commandEnvironment, DOCKER_HOST: dockerHost };
  const children: ChildProcess[] = [];
  const servers: Server[] = [];
  const logObservers: ReturnType<typeof createLogObserver>[] = [];
  const routedChats: RoutedChat[] = [];
  const webPorts: number[] = [];
  const apiPorts: number[] = [];
  let identity: Awaited<ReturnType<typeof startTestIdp>> | undefined;
  let authorityStore: PostgresJsonStore | undefined;
  let budgetStore: PostgresJsonStore | undefined;
  let containerName: string | undefined;
  let containerOwnershipLabel: string | undefined;
  let fakeProvider: ReturnType<typeof createFakeProvider> | undefined;
  let webOrigin = '';
  let apiOrigin = '';
  let fakeOrigin = '';
  let apiRoundRobin = 0;
  let webRoundRobin = 0;
  let nextEnvironment: NodeJS.ProcessEnv | undefined;
  let apiEnvironment: NodeJS.ProcessEnv | undefined;

  try {
    webPorts.push(await allocatePort(), await allocatePort());
    apiPorts.push(await allocatePort(), await allocatePort());
    stage = 'disposable-postgres';
    const database = await createDisposableDatabase(dockerEnvironment, (name, ownershipLabel) => {
      containerName = name;
      containerOwnershipLabel = ownershipLabel;
    });
    const connectionString = isolatedDatabaseUrl(database.connectionString, database.port);

    stage = 'ephemeral-tls';
    const tlsKeyPath = join(directory, 'fixture-tls-key.pem');
    const tlsCertPath = join(directory, 'fixture-tls-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', tlsKeyPath, '-out', tlsCertPath,
    ], { stdio: 'ignore', timeout: 30_000, env: commandEnvironment });
    await chmod(tlsKeyPath, 0o600);
    await chmod(tlsCertPath, 0o600);
    const key = await readFile(tlsKeyPath);
    const cert = await readFile(tlsCertPath);

    stage = 'synthetic-test-idp';
    const webProxy = await createTlsProxy(key, cert, () => {
      const selected = webPorts[webRoundRobin % webPorts.length];
      webRoundRobin += 1;
      assert(selected !== undefined, 'A Next.js replica port was not assigned.');
      return selected;
    }, (path, targetPort) => {
      if (path === '/api/chat' && (stage === 'budget-race' || stage === 'budget-restart-proof'
        || stage === 'budget-loss-drill' || stage === 'budget-loss-restart-proof')) {
        routedChats.push({ stage, targetPort });
      }
    });
    servers.push(webProxy.server);
    webOrigin = webProxy.origin;

    const apiProxy = await createTlsProxy(key, cert, () => {
      const selected = apiPorts[apiRoundRobin % apiPorts.length];
      apiRoundRobin += 1;
      assert(selected !== undefined, 'A production API replica port was not assigned.');
      return selected;
    });
    servers.push(apiProxy.server);
    apiOrigin = apiProxy.origin;

    fakeProvider = createFakeProvider(key, cert);
    fakeProvider.server.listen(0, '127.0.0.1');
    await once(fakeProvider.server, 'listening');
    servers.push(fakeProvider.server);
    const providerAddress = fakeProvider.server.address();
    assert(providerAddress && typeof providerAddress !== 'string', 'The fake provider failed to bind to loopback.');
    fakeOrigin = 'https://127.0.0.1:' + String(providerAddress.port);

    identity = await startTestIdp({
      mode: 'test',
      clientId: 'hasi-budget-fixture',
      redirectUri: webOrigin + '/api/auth/callback',
      subject: 'synthetic-budget-operator',
      tls: { key, cert },
    });

    stage = 'preinitialize-isolated-state';
    const scope = randomUUID();
    authorityStore = new PostgresJsonStore('production:' + scope, {
      poolConfig: { connectionString, max: 4 },
    });
    await authorityStore.initialize();
    const authorityKeys = generateKeyPairSync('ed25519');
    const privateKeyPath = join(directory, 'fixture-authority-key.pem');
    await writeFile(privateKeyPath, authorityKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const directoryForRuntime = new ProductionAuthorityDirectory(authorityStore, authorityKeys.privateKey, scope);
    const subject = stableOidcSubject(identity.issuer, 'synthetic-budget-operator');
    const syntheticUser = {
      id: subject,
      displayName: 'Synthetic budget operator',
      role: 'admin' as const,
      actor: { subject, permissions: ['plugins:manage'] },
    };
    assert(await directoryForRuntime.replace(subject, null, syntheticUser), 'The signed synthetic authority record could not be created.');

    const model = createBudgetConfiguration(fakeOrigin);
    const budgetPolicy = {
      ...ASSISTANT_BUDGET_POLICY,
      inputMicroUsdPerMillion: inputRate,
      outputMicroUsdPerMillion: outputRate,
      requireExistingState: true,
    };
    budgetStore = new PostgresJsonStore(ASSISTANT_BUDGET_NAMESPACE, {
      poolConfig: { connectionString, max: 4 },
    });
    await budgetStore.initialize();
    const ownedBudgetStore = budgetStore;
    let budgetLedgerStoreKey: string | undefined;
    const observeBudgetLedgerKey = (key: string) => {
      budgetLedgerStoreKey ??= key;
      assert(budgetLedgerStoreKey === key, 'The budget ledger attempted to access more than its one owned row.');
    };
    const ledgerStore: JsonStore = {
      read: key => { observeBudgetLedgerKey(key); return ownedBudgetStore.read(key); },
      compareAndSet: (key, revision, value, expiresAt) => {
        observeBudgetLedgerKey(key);
        return ownedBudgetStore.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => { observeBudgetLedgerKey(key); return ownedBudgetStore.delete(key); },
    };
    const ledger = new ModelBudgetLedger(ledgerStore, budgetPolicy);

    stage = 'missing-ledger-counterprobe';
    const missingNamespace = 'model-budget-missing-' + randomUUID();
    const missingStore = new PostgresJsonStore(missingNamespace, {
      poolConfig: { connectionString, max: 2 },
    });
    await missingStore.initialize();
    try {
      const missingLedger = new ModelBudgetLedger(missingStore, {
        ...ASSISTANT_BUDGET_POLICY,
        inputMicroUsdPerMillion: inputRate,
        outputMicroUsdPerMillion: outputRate,
        requireExistingState: true,
      });
      let deniedForMissingState = false;
      try {
        await missingLedger.reserve({ id: randomUUID(), inputTokens: 1, outputTokens: 1 });
      } catch (error) {
        deniedForMissingState = isExpectedBudgetError(error);
      }
      assert(deniedForMissingState, 'An uninitialized durable ledger did not fail closed with ModelBudgetError(unavailable).');
    } finally {
      await missingStore.close();
    }

    stage = 'test-process-start';
    const tlsCertDigest = createHash('sha256').update(cert).digest('hex');
    const privateKey = await readFile(privateKeyPath);
    assert(privateKey.length > 0, 'The synthetic API signing key is missing.');
    const apiConfig: ApiConfiguration = {
      scope,
      webOrigin,
      issuer: identity.issuer,
      privateKeyPath,
      port: 0,
    };
    apiEnvironment = {
      TEST_DATABASE_URL: connectionString,
      NODE_EXTRA_CA_CERTS: tlsCertPath,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      HOME: join(directory, 'api-home'),
    };
    await mkdir(join(directory, 'api-home'), { recursive: true, mode: 0o700 });
    for (const apiPort of apiPorts) {
      const path = join(directory, 'api-' + String(apiPort) + '.json');
      await writeFile(path, JSON.stringify({ ...apiConfig, port: apiPort }), { mode: 0o600 });
      const observer = createLogObserver();
      logObservers.push(observer);
      children.push(startChild(['--import', 'tsx', script, '--api', path], apiEnvironment, chunk => { observer.feed(chunk); }));
    }

    const routesPath = join(root, 'apps/web/.next/routes-manifest.json');
    const routes = JSON.parse(await readFile(routesPath, 'utf8')) as { rewrites?: unknown };
    assert(!JSON.stringify(routes.rewrites).includes('/api/:path*'), 'Build the Next.js production app without the development API rewrite.');
    const buildId = (await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')).trim();
    assert(buildId.length > 0, 'The existing Next.js production build is unavailable.');
    const webDirectoryEntries = await readdir(join(root, 'apps/web'));
    assert(!webDirectoryEntries.some(name => name.startsWith('.env') && name !== '.env.example'), 'Do not run the fixture from a web app directory containing .env files.');

    const modelEnvironment = {
      HASI_APP_MODE: 'production',
      HASI_WEB_ORIGIN: webOrigin,
      HASI_API_ORIGIN: apiOrigin,
      HASI_CHAT_SIGNING_SECRET: randomBytes(32).toString('base64url'),
      HASI_LLM_CONFIG: JSON.stringify(model.configuration),
      HASI_MODEL_PRICES: JSON.stringify(model.prices),
      HASI_LLM_SECRET_BUD_A1: fixtureCredential,
      DATABASE_URL: connectionString,
    };
    const home = join(directory, 'web-home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    nextEnvironment = {
      NODE_ENV: 'production',
      NODE_EXTRA_CA_CERTS: tlsCertPath,
      NEXT_TELEMETRY_DISABLED: '1',
      HOME: home,
      ...modelEnvironment,
    };

    await Promise.all(apiPorts.map((port, index) => {
      const process_ = children[index];
      assert(process_, 'A production API child was not started.');
      return readyApi('http://127.0.0.1:' + String(port) + '/health', process_);
    }));
    for (const port of webPorts) {
      const observer = createLogObserver();
      logObservers.push(observer);
      const process_ = startChild([
        join(root, 'apps/web/node_modules/next/dist/bin/next'),
        'start',
        join(root, 'apps/web'),
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ], nextEnvironment, chunk => { observer.feed(chunk); });
      children.push(process_);
    }
    await Promise.all(webPorts.map((port, index) => {
      const process_ = children[apiPorts.length + index];
      assert(process_, 'A Next.js production child was not started.');
      return readyWeb('http://127.0.0.1:' + String(port) + '/', cert, process_);
    }));

    stage = 'production-session';
    assert(webOrigin !== apiOrigin, 'The frontend and API origins must remain separate.');
    assert((await probe(webOrigin + '/', cert)).status === 200, 'The TLS frontend proxy did not serve the shared production build.');
    let untrustedTlsRejected = false;
    try {
      await probe(fakeOrigin + '/v1/chat/completions', undefined, { method: 'POST', body: {} });
    } catch (error) {
      untrustedTlsRejected = safeCode(error) === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        || safeCode(error) === 'SELF_SIGNED_CERT_IN_CHAIN'
        || safeCode(error) === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    }
    assert(untrustedTlsRejected, 'The local fake provider certificate was accepted without the fixture CA.');

    const login = await probe(webOrigin + '/api/auth/login?returnTo=%2F', cert);
    assert(login.status === 302 && typeof login.headers.location === 'string', 'The production OIDC authorization flow did not start.');
    const transaction = login.headers['set-cookie']?.find(value => value.startsWith('hasi-oidc-transaction='));
    assert(transaction, 'The OIDC transaction cookie was not issued.');
    const transactionCookie = transaction.split(';')[0];
    assert(transactionCookie, 'The OIDC transaction cookie was malformed.');
    const authorized = await probe(login.headers.location, cert);
    assert(authorized.status === 302 && typeof authorized.headers.location === 'string', 'The native TLS Test-IdP did not authorize the synthetic identity.');
    const callback = await probe(authorized.headers.location, cert, { cookie: transactionCookie });
    assert(callback.status === 302, 'The production OIDC callback failed.');
    const sessionCookie = callback.headers['set-cookie']?.find(value => value.startsWith('__Host-hasi-session='));
    assert(sessionCookie && /;\s*Secure(?:;|$)/iu.test(sessionCookie)
      && /;\s*HttpOnly(?:;|$)/iu.test(sessionCookie)
      && /;\s*Path=\/(?:;|$)/iu.test(sessionCookie)
      && !/;\s*Domain=/iu.test(sessionCookie),
    'The production session cookie did not remain secure and host-bound.');
    const cookie = sessionCookie.split(';')[0];
    assert(cookie, 'The OIDC session cookie was malformed.');
    const session = await probe(webOrigin + '/api/session', cert, { cookie });
    assert(session.status === 200, 'The synthetic OIDC session was not usable through the frontend.');
    let sessionBody: unknown;
    try {
      sessionBody = JSON.parse(session.text) as unknown;
    } catch {
      throw new QualificationError('The production session endpoint returned invalid JSON.');
    }
    assert(isRecord(sessionBody) && sessionBody.mode === 'oidc'
      && isRecord(sessionBody.user) && sessionBody.user.id === subject,
    'The production API did not resolve the signed synthetic authority.');
    const sessionModelContext = isRecord(sessionBody.modelContext) ? sessionBody.modelContext : undefined;
    const sessionDataClasses = sessionModelContext?.dataClasses;
    assert(Array.isArray(sessionDataClasses)
      && ['public', 'internal', 'confidential'].every(dataClass => sessionDataClasses.includes(dataClass)),
    'The authenticated production session did not expose all three expected model data classes.');
    const profileResponse = await probe(webOrigin + '/api/chat', cert);
    assert(profileResponse.status === 200, 'The production model profile endpoint failed.');
    const profileBody: unknown = JSON.parse(profileResponse.text) as unknown;
    assert(isRecord(profileBody) && Array.isArray(profileBody.profiles)
      && profileBody.profiles.some(profile => isRecord(profile) && profile.id === modelProfileId && profile.configured === true),
    'The local OpenAI-compatible profile was not configured from server-owned fixture inputs.');
    assert(!profileResponse.text.includes(fixtureCredential), 'The synthetic credential was exposed by the profile endpoint.');

    stage = 'missing-ledger-runtime-probe';
    const uninitializedAttempt = makeAttempt(99);
    const uninitializedMessage = await stampMessage(webOrigin, cert, cookie, uninitializedAttempt);
    const uninitializedResponse = await probe(webOrigin + '/api/chat', cert, {
      method: 'POST',
      cookie,
      origin: webOrigin,
      body: {
        profileId: modelProfileId,
        conversationId: uninitializedAttempt.conversationId,
        messages: [uninitializedMessage],
      },
    });
    let unavailablePayload: unknown;
    try {
      unavailablePayload = JSON.parse(uninitializedResponse.text) as unknown;
    } catch {
      throw new QualificationError('The uninitialized budget probe returned invalid JSON.');
    }
    assert(uninitializedResponse.status === 503 && isRecord(unavailablePayload)
      && unavailablePayload.error === expectedBudgetUnavailable,
    'The production chat route did not fail closed with the expected budget_unavailable response.');
    assert(fakeProviderCount(fakeProvider, 'requests') === 0, 'A request reached the fake provider before budget initialization.');
    await waitUntil(
      () => logObservers.reduce((total, observer) => total + observer.unavailable(), 0) >= 1,
      3_000,
      'The production Next.js runtime did not report budget_unavailable for the missing ledger.',
    );
    const budgetUnavailableCodes = logObservers.reduce((total, observer) => total + observer.unavailable(), 0);
    await ledger.initialize();
    const preinitialized = await ledger.snapshot();
    assertBudgetBound(preinitialized);
    assert(preinitialized.initialized && preinitialized.microUsdUsed === 0, 'The isolated shared ledger did not start empty.');

    stage = 'budget-prefill';
    const initial = await ledger.snapshot();
    assert(initial.microUsdUsed === 0, 'The isolated budget was changed before the controlled prefill.');
    const prefillId = randomUUID();
    await ledger.reserve({ id: prefillId, inputTokens: 0, outputTokens: 247_500 });
    await ledger.settle(prefillId);
    const prefetched = await ledger.snapshot();
    assertBudgetBound(prefetched);
    assert(prefetched.microUsdUsed === 990_000
      && prefetched.outputTokensUsed === 247_500
      && prefetched.unknownUsageReservations === 1
      && prefetched.unresolvedReservations === 1,
    'The public ledger prefill did not retain its 990,000-micro-USD conservative reservation.');

    stage = 'budget-race';
    const raceAttempts = Array.from({ length: raceSize }, (_, index) => makeAttempt(index));
    const stampedMessages = await Promise.all(raceAttempts.map(attempt => stampMessage(webOrigin, cert, cookie, attempt)));
    const outcomes = Array.from<ChatAttempt | undefined>({ length: raceSize });
    const responsePromises = raceAttempts.map((attempt, index) => {
      const timestampedMessage = stampedMessages[index];
      assert(timestampedMessage, 'A server timestamp was not returned for a race request.');
      const startedAt = performance.now();
      return probe(webOrigin + '/api/chat', cert, {
        method: 'POST',
        cookie,
        origin: webOrigin,
        body: {
          profileId: modelProfileId,
          conversationId: attempt.conversationId,
          messages: [timestampedMessage],
        },
      }).then(response => {
        const value: ChatAttempt = { ...attempt, startedAt, result: response };
        outcomes[index] = value;
        return value;
      }).catch(() => {
        const value: ChatAttempt = { ...attempt, startedAt, requestFailed: true };
        outcomes[index] = value;
        return value;
      });
    });

    const accountedRace = () => {
      const explicitDenials = outcomes.filter(value => budgetDenial(value?.result)).length;
      return Boolean(fakeProvider && fakeProviderCount(fakeProvider, 'requests') === raceSize - explicitDenials);
    };
    await waitUntil(
      () => Boolean(fakeProvider && fakeProviderCount(fakeProvider, 'requests') >= 1)
        && outcomes.some(value => budgetDenial(value?.result))
        && accountedRace(),
      raceDeadlineMs,
      'The concurrent race did not produce both an admitted provider call and a budget-exhausted response.',
    );
    const inFlight = await ledger.snapshot();
    assertBudgetBound(inFlight);
    const deniedBeforeRelease = outcomes.filter(value => budgetDenial(value?.result)).length;
    const providerInFlight = fakeProviderCount(fakeProvider, 'requests');
    assert(providerInFlight >= 1 && deniedBeforeRelease >= 1 && providerInFlight + deniedBeforeRelease === raceSize,
      'The race did not account for every request as either dispatched or explicitly budget-denied.');
    assert(inFlight.unresolvedReservations === providerInFlight + 1
      && inFlight.unknownUsageReservations === 1
      && inFlight.microUsdUsed > prefetched.microUsdUsed,
    'The held requests were not represented as shared unresolved reservations before provider completion.');
    assert(inFlight.reservationsInWindow === providerInFlight + 1, 'A denied race request created a budget reservation.');
    assert(routedChats.filter(item => item.stage === 'budget-race').length === raceSize
      && new Set(routedChats.filter(item => item.stage === 'budget-race').map(item => item.targetPort)).size === 2,
    'The race did not traverse both separate Next.js processes.');
    await waitUntil(
      () => logObservers.reduce((total, observer) => total + observer.exhausted(), 0) >= deniedBeforeRelease,
      3_000,
      'The Next.js runtime did not log the expected sanitized budget_exhausted code.',
    );
    fakeProvider.release();
    const resolvedRace = await Promise.all(responsePromises);
    assert(resolvedRace.every(value => !value.requestFailed && (value.result?.status === 200 || budgetDenial(value.result))),
      'A race request failed with an unexpected status instead of success or the expected budget denial.');
    const admitted = resolvedRace.filter(value => value.result?.status === 200).length;
    const denied = resolvedRace.filter(value => budgetDenial(value.result)).length;
    assert(admitted >= 1 && denied >= 1 && admitted + denied === raceSize,
      'The race did not produce a successful fake completion and at least one budget denial.');
    assert(fakeProviderCount(fakeProvider, 'requests') === admitted
      && fakeProviderCount(fakeProvider, 'completed') === admitted
      && fakeProviderCount(fakeProvider, 'invalid') === 0,
      'The fake provider request count did not match admitted calls.');
    for (const outcome of resolvedRace) {
      if (outcome.result?.status !== 200) continue;
      let reply: unknown;
      try {
        reply = JSON.parse(outcome.result.text) as unknown;
      } catch {
        throw new QualificationError('The production chat route returned invalid JSON.');
      }
      assert(isRecord(reply) && isRecord(reply.message)
        && reply.message.content === 'Synthetic qualification completed.'
        && isRecord(reply.profile) && reply.profile.id === modelProfileId,
      'The positive local-provider completion did not traverse the real production chat route.');
    }
    const settledRace = await ledger.snapshot();
    assertBudgetBound(settledRace);
    assert(settledRace.unknownUsageReservations === 1
      && settledRace.unresolvedReservations === 1
      && settledRace.reservationsInWindow === admitted + 1,
    'The successful fake calls did not settle while preserving only the synthetic unknown-usage prefill.');
    const deniedLogsBeforeRestart = logObservers.reduce((total, observer) => total + observer.exhausted(), 0);
    assert(deniedLogsBeforeRestart >= denied, 'The application did not record budget_exhausted for each race denial.');

    stage = 'exhaust-remaining-budget';
    const remainingMicroUsd = ASSISTANT_BUDGET_POLICY.microUsdLimit - settledRace.microUsdUsed;
    assert(remainingMicroUsd > 0, 'The race unexpectedly consumed more than the prefilled budget.');
    const finalInputTokens = Number((BigInt(remainingMicroUsd) * 1_000_000n) / BigInt(inputRate));
    assert(finalInputTokens > 0 && finalInputTokens <= settledRace.inputTokenLimit - settledRace.inputTokensUsed,
      'The remaining budget could not be conservatively consumed within the shared input-token ceiling.');
    const finalReservationId = randomUUID();
    await ledger.reserve({ id: finalReservationId, inputTokens: finalInputTokens, outputTokens: 0 });
    await ledger.settle(finalReservationId);
    const exhausted = await ledger.snapshot();
    assertBudgetBound(exhausted);
    assert(exhausted.microUsdUsed === ASSISTANT_BUDGET_POLICY.microUsdLimit,
      'The isolated ledger did not reach the unchanged USD1 ceiling.');

    stage = 'restart-next-replica';
    const nextIndex = apiPorts.length;
    const oldNext = children[nextIndex];
    const firstNextPort = webPorts[0];
    assert(oldNext && firstNextPort !== undefined, 'The first Next.js child was not available for restart proof.');
    const originalPid = oldNext.pid;
    await stopChild(oldNext);
    const observer = createLogObserver();
    logObservers.push(observer);
    const replacement = startChild([
      join(root, 'apps/web/node_modules/next/dist/bin/next'),
      'start',
      join(root, 'apps/web'),
      '--hostname',
      '127.0.0.1',
      '--port',
      String(firstNextPort),
    ], nextEnvironment, chunk => { observer.feed(chunk); });
    children[nextIndex] = replacement;
    await readyWeb('http://127.0.0.1:' + String(firstNextPort) + '/', cert, replacement);
    assert(replacement.pid !== originalPid, 'The replacement Next.js process did not have a new process ID.');

    stage = 'budget-restart-proof';
    const restartAttempts = [makeAttempt(10), makeAttempt(11)];
    const restartMessages = await Promise.all(restartAttempts.map(attempt => stampMessage(webOrigin, cert, cookie, attempt)));
    const restartOutcomes = await Promise.all(restartAttempts.map(async (attempt, index) => {
      const message = restartMessages[index];
      assert(message, 'A restart-probe timestamp was not returned.');
      try {
        const result = await probe(webOrigin + '/api/chat', cert, {
          method: 'POST',
          cookie,
          origin: webOrigin,
          body: { profileId: modelProfileId, conversationId: attempt.conversationId, messages: [message] },
        });
        return { result, elapsedMs: result.elapsedMs };
      } catch {
        return { result: undefined, elapsedMs: 0 };
      }
    }));
    assert(restartOutcomes.every(value => budgetDenial(value.result)),
      'Both Next.js replicas must return the exact budget-exhausted response after the ledger is full.');
    assert(fakeProviderCount(fakeProvider, 'requests') === admitted
      && fakeProviderCount(fakeProvider, 'completed') === admitted,
      'A request denied after the restart reached the fake provider.');
    const restartRoutes = routedChats.filter(item => item.stage === 'budget-restart-proof');
    assert(restartRoutes.length === 2 && new Set(restartRoutes.map(item => item.targetPort)).size === 2
      && webPorts.every(port => restartRoutes.some(route => route.targetPort === port)),
    'The exhausted-ledger proof did not route one request through each live Next.js process.');
    await waitUntil(
      () => logObservers.reduce((total, item) => total + item.exhausted(), 0) >= deniedLogsBeforeRestart + 2,
      3_000,
      'The restarted and surviving Next.js processes did not report the expected budget_exhausted code.',
    );
    const afterRestart = await ledger.snapshot();
    assertBudgetBound(afterRestart);
    assert(afterRestart.microUsdUsed === ASSISTANT_BUDGET_POLICY.microUsdLimit
      && afterRestart.reservationsInWindow === admitted + 2
      && afterRestart.unresolvedReservations === 2
      && afterRestart.unknownUsageReservations === 2
      && afterRestart.reservationsInWindow === exhausted.reservationsInWindow,
    'The restart proof changed shared ledger usage or created denied reservations.');

    let stateLossDrill: Record<string, unknown> | undefined;
    if (mode === 'state-loss-drill') {
      stage = 'budget-loss-drill';
      assert(budgetLedgerStoreKey !== undefined, 'The owned budget ledger key was not observed.');
      const removedLedgerKey = budgetLedgerStoreKey;
      const actualOwnershipLabel = containerName && containerOwnershipLabel
        ? ownedContainerLabel(containerName, dockerEnvironment)
        : undefined;
      assertOwnedBudgetLedgerRemoval({
        mode,
        namespace: ASSISTANT_BUDGET_NAMESPACE,
        ledgerKey: removedLedgerKey,
        containerName: containerName ?? '',
        expectedOwnerLabel: containerOwnershipLabel ?? '',
        actualOwnerLabel: actualOwnershipLabel,
      });
      const spentLedgerRow = await ownedBudgetStore.read(removedLedgerKey);
      assert(spentLedgerRow !== undefined, 'The spent fixture ledger row was already missing before the state-loss drill.');

      // Delete exactly the owned ledger row after synthetic spending. The identity/session rows and table remain intact.
      await ownedBudgetStore.delete(removedLedgerKey);
      assert(await ownedBudgetStore.read(removedLedgerKey) === undefined,
        'The owned fixture ledger row remained visible after deletion.');
      const lossDetectedAt = Date.now();
      const providerRequestsAtLoss = fakeProviderCount(fakeProvider, 'requests');
      const unavailableLogsBeforeLoss = logObservers.reduce((total, observer) => total + observer.unavailable(), 0);

      const postUnavailableChat = async (index: number): Promise<ProbeResponse> => {
        const attempt = makeAttempt(index);
        const message = await stampMessage(webOrigin, cert, cookie, attempt);
        return probe(webOrigin + '/api/chat', cert, {
          method: 'POST',
          cookie,
          origin: webOrigin,
          body: { profileId: modelProfileId, conversationId: attempt.conversationId, messages: [message] },
        });
      };

      const lossOutcomes = await Promise.all([postUnavailableChat(20), postUnavailableChat(21)]);
      assert(lossOutcomes.every(budgetUnavailable),
        'Both live Next.js processes must return budget_unavailable after spent accounting is removed.');
      const lossRoutes = routedChats.filter(item => item.stage === 'budget-loss-drill');
      assert(lossRoutes.length === 2 && new Set(lossRoutes.map(item => item.targetPort)).size === 2
        && webPorts.every(port => lossRoutes.some(route => route.targetPort === port)),
      'The missing-accounting probes did not traverse both live Next.js processes.');
      assert(fakeProviderCount(fakeProvider, 'requests') === providerRequestsAtLoss,
        'A request reached the fake provider after spent accounting was removed.');
      assert(await ownedBudgetStore.read(removedLedgerKey) === undefined,
        'The missing-accounting route created a fresh budget row.');
      await waitUntil(
        () => logObservers.reduce((total, observer) => total + observer.unavailable(), 0) >= unavailableLogsBeforeLoss + 2,
        3_000,
        'Both live Next.js processes did not report budget_unavailable after the state loss.',
      );

      stage = 'budget-loss-restart-proof';
      const nextIndex = apiPorts.length;
      const oldNext = children[nextIndex];
      const firstNextPort = webPorts[0];
      assert(oldNext && firstNextPort !== undefined, 'The first Next.js process was not available for the state-loss restart proof.');
      const originalPid = oldNext.pid;
      await stopChild(oldNext);
      const observer = createLogObserver();
      logObservers.push(observer);
      const replacement = startChild([
        join(root, 'apps/web/node_modules/next/dist/bin/next'),
        'start',
        join(root, 'apps/web'),
        '--hostname',
        '127.0.0.1',
        '--port',
        String(firstNextPort),
      ], nextEnvironment, chunk => { observer.feed(chunk); });
      children[nextIndex] = replacement;
      await readyWeb('http://127.0.0.1:' + String(firstNextPort) + '/', cert, replacement);
      assert(replacement.pid !== originalPid, 'The state-loss replacement Next.js process did not get a new process ID.');

      const restartUnavailableLogsBefore = logObservers.reduce((total, item) => total + item.unavailable(), 0);
      const lossRestartOutcomes = await Promise.all([postUnavailableChat(22), postUnavailableChat(23)]);
      assert(lossRestartOutcomes.every(budgetUnavailable),
        'Both Next.js processes must return budget_unavailable after process replacement with missing accounting.');
      const lossRestartRoutes = routedChats.filter(item => item.stage === 'budget-loss-restart-proof');
      assert(lossRestartRoutes.length === 2 && new Set(lossRestartRoutes.map(item => item.targetPort)).size === 2
        && webPorts.every(port => lossRestartRoutes.some(route => route.targetPort === port)),
      'The post-loss retry probes did not traverse both surviving and replaced Next.js processes.');
      assert(fakeProviderCount(fakeProvider, 'requests') === providerRequestsAtLoss,
        'A retry or restarted process reached the fake provider while accounting was missing.');
      assert(await ownedBudgetStore.read(removedLedgerKey) === undefined,
        'A retry or restarted process created a fresh budget row.');
      await waitUntil(
        () => logObservers.reduce((total, item) => total + item.unavailable(), 0) >= restartUnavailableLogsBefore + 2,
        3_000,
        'The post-loss retry and replacement process did not report budget_unavailable.',
      );

      // Use the real PostgreSQL row with an injected clock to qualify the UTC hold without waiting a full day.
      // This is ledger-level evidence; it does not change the production router's wall clock.
      const safeRecoveryAt = budgetRecoverySafeAt(lossDetectedAt);
      let recoveryNow = lossDetectedAt;
      const recoveryLedger = new ModelBudgetLedger(ownedBudgetStore, { ...budgetPolicy, now: () => recoveryNow });
      const assertRecoveryDenied = async (id: string): Promise<void> => {
        let deniedForMissingAccounting = false;
        try {
          await recoveryLedger.reserve({ id, inputTokens: 1, outputTokens: 1 });
        } catch (error) {
          deniedForMissingAccounting = isExpectedBudgetError(error);
        }
        assert(deniedForMissingAccounting, 'The missing PostgreSQL ledger did not fail closed at the simulated time.');
        assert(await ownedBudgetStore.read(removedLedgerKey) === undefined,
          'A denied ledger-level attempt created a budget row.');
      };

      await assertRecoveryDenied('state-loss-before-boundary');
      const currentWindowEnd = Math.floor(lossDetectedAt / ASSISTANT_BUDGET_POLICY.windowMs)
        * ASSISTANT_BUDGET_POLICY.windowMs + ASSISTANT_BUDGET_POLICY.windowMs;
      recoveryNow = currentWindowEnd;
      await assertRecoveryDenied('state-loss-after-boundary-before-initialize');
      recoveryNow = safeRecoveryAt - 1;
      let prematureInitializationBlocked = false;
      try {
        assertBudgetRecoveryBoundaryPassed(recoveryNow, lossDetectedAt);
      } catch {
        prematureInitializationBlocked = true;
      }
      assert(prematureInitializationBlocked, 'The recovery boundary guard allowed initialization before its safety margin.');
      recoveryNow = safeRecoveryAt;
      assert(assertBudgetRecoveryBoundaryPassed(recoveryNow, lossDetectedAt) === safeRecoveryAt,
        'The recovery boundary guard returned an unexpected safe time.');
      await assertRecoveryDenied('state-loss-at-safe-boundary-before-initialize');

      // Mirrors the explicit operator initializer only after the runbook's safe UTC boundary.
      await recoveryLedger.initialize();
      const initializedAfterWindow = await recoveryLedger.snapshot();
      assertBudgetBound(initializedAfterWindow);
      assert(initializedAfterWindow.initialized && initializedAfterWindow.windowStart === currentWindowEnd
        && initializedAfterWindow.microUsdUsed === 0,
      'Explicit initialization after the safe boundary did not create an empty current-window ledger.');
      const recoveredReservationId = randomUUID();
      await recoveryLedger.reserve({ id: recoveredReservationId, inputTokens: 1, outputTokens: 1 });
      await recoveryLedger.settle(recoveredReservationId, { inputTokens: 1, outputTokens: 1 });
      const recoveredLedger = await recoveryLedger.snapshot();
      assertBudgetBound(recoveredLedger);
      assert(recoveredLedger.microUsdUsed > 0, 'The explicitly initialized PostgreSQL ledger did not admit a bounded synthetic reservation.');
      stateLossDrill = {
        scope: 'missing-accounting-after-synthetic-spending',
        spentBeforeRemovalMicroUsd: afterRestart.microUsdUsed,
        onlyOwnedBudgetLedgerRowRemoved: true,
        productionChatUnavailableResponses: lossOutcomes.length + lossRestartOutcomes.length,
        replacementProcessStarted: true,
        replacementAndSurvivingReplicasDenied: true,
        budgetRowCreatedByDeniedRequests: false,
        providerRequestsBeforeRemoval: providerRequestsAtLoss,
        providerRequestsAfterLossRetries: fakeProviderCount(fakeProvider, 'requests'),
        latestPossibleProviderDispatchAt: new Date(lossDetectedAt).toISOString(),
        nextUtcWindowEnd: new Date(currentWindowEnd).toISOString(),
        safeRecoveryAt: new Date(safeRecoveryAt).toISOString(),
        deniedBeforeWindowEnd: true,
        deniedAfterWindowEndUntilExplicitInitialization: true,
        initializedAfterSafeBoundary: true,
        recoveredWindowStart: new Date(initializedAfterWindow.windowStart).toISOString(),
        recoveredLedgerLevelMicroUsdUsed: recoveredLedger.microUsdUsed,
        clockPhase: 'real-postgresql-ledger-with-injected-clock; not production-router wall clock',
        realProviderCalls: 0,
      };
    }

    stage = 'qualification-output';
    const raceLatencies = resolvedRace.map(value => value.result?.elapsedMs ?? 0).sort((left, right) => left - right);
    const percentile = (values: readonly number[], p: number) => Math.round((values[Math.ceil(values.length * p) - 1] ?? 0) * 100) / 100;
    qualificationReport = {
      event: 'model_budget_topology_qualified',
      scope: 'isolated-synthetic-openai-compatible',
      node: process.version,
      apiProcesses: 2,
      nextProcesses: 2,
      sharedPostgres: true,
      oidcSession: true,
      trustedTlsOnly: true,
      budgetPolicyDigest: policyDigest(),
      budget: {
        windowMs: afterRestart.windowEnd - afterRestart.windowStart,
        inputTokenLimit: afterRestart.inputTokenLimit,
        outputTokenLimit: afterRestart.outputTokenLimit,
        microUsdLimit: afterRestart.microUsdLimit,
        inputTokensUsed: afterRestart.inputTokensUsed,
        outputTokensUsed: afterRestart.outputTokensUsed,
        prefillsMicroUsd: 990_000,
        prefillIsUnknownUsageReservation: true,
        finalMicroUsdUsed: afterRestart.microUsdUsed,
      },
      missingLedger: {
        failsClosed: true,
        status: uninitializedResponse.status,
        budgetUnavailableCodes,
        providerRequestsBeforeInitialization: 0,
      },
      race: {
        requests: raceSize,
        admitted,
        denied,
        providerRequests: fakeProviderCount(fakeProvider, 'requests'),
        providerResponses: fakeProviderCount(fakeProvider, 'completed'),
        deniedBeforeProviderRelease: deniedBeforeRelease,
        budgetExhaustedCodes: deniedLogsBeforeRestart,
        p50Ms: percentile(raceLatencies, 0.5),
        p95Ms: percentile(raceLatencies, 0.95),
      },
      restartProof: {
        processReplaced: true,
        replicasBudgetDenied: restartOutcomes.length,
        budgetExhaustedCodes: 2,
        providerRequestsAfterRestart: fakeProviderCount(fakeProvider, 'requests') - admitted,
        deniedReservations: afterRestart.reservationsInWindow - exhausted.reservationsInWindow,
      },
      ...(stateLossDrill ? { stateLossDrill } : {}),
      businessActions: 0,
      realProviderCalls: 0,
      remaining: ['full-model-and-budget-evaluation', 'browser-workflows', 'institutional-data-approval'],
      tlsCertificateDigest: tlsCertDigest,
    };
  } finally {
    stage = 'cleanup';
    const cleanupFailures: unknown[] = [];
    const childCleanup = await Promise.allSettled(children.map(stopChild));
    cleanupFailures.push(...childCleanup.filter(result => result.status === 'rejected'));
    const serverCleanup = await Promise.allSettled(servers.map(closeServer));
    cleanupFailures.push(...serverCleanup.filter(result => result.status === 'rejected'));
    const serviceCleanup: Promise<unknown>[] = [];
    if (identity) serviceCleanup.push(identity.close());
    if (authorityStore) serviceCleanup.push(authorityStore.close());
    if (budgetStore) serviceCleanup.push(budgetStore.close());
    const serviceResults = await Promise.allSettled(serviceCleanup);
    cleanupFailures.push(...serviceResults.filter(result => result.status === 'rejected'));
    if (containerName) {
      try {
        assert(containerOwnershipLabel, 'The disposable PostgreSQL ownership label is unavailable.');
        removeOwnedContainer(containerName, containerOwnershipLabel, dockerEnvironment);
      } catch {
        cleanupFailures.push(new Error('The disposable PostgreSQL container could not be removed.'));
      }
    }
    await rm(directory, { recursive: true, force: true });
    assert(cleanupFailures.length === 0, 'One or more owned qualification resources could not be cleaned up.');
  }
  assert(qualificationReport, 'The budget qualification did not produce a verified report.');
  console.info(JSON.stringify(qualificationReport));
}

async function runCli(): Promise<void> {
  try {
    if (process.argv[2] === '--api') {
      const configurationPath = process.argv[3];
      assert(configurationPath, 'Missing synthetic API fixture configuration.');
      await apiChild(configurationPath);
      return;
    }
    await main(parseQualificationMode(process.argv.slice(2)));
  } catch (error: unknown) {
    const frame = error instanceof Error
      ? error.stack?.split('\n').find(line => line.includes(script))?.match(/:(\d+):(\d+)\)?$/u)?.[1]
      : undefined;
    const reason = error instanceof QualificationError ? error.message : 'Check the isolated fixture prerequisites.';
    console.error((process.argv[2] === '--api' ? 'Synthetic production API startup failed.' : 'Model budget topology qualification failed at ' + stage)
      + (frame ? ' (script line ' + frame + ')' : '') + ': ' + reason);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === script) {
  await runCli();
}
