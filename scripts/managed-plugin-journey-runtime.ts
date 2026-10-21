import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { digest, manifestSchema, type PluginManifest } from '@hasi/plugin-sdk';
import {
  PLUGIN_IMAGE_PROVENANCE_LABEL, pluginImageProvenanceLabel, pluginReleaseInventoryDigest,
  type PluginReleaseProvenance,
} from '@hasi/plugin-sdk/releases';
import type { ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import type { Persona } from '../apps/api/src/index.js';
import { ProductionAuthorityDirectory } from '../apps/api/src/production-runtime.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import {
  pluginReleaseSigningBytes,
  verifyPluginRelease,
  type PluginContainerLaunchOptions,
  type PluginReleaseEnvelope,
  type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import { createManagedPluginRpcClient } from '../apps/api/src/managed-plugin-rpc.js';
import { DOCKER_PLUGIN_MANAGED_VALUE } from '../apps/api/src/docker-plugin-relay.js';
import type { ReferencePluginArtifactEvidence } from './package-reference-plugin.js';
import { qualificationFixtures as f } from './healthy-plugin-qualification.js';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';
import { artifactPluginProvenance } from './plugin-release-provenance.js';
import type { ExternalPluginSourceIdentity } from './plugin-gateway-qualification-artifacts.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = 'hasi.reference';
const INSTALLATION_ID = 'hasi.reference';
const IMAGE_REPOSITORY = 'localhost/hasi-reference-qualification';
const OWNER_LABEL = 'com.hasi.qualification.owner';
const OWNER_MARKER_KEY = 'qualification:managed-plugin-journey:owner:v1';
const ADMIN_PERMISSION = 'plugins:manage';
const STUDENT_PERMISSIONS = ['reference:read', 'reference:prepare', 'reference:execute'] as const;
const SERVICE_TOKEN_SLOT = 'SERVICE_TOKEN';
const PUBLIC_KEY_SLOT = 'PUBLIC_KEY';
const SERVICE_TOKEN_ENVIRONMENT = 'HASI_PLUGIN_SECRET_SERVICE_TOKEN';
const TRANSPORT_ENVIRONMENT = 'HASI_PLUGIN_SECRET_TRANSPORT';
const PUBLIC_KEY_ENVIRONMENT = 'HASI_PLUGIN_SECRET_PUBLIC_KEY';
const OWNER_ID_LABEL = 'hasi.owner';
const MANAGED_LABEL = 'hasi.managed-by';
const INSTALLATION_LABEL = 'hasi.installation';
const PLUGIN_LABEL = 'hasi.plugin';
const OPERATION_LABEL = 'hasi.operation';
const FULL_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RELEASES = [
  { version: '1.0.0', id: 'reference-v1', suffix: 'v1' },
  { version: '1.0.1', id: 'reference-v2', suffix: 'v2' },
] as const;
const READINESS_MARKER = 'HASI managed plugin installer ready';

/** Slot names stay distinct; both resolve to the same synthetic instance credential. */
export const managedJourneyCredentialSlotContract = Object.freeze({
  transport: Object.freeze({ logicalName: 'transport', environmentName: TRANSPORT_ENVIRONMENT, valueBinding: 'installation-service-credential' }),
  plugin: Object.freeze({ logicalName: SERVICE_TOKEN_SLOT, environmentName: SERVICE_TOKEN_ENVIRONMENT, valueBinding: 'installation-service-credential' }),
});

export interface ManagedJourneyReleaseInput {
  readonly directory: string;
  readonly sourceSha: string;
  readonly sourceIdentity: ExternalPluginSourceIdentity;
  readonly evidence: ReferencePluginArtifactEvidence;
}

export interface ManagedPluginJourneyRuntimeOptions {
  /** Existing private temporary directory owned by the caller. */
  readonly directory: string;
  readonly scope: string;
  readonly databaseUrl: string;
  readonly authorityPrivateKey: KeyObject;
  readonly authorities: readonly Persona[];
  /** The installation-scoped bearer used by both the API and reference plugin. */
  readonly transportToken: string;
  /** Independently packaged v1 (1.0.0) and v2 (1.0.1) local artifacts. */
  readonly releases: readonly ManagedJourneyReleaseInput[];
  readonly onUnexpectedExit: () => void;
}

export interface ManagedJourneyReleaseMetadata {
  readonly id: string;
  readonly version: '1.0.0' | '1.0.1';
  readonly sourceSha: string;
  readonly artifactSha256: string;
  readonly artifactManifestSha256: string;
  readonly manifestDigest: string;
  readonly manifestFileSha256: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly releaseDigest: string;
}

export interface ManagedJourneySnapshot {
  readonly workerPid: number;
  readonly scope: string;
  readonly installationId: typeof INSTALLATION_ID;
  readonly status: ManagedPluginView['status'];
  readonly currentReleaseDigest: string | null;
  readonly previousReleaseDigest: string | null;
  readonly candidateReleaseDigest: string | null;
  readonly releases: readonly ManagedJourneyReleaseMetadata[];
}

export interface ManagedJourneyCleanupMetadata {
  readonly workerStopped: true;
  readonly routeWithdrawn: true;
  readonly containersRemoved: number;
  readonly networksRemoved: number;
  readonly imagesRemoved: number;
  readonly databaseNamespaceRetained: true;
  readonly recoveryMaterialRemoved: true;
}

export interface ManagedJourneyRuntime {
  readonly configuration: Readonly<{ ownerId: string; rpcOrigin: string; gatewayOrigin: string }>;
  snapshot(): Promise<ManagedJourneySnapshot>;
  close(): Promise<ManagedJourneyCleanupMetadata>;
}

export class ManagedPluginJourneyRuntimeError extends Error {
  readonly recoveryRequired: boolean;
  constructor(message: 'Managed plugin journey runtime failed.' | 'Managed plugin journey recovery is required.' | 'Managed plugin journey snapshot is unavailable.', recoveryRequired = false) {
    super(message);
    this.name = 'ManagedPluginJourneyRuntimeError';
    this.recoveryRequired = recoveryRequired;
  }
}

interface ArtifactRelease {
  readonly id: (typeof RELEASES)[number]['id'];
  readonly version: (typeof RELEASES)[number]['version'];
  readonly directory: string;
  readonly sourceSha: string;
  readonly sourceIdentity: ExternalPluginSourceIdentity;
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly provenance: PluginReleaseProvenance;
  readonly artifact: Awaited<ReturnType<typeof f.readArtifactManifest>>;
  readonly manifest: PluginManifest;
  readonly imageTag: string;
  imageId?: string;
  imageReference?: string;
  readonly launch: PluginContainerLaunchOptions;
  envelope?: PluginReleaseEnvelope;
  releaseDigest?: string;
}

interface ImageOwnership {
  readonly tag: string;
  readonly ownerId: string;
  expectedId?: string;
  attempted: boolean;
}

interface NetworkOwnership {
  readonly name: string;
  readonly internal: boolean;
  attempted: boolean;
}

interface WorkerHandle {
  readonly pid: number;
  ready(): Promise<void>;
  stop(): Promise<{ readonly stopped: boolean; readonly forced: boolean }>;
}

interface DockerImageInspection {
  readonly id: string;
  readonly owner: string;
  readonly repoTags: readonly string[];
}

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('Managed plugin journey boundary rejected.');
}

