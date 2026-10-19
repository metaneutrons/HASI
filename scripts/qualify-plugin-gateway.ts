import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { digest } from '@hasi/plugin-sdk';
import {
  DeploymentDriverError, PluginDeploymentCoordinator, pluginReleaseSigningBytes, verifyPluginRelease,
  type DeploymentDriver, type PluginReleaseEnvelope, type PublisherApproval, type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import { createDockerPluginDriver } from '../apps/api/src/docker-plugin-driver.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import { PluginDeploymentBinding } from '../apps/api/src/plugin-deployment-binding.js';
import { qualificationFixtures as f, qualificationFailureCategory } from './healthy-plugin-qualification.js';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';
import {
  createVerifiedArtifactSnapshot, ExternalPluginArtifactInputError, loadExternalPluginArtifactPair,
  type ExternalPluginArtifact, type ExternalPluginArtifactPair,
} from './plugin-gateway-qualification-artifacts.js';

const assert: (condition: unknown, category: string) => asserts condition = f.assert;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OWNER_LABEL = 'com.hasi.qualification.owner';
const REPOSITORY = 'localhost/hasi-reference-qualification';
type Artifact = Awaited<ReturnType<typeof f.readArtifactManifest>>;
interface GatewayWorker { child: ChildProcess; origin: string; bootId: string; pid: number }
interface StageRecord { operationId: string; deploymentId?: string }

async function startWorker(config: Record<string, unknown>): Promise<GatewayWorker> {
  const env: NodeJS.ProcessEnv = { HASI_DOCKER_QUALIFY: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'LANG']) if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/plugin-gateway-qualification-worker.ts')], {
    cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    return await new Promise<GatewayWorker>((resolve, reject) => {
      let output = '';
      let settled = false;
      const timer = setTimeout(() => { finish(new Error('gateway_worker_start_timeout')); }, 15000);
      const finish = (error: Error | null, worker?: GatewayWorker) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else if (worker) resolve(worker);
      };
      child.once('error', () => { finish(new Error('gateway_worker_start_failed')); });
      child.once('exit', () => { finish(new Error('gateway_worker_exited_before_ready')); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 4096) { finish(new Error('gateway_worker_output_invalid')); return; }
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(output.slice(0, newline)) as Record<string, unknown>;
          const url = new URL(String(value.origin));
          if (value.event !== 'ready' || typeof value.bootId !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.bootId)
            || value.pid !== child.pid || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
            || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
          finish(null, { child, origin: url.origin, bootId: value.bootId, pid: Number(value.pid) });
        } catch { finish(new Error('gateway_worker_output_invalid')); }
      });
      // Consume bounded diagnostic bytes without forwarding configuration or credentials.
      let diagnostics = 0;
      child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.byteLength; if (diagnostics > 4096) finish(new Error('gateway_worker_diagnostics_exceeded')); });
      child.stdin.on('error', () => { finish(new Error('gateway_worker_input_failed')); });
      child.stdin.end(JSON.stringify(config));
    });
  } catch (error) { await stopWorker(child); throw error; }
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0 || child.signalCode !== null) throw new Error('gateway_worker_exited_unsafely');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('gateway_worker_stop_timeout')); }, 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve(); else reject(new Error('gateway_worker_stop_failed'));
    });
    child.kill('SIGTERM');
  });
}

