import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { createPluginServer, digest, type PluginManifest } from '@hasi/plugin-sdk';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_COMMIT = 'e9a28743d5fe2338509d6c9e5f4bd4dda1c33501';
const WORKER_PATH = join(ROOT, 'scripts/core-epoch-cutover-worker.ts');
const OWNER_KIND = 'core-epoch-cutover-owner-v1';
const SESSION_KIND = 'synthetic-session-sentinel-v1';
const BUDGET_KIND = 'synthetic-budget-sentinel-v1';
const PROPOSAL_KIND = 'synthetic-proposal-binding-sentinel-v1';
const MAX_WORKER_OUTPUT_BYTES = 16_384;
const MAX_WORKER_DIAGNOSTIC_BYTES = 8_192;

type Environment = Readonly<Record<string, string | undefined>>;
type WorkerMode = 'legacy-seed' | 'epoch-transition' | 'epoch-forward' | 'legacy-probe';
interface WorkerConfig {
  version: 1;
  mode: WorkerMode;
  databaseUrl: string;
  legacyRoot: string;
  namespace: string;
  nonce: string;
  pluginId: string;
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  privateKeyPem: string;
  expectedLegacyBinding?: string;
  expectedLegacyStateRevision?: string;
  expectedEpoch?: string;
  expectedEpochStateRevision?: string;
}
type WorkerMessage = Record<string, unknown> & { event: string };
interface QualificationKeys {
  owner: string;
  registry: string;
  session: string;
  budget: string;
  proposal: string;
  settings: string;
}
interface WorkerHandle {
  child: ChildProcess;
  pid: number;
  message: Promise<WorkerMessage>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  outputFailure: string | undefined;
  diagnosticBytes: number;
}

class QualificationFailure extends Error {
  constructor(readonly code: string, readonly stage?: string) { super(code); }
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new QualificationFailure(code);
}

/** Only the exact passwordless local disposable database is accepted. */
export function validateCoreEpochCutoverEnvironment(environment: Environment): string {
  if (environment.HASI_CORE_EPOCH_CUTOVER_QUALIFY !== '1') throw new QualificationFailure('explicit_opt_in_required');
  const legacyRoot = environment.HASI_CORE_EPOCH_LEGACY_ROOT;
  if (!legacyRoot || !isAbsolute(legacyRoot) || legacyRoot.length > 4096) {
    throw new QualificationFailure('legacy_source_root_required');
  }
  const databaseUrl = environment.TEST_DATABASE_URL;
  if (typeof databaseUrl !== 'string') throw new QualificationFailure('exact_disposable_database_required');
  try { qualificationDatabase(databaseUrl); }
  catch { throw new QualificationFailure('exact_disposable_database_required'); }
  if (environment.DATABASE_URL || environment.HASI_DEMO_MODE || environment.HASI_MODE === 'production'
    || environment.NODE_ENV === 'production' || environment.VERCEL !== undefined) {
    throw new QualificationFailure('production_environment_forbidden');
  }
  if (Object.entries(environment).some(([name, value]) => value && (name.startsWith('PG') || name === 'NODE_PG_FORCE_NATIVE'))) {
    throw new QualificationFailure('postgres_environment_override_forbidden');
  }
  return databaseUrl;
}

function configuredLegacyRoot(environment: Environment): string {
  const root = environment.HASI_CORE_EPOCH_LEGACY_ROOT;
  check(typeof root === 'string' && isAbsolute(root) && root.length <= 4096, 'legacy_source_root_required');
  return resolve(root);
}

function keyFor(scope: string, pluginId: string): string {
  return `hasi:plugin-registry:v1:${digest({ scope, pluginId })}`;
}

function settingsKeyFor(scope: string, pluginId: string): string {
  return `plugin-settings:v1:${digest({ scope, instanceId: pluginId })}`;
}

function knownKeys(scope: string, pluginId: string): QualificationKeys {
  return {
    owner: 'qualification:core-epoch:owner',
    registry: keyFor(scope, pluginId),
    session: 'qualification:core-epoch:session-sentinel',
    budget: 'qualification:core-epoch:budget-sentinel',
    proposal: 'qualification:core-epoch:proposal-sentinel',
    settings: settingsKeyFor(scope, pluginId),
  };
}

function ownerValue(nonce: string): Record<string, unknown> {
  return { kind: OWNER_KIND, nonce };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return isRecord(value) && typeof value.event === 'string';
}

