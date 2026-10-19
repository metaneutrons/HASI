import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';

/** Verifies durable route metadata only; this test does not assess containers, health, or traffic. */

type ActivateInput = Parameters<PluginRouteController['activate']>[0];
type RollbackInput = Parameters<PluginRouteController['rollback']>[0];
type ConfigurationInput = Parameters<PluginRouteController['updateConfigurationRevision']>[0];

type WorkerCommand =
  | { readonly kind: 'connect'; readonly databaseUrl: string; readonly namespace: string; readonly scope: string; readonly ownerId: string }
  | { readonly kind: 'initialize-installation'; readonly installationId: string; readonly configurationRevision: string }
  | { readonly kind: 'activate'; readonly input: ActivateInput }
  | { readonly kind: 'activate-and-exit'; readonly input: ActivateInput }
  | { readonly kind: 'rollback'; readonly input: RollbackInput }
  | { readonly kind: 'update-configuration'; readonly input: ConfigurationInput }
  | { readonly kind: 'inspect'; readonly installationId: string; readonly operationIds: readonly string[] }
  | { readonly kind: 'shutdown' };

interface WorkerReply {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

interface PendingRequest {
  resolve(value: WorkerReply): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerProcess {
  readonly child: ChildProcess;
  readonly pending: Map<string, PendingRequest>;
  readonly exited: Promise<void>;
  bootId: string;
  pid: number;
  didExit: boolean;
  stopPromise?: Promise<void>;
}

interface MutationReply {
  readonly status: 'resolved' | 'rejected';
  readonly outcome?: string;
}

interface Inspection {
  readonly activeRoute: { readonly deploymentId: string; readonly releaseDigest: string } | null;
  readonly snapshot: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly configurationRevision: string;
    readonly routeRevision: number;
    readonly active: { readonly deploymentId: string; readonly releaseDigest: string } | null;
  };
  readonly operations: Readonly<Record<string, string>>;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const CHILD_TIMEOUT_MS = 10_000;
const OWNER_ID = 'operator-plugin-route-postgres';
const INITIAL_CONFIGURATION = 'configuration-revision-1';
const NEXT_CONFIGURATION = 'configuration-revision-2';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let childTsconfigPath: string | undefined;

function validateLiteralLoopbackDatabaseUrl(value: string): string {
  if (value.length > 2_048) throw new TypeError('TEST_DATABASE_URL is too long.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('TEST_DATABASE_URL is invalid.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  const addressFamily = isIP(hostname);
  const loopback = addressFamily === 4 ? hostname.startsWith('127.') : addressFamily === 6 && hostname === '::1';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !loopback || !parsed.port || parsed.search || parsed.hash || parsed.pathname.length < 2) {
    throw new TypeError('TEST_DATABASE_URL must use a literal loopback address, include a database path, and have no query or fragment.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReply(value: unknown): WorkerReply | undefined {
  if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') return undefined;
  return value as unknown as WorkerReply;
}

async function startWorker(activeWorkers: WorkerProcess[]): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    fileURLToPath(new URL('./fixtures/plugin-route-process.ts', import.meta.url)),
  ], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? '',
      ...(childTsconfigPath ? { TSX_TSCONFIG_PATH: childTsconfigPath } : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  let markExited!: () => void;
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  const worker: WorkerProcess = {
    child,
    pending: new Map(),
    exited,
    bootId: '',
    pid: -1,
    didExit: false,
  };
  activeWorkers.push(worker);

  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  let readySettled = false;
  const readyTimer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      failReady(new Error('The PostgreSQL route child did not become ready.'));
    }
  }, CHILD_TIMEOUT_MS);

  child.on('message', (message: unknown) => {
    if (isRecord(message) && message.kind === 'ready' && typeof message.bootId === 'string' && typeof message.pid === 'number') {
      if (!readySettled) {
        readySettled = true;
        worker.bootId = message.bootId;
        worker.pid = message.pid;
        markReady();
      }
      return;
    }
    const reply = parseReply(message);
    if (!reply) return;
    const pending = worker.pending.get(reply.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    worker.pending.delete(reply.requestId);
    pending.resolve(reply);
  });

  child.once('error', () => {
    if (!readySettled) {
      readySettled = true;
      failReady(new Error('The PostgreSQL route child could not start.'));
    }
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The PostgreSQL route child stopped unexpectedly.'));
    }
    worker.pending.clear();
  });