async function versionedSource(root: string): Promise<string> {
  const source = join(root, 'source-b');
  await mkdir(join(source, 'src'), { recursive: true });
  for (const name of ['package.json', 'src/manifest.json']) {
    const value = JSON.parse(await readFile(join(ROOT, 'examples/reference-plugin', name), 'utf8')) as Record<string, unknown>;
    value.version = '1.1.0';
    await writeFile(join(source, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  }
  for (const name of ['README.md', 'src/server.js']) await copyFile(join(ROOT, 'examples/reference-plugin', name), join(source, name));
  return source;
}

async function main(): Promise<Record<string, unknown>> {
  f.requireOptIn(); assertNoPostgresEnvironment();
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const database = qualificationDatabase(databaseUrl);
  const sourceFileSha256 = Object.fromEntries<string>(await Promise.all([
    'scripts/qualify-plugin-gateway.ts', 'scripts/plugin-gateway-qualification-artifacts.ts',
    'scripts/plugin-gateway-qualification-worker.ts',
    'scripts/plugin-gateway-qualification-config.ts', 'scripts/healthy-plugin-qualification.ts',
    'scripts/package-reference-plugin.ts', 'apps/api/src/plugin-artifacts.ts',
    'apps/api/src/plugin-route-controller.ts', 'apps/api/src/plugin-deployment-binding.ts',
    'apps/api/src/plugin-deployment-proxy.ts', 'apps/api/src/docker-plugin-driver.ts',
    'apps/api/src/docker-plugin-relay.ts', 'apps/api/src/plugin-relay-program.ts',
    'examples/reference-plugin/src/server.js', 'pnpm-lock.yaml',
  ].map(async (path): Promise<[string, string]> => [path, f.sha256(await readFile(join(ROOT, path), 'utf8'))])));
  let externalArtifacts: ExternalPluginArtifactPair<Artifact> | undefined;
  try {
    externalArtifacts = await loadExternalPluginArtifactPair({
      env: process.env,
      workspaceRoot: ROOT,
      readArtifactManifest: f.readArtifactManifest,
    });
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) f.fail(error.category);
    throw error;
  }
  const socketPath = f.dockerSocketPath(); f.assertLocalNodeImage();
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const ownerId = `gateway-qualifier-${nonce}`;
  const namespace = `gateway-qualification-${nonce}`;
  const installationId = `reference-${nonce}`;
  const networks = ['a', 'b', 'c'].map(letter => `hasi-gateway-${nonce}-${letter}`);
  const relayNetwork = `hasi-gateway-${nonce}-relay`;
  const baseline = f.exactContainerList();
  const root = await mkdtemp(join(tmpdir(), 'hasi-gateway-qualification-'));
  const images: { tag: string; id?: string }[] = [];
  const attemptedNetworks: string[] = [];
  const stages: StageRecord[] = [];
  const workers: GatewayWorker[] = [];
  const store = new PostgresJsonStore(namespace, { poolConfig: database });
  const routeKey = `hasi:plugin-route:v1:${digest(namespace)}:${digest([ownerId, installationId])}`;
  const deploymentKey = `hasi:plugin-deployment:v1:${digest(namespace)}:${digest(installationId)}`;
  const keys = ['active-settings', routeKey, deploymentKey];
  const runtimeKeys = generateKeyPairSync('ed25519');
  const publisherKeys = generateKeyPairSync('ed25519');
  const token = randomBytes(32).toString('base64url');
  const assignments = [{ name: 'SERVICE_TOKEN', secretRef: `token-${nonce}` }, { name: 'PUBLIC_KEY', secretRef: `key-${nonce}` }];
  const publisher: PublisherApproval = { publisherId: `publisher-${nonce}`, publicKey: publisherKeys.publicKey,
    sourceRegistryPrefix: REPOSITORY, allowedPluginIds: ['hasi.reference'] };
  const resolvePublisher = (id: string) => id === publisher.publisherId ? publisher : undefined;
  const allowed = new Set<string>();
  let routes: PluginRouteController | undefined;
  let driver: ReturnType<typeof createDockerPluginDriver> | undefined;
  let loseActivationReply = false;
  let activationCommits = 0;
  let namespaceInitialized = false;
  let cleanupVerified = true;
  let phase = 'initializing';
  let blocker: string | null = null;
  let report: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  let nativeReads = 0;

  const revision = async () => {
    const value = (await store.read('active-settings'))?.value;
    assert(typeof value === 'object' && value !== null && 'revision' in value
      && 'qualificationOwner' in value && value.qualificationOwner === ownerId
      && (value.revision === '1' || value.revision === '2'), 'settings_revision_unavailable');
    return value.revision;
  };
  const newRoutes = () => new PluginRouteController({ store, scope: namespace, ownerId });
  const newDriver = (controller: PluginRouteController) => createDockerPluginDriver({
    enabled: true, deploymentTarget: 'operator-local', socketPath, ownerId,
    allowedInternalNetworks: networks, relayNetwork,
    routing: {
      activate: async input => {
        await controller.activate(input); activationCommits += 1;
        if (loseActivationReply) { loseActivationReply = false; throw new DeploymentDriverError('unknown'); }
      },
      rollback: input => controller.rollback(input), readActiveRoute: input => controller.readActiveRoute(input),
      readActiveDeploymentId: input => controller.readActiveDeploymentId(input), readOperationStatus: input => controller.readOperationStatus(input),
    },
    resolveSecret: input => {
      assert(input.ownerId === ownerId && input.installationId === installationId && input.pluginId === 'hasi.reference', 'secret_scope_mismatch');
      if (input.secretName === 'SERVICE_TOKEN' && input.secretRef === `token-${nonce}`) return token;
      if (input.secretName === 'PUBLIC_KEY' && input.secretRef === `key-${nonce}`) return runtimeKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      if (input.secretName === 'PUBLIC_KEY' && input.secretRef === `missing-${nonce}`) return undefined;
      return f.fail('unassigned_credential_requested');
    }, healthPath: '/healthz', requestTimeoutMs: 5000,
  });
  const trackedDriver = (): DeploymentDriver => ({
    stage: async input => {
      assert(driver !== undefined, 'driver_missing');
      const record: StageRecord = { operationId: input.operationId }; stages.push(record);
      const result = await driver.stage(input); record.deploymentId = result.deploymentId; return result;
    },
    check: input => { assert(driver !== undefined, 'driver_missing'); return driver.check(input); },
    discard: input => { assert(driver !== undefined, 'driver_missing'); return driver.discard(input); },
    activate: input => { assert(driver !== undefined, 'driver_missing'); return driver.activate(input); },
    rollback: input => { assert(driver !== undefined, 'driver_missing'); return driver.rollback(input); },
    reconcile: input => { assert(driver !== undefined, 'driver_missing'); return driver.reconcile(input); },
  });
  const coordinator = () => new PluginDeploymentCoordinator({
    store, scope: namespace, driver: trackedDriver(), resolvePublisher,
    isCurrentlyTrusted: (release, refs) => allowed.has(release.releaseDigest) && refs.every(ref =>
      (ref.name === 'SERVICE_TOKEN' && ref.secretRef === `token-${nonce}`)
      || (ref.name === 'PUBLIC_KEY' && [ `key-${nonce}`, `missing-${nonce}` ].includes(ref.secretRef))),
    authorizeReview: () => false, getConfigurationRevision: revision,
  });
  const build = async (letter: string, external?: ExternalPluginArtifact<Artifact>, sourceDirectory?: string) => {
    const directory = join(root, `artifact-${letter}`);
    const evidence = external?.evidence
      ?? f.packageReferencePluginWithAllowlistedEnvironment(directory, sourceDirectory);
    const artifact = external
      ? (await createVerifiedArtifactSnapshot({ sourceDirectory: external.directory, destinationDirectory: directory,
        evidence, inventory: external.artifact.payloadFiles, readArtifactManifest: f.readArtifactManifest })).artifact
      : await f.readArtifactManifest(directory, evidence);
    const dockerfile = join(root, `Dockerfile-${letter}`); await writeFile(dockerfile, f.pluginLauncherDockerfile(), { flag: 'wx' });
    const tag = `${REPOSITORY}:${nonce}-${letter}`;
    assert(f.runDocker(['image', 'ls', '--quiet', tag], 'image_collision_check_failed') === '', 'image_tag_collision');
    const image: { tag: string; id?: string } = { tag }; images.push(image);
    f.runDocker(['build', '--network=none', '--pull=false', '--label', `${OWNER_LABEL}=${ownerId}`, '--tag', tag,
      '--file', dockerfile, directory], 'offline_image_build_failed', 180000);
    const identity = f.dockerImageIdentity(tag, ownerId); image.id = identity.id;
    const unsigned: UnsignedPluginRelease = { schemaVersion: 1, publisherId: publisher.publisherId, pluginId: artifact.pluginId,
      version: artifact.pluginVersion, manifestDigest: artifact.manifestDigest, image: identity.repoDigest, configSchemaVersion: 1, stateMigration: 'none' };
    const envelope: PluginReleaseEnvelope = { ...unsigned, signature: sign(null, pluginReleaseSigningBytes(unsigned), publisherKeys.privateKey).toString('base64url') };
    const verified = verifyPluginRelease(envelope, resolvePublisher); allowed.add(verified.releaseDigest);
    return { envelope, verified, artifact, evidence, ...(external ? { source: external.source } : {}) };
  };
  const workerConfig = { databaseUrl, namespace, ownerId, installationId, socketPath, internalNetworks: networks, relayNetwork, serviceToken: token };
  const read = async (worker: GatewayWorker, artifact: Artifact, configurationRevision = 1) => {
    await f.verifyPinnedManifestAndRead({ baseUrl: `${worker.origin}/api/plugin-deployments/${installationId}/`,
      installationId, configurationRevision, artifact, releaseManifestDigest: artifact.manifestDigest,
      privateKey: runtimeKeys.privateKey, serviceToken: token, nonce }); nativeReads += 1;
  };
  const stage = async (control: PluginDeploymentCoordinator, release: PluginReleaseEnvelope, index: number, refs = assignments) => {
    const hostPort = await f.ephemeralLoopbackPort();
    const result = await control.stageCandidate({ installationId, release, configurationRevision: await revision(),
      configurationCompatible: true, effectsExpanded: false, permissionsExpanded: false, secretAssignments: refs,
      launch: { network: { mode: 'internal', name: networks[index] ?? '' }, hostPort, containerPort: 3000,
        cpuMillicores: 500, memoryBytes: 268435456, pidsLimit: 64, startupTimeoutMs: 5000, shutdownTimeoutMs: 2000 } });
    return result;
  };

  try {
    await store.initialize();
    for (const key of keys) assert(await store.read(key) === undefined, 'qualification_state_already_exists');
    namespaceInitialized = true;
    assert(await store.compareAndSet('active-settings', null, { revision: '1', qualificationOwner: ownerId }), 'settings_initialization_failed');
    routes = newRoutes(); await routes.initializeInstallation({ installationId, configurationRevision: '1' }); driver = newDriver(routes);
    for (const name of [...networks, relayNetwork]) { attemptedNetworks.push(name); f.createQualificationNetwork(name, ownerId, name !== relayNetwork); }
    phase = 'building-artifacts';
    const a = await build('a', externalArtifacts?.a);
    const b = externalArtifacts
      ? await build('b', externalArtifacts.b)
      : await build('b', undefined, await versionedSource(root));
    assert(a.artifact.pluginId === 'hasi.reference' && b.artifact.pluginId === 'hasi.reference'
      && a.artifact.pluginVersion !== b.artifact.pluginVersion
      && a.verified.releaseDigest !== b.verified.releaseDigest, 'distinct_versions_not_built');
    if (!externalArtifacts) {
      assert(a.artifact.pluginVersion === '1.0.0' && b.artifact.pluginVersion === '1.1.0', 'fixture_versions_invalid');
    }
    let control = coordinator(); await control.initialize({ installationId, pluginId: 'hasi.reference', configurationSchemaVersion: 1 });
    phase = 'activating-a';
    const first = await stage(control, a.envelope, 0); assert(first.outcome === 'candidate-ready', 'first_stage_failed');
    assert((await control.activate({ installationId, candidateDigest: a.verified.releaseDigest,
      baseCurrentDigest: null, configurationRevision: '1' })).outcome === 'activated', 'first_activation_failed');
    const one = await startWorker(workerConfig); workers.push(one); const two = await startWorker(workerConfig); workers.push(two);
    await read(one, a.artifact); await read(two, a.artifact); checks.twoProcessesServeActiveA = true;
    checks.validSignedForeignInstallationDenied = true;
    const unauth = await fetch(`${one.origin}/api/plugin-deployments/${installationId}/.well-known/hasi-plugin.json`, { signal: AbortSignal.timeout(3000) });
    await unauth.body?.cancel(); assert(unauth.status === 401, 'gateway_unauthenticated_request_accepted'); checks.unauthenticatedDenied = true;
    phase = 'updating-b';
    const second = await stage(control, b.envelope, 1); assert(second.outcome === 'candidate-ready', 'second_stage_failed');
    await read(one, a.artifact); checks.stagedBDoesNotReplaceA = true;
    loseActivationReply = true;
    assert((await control.activate({ installationId, candidateDigest: b.verified.releaseDigest,
      baseCurrentDigest: a.verified.releaseDigest, configurationRevision: '1' })).outcome === 'unknown', 'lost_reply_not_unknown');
    await read(two, b.artifact);
    routes = newRoutes(); driver = newDriver(routes); control = coordinator();
    assert((await control.reconcile(installationId)).outcome === 'resolved', 'activation_reconciliation_failed');
    assert((await control.get(installationId)).current?.releaseDigest === b.verified.releaseDigest && activationCommits === 2,
      'activation_reconciliation_replayed_route'); checks.lostCommittedReplyReconciledWithoutReplay = true;
    await stopWorker(one.child); const replacement = await startWorker(workerConfig); workers.push(replacement);
    assert(replacement.pid !== one.pid && replacement.bootId !== one.bootId, 'gateway_process_not_replaced');
    await read(replacement, b.artifact); await read(two, b.artifact); checks.newProcessRestoresBFromPostgres = true;
    phase = 'failed-preflight';
    const bad = await stage(control, a.envelope, 2, [{ name: 'SERVICE_TOKEN', secretRef: `token-${nonce}` }, { name: 'PUBLIC_KEY', secretRef: `missing-${nonce}` }]);
    assert(bad.outcome === 'stage-failed', 'missing_credential_stage_not_denied'); await read(two, b.artifact); checks.failedPreflightPreservesB = true;
    phase = 'configuration-and-cancel';
    const pending = await stage(control, a.envelope, 2); assert(pending.outcome === 'candidate-ready', 'cancel_candidate_stage_failed');
    const pendingCandidate = pending.state.candidate;
    assert(pendingCandidate?.stagingOperationId, 'candidate_stage_token_missing');
    const settings = await store.read('active-settings'); assert(settings !== undefined, 'settings_missing');
    assert(await store.compareAndSet('active-settings', settings.revision, { revision: '2', qualificationOwner: ownerId }), 'settings_activation_failed');
    const binding = new PluginDeploymentBinding({ routes, ownerId, readAuthoritativeRevision: async () => Number(await revision()) });
    await binding.configurationActivated(installationId, 2);
    const cancelled = await control.discardCandidate({ installationId, candidateDigest: a.verified.releaseDigest,
      stagingOperationId: pendingCandidate.stagingOperationId, configurationRevision: '1' });
    assert(cancelled.status === 'active' && cancelled.candidate === null && cancelled.current?.releaseDigest === b.verified.releaseDigest, 'old_configuration_candidate_not_discarded');
    await control.synchronizeConfigurationRevision({ installationId, expectedRevision: '1', approvedConfigurationRevision: '2', configurationCompatible: true });
    await read(two, b.artifact, 2); checks.changedConfigurationCanCancelAndConverge = true;
    phase = 'rollback';
    assert((await control.rollback({ installationId, targetDigest: a.verified.releaseDigest,
      configurationRevision: '2', configurationCompatible: true })).outcome === 'rolled-back', 'retained_artifact_rollback_failed');
    await read(replacement, a.artifact, 2); checks.realGatewayRollbackToA = true;
    allowed.delete(b.verified.releaseDigest);
    let denied = false;
    try { await control.rollback({ installationId, targetDigest: b.verified.releaseDigest, configurationRevision: '2', configurationCompatible: true }); }
    catch { denied = true; }
    assert(denied && (await routes.readActiveRoute({ ownerId, installationId }))?.releaseDigest === a.verified.releaseDigest,
      'revoked_release_rollback_not_denied'); await read(two, a.artifact, 2); checks.revokedRollbackDenied = true;
    phase = 'withdrawing';
    const active = await routes.readActiveRoute({ ownerId, installationId }); assert(active !== null, 'active_route_missing');
    await routes.withdraw({ ownerId, installationId, operationId: `withdraw-${randomUUID()}`, currentDeploymentId: active.deploymentId,
      currentReleaseDigest: active.releaseDigest, configurationRevision: '2' });
    const inactive = await fetch(`${two.origin}/api/plugin-deployments/${installationId}/.well-known/hasi-plugin.json`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    await inactive.body?.cancel(); assert(inactive.status === 503, 'withdrawn_route_still_serves'); checks.withdrawalStopsGatewayTraffic = true;
    report = { qualification: 'postgres-paired-plugin-gateway-lifecycle', qualified: true, fullP5P6Acceptance: false,
      independentDistributionAcceptance: false, artifactInputMode: externalArtifacts ? 'external-prebuilt-pair' : 'workspace-reference-fixture',
      ...(externalArtifacts ? {
        qualificationScope: 'local-independent-source-artifacts',
        sourceIdentityAssurance: 'operator-declared-metadata-only-not-cryptographic-provenance',
        filesystemAssurance: 'preflight-plus-private-snapshot-inventory-not-general-hostile-filesystem-proof',
        publisherTrust: 'ephemeral-synthetic-qualification-key-only',
      } : {}),
      nativeReads, activationCommits, checks,
      artifacts: [a, b].map(value => ({ version: value.artifact.pluginVersion, artifactSha256: value.evidence.artifactSha256,
        artifactManifestSha256: value.evidence.artifactManifestSha256, manifestDigest: value.artifact.manifestDigest,
        image: value.verified.image, releaseDigest: value.verified.releaseDigest,
        ...(value.source ? { source: value.source } : {}) })),
      ownerId, installationId, namespace, cleanupVerified: true };
  } catch (error) {
    blocker = qualificationFailureCategory(error);
    report = { qualification: 'postgres-paired-plugin-gateway-lifecycle', qualified: false, fullP5P6Acceptance: false,
      phase, blocker, nativeReads, activationCommits, checks, ownerId, installationId, namespace, cleanupVerified: false };
  } finally {
    for (const worker of workers) { try { await stopWorker(worker.child); } catch { cleanupVerified = false; } }
    if (routes) {
      try {
        const active = await routes.readActiveRoute({ ownerId, installationId });
        if (active) await routes.withdraw({ ownerId, installationId, operationId: `cleanup-${randomUUID()}`,
          currentDeploymentId: active.deploymentId, currentReleaseDigest: active.releaseDigest, configurationRevision: await revision() });
      } catch { cleanupVerified = false; }
    }
    if (driver) for (const record of [...stages].reverse()) {
      try {
        const observed = await driver.reconcile({ installationId, operationId: record.operationId });
        const id = record.deploymentId ?? observed.stagedDeploymentId;
        if (id) await driver.discard({ installationId, operationId: record.operationId, deploymentId: id });
      } catch { cleanupVerified = false; }
    }
    for (const name of [...attemptedNetworks].reverse()) { try { if (!f.removeOwnedNetwork(name, ownerId)) cleanupVerified = false; } catch { cleanupVerified = false; } }
    for (const image of [...images].reverse()) { try { if (!f.removeOwnedImage(image.tag, image.id, ownerId)) cleanupVerified = false; } catch { cleanupVerified = false; } }
    try {
      const after = f.exactContainerList();
      if (after.size !== baseline.size || [...after].some(id => !baseline.has(id))) cleanupVerified = false;
    } catch { cleanupVerified = false; }
    try {
      // Keep the durable recovery journal if any runtime cleanup is uncertain.
      if (namespaceInitialized && cleanupVerified) for (const key of keys) {
        const entry = await store.read(key);
        if (entry) {
          const value = entry.value;
          assert(typeof value === 'object' && value !== null
            && (key === 'active-settings' ? 'qualificationOwner' in value && value.qualificationOwner === ownerId
              : 'installationId' in value && value.installationId === installationId
                && (key !== routeKey || 'ownerId' in value && value.ownerId === ownerId)), 'state_cleanup_owner_mismatch');
          await store.delete(key);
        }
        assert(await store.read(key) === undefined, 'state_cleanup_unverified');
      }
    } catch { cleanupVerified = false; }
    try { await store.close(); } catch { cleanupVerified = false; }
    try { await rm(root, { recursive: true, force: true }); } catch { cleanupVerified = false; }

  }
  return { ...report, sourceFileSha256, runtime: { node: process.version, platform: process.platform, arch: process.arch },
    cleanupVerified, ...(cleanupVerified ? {} : { qualified: false, blocker: 'cleanup_unconfirmed', primaryBlocker: blocker, phase }) };
}

try {
  const result = await main(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.qualified !== true) process.exitCode = 1;
} catch {
  process.stderr.write(`${JSON.stringify({ qualified: false, blocker: 'gateway_qualification_or_cleanup_failed' })}\n`);
  process.exitCode = 1;
}