function validKeyPair(privateKey: KeyObject): boolean {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') return false;
  try {
    const publicKey = createPublicKey(privateKey);
    return publicKey.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function validateAuthorities(authorities: readonly Persona[]): void {
  assert(authorities.length === 2);
  const admin = authorities.find(person => person.role === 'admin');
  const student = authorities.find(person => person.role === 'student');
  assert(admin && student && authorities.every(person => person.role === 'admin' || person.role === 'student'));
  for (const person of authorities) {
    assert(person.id.length > 0 && person.id.length <= 256 && person.id === person.actor.subject);
  }
  assert(admin.actor.permissions.includes(ADMIN_PERMISSION));
  assert(STUDENT_PERMISSIONS.every(permission => student.actor.permissions.includes(permission)));
  // The reference.account claim is granted only by the plugin account projection after connect.
}

/** Pure admission boundary used by the runtime and its no-Docker/no-DB tests. */
export function validateManagedPluginJourneyBoundary(options: ManagedPluginJourneyRuntimeOptions): void {
  assert(typeof options.directory === 'string' && isAbsolute(options.directory) && !options.directory.includes('\0'));
  assert(typeof options.scope === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.scope));
  qualificationDatabase(options.databaseUrl);
  assert(validKeyPair(options.authorityPrivateKey));
  validateAuthorities(options.authorities);
  assert(typeof options.transportToken === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(options.transportToken));
  assert(typeof options.onUnexpectedExit === 'function');
  assert(options.releases.length === 2);
  const versions = new Set<string>();
  const sourceShas = new Set<string>();
  const sourceRepositories = new Set<string>();
  const directories = new Set<string>();
  for (const release of options.releases) {
    assert(typeof release.directory === 'string' && isAbsolute(release.directory) && !release.directory.includes('\0'));
    assert(GIT_SHA.test(release.sourceSha));
    const sourceIdentity: unknown = release.sourceIdentity;
    if (typeof sourceIdentity !== 'object' || sourceIdentity === null || Array.isArray(sourceIdentity)) {
      throw new ManagedPluginJourneyRuntimeError('Managed plugin journey runtime failed.');
    }
    const source = sourceIdentity as ExternalPluginSourceIdentity;
    assert(typeof source.repository === 'string' && source.revision === release.sourceSha && typeof source.tag === 'string');
    assert(source.tag.startsWith('v') ? source.tag.slice(1) === release.evidence.pluginVersion
      : source.tag === release.evidence.pluginVersion);
    try {
      artifactPluginProvenance(release.evidence, {
        repository: source.repository,
        revision: source.revision,
      });
    } catch { throw new ManagedPluginJourneyRuntimeError('Managed plugin journey runtime failed.'); }
    assert(!sourceShas.has(release.sourceSha));
    assert(!directories.has(resolve(release.directory)));
    assert(release.evidence.pluginId === PLUGIN_ID);
    assert(release.evidence.pluginVersion === '1.0.0' || release.evidence.pluginVersion === '1.0.1');
    assert(!versions.has(release.evidence.pluginVersion));
    assert(SHA256.test(release.evidence.manifestDigest)
      && SHA256.test(release.evidence.manifestFileSha256)
      && SHA256.test(release.evidence.artifactSha256)
      && SHA256.test(release.evidence.artifactManifestSha256));
    assert(Number.isSafeInteger(release.evidence.payloadFileCount) && release.evidence.payloadFileCount > 0);
    assert(Number.isSafeInteger(release.evidence.runtimePackageCount) && release.evidence.runtimePackageCount > 0);
    assert(release.evidence.licenseInventory.length <= 10_000);
    versions.add(release.evidence.pluginVersion);
    sourceShas.add(release.sourceSha);
    sourceRepositories.add(source.repository);
    directories.add(resolve(release.directory));
  }
  assert(versions.has('1.0.0') && versions.has('1.0.1') && sourceRepositories.size === 1);
}

/** Plans removals only for new containers carrying this runtime's owner label. */
export function planManagedJourneyContainerRemoval(input: {
  readonly baselineIds: readonly string[];
  readonly currentIds: readonly string[];
  readonly ownerFilteredIds: readonly string[];
}): readonly string[] {
  const isUniqueFullInventory = (ids: readonly string[]) => ids.every(id => FULL_ID.test(id)) && new Set(ids).size === ids.length;
  assert(isUniqueFullInventory(input.baselineIds)
    && isUniqueFullInventory(input.currentIds)
    && isUniqueFullInventory(input.ownerFilteredIds));
  const baseline = new Set(input.baselineIds);
  const current = new Set(input.currentIds);
  assert(input.ownerFilteredIds.every(id => current.has(id)));
  assert(input.ownerFilteredIds.every(id => !baseline.has(id)));
  return Object.freeze([...input.ownerFilteredIds].sort());
}

function secureTokenReference(ownerId: string, slot: 'service' | 'public'): string {
  return `journey-${ownerId.slice(-12)}-${slot}`;
}

function exactFullContainerList(): Set<string> {
  const output = f.runDocker(['container', 'ls', '--all', '--quiet', '--no-trunc'], 'managed_container_inventory_failed');
  if (output.length === 0) return new Set<string>();
  const ids = output.split('\n');
  assert(ids.every(id => FULL_ID.test(id)));
  assert(new Set(ids).size === ids.length);
  return new Set(ids);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseLabels(value: string | undefined): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '') as unknown;
  } catch {
    throw new Error('Managed plugin journey boundary rejected.');
  }
  const record = asRecord(parsed);
  assert(Object.values(record).every(label => typeof label === 'string'));
  return record as Record<string, string>;
}