function hasOwnedSentinel(value: unknown, kind: string, nonce: string): boolean {
  return isRecord(value) && value.kind === kind && value.nonce === nonce;
}

function hasOwnedRegistryState(value: unknown, namespace: string, pluginId: string): boolean {
  return isRecord(value) && value.schemaVersion === 1 && value.scope === namespace && value.pluginId === pluginId
    && typeof value.signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(value.signature);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    TZ: 'UTC',
    HASI_CORE_EPOCH_CUTOVER_WORKER: '1',
  };
  return environment;
}

function launchWorker(config: WorkerConfig): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_PATH], {
    cwd: ROOT,
    env: childEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  check(child.pid, 'worker_process_start_failed');
  let buffered = '';
  let outputBytes = 0;
  let resolveMessage!: (value: WorkerMessage) => void;
  let rejectMessage!: (error: Error) => void;
  const message = new Promise<WorkerMessage>((resolveMessage_, rejectMessage_) => {
    resolveMessage = resolveMessage_;
    rejectMessage = rejectMessage_;
  });
  let outputFailure: string | undefined;
  let diagnosticBytes = 0;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once('exit', (code, signal) => { resolveExit({ code, signal }); });
    child.once('error', () => { rejectExit(new QualificationFailure('worker_process_error')); });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_WORKER_OUTPUT_BYTES) {
      outputFailure = 'worker_output_limit_exceeded';
      rejectMessage(new QualificationFailure(outputFailure));
      child.kill('SIGTERM');
      return;
    }
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    const remainder = buffered.slice(newline + 1);
    buffered = remainder;
    try {
      const parsed = JSON.parse(line) as unknown;
      check(isWorkerMessage(parsed), 'worker_message_invalid');
      if (parsed.event === 'worker_failed') {
        const code = typeof parsed.code === 'string' && /^[a-z0-9_]{1,80}$/u.test(parsed.code) ? parsed.code : 'worker_operation_failed';
        outputFailure = code;
        rejectMessage(new QualificationFailure(code));
        return;
      }
      resolveMessage(parsed);
    } catch {
      outputFailure = 'worker_message_invalid';
      rejectMessage(new QualificationFailure(outputFailure));
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.byteLength;
    if (diagnosticBytes > MAX_WORKER_DIAGNOSTIC_BYTES) {
      outputFailure = 'worker_diagnostic_limit_exceeded';
      child.kill('SIGTERM');
    }
  });
  child.stdin.on('error', () => { outputFailure = 'worker_input_failed'; });
  child.stdin.end(JSON.stringify(config));
  return { child, pid: child.pid, message, exit, get outputFailure() { return outputFailure; }, get diagnosticBytes() { return diagnosticBytes; } };
}

async function workerMessage(handle: WorkerHandle, timeoutMs = 20_000): Promise<WorkerMessage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.message,
      handle.exit.then(() => { throw new QualificationFailure('worker_exited_before_result'); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new QualificationFailure('worker_result_timeout')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function workerExit(handle: WorkerHandle, timeoutMs = 12_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.exit,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new QualificationFailure('worker_exit_timeout')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'; }
}

async function stopWorker(handle: WorkerHandle, allowForce = true): Promise<{ graceful: boolean; pidGone: boolean }> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
  let graceful = false;
  try {
    const result = await workerExit(handle, 8_000);
    graceful = result.code === 0 && result.signal === null;
  } catch {
    if (allowForce && handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGKILL');
      try { await workerExit(handle, 5_000); } catch { return { graceful: false, pidGone: false }; }
    } else return { graceful: false, pidGone: false };
  }
  return { graceful, pidGone: !pidExists(handle.pid) };
}

function gitOutput(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', LANG: 'C' },
      maxBuffer: 4096,
    }).trim();
  } catch { throw new QualificationFailure('source_identity_unavailable'); }
}

function registrySourceIsClean(root: string): boolean {
  return gitOutput(root, ['diff', '--name-only', 'HEAD', '--', 'apps/api/src/registry.ts']) === '';
}