  child.once('exit', () => {
    worker.didExit = true;
    markExited();
    if (!readySettled) {
      readySettled = true;
      failReady(new Error('The PostgreSQL route child exited before becoming ready.'));
    }
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The PostgreSQL route child exited during a command.'));
    }
    worker.pending.clear();
  });

  try {
    await ready;
    return worker;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
}

function request(worker: WorkerProcess, command: WorkerCommand, timeoutMs = CHILD_TIMEOUT_MS): Promise<WorkerReply> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(requestId);
      reject(new Error(`PostgreSQL route child command timed out: ${command.kind}.`));
    }, timeoutMs);
    worker.pending.set(requestId, { resolve, reject, timer });
    try {
      worker.child.send({ requestId, command }, error => {
        if (error) {
          const pending = worker.pending.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          worker.pending.delete(requestId);
          pending.reject(new Error(`PostgreSQL route child could not accept ${command.kind}.`));
        }
      });
    } catch {
      clearTimeout(timer);
      worker.pending.delete(requestId);
      reject(new Error(`PostgreSQL route child could not accept ${command.kind}.`));
    }
  });
}

async function call<T>(worker: WorkerProcess, command: WorkerCommand): Promise<T> {
  const reply = await request(worker, command);
  if (!reply.ok) throw new Error(`PostgreSQL route child command failed: ${command.kind} (${reply.error ?? 'unknown'}).`);
  return reply.result as T;
}

async function waitForExit(worker: WorkerProcess, timeoutMs: number): Promise<boolean> {
  if (worker.didExit) return true;
  return await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { resolve(false); }, timeoutMs);
    void worker.exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopWorker(worker: WorkerProcess): Promise<void> {
  if (worker.stopPromise) {
    await worker.stopPromise;
    return;
  }
  worker.stopPromise = (async () => {
    if (worker.didExit) return;
    if (worker.child.connected) {
      try {
        await call(worker, { kind: 'shutdown' });
      } catch {
        // The bounded signal escalation below handles an unresponsive child.
      }
    }
    if (await waitForExit(worker, 3_000)) return;
    worker.child.kill('SIGTERM');
    if (await waitForExit(worker, 1_000)) return;
    worker.child.kill('SIGKILL');
    if (!await waitForExit(worker, 1_000)) throw new Error('PostgreSQL route child did not exit after SIGKILL.');
  })();
  await worker.stopPromise;
}

function releaseDigest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function activation(overrides: Partial<ActivateInput> = {}): ActivateInput {
  return {
    ownerId: OWNER_ID,
    installationId: 'installation-not-initialized',
    operationId: `operation-${randomUUID()}`,
    candidateDeploymentId: `deployment-${randomUUID()}`,
    candidateReleaseDigest: releaseDigest(randomUUID()),
    previousDeploymentId: null,
    baseCurrentDigest: null,
    configurationRevision: INITIAL_CONFIGURATION,
    ...overrides,
  };
}

describe('PostgreSQL route test URL guard', () => {
  it.each([
    ['remote host', 'postgresql://postgres@db.example:5432/unit-test-db'],
    ['hostname alias', 'postgresql://postgres@localhost:5432/unit-test-db'],
    ['missing explicit port', 'postgresql://postgres@127.0.0.1/unit-test-db'],
    ['query override', 'postgresql://postgres@127.0.0.1:5432/unit-test-db?options=-csearch_path%3Dother'],
    ['fragment', 'postgresql://postgres@127.0.0.1:5432/unit-test-db#other'],
    ['missing database path', 'postgresql://postgres@127.0.0.1:5432/'],
  ])('rejects a %s', (_label, value) => {
    expect(() => validateLiteralLoopbackDatabaseUrl(value)).toThrow(TypeError);
  });

  it('accepts an explicit PostgreSQL database on a literal loopback address', () => {
    expect(validateLiteralLoopbackDatabaseUrl('postgresql://postgres@127.0.0.1:5432/unit-test-db'))
      .toBe('postgresql://postgres@127.0.0.1:5432/unit-test-db');
  });

  it('accepts IPv6 loopback literals', () => {
    expect(validateLiteralLoopbackDatabaseUrl('postgresql://postgres@[::1]:5432/unit-test-db'))
      .toBe('postgresql://postgres@[::1]:5432/unit-test-db');
  });
});