function inspectContainer(id: string, ownerId: string): { readonly id: string; readonly operationId: string } {
  const fields = f.runDocker([
    'container', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{json .Config.Labels}}', id,
  ], 'managed_container_cleanup_inspection_failed').split('|');
  const labels = parseLabels(fields[2]);
  assert(fields[0] === id && fields[1]?.startsWith('/'));
  assert(labels[OWNER_ID_LABEL] === ownerId
    && labels[MANAGED_LABEL] === DOCKER_PLUGIN_MANAGED_VALUE
    && labels[INSTALLATION_LABEL] === INSTALLATION_ID
    && labels[PLUGIN_LABEL] === PLUGIN_ID
    && typeof labels[OPERATION_LABEL] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(labels[OPERATION_LABEL])
    && (labels['hasi.role'] === 'candidate' || labels['hasi.role'] === 'relay'));
  return { id, operationId: labels[OPERATION_LABEL] };
}

function inspectNetwork(network: NetworkOwnership, ownerId: string): { readonly id: string; readonly name: string } {
  const fields = f.runDocker([
    'network', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{.Internal}}|{{json .Labels}}', network.name,
  ], 'managed_network_cleanup_inspection_failed').split('|');
  const labels = parseLabels(fields[3]);
  assert(FULL_ID.test(fields[0] ?? '') && fields[1] === network.name
    && fields[2] === String(network.internal)
    && labels[OWNER_LABEL] === ownerId
    && labels[MANAGED_LABEL] === DOCKER_PLUGIN_MANAGED_VALUE
    && labels[OWNER_ID_LABEL] === ownerId);
  return { id: fields[0] ?? '', name: network.name };
}

function inspectImage(tag: string): DockerImageInspection {
  const fields = f.runDocker([
    'image', 'inspect', '--format', '{{.Id}}|{{json .RepoTags}}|{{index .Config.Labels "' + OWNER_LABEL + '"}}', tag,
  ], 'managed_image_cleanup_inspection_failed').split('|');
  assert(/^sha256:[a-f0-9]{64}$/u.test(fields[0] ?? ''));
  let repoTags: unknown;
  try {
    repoTags = JSON.parse(fields[1] ?? '') as unknown;
  } catch {
    throw new Error('Managed plugin journey boundary rejected.');
  }
  assert(repoTags === null || (Array.isArray(repoTags) && repoTags.every(value => typeof value === 'string')));
  return { id: fields[0] ?? '', owner: fields[2] ?? '', repoTags: Array.isArray(repoTags) ? repoTags : [] };
}

