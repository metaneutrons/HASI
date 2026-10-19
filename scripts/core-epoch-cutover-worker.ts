import { createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PostgresJsonStore } from '@hasi/state';
import { digest } from '@hasi/plugin-sdk';
import { z } from 'zod';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_COMMIT = 'e9a28743d5fe2338509d6c9e5f4bd4dda1c33501';
const OWNER_KIND = 'core-epoch-cutover-owner-v1';
const SESSION_KIND = 'synthetic-session-sentinel-v1';
const BUDGET_KIND = 'synthetic-budget-sentinel-v1';
const PROPOSAL_KIND = 'synthetic-proposal-binding-sentinel-v1';

const configSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['legacy-seed', 'epoch-transition', 'epoch-forward', 'legacy-probe']),
  databaseUrl: z.string().min(1).max(2048),
  legacyRoot: z.string().min(1).max(4096),
  namespace: z.string().regex(/^core-epoch-cutover:v1:[a-f0-9]{32}$/u),
  nonce: z.string().regex(/^[a-f0-9]{32}$/u),
  pluginId: z.string().regex(/^cutover-[a-f0-9]{32}$/u),
  endpoint: z.string().max(512),
  serviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expectedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  privateKeyPem: z.string().min(1).max(4096),
  expectedLegacyBinding: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedLegacyStateRevision: z.uuid().optional(),
  expectedEpoch: z.uuid().optional(),
  expectedEpochStateRevision: z.uuid().optional(),
});

type Config = z.infer<typeof configSchema>;
interface RegistryModule {
  PluginRegistry: new (privateKey: ReturnType<typeof createPrivateKey>, options: { store: PostgresJsonStore; scope: string }) => {
    install(registration: Registration): Promise<void>;
    binding(id: string): Promise<string>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    invoke(id: string, name: string, args: Record<string, unknown>, actor: { subject: string; permissions: string[] }): Promise<unknown>;
  };
}
interface Registration {
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  allowLoopback: boolean;
}

class WorkerFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new WorkerFailure(code);
}

function keyFor(config: Config): string {
  return `hasi:plugin-registry:v1:${digest({ scope: config.namespace, pluginId: config.pluginId })}`;
}

function ownerKey(): string { return 'qualification:core-epoch:owner'; }
function sessionKey(): string { return 'qualification:core-epoch:session-sentinel'; }
function budgetKey(): string { return 'qualification:core-epoch:budget-sentinel'; }
function proposalKey(): string { return 'qualification:core-epoch:proposal-sentinel'; }

function ownerValue(config: Config): Record<string, unknown> {
  return { kind: OWNER_KIND, nonce: config.nonce };
}

function sentinelValue(value: unknown, kind: string, nonce: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'kind' in value && value.kind === kind && 'nonce' in value && value.nonce === nonce;
}

function stateValue(value: unknown, config: Config): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'schemaVersion' in value && value.schemaVersion === 1
    && 'scope' in value && value.scope === config.namespace
    && 'pluginId' in value && value.pluginId === config.pluginId
    && 'signature' in value && typeof value.signature === 'string';
}

function endpointIsAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
      && url.pathname === '/mcp' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

async function loadRegistry(config: Config): Promise<RegistryModule> {
  const mode = config.mode;
  const legacy = mode === 'legacy-seed' || mode === 'legacy-probe';
  const root = legacy ? config.legacyRoot : ROOT;
  check(!legacy || (isAbsolute(root) && await legacySourceIsApproved(root)), 'legacy_source_not_approved');
  const registryPath = join(root, 'apps/api/src/registry.ts');
  const module = await import(pathToFileURL(registryPath).href) as Partial<RegistryModule>;
  check(typeof module.PluginRegistry === 'function', 'registry_module_unavailable');
  return module as RegistryModule;
}

async function legacySourceIsApproved(root: string): Promise<boolean> {
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', LANG: 'C' };
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env, maxBuffer: 1024,
    }).trim();
    if (commit !== LEGACY_COMMIT) return false;
    execFileSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', 'apps/api/src/registry.ts'], {
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000, env,
    });
    const source = await readFile(join(root, 'apps/api/src/registry.ts'), 'utf8');
    return !source.includes('lifecycleRevision');
  } catch { return false; }
}