async function sourceIdentity(root: string, legacy: boolean): Promise<{ commit: string; registrySha256: string; registrySourceClean: boolean }> {
  const registryPath = join(root, 'apps/api/src/registry.ts');
  let source: string;
  try { source = await readFile(registryPath, 'utf8'); }
  catch { throw new QualificationFailure('registry_source_unavailable'); }
  const commit = gitOutput(root, ['rev-parse', 'HEAD']);
  if (legacy) {
    check(commit === LEGACY_COMMIT, 'legacy_source_revision_mismatch');
    check(!source.includes('lifecycleRevision'), 'legacy_source_is_epoch_aware');
    check(registrySourceIsClean(root), 'legacy_registry_source_modified');
  } else check(source.includes('lifecycleRevision'), 'epoch_source_missing_lifecycle_revision');
  return {
    commit,
    registrySha256: createHash('sha256').update(source).digest('hex'),
    registrySourceClean: registrySourceIsClean(root),
  };
}

function makeManifest(pluginId: string): PluginManifest {
  return {
    manifestVersion: 1,
    id: pluginId,
    name: 'Core epoch cutover fixture',
    description: 'Synthetic loopback-only read fixture for the disposable core epoch cutover qualifier.',
    version: '0.1.0',
    apiVersion: '1.0.0',
    mcpVersion: '2026-07-28',
    tools: [{
      name: 'cutover.read',
      title: 'Read cutover fixture',
      description: 'Returns a fixed synthetic value without external effects.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      effect: 'read',
      requiredPermissions: ['cutover:read'],
    }],
  };
}