function exactDockerImageIdList(): Set<string> {
  const output = f.runDocker(['image', 'ls', '--all', '--quiet', '--no-trunc'], 'managed_image_inventory_failed');
  const ids = output ? output.split('\n') : [];
  assert(ids.every(id => /^sha256:[a-f0-9]{64}$/u.test(id)));
  return new Set(ids);
}

function startWorkerProcess(environment: Readonly<Record<string, string | undefined>>, onUnexpectedExit: () => void): WorkerHandle {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'LANG'] as const) {
    const value = process.env[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  Object.assign(childEnvironment, environment);
  const child: ChildProcess = spawn(process.execPath,
    ['--import', 'tsx', join(ROOT, 'apps/api/src/managed-plugin-worker.ts')],
    { cwd: ROOT, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  assert(typeof child.pid === 'number' && child.pid !== process.pid);
  let ready = false;
  let failed = false;
  let stopping = false;
  let markerTail = '';
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>(resolveExitPromise => { resolveExit = resolveExitPromise; });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (ready) return;
    const value = `${markerTail}${chunk.toString('utf8')}`;
    if (value.includes(READINESS_MARKER)) ready = true;
    markerTail = value.slice(-READINESS_MARKER.length);
  });
  child.stderr?.resume();
  child.once('error', () => { failed = true; resolveExit?.(); });
  child.once('exit', () => {
    resolveExit?.();
    if (!stopping) {
      try { onUnexpectedExit(); } catch { /* The host callback must not affect worker cleanup. */ }
    }
  });
  const running = () => child.exitCode === null && child.signalCode === null && !failed;
  return {
    pid: child.pid,
    ready: async () => {
      const deadline = Date.now() + 15_000;
      while (!ready && running() && Date.now() < deadline) await delay(50);
      assert(ready && running());
    },
    stop: async () => {
      stopping = true;
      if (!running()) return { stopped: child.exitCode !== null || child.signalCode !== null, forced: false };
      if (!child.kill('SIGTERM')) return { stopped: false, forced: false };
      const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
      if (graceful) return { stopped: true, forced: false };
      if (!child.kill('SIGKILL')) return { stopped: false, forced: true };
      const killed = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
      return { stopped: killed, forced: true };
    },
  };
}

function assignReleaseIdentity(release: ArtifactRelease, publisher: PublisherApproval, publisherKey: KeyObject): void {
  const unsigned: UnsignedPluginRelease = {
    schemaVersion: 2,
    pluginId: PLUGIN_ID,
    version: release.version,
    manifestDigest: digest(release.manifest),
    image: release.imageReference ?? '',
    publisherId: publisher.publisherId,
    configSchemaVersion: 1,
    stateMigration: 'none',
    provenance: release.provenance,
  };
  const envelope: PluginReleaseEnvelope = {
    ...unsigned,
    signature: sign(null, pluginReleaseSigningBytes(unsigned), publisherKey).toString('base64url'),
  };
  const verified = verifyPluginRelease(envelope, id => id === publisher.publisherId ? publisher : undefined);
  assert(verified.pluginId === PLUGIN_ID && verified.version === release.version
    && verified.manifestDigest === digest(release.manifest));
  release.envelope = envelope;
  release.releaseDigest = verified.releaseDigest;
}

function metadata(release: ArtifactRelease): ManagedJourneyReleaseMetadata {
  assert(release.imageId && release.imageReference && release.releaseDigest);
  return {
    id: release.id,
    version: release.version,
    sourceSha: release.sourceSha,
    artifactSha256: release.evidence.artifactSha256,
    artifactManifestSha256: release.evidence.artifactManifestSha256,
    manifestDigest: digest(release.manifest),
    manifestFileSha256: release.evidence.manifestFileSha256,
    imageId: release.imageId,
    imageReference: release.imageReference,
    releaseDigest: release.releaseDigest,
  };
}

async function directoryIdentity(path: string): Promise<void> {
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink());
}

/**
 * Starts the actual operator-owned installer worker and Docker gateway for the
 * held browser journey. The worker alone receives Docker socket configuration.
 * The API's gateway forwards Authorization unchanged, so the two differently
 * named transport and SERVICE_TOKEN slots intentionally resolve to the same
 * per-installation synthetic credential; this is not independent credential
 * separation.
 */