async function readConfig(): Promise<Config> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16_384) throw new WorkerFailure('worker_input_too_large');
  }
  try { return configSchema.parse(JSON.parse(input) as unknown); }
  catch (error) {
    if (error instanceof WorkerFailure) throw error;
    throw new WorkerFailure('worker_configuration_invalid');
  }
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  let store: PostgresJsonStore | undefined;
  let holdForDrain = false;
  let finishDrain: (() => void) | undefined;
  const drained = new Promise<void>(resolveDrain => { finishDrain = resolveDrain; });
  const onSignal = () => { finishDrain?.(); };
  process.once('SIGTERM', onSignal);

  try {
    check(process.env.HASI_CORE_EPOCH_CUTOVER_WORKER === '1', 'worker_opt_in_required');
    check(!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL, 'worker_database_environment_forbidden');
    assertNoPostgresEnvironment();
    const config = await readConfig();
    check(endpointIsAllowed(config.endpoint), 'fixture_endpoint_invalid');
    const activeStore = new PostgresJsonStore(config.namespace, { poolConfig: qualificationDatabase(config.databaseUrl) });
    store = activeStore;
    await activeStore.initialize();
    const owner = await activeStore.read(ownerKey());
    check(owner && isDeepStrictEqual(owner.value, ownerValue(config)), 'namespace_ownership_unverified');

    const registryModule = await loadRegistry(config);
    const signingKey = createPrivateKey(config.privateKeyPem);
    const registry = new registryModule.PluginRegistry(signingKey, { store: activeStore, scope: config.namespace });
    const registration: Registration = {
      endpoint: config.endpoint,
      serviceToken: config.serviceToken,
      expectedManifestDigest: config.expectedManifestDigest,
      allowLoopback: true,
    };
    const stateKey = keyFor(config);

    if (config.mode === 'legacy-seed') {
      const before = await activeStore.read(stateKey);
      check(before === undefined, 'legacy_state_key_already_exists');
      const [sessionBefore, budgetBefore, proposalBefore] = await Promise.all([
        activeStore.read(sessionKey()), activeStore.read(budgetKey()), activeStore.read(proposalKey()),
      ]);
      check(!sessionBefore && !budgetBefore && !proposalBefore, 'sentinel_key_already_exists');
      await registry.install(registration);
      const state = await activeStore.read(stateKey);
      check(state && stateValue(state.value, config) && !Object.hasOwn(state.value, 'lifecycleRevision'), 'legacy_state_shape_invalid');
      check(typeof state.value.signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(state.value.signature), 'legacy_state_signature_invalid');
      const oldBinding = await registry.binding(config.pluginId);
      check(/^[a-f0-9]{64}$/u.test(oldBinding), 'legacy_binding_invalid');
      const sentinels = [
        [sessionKey(), { kind: SESSION_KIND, nonce: config.nonce, label: 'synthetic-session-sentinel', value: 'fixture-session-preserved' }],
        [budgetKey(), { kind: BUDGET_KIND, nonce: config.nonce, label: 'synthetic-budget-sentinel', usedMinorUnits: 17 }],
        [proposalKey(), { kind: PROPOSAL_KIND, nonce: config.nonce, label: 'synthetic-old-proposal-binding', actionBinding: oldBinding }],
      ] as const;
      const sentinelRevisions: Record<string, string> = {};
      for (const [key, value] of sentinels) {
        check(await activeStore.compareAndSet(key, null, value), 'sentinel_create_failed');
        const saved = await activeStore.read(key);
        check(saved && sentinelValue(saved.value, value.kind, config.nonce), 'sentinel_readback_failed');
        sentinelRevisions[key] = saved.revision;
      }
      holdForDrain = true;
      emit({ event: 'legacy_seeded', pid: process.pid, stateRevision: state.revision, oldBinding,
        signedNoEpochState: true, sessionSentinelRevision: sentinelRevisions[sessionKey()],
        budgetSentinelRevision: sentinelRevisions[budgetKey()], proposalSentinelRevision: sentinelRevisions[proposalKey()] });
      await drained;
      await store.close(); store = undefined;
      return;
    }

    if (config.mode === 'epoch-transition') {
      check(config.expectedLegacyBinding && config.expectedLegacyStateRevision, 'legacy_expectations_missing');
      const legacy = await activeStore.read(stateKey);
      check(legacy?.revision === config.expectedLegacyStateRevision && stateValue(legacy.value, config)
        && !Object.hasOwn(legacy.value, 'lifecycleRevision'), 'legacy_state_before_migration_invalid');
      await registry.install(registration);
      const afterInstall = await activeStore.read(stateKey);
      check(afterInstall?.revision === legacy.revision && isDeepStrictEqual(afterInstall.value, legacy.value), 'legacy_validation_mutated_state');
      const epochlessBinding = await registry.binding(config.pluginId);
      check(epochlessBinding !== config.expectedLegacyBinding, 'new_binding_did_not_change_old_binding_format');
      await registry.setEnabled(config.pluginId, false);
      await registry.setEnabled(config.pluginId, true);
      const transitioned = await activeStore.read(stateKey);
      check(transitioned && stateValue(transitioned.value, config) && transitioned.value.enabled === true
        && typeof transitioned.value.lifecycleRevision === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(transitioned.value.lifecycleRevision), 'epoch_transition_missing');
      const binding = await registry.binding(config.pluginId);
      check(binding !== config.expectedLegacyBinding && binding !== epochlessBinding, 'active_epoch_did_not_invalidate_prior_binding');
      const result = await registry.invoke(config.pluginId, 'cutover.read', {}, { subject: 'synthetic-cutover-check', permissions: ['cutover:read'] });
      check(isDeepStrictEqual(result, { value: 'epoch-aware-registry-ready' }), 'epoch_registry_read_probe_failed');
      emit({ event: 'epoch_transition_complete', pid: process.pid, stateRevision: transitioned.revision,
        epoch: transitioned.value.lifecycleRevision, binding, oldBindingRejectedByComparison: true,
        legacySignedRowValidatedWithoutMutation: true, syntheticReadSucceeded: true });
      return;
    }

    if (config.mode === 'epoch-forward') {
      check(config.expectedEpoch && config.expectedEpochStateRevision && config.expectedLegacyBinding, 'epoch_expectations_missing');
      const before = await activeStore.read(stateKey);
      check(before?.revision === config.expectedEpochStateRevision && stateValue(before.value, config)
        && before.value.lifecycleRevision === config.expectedEpoch && before.value.enabled === true, 'epoch_state_before_restart_invalid');
      await registry.install(registration);
      const afterInstall = await activeStore.read(stateKey);
      check(afterInstall?.revision === before.revision && isDeepStrictEqual(afterInstall.value, before.value), 'restart_install_mutated_epoch_state');
      const binding = await registry.binding(config.pluginId);
      check(binding !== config.expectedLegacyBinding, 'restart_restored_legacy_binding');
      const result = await registry.invoke(config.pluginId, 'cutover.read', {}, { subject: 'synthetic-cutover-check', permissions: ['cutover:read'] });
      check(isDeepStrictEqual(result, { value: 'epoch-aware-registry-ready' }), 'forward_recovery_read_probe_failed');
      emit({ event: 'epoch_forward_recovery_verified', pid: process.pid, stateRevision: afterInstall.revision,
        epoch: config.expectedEpoch, binding, signatureVerifiedOnRestart: true, syntheticReadSucceeded: true });
      return;
    }

    check(config.expectedEpoch && config.expectedEpochStateRevision, 'legacy_probe_expectations_missing');
    const beforeProbe = await activeStore.read(stateKey);
    check(beforeProbe?.revision === config.expectedEpochStateRevision && stateValue(beforeProbe.value, config)
      && beforeProbe.value.lifecycleRevision === config.expectedEpoch, 'epoch_state_before_legacy_probe_invalid');
    let rejected = false;
    try { await registry.install(registration); }
    catch (error) {
      rejected = typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
    }
    check(rejected, 'legacy_decoder_accepted_epoch_record');
    const afterProbe = await activeStore.read(stateKey);
    check(afterProbe?.revision === beforeProbe.revision && isDeepStrictEqual(afterProbe.value, beforeProbe.value), 'legacy_probe_mutated_epoch_state');
    emit({ event: 'legacy_decoder_countercheck', pid: process.pid, stateRevision: afterProbe.revision,
      rejectsEpochField: true, readOnly: true });
  } catch (error) {
    const code = error instanceof WorkerFailure ? error.code : 'worker_operation_failed';
    process.stderr.write(`${JSON.stringify({ event: 'worker_failed', code })}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    if (store) {
      try { await store.close(); }
      catch { process.exitCode = 1; }
    }
    if (holdForDrain && process.exitCode === undefined) process.exitCode = 0;
  }
}

void main();