function assertWorkerEvent(message: WorkerMessage, expected: string): void {
  check(message.event === expected, 'worker_event_mismatch');
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

async function runQualification(): Promise<Record<string, unknown>> {
  let stage = 'preflight';
  let store: PostgresJsonStore | undefined;
  let pluginServer: ReturnType<typeof createPluginServer> | undefined;
  const workers: WorkerHandle[] = [];
  let namespace: string | undefined;
  let pluginId: string | undefined;
  let keys: QualificationKeys | undefined;
  let nonce: string | undefined;
  let ownerMarkerCreated = false;
  let cleanupComplete = false;
  let failureCode: string | undefined;
  let failureStage: string | undefined;
  let result: Record<string, unknown> | undefined;
  let stateAtEnd: { revision: string; value: unknown } | undefined;

  try {
    const databaseUrl = validateCoreEpochCutoverEnvironment(process.env);
    assertNoPostgresEnvironment();
    const legacyRoot = configuredLegacyRoot(process.env);
    const legacySource = await sourceIdentity(legacyRoot, true);
    const epochSource = await sourceIdentity(ROOT, false);
    const database = qualificationDatabase(databaseUrl);
    const runNonce = randomBytes(16).toString('hex');
    nonce = runNonce;
    const runNamespace = `core-epoch-cutover:v1:${runNonce}`;
    namespace = runNamespace;
    const runPluginId = `cutover-${runNonce}`;
    pluginId = runPluginId;
    const runKeys = knownKeys(runNamespace, runPluginId);
    keys = runKeys;
    const keyPair = generateKeyPairSync('ed25519');
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const serviceToken = randomBytes(32).toString('base64url');
    const manifest = makeManifest(runPluginId);
    const manifestDigest = digest(manifest);
    pluginServer = createPluginServer({
      manifest,
      publicKey: keyPair.publicKey,
      serviceToken,
      handlers: { 'cutover.read': () => Promise.resolve({ value: 'epoch-aware-registry-ready' }) },
    });
    pluginServer.server.keepAliveTimeout = 1;
    await pluginServer.listen({ host: '127.0.0.1', port: 0 });
    const address = pluginServer.server.address();
    check(address && typeof address !== 'string' && address.port > 0, 'loopback_fixture_bind_failed');
    const endpoint = `http://127.0.0.1:${address.port.toString()}/mcp`;

    const activeStore = new PostgresJsonStore(runNamespace, { poolConfig: database });
    store = activeStore;
    await activeStore.initialize();
    for (const key of [runKeys.owner, runKeys.registry, runKeys.session, runKeys.budget, runKeys.proposal, runKeys.settings]) {
      check(await activeStore.read(key) === undefined, 'random_namespace_key_collision');
    }
    check(await activeStore.compareAndSet(runKeys.owner, null, ownerValue(runNonce)), 'namespace_owner_claim_failed');
    ownerMarkerCreated = true;

    const base: Omit<WorkerConfig, 'mode'> = {
      version: 1, databaseUrl, legacyRoot, namespace: runNamespace, nonce: runNonce, pluginId: runPluginId, endpoint, serviceToken,
      expectedManifestDigest: manifestDigest, privateKeyPem,
    };
    stage = 'legacy-process-start';
    const legacy = launchWorker({ ...base, mode: 'legacy-seed' }); workers.push(legacy);
    const seeded = await workerMessage(legacy);
    assertWorkerEvent(seeded, 'legacy_seeded');
    check(seeded.pid === legacy.pid && uuid(seeded.stateRevision) && typeof seeded.oldBinding === 'string'
      && /^[a-f0-9]{64}$/u.test(seeded.oldBinding), 'legacy_seed_evidence_invalid');
    check(seeded.signedNoEpochState === true && uuid(seeded.sessionSentinelRevision)
      && uuid(seeded.budgetSentinelRevision) && uuid(seeded.proposalSentinelRevision), 'legacy_seed_sentinels_invalid');
    check(pidExists(legacy.pid), 'legacy_process_not_running_after_seed');
    const legacyState = await activeStore.read(runKeys.registry);
    check(legacyState?.revision === seeded.stateRevision && isRecord(legacyState.value)
      && !Object.hasOwn(legacyState.value, 'lifecycleRevision') && legacyState.value.scope === namespace
      && legacyState.value.pluginId === pluginId, 'legacy_signed_row_not_persisted');
    const stateRevision = readUuid(seeded, 'stateRevision');
    const legacyBinding = readDigest(seeded, 'oldBinding');
    const sentinelRows = await readSentinels(activeStore, runKeys, runNonce, seeded);

    stage = 'legacy-process-drain';
    const drained = await stopWorker(legacy, false);
    check(drained.graceful && drained.pidGone, 'legacy_process_drain_unverified');

    stage = 'epoch-transition-process';
    const transitionWorker = launchWorker({ ...base, mode: 'epoch-transition',
      expectedLegacyBinding: legacyBinding, expectedLegacyStateRevision: stateRevision });
    workers.push(transitionWorker);
    const transitioned = await workerMessage(transitionWorker);
    assertWorkerEvent(transitioned, 'epoch_transition_complete');
    const transitionExit = await workerExit(transitionWorker);
    check(transitionExit.code === 0 && transitionExit.signal === null && !pidExists(transitionWorker.pid), 'epoch_transition_process_exit_unverified');
    check(uuid(transitioned.epoch) && uuid(transitioned.stateRevision) && typeof transitioned.binding === 'string'
      && /^[a-f0-9]{64}$/u.test(transitioned.binding) && transitioned.legacySignedRowValidatedWithoutMutation === true
      && transitioned.oldBindingRejectedByComparison === true && transitioned.syntheticReadSucceeded === true, 'epoch_transition_evidence_invalid');
    const transitionRevision = readUuid(transitioned, 'stateRevision');
    const lifecycleEpoch = readUuid(transitioned, 'epoch');
    const epochState = await activeStore.read(runKeys.registry);
    check(epochState?.revision === transitioned.stateRevision && isRecord(epochState.value)
      && epochState.value.lifecycleRevision === transitioned.epoch && epochState.value.enabled === true, 'epoch_state_not_persisted');
    await assertSentinelsUnchanged(activeStore, runKeys, sentinelRows);
    stateAtEnd = epochState;

    stage = 'epoch-forward-recovery-process';
    const forwardWorker = launchWorker({ ...base, mode: 'epoch-forward', expectedLegacyBinding: legacyBinding,
      expectedEpoch: lifecycleEpoch, expectedEpochStateRevision: transitionRevision });
    workers.push(forwardWorker);
    const forward = await workerMessage(forwardWorker);
    assertWorkerEvent(forward, 'epoch_forward_recovery_verified');
    const forwardExit = await workerExit(forwardWorker);
    check(forwardExit.code === 0 && forwardExit.signal === null && !pidExists(forwardWorker.pid), 'epoch_forward_process_exit_unverified');
    check(forward.epoch === transitioned.epoch && forward.stateRevision === transitioned.stateRevision
      && forward.binding === transitioned.binding && forward.signatureVerifiedOnRestart === true
      && forward.syntheticReadSucceeded === true, 'epoch_forward_evidence_invalid');
    await assertSentinelsUnchanged(activeStore, runKeys, sentinelRows);
    stateAtEnd = await activeStore.read(runKeys.registry);
    check(stateAtEnd?.revision === transitioned.stateRevision, 'epoch_state_changed_during_restart');

    stage = 'stopped-legacy-decoder-probe';
    const legacyProbe = launchWorker({ ...base, mode: 'legacy-probe', expectedEpoch: lifecycleEpoch,
      expectedEpochStateRevision: transitionRevision });
    workers.push(legacyProbe);
    const rejected = await workerMessage(legacyProbe);
    assertWorkerEvent(rejected, 'legacy_decoder_countercheck');
    const probeExit = await workerExit(legacyProbe);
    check(probeExit.code === 0 && probeExit.signal === null && !pidExists(legacyProbe.pid)
      && rejected.rejectsEpochField === true && rejected.readOnly === true, 'legacy_decoder_countercheck_failed');
    const afterProbe = await activeStore.read(runKeys.registry);
    check(afterProbe?.revision === stateAtEnd.revision && digest(afterProbe.value) === digest(stateAtEnd.value), 'legacy_probe_changed_epoch_record');
    await assertSentinelsUnchanged(activeStore, runKeys, sentinelRows);
    stateAtEnd = afterProbe;

    result = {
      event: 'core_epoch_cutover_qualified',
      scope: 'disposable-postgres-and-local-processes',
      node: process.version,
      sources: { preEpoch: legacySource, epochAware: epochSource },
      workerPids: { oldWriter: legacy.pid, epochTransition: transitionWorker.pid, restart: forwardWorker.pid, legacyDecoderProbe: legacyProbe.pid },
      checks: {
        oldSignedStateSeededWithoutEpoch: true,
        oldWriterExitedGracefullyAndPidWasGoneBeforeEpochProcess: true,
        newCoreValidatedOldSignatureWithoutRewritingBeforeFirstTransition: true,
        disableEnablePersistedEpochAndChangedBinding: true,
        secondEpochAwareProcessVerifiedSignatureAndStableBinding: true,
        syntheticReadWorkedAfterTransitionAndRestart: true,
        stoppedLegacyDecoderRejectedEpochRecordWithoutMutation: true,
        syntheticSessionBudgetAndProposalSentinelsPreserved: true,
      },
      sentinelEvidence: {
        sessionRevision: sentinelRows.session.revision,
        budgetRevision: sentinelRows.budget.revision,
        proposalRevision: sentinelRows.proposal.revision,
        legacyBindingChanged: true,
      },
      limits: [
        'Session, budget, and proposal rows are labeled synthetic sentinels, not the production session or budget implementation.',
        'The proposal check compares a synthetic stored binding; it does not exercise the public API confirmation route.',
        'The legacy process pins and checks the old registry source only, not a complete historical dependency tree, Coolify container or production app image.',
        'This does not qualify a live Coolify drain, public traffic handoff, managed installer deployment, or production rollback.',
        'No model/provider, booking, institutional service, production database, or production credential was used.',
      ],
    };
  } catch (error) {
    failureCode = error instanceof QualificationFailure ? error.code : 'qualification_failed';
    failureStage = stage;
  } finally {
    stage = 'cleanup';
    let allWorkersGone = true;
    for (const worker of workers) {
      const stopped = await stopWorker(worker, true).catch(() => ({ graceful: false, pidGone: false }));
      if (!stopped.pidGone) allWorkersGone = false;
    }
    if (!allWorkersGone) {
      cleanupComplete = false;
      failureCode ??= 'worker_cleanup_unverified';
      failureStage ??= stage;
    } else if (store && ownerMarkerCreated && namespace && pluginId && nonce && keys) {
      try {
        const activeStore = store;
        const owner = await activeStore.read(keys.owner);
        check(owner && isDeepStrictEqual(owner.value, ownerValue(nonce)), 'cleanup_owner_marker_invalid');
        const keyEntries = [
          { name: 'owner', key: keys.owner }, { name: 'registry', key: keys.registry },
          { name: 'session', key: keys.session }, { name: 'budget', key: keys.budget },
          { name: 'proposal', key: keys.proposal }, { name: 'settings', key: keys.settings },
        ] as const;
        const rows = await Promise.all(keyEntries.map(async ({ name, key }) => [name, await activeStore.read(key)] as const));
        let settingsRowFound = false;
        for (const [name, row] of rows) {
          if (!row) continue;
          if (name === 'owner') check(isDeepStrictEqual(row.value, ownerValue(nonce)), 'cleanup_owner_row_not_owned');
          else if (name === 'registry') check(hasOwnedRegistryState(row.value, namespace, pluginId), 'cleanup_registry_row_not_owned');
          else if (name === 'settings') settingsRowFound = true;
          else {
            const expectedKind = name === 'session' ? SESSION_KIND : name === 'budget' ? BUDGET_KIND : PROPOSAL_KIND;
            check(hasOwnedSentinel(row.value, expectedKind, nonce), 'cleanup_sentinel_row_not_owned');
          }
        }
        if (settingsRowFound) {
          failureCode ??= 'unexpected_settings_row_created';
          failureStage ??= stage;
        } else if (stateAtEnd) {
          const current = rows.find(([name]) => name === 'registry')?.[1];
          check(current?.revision === stateAtEnd.revision && digest(current.value) === digest(stateAtEnd.value), 'cleanup_registry_state_changed');
        }
        if (!settingsRowFound) {
          const ownedKeys = [keys.owner, keys.registry, keys.session, keys.budget, keys.proposal, keys.settings];
          for (const key of ownedKeys) await activeStore.delete(key);
          const remaining = await Promise.all(ownedKeys.map(key => activeStore.read(key)));
          cleanupComplete = remaining.every(row => row === undefined);
          if (!cleanupComplete) {
            failureCode ??= 'cleanup_exact_keys_remain';
            failureStage ??= stage;
          }
        }
      } catch {
        cleanupComplete = false;
        failureCode ??= 'owned_key_cleanup_failed';
        failureStage ??= stage;
      }
    } else if (!ownerMarkerCreated) cleanupComplete = true;
    if (pluginServer) {
      try { pluginServer.server.closeAllConnections(); await pluginServer.close(); }
      catch { failureCode ??= 'fixture_server_cleanup_failed'; failureStage ??= stage; }
    }
    if (store) {
      try { await store.close(); }
      catch { failureCode ??= 'database_pool_cleanup_failed'; failureStage ??= stage; }
    }
  }

  if (failureCode || !result || !cleanupComplete) throw new QualificationFailure(failureCode ?? 'qualification_incomplete', failureStage ?? 'cleanup');
  return { ...result, cleanup: { exactOwnedKeysRemoved: 5, noDatabaseOrNamespaceDrop: true } };
}

async function readSentinels(store: PostgresJsonStore, keys: QualificationKeys, nonce: string, seeded: WorkerMessage) {
  const [session, budget, proposal, settings] = await Promise.all([
    store.read(keys.session), store.read(keys.budget), store.read(keys.proposal), store.read(keys.settings),
  ]);
  check(session && hasOwnedSentinel(session.value, SESSION_KIND, nonce) && session.revision === seeded.sessionSentinelRevision
    && isRecord(session.value) && session.value.value === 'fixture-session-preserved', 'session_sentinel_invalid');
  check(budget && hasOwnedSentinel(budget.value, BUDGET_KIND, nonce) && budget.revision === seeded.budgetSentinelRevision
    && isRecord(budget.value) && budget.value.usedMinorUnits === 17, 'budget_sentinel_invalid');
  check(proposal && hasOwnedSentinel(proposal.value, PROPOSAL_KIND, nonce) && proposal.revision === seeded.proposalSentinelRevision
    && isRecord(proposal.value) && proposal.value.actionBinding === readDigest(seeded, 'oldBinding'), 'proposal_sentinel_invalid');
  check(settings === undefined, 'unexpected_settings_row_created');
  return { session, budget, proposal };
}

async function assertSentinelsUnchanged(store: PostgresJsonStore, keys: QualificationKeys,
  expected: Awaited<ReturnType<typeof readSentinels>>): Promise<void> {
  for (const [name, row] of Object.entries(expected)) {
    const current = await store.read(keys[name as 'session' | 'budget' | 'proposal']);
    check(current?.revision === row.revision && digest(current.value) === digest(row.value), `${name}_sentinel_changed`);
  }
  const settings = await store.read(keys.settings);
  check(settings === undefined, 'unexpected_settings_row_created');
}

function readUuid(message: WorkerMessage, key: string): string {
  const value = message[key];
  check(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value), 'worker_uuid_evidence_invalid');
  return value;
}

function readDigest(message: WorkerMessage, key: string): string {
  const value = message[key];
  check(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'worker_digest_evidence_invalid');
  return value;
}

async function directMain(): Promise<void> {
  try {
    const result = await runQualification();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof QualificationFailure ? error.code : 'qualification_failed';
    const stage = error instanceof QualificationFailure ? error.stage : undefined;
    process.stderr.write(`${JSON.stringify({ event: 'core_epoch_cutover_failed', ...(stage ? { stage } : {}), code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void directMain();