export async function startManagedJourneyRuntime(options: ManagedPluginJourneyRuntimeOptions): Promise<ManagedJourneyRuntime> {
  try {
    validateManagedPluginJourneyBoundary(options);
    assertNoPostgresEnvironment();
    await directoryIdentity(options.directory);
  } catch {
    throw new ManagedPluginJourneyRuntimeError('Managed plugin journey runtime failed.');
  }

  const database = qualificationDatabase(options.databaseUrl);
  let socketPath: string;
  try {
    socketPath = f.dockerSocketPath();
    f.assertLocalNodeImage();
  } catch {
    throw new ManagedPluginJourneyRuntimeError('Managed plugin journey runtime failed.');
  }

  const uuid = randomUUID();
  const suffix = uuid.replaceAll('-', '');
  const ownerId = `managed-journey-${suffix.slice(-12)}`;
  const namespace = `production:${options.scope}`;
  const helperDirectory = join(options.directory, `.managed-plugin-runtime-${suffix}`);
  const networkOwnership: NetworkOwnership[] = [
    { name: `hasi-journey-${suffix.slice(-12)}-a`, internal: true, attempted: false },
    { name: `hasi-journey-${suffix.slice(-12)}-b`, internal: true, attempted: false },
    { name: `hasi-journey-${suffix.slice(-12)}-relay`, internal: false, attempted: false },
  ];
  const imageOwnership: ImageOwnership[] = RELEASES.map(release => ({
    tag: `${IMAGE_REPOSITORY}:${suffix.slice(-12)}-${release.suffix}`,
    ownerId,
    attempted: false,
  }));
  const store = new PostgresJsonStore(namespace, { poolConfig: { ...database, max: 4 } });
  const routes = new PluginRouteController({ store, scope: options.scope, ownerId });
  const adminAuthority = options.authorities.find(person => person.role === 'admin');
  assert(adminAuthority);
  const publisherKeys = generateKeyPairSync('ed25519');
  const publisher: PublisherApproval = {
    publisherId: `hasi-journey-${suffix}`,
    publicKey: publisherKeys.publicKey,
    sourceRegistryPrefix: IMAGE_REPOSITORY,
    allowedPluginIds: [PLUGIN_ID],
  };
  const sourceInputs = [...options.releases].sort((a, b) => a.evidence.pluginVersion.localeCompare(b.evidence.pluginVersion));
  const allocatedPorts: number[] = [];
  const releases: ArtifactRelease[] = [];
  let storeOpened = false;
  let markerClaimed = false;
  let helperDirectoryCreated = false;
  let worker: WorkerHandle | undefined;
  let workerReady = false;
  let closed = false;
  let closing = false;
  let completedCleanup: ManagedJourneyCleanupMetadata | undefined;
  let closePromise: Promise<ManagedJourneyCleanupMetadata> | undefined;
  let baselineContainers: Set<string> | undefined;
  const config: { ownerId: string; rpcOrigin: string; gatewayOrigin: string } = {
    ownerId,
    rpcOrigin: '',
    gatewayOrigin: '',
  };

  const port = async () => {
    let value = await f.ephemeralLoopbackPort();
    while (allocatedPorts.includes(value)) value = await f.ephemeralLoopbackPort();
    allocatedPorts.push(value);
    return value;
  };

  const withdrawRoute = async (): Promise<boolean> => {
    if (!workerReady) return true;
    try {
      const route = await routes.read({ ownerId, installationId: INSTALLATION_ID });
      if (route.active) {
        await routes.withdraw({
          ownerId,
          installationId: INSTALLATION_ID,
          operationId: randomUUID(),
          currentDeploymentId: route.active.deploymentId,
          currentReleaseDigest: route.active.releaseDigest,
          configurationRevision: route.configurationRevision,
        });
      }
      return (await routes.read({ ownerId, installationId: INSTALLATION_ID })).active === null;
    } catch {
      return false;
    }
  };

  const stopWorker = async (): Promise<boolean> => {
    if (!worker) return true;
    try {
      const stopped = await worker.stop();
      return stopped.stopped;
    } catch {
      return false;
    }
  };

  const removeOwnedContainers = (): number | undefined => {
    if (!baselineContainers) return 0;
    try {
      const current = exactFullContainerList();
      const ownerIds = f.runDocker([
        'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_ID_LABEL}=${ownerId}`,
      ], 'managed_container_owner_inventory_failed').split('\n').filter(Boolean);
      const plannedIds = planManagedJourneyContainerRemoval({
        baselineIds: [...baselineContainers],
        currentIds: [...current],
        ownerFilteredIds: ownerIds,
      });
      const plan = plannedIds.map(id => inspectContainer(id, ownerId));
      const rechecked = exactFullContainerList();
      const recheckedOwnerIds = f.runDocker([
        'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_ID_LABEL}=${ownerId}`,
      ], 'managed_container_owner_inventory_failed').split('\n').filter(Boolean);
      const recheckedPlan = planManagedJourneyContainerRemoval({
        baselineIds: [...baselineContainers],
        currentIds: [...rechecked],
        ownerFilteredIds: recheckedOwnerIds,
      });
      if (recheckedPlan.length !== plan.length || recheckedPlan.some((id, index) => id !== plan[index]?.id)) return undefined;
      for (const container of plan) {
        f.runDocker(['container', 'rm', '--force', container.id], 'managed_owned_container_cleanup_failed');
      }
      const after = exactFullContainerList();
      const remainingOwnerIds = f.runDocker([
        'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_ID_LABEL}=${ownerId}`,
      ], 'managed_container_owner_inventory_failed').split('\n').filter(Boolean);
      if (planManagedJourneyContainerRemoval({
        baselineIds: [...baselineContainers],
        currentIds: [...after],
        ownerFilteredIds: remainingOwnerIds,
      }).length !== 0) return undefined;
      return plan.length;
    } catch {
      return undefined;
    }
  };

  const removeOwnedNetworks = (): number | undefined => {
    const attempted = networkOwnership.filter(network => network.attempted);
    try {
      const present = attempted.filter(network => {
        const names = f.runDocker(['network', 'ls', '--no-trunc', '--format', '{{.Name}}'], 'managed_network_inventory_failed');
        return names.split('\n').includes(network.name);
      });
      const plan = present.map(network => ({ network, identity: inspectNetwork(network, ownerId) }));
      for (const { network } of plan) {
        f.runDocker(['network', 'rm', network.name], 'managed_network_cleanup_failed');
      }
      for (const { network } of plan) {
        const names = f.runDocker(['network', 'ls', '--no-trunc', '--format', '{{.Name}}'], 'managed_network_cleanup_verification_failed');
        if (names.split('\n').includes(network.name)) return undefined;
      }
      return plan.length;
    } catch {
      return undefined;
    }
  };

  const removeOwnedImages = (): number | undefined => {
    const attempted = imageOwnership.filter(image => image.attempted);
    try {
      const imageIds = exactDockerImageIdList();
      const plan: { image: ImageOwnership; inspected: DockerImageInspection; reference: string }[] = [];
      for (const image of attempted) {
        const tags = f.runDocker(['image', 'ls', '--all', '--quiet', '--no-trunc', image.tag], 'managed_image_inventory_failed');
        if (tags) {
          const inspected = inspectImage(image.tag);
          if (inspected.owner !== image.ownerId || (image.expectedId !== undefined && inspected.id !== image.expectedId)
            || inspected.repoTags.length !== 1 || inspected.repoTags[0] !== image.tag) return undefined;
          plan.push({ image, inspected, reference: image.tag });
        } else if (image.expectedId) {
          if (!imageIds.has(image.expectedId)) continue;
          const inspected = inspectImage(image.expectedId);
          if (inspected.owner !== image.ownerId || inspected.id !== image.expectedId || inspected.repoTags.length !== 0) return undefined;
          plan.push({ image, inspected, reference: image.expectedId });
        } else {
          // A failed build without a recorded image ID or tag has an ambiguous
          // outcome, so preserve the recovery directory and leave Docker alone.
          return undefined;
        }
      }
      for (const { reference } of plan) {
        f.runDocker(['image', 'rm', reference], 'managed_image_cleanup_failed');
      }
      for (const { image, inspected } of plan) {
        const tags = f.runDocker(['image', 'ls', '--all', '--quiet', '--no-trunc', image.tag], 'managed_image_cleanup_verification_failed');
        if (tags) return undefined;
        if (exactDockerImageIdList().has(inspected.id)) return undefined;
      }
      return plan.length;
    } catch {
      return undefined;
    }
  };

  const closeStore = async (): Promise<boolean> => {
    if (!storeOpened) return true;
    try {
      await store.close();
      storeOpened = false;
      return true;
    } catch {
      return false;
    }
  };

  const cleanup = async (): Promise<ManagedJourneyCleanupMetadata | undefined> => {
    let routeWithdrawn = false;
    try {
      routeWithdrawn = await withdrawRoute();
    } catch {
      routeWithdrawn = false;
    }
    const workerStopped = await stopWorker();
    let containersRemoved: number | undefined;
    let networksRemoved: number | undefined;
    let imagesRemoved: number | undefined;
    if (routeWithdrawn && workerStopped) containersRemoved = removeOwnedContainers();
    if (routeWithdrawn && workerStopped && containersRemoved !== undefined) networksRemoved = removeOwnedNetworks();
    if (routeWithdrawn && workerStopped && containersRemoved !== undefined && networksRemoved !== undefined) {
      imagesRemoved = removeOwnedImages();
    }
    const databaseClosed = await closeStore();
    const clean = routeWithdrawn && workerStopped && containersRemoved !== undefined
      && networksRemoved !== undefined && imagesRemoved !== undefined && databaseClosed;
    if (!clean || containersRemoved === undefined || networksRemoved === undefined || imagesRemoved === undefined) return undefined;
    if (helperDirectoryCreated) {
      try {
        await rm(helperDirectory, { recursive: true, force: false });
        helperDirectoryCreated = false;
      } catch {
        return undefined;
      }
    }
    closed = true;
    return {
      workerStopped: true,
      routeWithdrawn: true,
      containersRemoved,
      networksRemoved,
      imagesRemoved,
      databaseNamespaceRetained: true,
      recoveryMaterialRemoved: true,
    };
  };

  try {
    await mkdir(helperDirectory, { mode: 0o700 });
    helperDirectoryCreated = true;
    const info = await lstat(helperDirectory);
    assert(info.isDirectory() && !info.isSymbolicLink());
    storeOpened = true;
    await store.initialize();
    const nonce = randomUUID();
    markerClaimed = await store.compareAndSet(OWNER_MARKER_KEY, null, {
      purpose: 'managed-plugin-journey', ownerId, namespace, nonce,
    });
    assert(markerClaimed);

    baselineContainers = exactFullContainerList();
    const preexistingOwnerContainers = f.runDocker([
      'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_ID_LABEL}=${ownerId}`,
    ], 'managed_container_owner_inventory_failed').split('\n').filter(Boolean);
    assert(planManagedJourneyContainerRemoval({
      baselineIds: [...baselineContainers],
      currentIds: [...baselineContainers],
      ownerFilteredIds: preexistingOwnerContainers,
    }).length === 0);
    const networkNames = f.runDocker(['network', 'ls', '--no-trunc', '--format', '{{.Name}}'], 'managed_network_inventory_failed').split('\n');
    assert(networkOwnership.every(network => !networkNames.includes(network.name)));
    for (const image of imageOwnership) {
      const existing = f.runDocker(['image', 'ls', '--all', '--quiet', '--no-trunc', image.tag], 'managed_image_collision_check_failed');
      assert(existing.length === 0);
    }

    const publisherPublicKey = publisherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    for (let index = 0; index < RELEASES.length; index += 1) {
      const spec = RELEASES[index];
      assert(spec);
      const source = sourceInputs.find(item => item.evidence.pluginVersion === spec.version);
      const image = imageOwnership[index];
      const network = networkOwnership[index];
      assert(source && image && network);
      const artifact = await f.readArtifactManifest(source.directory, source.evidence);
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(source.directory, 'src/manifest.json'), 'utf8')) as unknown);
      assert(manifest.id === PLUGIN_ID && manifest.version === spec.version
        && digest(manifest) === source.evidence.manifestDigest);
      const hostPort = await port();
      const release: ArtifactRelease = {
        id: spec.id,
        version: spec.version,
        directory: source.directory,
        sourceSha: source.sourceSha,
        sourceIdentity: source.sourceIdentity,
        evidence: source.evidence,
        provenance: artifactPluginProvenance(source.evidence, {
          repository: source.sourceIdentity.repository,
          revision: source.sourceIdentity.revision,
        }),
        artifact,
        manifest,
        imageTag: image.tag,
        launch: {
          network: { mode: 'internal', name: network.name },
          hostPort,
          containerPort: 3000,
          cpuMillicores: 500,
          memoryBytes: 268_435_456,
          pidsLimit: 64,
          startupTimeoutMs: 30_000,
          shutdownTimeoutMs: 2_000,
        },
      };
      const dockerfile = join(helperDirectory, `Dockerfile-${spec.suffix}`);
      await writeFile(dockerfile, f.pluginLauncherDockerfile(), { mode: 0o600, flag: 'wx' });
      const provenanceLabel = pluginImageProvenanceLabel({
        pluginId: PLUGIN_ID,
        version: release.version,
        manifestDigest: digest(release.manifest),
        provenance: release.provenance,
      });
      image.attempted = true;
      f.runDocker([
        'build', '--network=none', '--pull=false', '--label', `${OWNER_LABEL}=${ownerId}`,
        '--label', `${PLUGIN_IMAGE_PROVENANCE_LABEL}=${provenanceLabel}`,
        '--tag', image.tag, '--file', dockerfile, source.directory,
      ], 'managed_offline_image_build_failed', 180_000);
      const built = f.dockerImageIdentity(image.tag, ownerId, provenanceLabel);
      assert(/^sha256:[a-f0-9]{64}$/u.test(built.id)
        && /^localhost\/hasi-reference-qualification@sha256:[a-f0-9]{64}$/u.test(built.repoDigest));
      release.imageId = built.id;
      release.imageReference = built.repoDigest;
      image.expectedId = built.id;
      assignReleaseIdentity(release, publisher, publisherKeys.privateKey);
      releases.push(release);
    }

    for (const network of networkOwnership) {
      network.attempted = true;
      f.createQualificationNetwork(network.name, ownerId, network.internal);
      inspectNetwork(network, ownerId);
    }

    const serviceTokenRef = secureTokenReference(ownerId, 'service');
    const publicKeyRef = secureTokenReference(ownerId, 'public');
    const authorityPublicKey = createPublicKey(options.authorityPrivateKey)
      .export({ type: 'spki', format: 'pem' }).toString();
    const sourceCatalog = releases.map(release => ({
      id: release.id,
      envelope: release.envelope,
      manifest: release.manifest,
      launch: release.launch,
      secretAssignments: [
        { name: SERVICE_TOKEN_SLOT, secretRef: serviceTokenRef },
        { name: PUBLIC_KEY_SLOT, secretRef: publicKeyRef },
      ],
    }));
    const [rpcPort, gatewayPort] = await Promise.all([port(), port()]);
    const relayNetwork = networkOwnership[2];
    assert(relayNetwork);
    const installerConfig = {
      version: 1,
      scope: options.scope,
      ownerId,
      rpcPort,
      gatewayPort,
      socketPath,
      internalNetworks: networkOwnership.slice(0, 2).map(network => network.name),
      relayNetwork: relayNetwork.name,
      publishers: [{
        publisherId: publisher.publisherId,
        publicKey: publisherPublicKey,
        sourceRegistryPrefix: IMAGE_REPOSITORY,
        allowedPluginIds: [PLUGIN_ID],
        revoked: false,
      }],
      installations: [{
        id: INSTALLATION_ID,
        label: 'Synthetic managed reference plugin',
        pluginId: PLUGIN_ID,
        configurationSchemaVersion: 1,
        restorePlans: [],
        releases: sourceCatalog,
      }],
      credentials: {
        [INSTALLATION_ID]: {
          transport: { environmentName: TRANSPORT_ENVIRONMENT, revision: 'transport-r1' },
          slots: {
            [serviceTokenRef]: { environmentName: SERVICE_TOKEN_ENVIRONMENT, revision: 'service-token-r1' },
            [publicKeyRef]: { environmentName: PUBLIC_KEY_ENVIRONMENT, revision: 'public-key-r1' },
          },
        },
      },
    };
    const configPath = join(helperDirectory, 'installer-config.json');
    await writeFile(configPath, `${JSON.stringify(installerConfig, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

    const authorityDirectory = new ProductionAuthorityDirectory(store, options.authorityPrivateKey, options.scope);
    for (const person of options.authorities) {
      assert(await authorityDirectory.replace(person.id, null, person));
    }

    config.rpcOrigin = `http://127.0.0.1:${String(rpcPort)}`;
    config.gatewayOrigin = `http://127.0.0.1:${String(gatewayPort)}`;
    worker = startWorkerProcess({
      HASI_MODE: 'production',
      HASI_MANAGED_INSTALLER: '1',
      HASI_INSTALLER_CONFIG: configPath,
      DATABASE_URL: options.databaseUrl,
      HASI_PRIVATE_KEY: options.authorityPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      HASI_PLUGIN_SECRET_TRANSPORT: options.transportToken,
      // The gateway forwards its bearer unchanged; the fixture's two logical slots alias this one credential.
      HASI_PLUGIN_SECRET_SERVICE_TOKEN: options.transportToken,
      HASI_PLUGIN_SECRET_PUBLIC_KEY: authorityPublicKey,
    }, options.onUnexpectedExit);
    await worker.ready();
    workerReady = true;

    const rpc = createManagedPluginRpcClient({ origin: config.rpcOrigin, privateKey: options.authorityPrivateKey, scope: options.scope });
    const initial = await rpc.list(adminAuthority.id);
    const view = initial.installations.find(item => item.id === INSTALLATION_ID);
    assert(initial.installations.length === 1 && view?.status === 'empty'
      && view.current === null && view.previous === null && view.candidate === null);
    assert(view.releases.length === releases.length);
    for (const release of releases) {
      const installed = view.releases.find(item => item.id === release.id);
      assert(installed && installed.digest === release.releaseDigest && installed.version === release.version
        && installed.inventoryDigest === pluginReleaseInventoryDigest(release.provenance));
    }

    const snapshot = async (): Promise<ManagedJourneySnapshot> => {
      if (closed || closing || !worker) throw new ManagedPluginJourneyRuntimeError('Managed plugin journey snapshot is unavailable.');
      try {
        const catalog = await rpc.list(adminAuthority.id);
        assert(catalog.installations.length === 1);
        const installation = catalog.installations[0];
        assert(installation?.id === INSTALLATION_ID && installation.releases.length === releases.length);
        for (const release of releases) {
          const installed = installation.releases.find(item => item.id === release.id);
          assert(installed && installed.digest === release.releaseDigest && installed.version === release.version
            && installed.inventoryDigest === pluginReleaseInventoryDigest(release.provenance));
        }
        const result: ManagedJourneySnapshot = {
          workerPid: worker.pid,
          scope: options.scope,
          installationId: INSTALLATION_ID,
          status: installation.status,
          currentReleaseDigest: installation.current?.digest ?? null,
          previousReleaseDigest: installation.previous?.digest ?? null,
          candidateReleaseDigest: installation.candidate?.digest ?? null,
          releases: releases.map(metadata),
        };
        return result;
      } catch {
        throw new ManagedPluginJourneyRuntimeError('Managed plugin journey snapshot is unavailable.');
      }
    };

    const close = (): Promise<ManagedJourneyCleanupMetadata> => {
      if (completedCleanup) return Promise.resolve(completedCleanup);
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const result = await cleanup();
        if (!result) throw new ManagedPluginJourneyRuntimeError('Managed plugin journey recovery is required.', true);
        completedCleanup = result;
        return result;
      })().finally(() => {
        closing = false;
        if (!completedCleanup) closePromise = undefined;
      });
      return closePromise;
    };

    const runtime: ManagedJourneyRuntime = {
      configuration: Object.freeze({ ...config }),
      snapshot,
      close,
    };
    await snapshot();
    return runtime;
  } catch {
    const cleaned = await cleanup();
    if (!cleaned) throw new ManagedPluginJourneyRuntimeError('Managed plugin journey recovery is required.', true);
    throw new ManagedPluginJourneyRuntimeError('Managed plugin journey runtime failed.');
  }
}