if (testDatabaseUrl === undefined) {
  describe.skip('PostgreSQL plugin route metadata across processes (requires TEST_DATABASE_URL)', () => {
    it('runs when TEST_DATABASE_URL is configured', () => undefined);
  });
} else {
  const databaseUrl = validateLiteralLoopbackDatabaseUrl(testDatabaseUrl);
  describe('PostgreSQL plugin route metadata across processes', () => {
    const namespace = `plugin-route-process-${randomUUID()}`;
    const scope = `plugin-route-process-${randomUUID()}`;
    const installationId = `installation-${randomUUID()}`;
    const activeWorkers: WorkerProcess[] = [];
    let replicaA: WorkerProcess;
    let replicaB: WorkerProcess;

    beforeAll(async () => {
      const configDirectory = await mkdtemp(join(tmpdir(), 'hasi-plugin-route-child-'));
      childTsconfigPath = join(configDirectory, 'tsconfig.json');
      await writeFile(childTsconfigPath, JSON.stringify({
        compilerOptions: {
          baseUrl: projectRoot,
          paths: { '@hasi/plugin-sdk': ['packages/plugin-sdk/src/index.ts'] },
        },
      }));
      [replicaA, replicaB] = await Promise.all([
        startWorker(activeWorkers),
        startWorker(activeWorkers),
      ]);
      await Promise.all([replicaA, replicaB].map(worker => call(worker, {
        kind: 'connect', databaseUrl, namespace, scope, ownerId: OWNER_ID,
      })));
    }, 30_000);

    afterAll(async () => {
      try {
        await Promise.all(activeWorkers.map(stopWorker));
      } finally {
        if (childTsconfigPath) {
          await rm(join(childTsconfigPath, '..'), { recursive: true, force: true });
          childTsconfigPath = undefined;
        }
      }
    }, 20_000);

    it('serializes competing route mutations and persists route metadata and journal after a child restart', async () => {
      await call(replicaA, {
        kind: 'initialize-installation',
        installationId,
        configurationRevision: INITIAL_CONFIGURATION,
      });

      const left = activation({ installationId, operationId: `race-left-${randomUUID()}` });
      const right = activation({ installationId, operationId: `race-right-${randomUUID()}` });
      const race = await Promise.all([
        call<MutationReply>(replicaA, { kind: 'activate', input: left }),
        call<MutationReply>(replicaB, { kind: 'activate', input: right }),
      ]);
      expect(race.map(result => result.status).sort()).toEqual(['rejected', 'resolved']);

      const raceState = await call<Inspection>(replicaA, {
        kind: 'inspect', installationId, operationIds: [left.operationId, right.operationId],
      });
      const leftOutcome = raceState.operations[left.operationId];
      const rightOutcome = raceState.operations[right.operationId];
      expect([leftOutcome, rightOutcome].sort()).toEqual(['committed', 'not-committed']);
      const winnerIndex = leftOutcome === 'committed' ? 0 : 1;
      const winner = winnerIndex === 0 ? left : right;
      const retryWorker = winnerIndex === 0 ? replicaB : replicaA;
      expect(race[winnerIndex].status).toBe('resolved');
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      expect(race[loserIndex].status).toBe('rejected');
      expect(raceState.activeRoute).toEqual({
        deploymentId: winner.candidateDeploymentId,
        releaseDigest: winner.candidateReleaseDigest,
      });

      const later = activation({
        installationId,
        operationId: `later-${randomUUID()}`,
        previousDeploymentId: winner.candidateDeploymentId,
        baseCurrentDigest: winner.candidateReleaseDigest,
      });
      expect((await call<MutationReply>(replicaA, { kind: 'activate', input: later })).status).toBe('resolved');
      expect((await call<MutationReply>(retryWorker, { kind: 'activate', input: winner })).status).toBe('resolved');
      const afterRetry = await call<Inspection>(replicaB, {
        kind: 'inspect', installationId, operationIds: [winner.operationId, later.operationId],
      });
      expect(afterRetry.activeRoute).toEqual({
        deploymentId: later.candidateDeploymentId,
        releaseDigest: later.candidateReleaseDigest,
      });
      expect(afterRetry.operations[winner.operationId]).toBe('committed');

      await call(replicaB, {
        kind: 'update-configuration',
        input: {
          ownerId: OWNER_ID,
          installationId,
          expectedRevision: INITIAL_CONFIGURATION,
          configurationRevision: NEXT_CONFIGURATION,
        },
      });
      const stale = activation({
        installationId,
        operationId: `stale-${randomUUID()}`,
        previousDeploymentId: later.candidateDeploymentId,
        baseCurrentDigest: later.candidateReleaseDigest,
        configurationRevision: INITIAL_CONFIGURATION,
      });
      expect((await call<MutationReply>(replicaA, { kind: 'activate', input: stale })).status).toBe('rejected');

      const rollbackBase: RollbackInput = {
        ownerId: OWNER_ID,
        installationId,
        operationId: `rollback-valid-${randomUUID()}`,
        currentDeploymentId: later.candidateDeploymentId,
        currentReleaseDigest: later.candidateReleaseDigest,
        previousDeploymentId: winner.candidateDeploymentId,
        previousReleaseDigest: winner.candidateReleaseDigest,
        baseCurrentDigest: later.candidateReleaseDigest,
        configurationRevision: NEXT_CONFIGURATION,
      };
      const wrongDeploymentRollback = {
        ...rollbackBase,
        operationId: `rollback-wrong-deployment-${randomUUID()}`,
        currentDeploymentId: `deployment-${randomUUID()}`,
      };
      const wrongDigest = releaseDigest(`wrong-${randomUUID()}`);
      const wrongDigestRollback = {
        ...rollbackBase,
        operationId: `rollback-wrong-digest-${randomUUID()}`,
        currentReleaseDigest: wrongDigest,
        baseCurrentDigest: wrongDigest,
      };
      expect((await call<MutationReply>(replicaA, { kind: 'rollback', input: wrongDeploymentRollback })).status).toBe('rejected');
      expect((await call<MutationReply>(replicaB, { kind: 'rollback', input: wrongDigestRollback })).status).toBe('rejected');
      expect((await call<MutationReply>(replicaA, { kind: 'rollback', input: rollbackBase })).status).toBe('resolved');

      const journalIds = [
        left.operationId,
        right.operationId,
        later.operationId,
        stale.operationId,
        wrongDeploymentRollback.operationId,
        wrongDigestRollback.operationId,
        rollbackBase.operationId,
      ];
      const beforeRestart = await call<Inspection>(replicaB, { kind: 'inspect', installationId, operationIds: journalIds });
      expect(beforeRestart.snapshot).toMatchObject({
        ownerId: OWNER_ID,
        installationId,
        configurationRevision: NEXT_CONFIGURATION,
        routeRevision: 4,
      });
      expect(beforeRestart.activeRoute).toEqual({
        deploymentId: winner.candidateDeploymentId,
        releaseDigest: winner.candidateReleaseDigest,
      });
      expect(beforeRestart.operations).toEqual({
        [left.operationId]: leftOutcome,
        [right.operationId]: rightOutcome,
        [later.operationId]: 'committed',
        [stale.operationId]: 'not-committed',
        [wrongDeploymentRollback.operationId]: 'not-committed',
        [wrongDigestRollback.operationId]: 'not-committed',
        [rollbackBase.operationId]: 'committed',
      });

      const committedWithoutReply = activation({
        installationId,
        operationId: `activate-lost-reply-${randomUUID()}`,
        previousDeploymentId: winner.candidateDeploymentId,
        baseCurrentDigest: winner.candidateReleaseDigest,
        configurationRevision: NEXT_CONFIGURATION,
      });
      const lostReplyPid = replicaB.pid;
      const lostReplyBootId = replicaB.bootId;
      await expect(request(replicaB, { kind: 'activate-and-exit', input: committedWithoutReply }))
        .rejects.toThrow(/exited during a command/u);
      expect(await waitForExit(replicaB, 1_000)).toBe(true);

      replicaB = await startWorker(activeWorkers);
      expect(replicaB.pid).not.toBe(lostReplyPid);
      expect(replicaB.bootId).not.toBe(lostReplyBootId);
      await call(replicaB, { kind: 'connect', databaseUrl, namespace, scope, ownerId: OWNER_ID });
      const reconciledIds = [...journalIds, committedWithoutReply.operationId];
      const afterLostReply = await call<Inspection>(replicaB, { kind: 'inspect', installationId, operationIds: reconciledIds });
      expect(afterLostReply.snapshot.routeRevision).toBe(beforeRestart.snapshot.routeRevision + 1);
      expect(afterLostReply.activeRoute).toEqual({
        deploymentId: committedWithoutReply.candidateDeploymentId,
        releaseDigest: committedWithoutReply.candidateReleaseDigest,
      });
      expect(afterLostReply.operations[committedWithoutReply.operationId]).toBe('committed');

      expect((await call<MutationReply>(replicaB, { kind: 'activate', input: committedWithoutReply })).status).toBe('resolved');
      const afterReplay = await call<Inspection>(replicaB, { kind: 'inspect', installationId, operationIds: reconciledIds });
      expect(afterReplay.activeRoute).toEqual(afterLostReply.activeRoute);
      expect(afterReplay.snapshot).toEqual(afterLostReply.snapshot);
      expect(afterReplay.operations).toEqual(afterLostReply.operations);
    }, 45_000);
  });
}
