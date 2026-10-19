import { createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import { digest } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { valid as validSemver } from 'semver';
import { z } from 'zod';

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_DOMAIN = 'hasi-plugin-release-v1\0';
const DEFAULT_CPU_MILLICORES = 500;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_PIDS_LIMIT = 64;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const EMPTY_LIST = Object.freeze([] as const);

export class PluginArtifactError extends Error {
  constructor(message = 'Plugin artifact operation was rejected.') {
    super(message);
    this.name = 'PluginArtifactError';
  }
}

export class DeploymentDriverError extends Error {
  constructor(public readonly outcome: 'failed' | 'unknown') {
    super(outcome === 'failed' ? 'Deployment operation failed.' : 'Deployment outcome is unknown.');
    this.name = 'DeploymentDriverError';
  }
}

const unsignedReleaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pluginId: z.string().min(1).max(128).regex(PLUGIN_ID),
  version: z.string().min(1).max(128),
  manifestDigest: z.string().regex(SHA256),
  image: z.string().min(1).max(512),
  publisherId: z.string().min(1).max(128).regex(PLUGIN_ID),
  configSchemaVersion: z.number().int().positive().max(2_147_483_647),
  stateMigration: z.enum(['none', 'reversible', 'irreversible']),
});

const releaseEnvelopeSchema = unsignedReleaseSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type UnsignedPluginRelease = z.infer<typeof unsignedReleaseSchema>;
export type PluginReleaseEnvelope = z.infer<typeof releaseEnvelopeSchema>;

const verifiedReleaseBrand: unique symbol = Symbol('hasi.verified-plugin-release');
const verifiedReleases = new WeakSet();

/** A release whose signature, publisher, plugin and immutable image source were verified. */
export interface VerifiedPluginRelease extends PluginReleaseEnvelope {
  readonly releaseDigest: string;
  readonly imageDigest: string;
  readonly [verifiedReleaseBrand]: true;
}

export interface PublisherApproval {
  readonly publisherId: string;
  readonly publicKey: KeyObject | string | Buffer;
  /** Repository namespace approved by the operator, such as registry.example.org/hasi. */
  readonly sourceRegistryPrefix: string;
  readonly allowedPluginIds: readonly string[];
  readonly revoked?: boolean;
}

export type PublisherApprovalResolver = (publisherId: string) => PublisherApproval | undefined;

interface ParsedImage {
  readonly repository: string;
  readonly digest: string;
}

function parseRepository(repository: string): string {
  if (!repository || repository.length > 384 || repository.includes('\\') || /[\s?#@]/.test(repository)) {
    throw new PluginArtifactError('Plugin image reference is invalid.');
  }
  const components = repository.split('/');
  if (components.length < 2) throw new PluginArtifactError('Plugin image reference is invalid.');
  const registry = components.shift();
  if (!registry) throw new PluginArtifactError('Plugin image reference is invalid.');

  let hostname = registry;
  const portSeparator = registry.lastIndexOf(':');
  if (portSeparator !== -1) {
    hostname = registry.slice(0, portSeparator);
    const port = Number(registry.slice(portSeparator + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new PluginArtifactError('Plugin image reference is invalid.');
  }
  const labels = hostname.split('.');
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new PluginArtifactError('Plugin image reference is invalid.');
  }
  if (!components.every(component => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(component))) {
    throw new PluginArtifactError('Plugin image reference is invalid.');
  }
  return repository;
}

function parseImageReference(image: string): ParsedImage {
  const marker = image.lastIndexOf('@sha256:');
  if (marker <= 0 || marker !== image.indexOf('@sha256:')) throw new PluginArtifactError('Plugin image must use an immutable sha256 digest.');
  const repository = parseRepository(image.slice(0, marker));
  const imageDigest = image.slice(marker + '@sha256:'.length);
  if (!SHA256.test(imageDigest)) throw new PluginArtifactError('Plugin image must use an immutable sha256 digest.');
  return { repository, digest: imageDigest };
}

function parseRepositoryPrefix(prefix: string): string {
  if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  return parseRepository(prefix);
}

function validateUnsignedRelease(input: unknown): UnsignedPluginRelease {
  const parsed = unsignedReleaseSchema.safeParse(input);
  if (!parsed.success) throw new PluginArtifactError('Plugin release envelope is invalid.');
  if (validSemver(parsed.data.version) !== parsed.data.version) throw new PluginArtifactError('Plugin release version is invalid.');
  parseImageReference(parsed.data.image);
  return parsed.data;
}

function unsignedFromEnvelope(envelope: PluginReleaseEnvelope): UnsignedPluginRelease {
  return {
    schemaVersion: envelope.schemaVersion,
    pluginId: envelope.pluginId,
    version: envelope.version,
    manifestDigest: envelope.manifestDigest,
    image: envelope.image,
    publisherId: envelope.publisherId,
    configSchemaVersion: envelope.configSchemaVersion,
    stateMigration: envelope.stateMigration,
  };
}

/** Returns the canonical, domain-separated bytes publishers sign with Ed25519. */
export function pluginReleaseSigningBytes(input: unknown): Buffer {
  const release = validateUnsignedRelease(input);
  return Buffer.from(`${RELEASE_DOMAIN}${digest(release)}`, 'utf8');
}

function normalizePublicKey(input: PublisherApproval['publicKey']): KeyObject {
  try {
    let key: KeyObject;
    if (Buffer.isBuffer(input)) {
      key = createPublicKey(input);
    } else if (typeof input === 'string') {
      key = createPublicKey(input);
    } else {
      if (input.type !== 'public') throw new Error('not a public key');
      key = input;
    }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw new PluginArtifactError('Publisher trust configuration is invalid.');
  }
}

function resolveApproval(publisherId: string, resolve: PublisherApprovalResolver): PublisherApproval {
  let approval: PublisherApproval | undefined;
  try { approval = resolve(publisherId); } catch { /* Treat trust lookup failure as denial. */ }
  if (!approval || approval.revoked || approval.publisherId !== publisherId || !Array.isArray(approval.allowedPluginIds)) {
    throw new PluginArtifactError('Plugin publisher is not currently approved.');
  }
  return approval;
}

export function verifyPluginRelease(input: unknown, resolvePublisher: PublisherApprovalResolver): VerifiedPluginRelease {
  const parsed = releaseEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new PluginArtifactError('Plugin release envelope is invalid.');
  const envelope = parsed.data;
  const unsigned = validateUnsignedRelease(unsignedFromEnvelope(envelope));
  const image = parseImageReference(envelope.image);
  const approval = resolveApproval(envelope.publisherId, resolvePublisher);
  const pluginIds = new Set(approval.allowedPluginIds);
  if (!pluginIds.has(envelope.pluginId)) throw new PluginArtifactError('Plugin publisher is not approved for this plugin.');

  const approvedPrefix = parseRepositoryPrefix(approval.sourceRegistryPrefix);
  if (image.repository !== approvedPrefix && !image.repository.startsWith(`${approvedPrefix}/`)) {
    throw new PluginArtifactError('Plugin image source is not operator-approved.');
  }

  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.byteLength !== 64 || signature.toString('base64url') !== envelope.signature) {
    throw new PluginArtifactError('Plugin release signature is invalid.');
  }
  const key = normalizePublicKey(approval.publicKey);
  const signedBytes = Buffer.from(`${RELEASE_DOMAIN}${digest(unsigned)}`, 'utf8');
  if (!verify(null, signedBytes, key, signature)) throw new PluginArtifactError('Plugin release signature is invalid.');

  const releaseDigest = digest(unsigned);
  const verifiedRelease = Object.freeze({ ...envelope, releaseDigest, imageDigest: image.digest, [verifiedReleaseBrand]: true as const });
  verifiedReleases.add(verifiedRelease);
  return verifiedRelease;
}

export interface PluginContainerLaunchOptions {
  readonly network: { readonly mode: 'none' } | { readonly mode: 'internal'; readonly name: string };
  readonly hostPort?: number;
  readonly containerPort?: number;
  readonly cpuMillicores?: number;
  readonly memoryBytes?: number;
  readonly pidsLimit?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface PluginContainerLaunchPolicy {
  readonly image: string;
  readonly imageDigest: string;
  readonly user: { readonly uid: 65_532; readonly gid: 65_532 };
  readonly runAsNonRoot: true;
  readonly readOnlyRootFilesystem: true;
  readonly capDrop: readonly ['ALL'];
  readonly noNewPrivileges: true;
  readonly privileged: false;
  readonly seccompProfile: 'runtime/default';
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly memorySwapBytes: number;
  readonly pidsLimit: number;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly network: { readonly mode: 'none' } | { readonly mode: 'internal'; readonly name: string; readonly internal: true };
  readonly ingress: { readonly hostAddress: '127.0.0.1'; readonly hostPort: number; readonly containerPort: number; readonly protocol: 'tcp' } | null;
  readonly args: readonly [];
  readonly environment: readonly [];
  readonly mounts: readonly [];
  readonly devices: readonly [];
}

const networkOptionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('internal'), name: z.string().min(1).max(63).regex(/^[a-z][a-z0-9-]*$/) }),
]);
const launchOptionSchema = z.strictObject({
  network: networkOptionSchema,
  hostPort: z.number().int().min(1).max(65_535).optional(),
  containerPort: z.number().int().min(1).max(65_535).optional(),
  cpuMillicores: z.number().int().min(100).max(16_000).optional(),
  memoryBytes: z.number().int().min(64 * 1024 * 1024).max(16 * 1024 * 1024 * 1024).optional(),
  pidsLimit: z.number().int().min(1).max(4_096).optional(),
  startupTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  shutdownTimeoutMs: z.number().int().min(1).max(30_000).optional(),
});

export function buildPluginContainerLaunchPolicy(release: VerifiedPluginRelease, options: PluginContainerLaunchOptions): PluginContainerLaunchPolicy {
  if (typeof release !== 'object' || !verifiedReleases.has(release)) {
    throw new PluginArtifactError('Only a verified release can be admitted for deployment.');
  }
  const parsed = launchOptionSchema.safeParse(options);
  if (!parsed.success) throw new PluginArtifactError('Plugin launch policy is invalid.');
  const input = parsed.data;
  const internalNetwork = input.network.mode === 'internal';
  if ((internalNetwork && input.hostPort === undefined) || (!internalNetwork && input.hostPort !== undefined)) {
    throw new PluginArtifactError('An internal network requires relay loopback ingress; network-none forbids ingress.');
  }
  if (input.network.mode === 'internal' && ['bridge', 'default', 'host', 'none'].includes(input.network.name)) {
    throw new PluginArtifactError('Plugin network must be an operator-defined isolated network.');
  }

  const memoryBytes = input.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const network = input.network.mode === 'internal'
    ? Object.freeze({ mode: 'internal' as const, name: input.network.name, internal: true as const })
    : Object.freeze({ mode: 'none' as const });
  let ingress: PluginContainerLaunchPolicy['ingress'] = null;
  if (internalNetwork && input.hostPort !== undefined) {
    ingress = Object.freeze({ hostAddress: '127.0.0.1', hostPort: input.hostPort, containerPort: input.containerPort ?? 3000, protocol: 'tcp' });
  }

  return Object.freeze({
    image: release.image,
    imageDigest: release.imageDigest,
    user: Object.freeze({ uid: 65_532 as const, gid: 65_532 as const }),
    runAsNonRoot: true as const,
    readOnlyRootFilesystem: true as const,
    capDrop: Object.freeze(['ALL'] as const),
    noNewPrivileges: true as const,
    privileged: false as const,
    seccompProfile: 'runtime/default' as const,
    cpuMillicores: input.cpuMillicores ?? DEFAULT_CPU_MILLICORES,
    memoryBytes,
    memorySwapBytes: memoryBytes,
    pidsLimit: input.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    startupTimeoutMs: input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    shutdownTimeoutMs: input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    network,
    ingress,
    args: EMPTY_LIST,
    environment: EMPTY_LIST,
    mounts: EMPTY_LIST,
    devices: EMPTY_LIST,
  });
}

const logicalSecretAssignmentSchema = z.strictObject({
  name: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  secretRef: z.string().min(1).max(128).regex(OPAQUE_ID),
});
const secretAssignmentsSchema = z.array(logicalSecretAssignmentSchema).max(64).superRefine((assignments, context) => {
  const names = assignments.map(item => item.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'secret assignment names must be unique' });
});
export type LogicalSecretAssignment = z.infer<typeof logicalSecretAssignmentSchema>;

const reviewApprovalSchema = z.strictObject({
  approvalId: z.string().min(1).max(128).regex(OPAQUE_ID),
  reviewerId: z.string().min(1).max(128).regex(OPAQUE_ID),
  restorePlanId: z.string().min(1).max(128).regex(OPAQUE_ID).optional(),
});
export type PluginChangeReview = z.infer<typeof reviewApprovalSchema>;

const storedReleaseSchema = z.strictObject({
  envelope: releaseEnvelopeSchema,
  releaseDigest: z.string().regex(SHA256),
  deploymentId: z.string().min(1).max(128).regex(OPAQUE_ID),
  secretAssignments: secretAssignmentsSchema,
  effectsExpanded: z.boolean(),
  permissionsExpanded: z.boolean(),
  reviewApproval: reviewApprovalSchema.optional(),
});
const candidateSchema = z.strictObject({
  envelope: releaseEnvelopeSchema,
  releaseDigest: z.string().regex(SHA256),
  secretAssignments: secretAssignmentsSchema,
  // Retained so a revoked staged container can be discarded using its original
  // driver ownership token after the stage operation itself has completed.
  stagingOperationId: z.string().min(1).max(128).regex(OPAQUE_ID).optional(),
  stagedDeploymentId: z.string().min(1).max(128).regex(OPAQUE_ID).optional(),
  configurationRevision: z.string().min(1).max(256),
  baseCurrentDigest: z.string().regex(SHA256).nullable(),
  configurationCompatible: z.literal(true),
  effectsExpanded: z.boolean(),
  permissionsExpanded: z.boolean(),
  reviewApproval: reviewApprovalSchema.optional(),
});
const stagePendingSchema = z.strictObject({
  kind: z.literal('stage'),
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  baseCurrentDigest: z.string().regex(SHA256).nullable(),
  configurationRevision: z.string().min(1).max(256),
  candidateDigest: z.string().regex(SHA256),
});
const activatePendingSchema = z.strictObject({
  kind: z.literal('activate'),
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  baseCurrentDigest: z.string().regex(SHA256).nullable(),
  configurationRevision: z.string().min(1).max(256),
  candidateDigest: z.string().regex(SHA256),
});
const rollbackPendingSchema = z.strictObject({
  kind: z.literal('rollback'),
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  baseCurrentDigest: z.string().regex(SHA256),
  configurationRevision: z.string().min(1).max(256),
  targetDigest: z.string().regex(SHA256),
});
const discardPendingSchema = z.strictObject({
  kind: z.literal('discard'),
  operationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  stagingOperationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  stagedDeploymentId: z.string().min(1).max(128).regex(OPAQUE_ID),
  baseCurrentDigest: z.string().regex(SHA256).nullable(),
  configurationRevision: z.string().min(1).max(256),
  candidateDigest: z.string().regex(SHA256),
});
const pendingSchema = z.discriminatedUnion('kind', [stagePendingSchema, activatePendingSchema, rollbackPendingSchema, discardPendingSchema]);
const deploymentStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  pluginId: z.string().min(1).max(128).regex(PLUGIN_ID),
  status: z.enum(['empty', 'active', 'staging', 'stage-unknown', 'candidate-ready', 'review-required', 'discarding', 'discard-unknown', 'activating', 'activation-unknown', 'rolling-back', 'rollback-unknown']),
  configurationRevision: z.string().min(1).max(256),
  configurationSchemaVersion: z.number().int().positive().max(2_147_483_647),
  current: storedReleaseSchema.nullable(),
  previous: storedReleaseSchema.nullable(),
  candidate: candidateSchema.nullable(),
  pending: pendingSchema.nullable(),
});
type StoredRelease = z.infer<typeof storedReleaseSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type PendingOperation = z.infer<typeof pendingSchema>;
type DiscardOperation = Extract<PendingOperation, { kind: 'discard' }>;
type DeploymentState = z.infer<typeof deploymentStateSchema>;

function releaseDigest(envelope: PluginReleaseEnvelope): string {
  return digest(unsignedFromEnvelope(envelope));
}

function releaseIdentity(envelope: PluginReleaseEnvelope, hash: string): PluginReleaseIdentity {
  const image = parseImageReference(envelope.image);
  return Object.freeze({
    pluginId: envelope.pluginId,
    version: envelope.version,
    manifestDigest: envelope.manifestDigest,
    image: envelope.image,
    imageDigest: image.digest,
    publisherId: envelope.publisherId,
    configSchemaVersion: envelope.configSchemaVersion,
    stateMigration: envelope.stateMigration,
    releaseDigest: hash,
  });
}

export interface PluginReleaseIdentity {
  readonly pluginId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly publisherId: string;
  readonly configSchemaVersion: number;
  readonly stateMigration: 'none' | 'reversible' | 'irreversible';
  readonly releaseDigest: string;
}

function requiresReview(candidate: Candidate): boolean {
  return candidate.effectsExpanded || candidate.permissionsExpanded || candidate.envelope.stateMigration === 'irreversible';
}

function reviewIsSufficient(candidate: Candidate, approval = candidate.reviewApproval): boolean {
  if (!requiresReview(candidate)) return true;
  if (!approval?.approvalId || !approval.reviewerId) return false;
  return candidate.envelope.stateMigration !== 'irreversible' || approval.restorePlanId !== undefined;
}

function validateStoredRelease(record: StoredRelease, pluginId: string): void {
  validateUnsignedRelease(unsignedFromEnvelope(record.envelope));
  if (record.envelope.pluginId !== pluginId || releaseDigest(record.envelope) !== record.releaseDigest) throw new Error('release binding mismatch');
  const parsedSecrets = secretAssignmentsSchema.parse(record.secretAssignments);
  if (parsedSecrets.length !== record.secretAssignments.length) throw new Error('invalid secret assignments');
  const reviewRequired = record.effectsExpanded || record.permissionsExpanded || record.envelope.stateMigration === 'irreversible';
  if (reviewRequired && !record.reviewApproval) throw new Error('review record missing');
  if (record.envelope.stateMigration === 'irreversible' && !record.reviewApproval?.restorePlanId) throw new Error('restore plan missing');
}

function validateStateInvariants(state: DeploymentState): void {
  if (state.current) validateStoredRelease(state.current, state.pluginId);
  if (state.previous) validateStoredRelease(state.previous, state.pluginId);
  if (state.candidate) {
    validateUnsignedRelease(unsignedFromEnvelope(state.candidate.envelope));
    if (state.candidate.envelope.pluginId !== state.pluginId || releaseDigest(state.candidate.envelope) !== state.candidate.releaseDigest) throw new Error('candidate binding mismatch');
    secretAssignmentsSchema.parse(state.candidate.secretAssignments);
    if (state.candidate.configurationRevision !== state.configurationRevision) throw new Error('candidate configuration changed');
    if (state.candidate.baseCurrentDigest !== (state.current?.releaseDigest ?? null)) throw new Error('candidate base changed');
  }
  if (state.pending) {
    if (state.pending.configurationRevision !== state.configurationRevision || state.pending.baseCurrentDigest !== (state.current?.releaseDigest ?? null)) throw new Error('pending operation base changed');
  }
  const stageState = state.status === 'staging' || state.status === 'stage-unknown';
  const activationState = state.status === 'activating' || state.status === 'activation-unknown';
  const rollbackState = state.status === 'rolling-back' || state.status === 'rollback-unknown';
  const discardState = state.status === 'discarding' || state.status === 'discard-unknown';
  if (state.status === 'empty' && (state.current || state.candidate || state.pending)) throw new Error('invalid empty state');
  if (state.status === 'active' && (!state.current || state.candidate || state.pending)) throw new Error('invalid active state');
  if (stageState && (!state.candidate || state.pending?.kind !== 'stage')) throw new Error('invalid stage state');
  if (activationState && (!state.candidate || state.pending?.kind !== 'activate')) throw new Error('invalid activation state');
  if (rollbackState && (!state.current || !state.previous || state.candidate || state.pending?.kind !== 'rollback')) throw new Error('invalid rollback state');
  if (discardState && (!state.candidate?.stagedDeploymentId || state.pending?.kind !== 'discard')) throw new Error('invalid discard state');
  if (state.status === 'candidate-ready' && (!state.candidate?.stagedDeploymentId || state.pending || !reviewIsSufficient(state.candidate))) throw new Error('invalid ready candidate');
  if (state.status === 'review-required' && (!state.candidate?.stagedDeploymentId || state.pending || reviewIsSufficient(state.candidate))) throw new Error('invalid review state');
  if (state.candidate && state.pending && state.pending.kind !== 'rollback' && state.pending.candidateDigest !== state.candidate.releaseDigest) throw new Error('pending candidate changed');
  if (state.pending?.kind === 'rollback' && state.pending.targetDigest !== state.previous?.releaseDigest) throw new Error('rollback target changed');
  if (state.pending?.kind === 'discard'
    && (state.pending.stagingOperationId !== state.candidate?.stagingOperationId
      || state.pending.stagedDeploymentId !== state.candidate.stagedDeploymentId
      || state.pending.candidateDigest !== state.candidate.releaseDigest
      || state.pending.baseCurrentDigest !== (state.current?.releaseDigest ?? null))) throw new Error('discard target changed');
}

function parseState(value: unknown, installationId: string): DeploymentState {
  try {
    const state = deploymentStateSchema.parse(value);
    if (state.installationId !== installationId) throw new Error('installation binding mismatch');
    validateStateInvariants(state);
    return state;
  } catch {
    throw new PluginArtifactError('Stored plugin deployment state is invalid.');
  }
}

export interface PluginDeploymentSnapshot {
  readonly installationId: string;
  readonly pluginId: string;
  readonly status: DeploymentState['status'];
  readonly configurationRevision: string;
  readonly configurationSchemaVersion: number;
  readonly current: PluginReleaseIdentity | null;
  readonly previous: PluginReleaseIdentity | null;
  readonly candidate: (PluginReleaseIdentity & { readonly staged: boolean; readonly requiresReview: boolean; readonly stagingOperationId: string | null }) | null;
}

function snapshot(state: DeploymentState): PluginDeploymentSnapshot {
  const candidate = state.candidate
    ? Object.freeze({
      ...releaseIdentity(state.candidate.envelope, state.candidate.releaseDigest),
      staged: state.candidate.stagedDeploymentId !== undefined,
      requiresReview: requiresReview(state.candidate),
      stagingOperationId: state.candidate.stagingOperationId ?? null,
    })
    : null;
  return Object.freeze({
    installationId: state.installationId,
    pluginId: state.pluginId,
    status: state.status,
    configurationRevision: state.configurationRevision,
    configurationSchemaVersion: state.configurationSchemaVersion,
    current: state.current ? releaseIdentity(state.current.envelope, state.current.releaseDigest) : null,
    previous: state.previous ? releaseIdentity(state.previous.envelope, state.previous.releaseDigest) : null,
    candidate,
  });
}

export interface DeploymentDriver {
  stage(input: {
    readonly installationId: string;
    readonly operationId: string;
    readonly baseCurrentDigest: string | null;
    readonly configurationRevision: string;
    readonly release: VerifiedPluginRelease;
    readonly policy: PluginContainerLaunchPolicy;
    /** Logical references only. Secret values are never given to this coordinator. */
    readonly secretAssignments: readonly LogicalSecretAssignment[];
  }): Promise<{ readonly deploymentId: string }>;
  check(input: { readonly installationId: string; readonly deploymentId: string; readonly releaseDigest: string }): Promise<boolean>;
  /**
   * Idempotent exact-ID cleanup for an inactive candidate. Implementations
   * must freshly reject an active deployment or an ID owned by another stage.
   */
  discard(input: { readonly installationId: string; readonly operationId: string; readonly deploymentId: string }): Promise<void>;
  activate(input: {
    readonly installationId: string;
    readonly operationId: string;
    readonly candidateDeploymentId: string;
    readonly previousDeploymentId: string | null;
    readonly baseCurrentDigest: string | null;
    readonly configurationRevision: string;
  }): Promise<void>;
  rollback(input: {
    readonly installationId: string;
    readonly operationId: string;
    readonly currentDeploymentId: string;
    readonly previousDeploymentId: string;
    readonly baseCurrentDigest: string;
    readonly configurationRevision: string;
  }): Promise<void>;
  reconcile(input: { readonly installationId: string; readonly operationId: string }): Promise<DeploymentObservation>;
}

export interface DeploymentObservation {
  readonly activeDeploymentId: string | null;
  readonly stagedDeploymentId: string | null;
  /**
   * A terminal route status is authoritative only when the routing controller
   * also fences that operation ID against any later commit. Snapshot state is
   * insufficient because a timed-out route callback may still be running.
   */
  readonly routeOperationOutcome: 'committed' | 'not-committed' | 'pending' | 'unknown';
}

export interface PluginDeploymentCoordinatorOptions {
  readonly store: JsonStore;
  readonly driver: DeploymentDriver;
  readonly scope: string;
  readonly resolvePublisher: PublisherApprovalResolver;
  /** Checks current image and logical credential authorization; called again at activation and rollback. */
  readonly isCurrentlyTrusted: (release: VerifiedPluginRelease, secretAssignments: readonly LogicalSecretAssignment[]) => boolean | Promise<boolean>;
  /** Authenticates reviewer identity and approval against current operator policy. */
  readonly authorizeReview: (input: { readonly installationId: string; readonly approval: PluginChangeReview; readonly release: VerifiedPluginRelease }) => boolean | Promise<boolean>;
  /** Reads the live config revision, so a staged candidate cannot activate against changed config. */
  readonly getConfigurationRevision: (installationId: string) => string | Promise<string>;
}

function isDeploymentId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && OPAQUE_ID.test(value);
}

function sameOperation(pending: PendingOperation | null, operationId: string): boolean {
  return pending?.operationId === operationId;
}

export class PluginDeploymentCoordinator {
  private readonly keyPrefix: string;

  constructor(private readonly options: PluginDeploymentCoordinatorOptions) {
    if (!options.scope.trim() || options.scope.length > 128 || options.scope.includes('\0')) throw new TypeError('Deployment scope must be a non-empty server-owned identifier.');
    this.keyPrefix = `hasi:plugin-deployment:v1:${digest(options.scope)}:`;
  }

  private key(installationId: string): string {
    if (!OPAQUE_ID.test(installationId)) throw new PluginArtifactError('Installation identifier is invalid.');
    return `${this.keyPrefix}${digest(installationId)}`;
  }

  private async read(installationId: string): Promise<{ revision: string; state: DeploymentState }> {
    const entry = await this.options.store.read(this.key(installationId));
    if (!entry) throw new PluginArtifactError('Plugin installation was not initialized.');
    return { revision: entry.revision, state: parseState(entry.value, installationId) };
  }

  private async compareAndSet(key: string, revision: string, state: DeploymentState): Promise<void> {
    if (!await this.options.store.compareAndSet(key, revision, state)) throw new PluginArtifactError('Plugin deployment state changed concurrently.');
  }

  private async mutateOperation(
    installationId: string,
    operationId: string,
    expectedKind: PendingOperation['kind'],
    update: (state: DeploymentState) => DeploymentState,
  ): Promise<DeploymentState> {
    const key = this.key(installationId);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const entry = await this.options.store.read(key);
      if (!entry) throw new PluginArtifactError('Plugin installation was not initialized.');
      const state = parseState(entry.value, installationId);
      if (state.pending?.kind !== expectedKind || !sameOperation(state.pending, operationId)) {
        throw new PluginArtifactError('Plugin deployment operation is no longer current.');
      }
      const next = update(state);
      validateStateInvariants(next);
      if (await this.options.store.compareAndSet(key, entry.revision, next)) return next;
    }
    throw new PluginArtifactError('Plugin deployment state changed concurrently.');
  }

  private async liveConfigurationRevision(installationId: string): Promise<string> {
    let revision: string;
    try { revision = await this.options.getConfigurationRevision(installationId); } catch { throw new PluginArtifactError('Plugin configuration revision could not be verified.'); }
    if (typeof revision !== 'string' || revision.length < 1 || revision.length > 256 || revision.includes('\0')) {
      throw new PluginArtifactError('Plugin configuration revision is invalid.');
    }
    return revision;
  }

  private verified(release: PluginReleaseEnvelope): VerifiedPluginRelease {
    return verifyPluginRelease(release, this.options.resolvePublisher);
  }

  private async assertCurrentTrust(release: VerifiedPluginRelease, secrets: readonly LogicalSecretAssignment[]): Promise<void> {
    if (!await this.currentlyTrusted(release, secrets)) {
      throw new PluginArtifactError('Plugin release or its credentials are no longer trusted.');
    }
  }

  private async currentlyTrusted(release: VerifiedPluginRelease, secrets: readonly LogicalSecretAssignment[]): Promise<boolean> {
    try { return await this.options.isCurrentlyTrusted(release, secrets); } catch { return false; }
  }

  /**
   * Records an immutable cleanup intent before asking the driver to discard a
   * staged candidate. The cleanup operation fences coordinator state while the
   * original stage operation ID proves driver ownership.
   */
  private async discardRevokedCandidate(input: {
    readonly installationId: string;
    readonly candidate: Candidate;
    readonly expectedActivationOperationId?: string;
    readonly expectedStageOperationId?: string;
    /** A stage ID positively observed from the exact pending stage operation. */
    readonly observedStageDeploymentId?: string;
  }): Promise<{ readonly cleaned: boolean; readonly state: DeploymentState }> {
    const key = this.key(input.installationId);
    let entry: { revision: string; value: unknown } | undefined;
    try {
      entry = await this.options.store.read(key);
    } catch {
      throw new PluginArtifactError('Plugin deployment state could not be verified.');
    }
    if (!entry) throw new PluginArtifactError('Plugin installation was not initialized.');
    const state = parseState(entry.value, input.installationId);
    const candidate = state.candidate;
    const adoptingObservedStage = input.observedStageDeploymentId !== undefined;
    const stagedDeploymentId = input.observedStageDeploymentId ?? input.candidate.stagedDeploymentId;
    if (!candidate
      || !stagedDeploymentId
      || !isDeploymentId(stagedDeploymentId)
      || candidate.releaseDigest !== input.candidate.releaseDigest
      || (candidate.stagedDeploymentId !== stagedDeploymentId
        && !(adoptingObservedStage && candidate.stagedDeploymentId === undefined))
      || (input.candidate.stagedDeploymentId !== undefined && input.candidate.stagedDeploymentId !== stagedDeploymentId)
      || candidate.configurationRevision !== input.candidate.configurationRevision
      || candidate.baseCurrentDigest !== input.candidate.baseCurrentDigest
      || candidate.baseCurrentDigest !== (state.current?.releaseDigest ?? null)) {
      return { cleaned: false, state };
    }

    const stageOperationId = input.expectedStageOperationId
      ?? input.candidate.stagingOperationId
      ?? candidate.stagingOperationId
      ?? (state.pending?.kind === 'stage' ? state.pending.operationId : undefined);
    if (!stageOperationId
      || (candidate.stagingOperationId !== undefined && candidate.stagingOperationId !== stageOperationId)
      || (input.candidate.stagingOperationId !== undefined && input.candidate.stagingOperationId !== stageOperationId)) {
      return { cleaned: false, state };
    }

    const pending = state.pending;
    const stageOperationAlreadyPending = pending?.kind === 'stage'
      && pending.operationId === stageOperationId
      && (state.status === 'staging' || state.status === 'stage-unknown');
    const observedStageIsFencedByPendingOperation = adoptingObservedStage
      && input.expectedStageOperationId === stageOperationId
      && stageOperationAlreadyPending
      && pending.candidateDigest === candidate.releaseDigest
      && pending.baseCurrentDigest === candidate.baseCurrentDigest
      && pending.configurationRevision === candidate.configurationRevision
      && state.configurationRevision === candidate.configurationRevision;
    const expectedActivationPending = pending?.kind === 'activate'
      && input.expectedActivationOperationId !== undefined
      && pending.operationId === input.expectedActivationOperationId
      && (state.status === 'activating' || state.status === 'activation-unknown');
    const readyCandidate = !pending && (state.status === 'candidate-ready' || state.status === 'review-required');
    if (adoptingObservedStage && !observedStageIsFencedByPendingOperation) return { cleaned: false, state };
    if (!stageOperationAlreadyPending && !expectedActivationPending && !readyCandidate) {
      return { cleaned: false, state };
    }

    const cleanupPending: PendingOperation = {
      kind: 'discard',
      operationId: randomUUID(),
      stagingOperationId: stageOperationId,
      stagedDeploymentId,
      baseCurrentDigest: candidate.baseCurrentDigest,
      configurationRevision: candidate.configurationRevision,
      candidateDigest: candidate.releaseDigest,
    };
    const candidateWithStageOperation: Candidate = {
      ...candidate,
      stagingOperationId: stageOperationId,
      stagedDeploymentId,
    };
    const cleanupState: DeploymentState = {
      ...state,
      status: 'discarding',
      candidate: candidateWithStageOperation,
      pending: cleanupPending,
    };
    validateStateInvariants(cleanupState);

    let committed = false;
    try {
      committed = await this.options.store.compareAndSet(key, entry.revision, cleanupState);
    } catch {
      const latest = await this.read(input.installationId);
      return { cleaned: false, state: latest.state };
    }
    if (!committed) {
      const latest = await this.read(input.installationId);
      return { cleaned: false, state: latest.state };
    }
    return this.executeDiscardIntent(input.installationId, cleanupPending, candidateWithStageOperation);
  }

  private async markDiscardUnknown(installationId: string, pending: DiscardOperation): Promise<DeploymentState> {
    try {
      return await this.mutateOperation(installationId, pending.operationId, 'discard', state => ({ ...state, status: 'discard-unknown' }));
    } catch {
      const { state } = await this.read(installationId);
      return state;
    }
  }

  private async executeDiscardIntent(
    installationId: string,
    pending: DiscardOperation,
    candidate: Candidate,
  ): Promise<{ readonly cleaned: boolean; readonly state: DeploymentState }> {
    const deploymentId = candidate.stagedDeploymentId;
    if (!deploymentId
      || deploymentId !== pending.stagedDeploymentId
      || candidate.stagingOperationId !== pending.stagingOperationId
      || candidate.releaseDigest !== pending.candidateDigest) {
      const state = await this.markDiscardUnknown(installationId, pending);
      return { cleaned: false, state };
    }

    try {
      await this.options.driver.discard({ installationId, operationId: pending.stagingOperationId, deploymentId });
    } catch {
      const state = await this.markDiscardUnknown(installationId, pending);
      return { cleaned: false, state };
    }

    try {
      const cleared = await this.mutateOperation(installationId, pending.operationId, 'discard', state => {
        if (state.pending?.kind !== 'discard'
          || state.pending.stagingOperationId !== pending.stagingOperationId
          || state.pending.stagedDeploymentId !== deploymentId
          || state.pending.candidateDigest !== pending.candidateDigest
          || state.candidate?.stagingOperationId !== pending.stagingOperationId
          || state.candidate.stagedDeploymentId !== deploymentId) {
          throw new PluginArtifactError('Plugin discard operation is no longer current.');
        }
        return {
          ...state,
          status: state.current ? 'active' : 'empty',
          candidate: null,
          pending: null,
        };
      });
      return { cleaned: true, state: cleared };
    } catch {
      const state = await this.markDiscardUnknown(installationId, pending);
      return { cleaned: false, state };
    }
  }

  private async assertReviewAuthorized(installationId: string, candidate: Candidate): Promise<void> {
    if (!requiresReview(candidate)) return;
    const approval = candidate.reviewApproval;
    if (!approval) throw new PluginArtifactError('Plugin candidate requires operator review.');
    let authorized = false;
    try {
      authorized = await this.options.authorizeReview({ installationId, approval, release: this.verified(candidate.envelope) });
    } catch {
      // Treat reviewer authorization service failures as denials.
    }
    if (!authorized) throw new PluginArtifactError('Plugin change review is not currently authorized.');
  }

  private async assertStoredReviewAuthorized(installationId: string, release: StoredRelease): Promise<void> {
    const reviewRequired = release.effectsExpanded || release.permissionsExpanded || release.envelope.stateMigration === 'irreversible';
    if (!reviewRequired) return;
    const approval = release.reviewApproval;
    if (!approval || (release.envelope.stateMigration === 'irreversible' && !approval.restorePlanId)) {
      throw new PluginArtifactError('Stored plugin release is missing its required review or restore plan.');
    }
    let authorized = false;
    try {
      authorized = await this.options.authorizeReview({ installationId, approval, release: this.verified(release.envelope) });
    } catch {
      // Treat reviewer authorization service failures as denials.
    }
    if (!authorized) throw new PluginArtifactError('Stored plugin release review is no longer authorized.');
  }

  private async currentSnapshot(state: DeploymentState, operation: string): Promise<void> {
    const liveRevision = await this.liveConfigurationRevision(state.installationId);
    if (liveRevision !== state.configurationRevision || liveRevision !== operation) {
      throw new PluginArtifactError('Plugin configuration changed during deployment.');
    }
  }

  async initialize(input: { readonly installationId: string; readonly pluginId: string; readonly configurationSchemaVersion: number }): Promise<PluginDeploymentSnapshot> {
    if (!OPAQUE_ID.test(input.installationId) || !PLUGIN_ID.test(input.pluginId)) throw new PluginArtifactError('Plugin installation identity is invalid.');
    if (!Number.isSafeInteger(input.configurationSchemaVersion) || input.configurationSchemaVersion < 1 || input.configurationSchemaVersion > 2_147_483_647) {
      throw new PluginArtifactError('Plugin configuration schema version is invalid.');
    }
    const configurationRevision = await this.liveConfigurationRevision(input.installationId);
    const state: DeploymentState = {
      schemaVersion: 1,
      installationId: input.installationId,
      pluginId: input.pluginId,
      status: 'empty',
      configurationRevision,
      configurationSchemaVersion: input.configurationSchemaVersion,
      current: null,
      previous: null,
      candidate: null,
      pending: null,
    };
    const key = this.key(input.installationId);
    if (!await this.options.store.compareAndSet(key, null, state)) throw new PluginArtifactError('Plugin installation already exists.');
    return snapshot(state);
  }

  async get(installationId: string): Promise<PluginDeploymentSnapshot> {
    const { state } = await this.read(installationId);
    return snapshot(state);
  }

  /**
   * Converges trusted operator-managed configuration metadata after an
   * independently verified compatible configuration change. This method is
   * not an authorization renewal and must not be exposed to client input.
   */
  async synchronizeConfigurationRevision(input: {
    readonly installationId: string;
    readonly expectedRevision: string;
    readonly approvedConfigurationRevision: string;
    readonly configurationCompatible: boolean;
  }): Promise<PluginDeploymentSnapshot> {
    if (!Object.is(input.configurationCompatible, true)) {
      throw new PluginArtifactError('Plugin configuration compatibility was not confirmed.');
    }
    if (typeof input.expectedRevision !== 'string'
      || input.expectedRevision.length < 1
      || input.expectedRevision.length > 256
      || input.expectedRevision.includes('\0')) {
      throw new PluginArtifactError('Plugin configuration revision is invalid.');
    }
    if (typeof input.approvedConfigurationRevision !== 'string'
      || input.approvedConfigurationRevision.length < 1
      || input.approvedConfigurationRevision.length > 256
      || input.approvedConfigurationRevision.includes('\0')) {
      throw new PluginArtifactError('Plugin configuration revision is invalid.');
    }

    const key = this.key(input.installationId);
    const readEntry = async () => {
      try {
        return await this.options.store.read(key);
      } catch {
        throw new PluginArtifactError('Plugin deployment state could not be verified.');
      }
    };
    const entry = await readEntry();
    if (!entry) throw new PluginArtifactError('Plugin installation was not initialized.');
    const current = parseState(entry.value, input.installationId);
    if ((current.status !== 'empty' && current.status !== 'active') || current.candidate || current.pending) {
      throw new PluginArtifactError('Plugin configuration cannot be synchronized during a deployment operation.');
    }
    if (current.configurationRevision !== input.expectedRevision) {
      throw new PluginArtifactError('Plugin configuration revision is stale.');
    }

    // The target is deliberately read from the server-owned configuration
    // authority. The approved revision only binds the compatibility preflight
    // to that value; it cannot select the destination.
    const targetRevision = await this.liveConfigurationRevision(input.installationId);
    if (targetRevision !== input.approvedConfigurationRevision) {
      throw new PluginArtifactError('Plugin configuration compatibility was not confirmed for the current revision.');
    }
    const next: DeploymentState = targetRevision === current.configurationRevision
      ? current
      : { ...current, configurationRevision: targetRevision };
    validateStateInvariants(next);

    // Check authority immediately before any potential write. Passing the
    // proposed state lets currentSnapshot require the live revision to equal
    // the authoritative target while the stored state still has the old one.
    await this.currentSnapshot(next, targetRevision);

    if (targetRevision === current.configurationRevision) {
      const verifiedEntry = await readEntry();
      if (verifiedEntry?.revision !== entry.revision) {
        throw new PluginArtifactError('Plugin deployment state changed concurrently.');
      }
      const verifiedState = parseState(verifiedEntry.value, input.installationId);
      if ((verifiedState.status !== 'empty' && verifiedState.status !== 'active')
        || verifiedState.candidate
        || verifiedState.pending
        || verifiedState.configurationRevision !== input.expectedRevision) {
        throw new PluginArtifactError('Plugin deployment state changed concurrently.');
      }
      await this.currentSnapshot(verifiedState, targetRevision);
      return snapshot(verifiedState);
    }

    let committed: boolean;
    try {
      // Keep the CAS anchored to the exact state inspected above.
      committed = await this.options.store.compareAndSet(key, entry.revision, next);
    } catch {
      // The store may have committed before its acknowledgement was lost. Only
      // treat that as success when the exact proposed state is present and the
      // same server-owned configuration revision is still authoritative.
      try {
        const verifiedEntry = await readEntry();
        if (!verifiedEntry) throw new Error('missing state');
        const verifiedState = parseState(verifiedEntry.value, input.installationId);
        if (JSON.stringify(verifiedState) !== JSON.stringify(next)) throw new Error('state differs');
        await this.currentSnapshot(verifiedState, targetRevision);
        return snapshot(verifiedState);
      } catch {
        throw new PluginArtifactError('Plugin deployment state could not be updated.');
      }
    }
    if (!committed) throw new PluginArtifactError('Plugin deployment state changed concurrently.');

    // Configuration can change while the store write is in flight. Verify
    // live authority on the far side of CAS and ensure no deployment state
    // replaced this synchronized snapshot before returning it.
    await this.currentSnapshot(next, targetRevision);
    const verifiedEntry = await readEntry();
    if (!verifiedEntry) throw new PluginArtifactError('Plugin installation was not initialized.');
    const verifiedState = parseState(verifiedEntry.value, input.installationId);
    if (JSON.stringify(verifiedState) !== JSON.stringify(next)) {
      throw new PluginArtifactError('Plugin deployment state changed concurrently.');
    }
    await this.currentSnapshot(verifiedState, targetRevision);
    return snapshot(verifiedState);
  }

  /**
   * Cancels and deletes a known inactive candidate at the operator's request.
   * This trusted control path is not a client authorization or activation path.
   */
  async discardCandidate(input: {
    readonly installationId: string;
    readonly candidateDigest: string;
    readonly stagingOperationId: string;
    readonly configurationRevision: string;
  }): Promise<PluginDeploymentSnapshot> {
    const key = this.key(input.installationId);
    const { revision, state } = await this.read(input.installationId);
    const candidate = state.candidate;
    if ((state.status !== 'candidate-ready' && state.status !== 'review-required')
      || state.pending
      || !candidate?.stagedDeploymentId
      || !isDeploymentId(candidate.stagedDeploymentId)
      || candidate.releaseDigest !== input.candidateDigest
      || candidate.stagingOperationId !== input.stagingOperationId
      || candidate.configurationRevision !== input.configurationRevision
      || state.configurationRevision !== input.configurationRevision
      || candidate.baseCurrentDigest !== (state.current?.releaseDigest ?? null)) {
      throw new PluginArtifactError('Plugin candidate is not available for this discard request.');
    }

    const cleanupPending: DiscardOperation = {
      kind: 'discard',
      operationId: randomUUID(),
      stagingOperationId: input.stagingOperationId,
      stagedDeploymentId: candidate.stagedDeploymentId,
      baseCurrentDigest: candidate.baseCurrentDigest,
      configurationRevision: state.configurationRevision,
      candidateDigest: candidate.releaseDigest,
    };
    const discarding: DeploymentState = {
      ...state,
      status: 'discarding',
      pending: cleanupPending,
    };
    validateStateInvariants(discarding);
    await this.compareAndSet(key, revision, discarding);
    const result = await this.executeDiscardIntent(input.installationId, cleanupPending, candidate);
    return snapshot(result.state);
  }

  async stageCandidate(input: {
    readonly installationId: string;
    /** Optional extra CAS pin for trusted administrator dispatch. */
    readonly baseCurrentDigest?: string | null;
    readonly release: unknown;
    readonly configurationRevision: string;
    readonly configurationCompatible: boolean;
    readonly effectsExpanded: boolean;
    readonly permissionsExpanded: boolean;
    readonly secretAssignments?: readonly LogicalSecretAssignment[];
    readonly launch: PluginContainerLaunchOptions;
  }): Promise<{ readonly outcome: 'candidate-ready' | 'review-required' | 'stage-failed' | 'stage-unknown'; readonly operationId: string; readonly state: PluginDeploymentSnapshot }> {
    const key = this.key(input.installationId);
    const { revision, state: current } = await this.read(input.installationId);
    if (current.status !== 'empty' && current.status !== 'active') throw new PluginArtifactError('Another plugin deployment operation is in progress.');
    if (Object.hasOwn(input, 'baseCurrentDigest') && input.baseCurrentDigest !== (current.current?.releaseDigest ?? null)) throw new PluginArtifactError('Plugin deployment base changed before staging.');
    const release = verifyPluginRelease(input.release, this.options.resolvePublisher);
    if (release.pluginId !== current.pluginId || !input.configurationCompatible) throw new PluginArtifactError('Plugin release or configuration is incompatible with this installation.');
    if (input.configurationRevision !== current.configurationRevision) throw new PluginArtifactError('Plugin configuration revision is stale.');
    const liveRevision = await this.liveConfigurationRevision(input.installationId);
    if (liveRevision !== input.configurationRevision) throw new PluginArtifactError('Plugin configuration revision is stale.');

    const secretsParsed = secretAssignmentsSchema.safeParse(input.secretAssignments ?? []);
    if (!secretsParsed.success) throw new PluginArtifactError('Plugin secret assignments are invalid.');
    const secretAssignments = secretsParsed.data.map(item => Object.freeze({ ...item })).sort((a, b) => a.name.localeCompare(b.name));
    const operationId = randomUUID();
    const candidate: Candidate = {
      envelope: { ...releaseEnvelopeSchema.parse(input.release) },
      releaseDigest: release.releaseDigest,
      secretAssignments,
      stagingOperationId: operationId,
      configurationRevision: liveRevision,
      baseCurrentDigest: current.current?.releaseDigest ?? null,
      configurationCompatible: true,
      effectsExpanded: input.effectsExpanded,
      permissionsExpanded: input.permissionsExpanded,
    };
    const policy = buildPluginContainerLaunchPolicy(release, input.launch);
    const pending: PendingOperation = {
      kind: 'stage',
      operationId,
      baseCurrentDigest: candidate.baseCurrentDigest,
      configurationRevision: liveRevision,
      candidateDigest: release.releaseDigest,
    };
    const start: DeploymentState = { ...current, status: 'staging', candidate, pending };
    validateStateInvariants(start);
    await this.compareAndSet(key, revision, start);

    try {
      await this.currentSnapshot(start, liveRevision);
      await this.assertCurrentTrust(release, secretAssignments);
    } catch (error) {
      await this.mutateOperation(input.installationId, operationId, 'stage', state => ({
        ...state,
        status: state.current ? 'active' : 'empty',
        candidate: null,
        pending: null,
      }));
      if (error instanceof PluginArtifactError) throw error;
      throw new PluginArtifactError('Plugin stage authorization failed.');
    }

    let staged: { readonly deploymentId: string };
    try {
      staged = await this.options.driver.stage({
        installationId: input.installationId,
        operationId,
        baseCurrentDigest: candidate.baseCurrentDigest,
        configurationRevision: candidate.configurationRevision,
        release,
        policy,
        secretAssignments,
      });
    } catch (error) {
      if (error instanceof DeploymentDriverError && error.outcome === 'failed') {
        const failed = await this.mutateOperation(input.installationId, operationId, 'stage', state => ({
          ...state,
          status: state.current ? 'active' : 'empty',
          candidate: null,
          pending: null,
        }));
        return { outcome: 'stage-failed', operationId, state: snapshot(failed) };
      }
      const unknown = await this.mutateOperation(input.installationId, operationId, 'stage', state => ({ ...state, status: 'stage-unknown' }));
      return { outcome: 'stage-unknown', operationId, state: snapshot(unknown) };
    }

    if (!isDeploymentId(staged.deploymentId)) {
      const unknown = await this.mutateOperation(input.installationId, operationId, 'stage', state => ({ ...state, status: 'stage-unknown' }));
      return { outcome: 'stage-unknown', operationId, state: snapshot(unknown) };
    }
    const stageStored = await this.mutateOperation(input.installationId, operationId, 'stage', state => {
      if (!state.candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
      return { ...state, candidate: { ...state.candidate, stagedDeploymentId: staged.deploymentId } };
    });

    if (!stageStored.candidate || !await this.currentlyTrusted(release, secretAssignments)) {
      const cleanup = stageStored.candidate
        ? await this.discardRevokedCandidate({ installationId: input.installationId, candidate: stageStored.candidate })
        : { cleaned: false, state: stageStored };
      return {
        outcome: cleanup.cleaned ? 'stage-failed' : 'stage-unknown',
        operationId,
        state: snapshot(cleanup.state),
      };
    }

    let healthy: boolean;
    try {
      healthy = await this.options.driver.check({ installationId: input.installationId, deploymentId: staged.deploymentId, releaseDigest: release.releaseDigest });
    } catch {
      const unknown = await this.mutateOperation(input.installationId, operationId, 'stage', state => ({ ...state, status: 'stage-unknown' }));
      return { outcome: 'stage-unknown', operationId, state: snapshot(unknown) };
    }
    if (!healthy) {
      const cleanup = await this.discardRevokedCandidate({ installationId: input.installationId, candidate: stageStored.candidate });
      return {
        outcome: cleanup.cleaned ? 'stage-failed' : 'stage-unknown',
        operationId,
        state: snapshot(cleanup.state),
      };
    }

    let configurationStillCurrent = true;
    try { await this.currentSnapshot(stageStored, liveRevision); } catch { configurationStillCurrent = false; }
    if (!configurationStillCurrent || !await this.currentlyTrusted(release, secretAssignments)) {
      const current = await this.read(input.installationId);
      const cleanup = current.state.candidate
        ? await this.discardRevokedCandidate({ installationId: input.installationId, candidate: current.state.candidate })
        : { cleaned: false, state: current.state };
      return {
        outcome: cleanup.cleaned ? 'stage-failed' : 'stage-unknown',
        operationId,
        state: snapshot(cleanup.state),
      };
    }

    const ready = await this.mutateOperation(input.installationId, operationId, 'stage', state => {
      if (!state.candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
      const candidateState = state.candidate;
      return { ...state, status: reviewIsSufficient(candidateState) ? 'candidate-ready' : 'review-required', pending: null };
    });
    return { outcome: ready.status as 'candidate-ready' | 'review-required', operationId, state: snapshot(ready) };
  }

  async approveCandidate(input: { readonly installationId: string; readonly candidateDigest: string; readonly stagingOperationId?: string; readonly approval: PluginChangeReview }): Promise<PluginDeploymentSnapshot> {
    const key = this.key(input.installationId);
    const { revision, state } = await this.read(input.installationId);
    if (state.status !== 'review-required' || state.candidate?.releaseDigest !== input.candidateDigest
      || (input.stagingOperationId !== undefined && state.candidate.stagingOperationId !== input.stagingOperationId)) {
      throw new PluginArtifactError('No matching plugin candidate is awaiting review.');
    }
    const parsed = reviewApprovalSchema.safeParse(input.approval);
    if (!parsed.success) throw new PluginArtifactError('Plugin change review is invalid.');
    if (state.candidate.envelope.stateMigration === 'irreversible' && !parsed.data.restorePlanId) {
      throw new PluginArtifactError('Irreversible migration requires an approved restore plan.');
    }
    const candidate: Candidate = { ...state.candidate, reviewApproval: parsed.data };
    await this.assertReviewAuthorized(input.installationId, candidate);
    const next: DeploymentState = { ...state, candidate, status: 'candidate-ready' };
    validateStateInvariants(next);
    await this.compareAndSet(key, revision, next);
    return snapshot(next);
  }

  async activate(input: {
    readonly installationId: string;
    readonly candidateDigest: string;
    readonly stagingOperationId?: string;
    readonly baseCurrentDigest: string | null;
    readonly configurationRevision: string;
  }): Promise<{ readonly outcome: 'activated' | 'known-failure' | 'unknown'; readonly operationId: string; readonly state: PluginDeploymentSnapshot }> {
    const key = this.key(input.installationId);
    const { revision, state: current } = await this.read(input.installationId);
    const candidate = current.candidate;
    if (current.status !== 'candidate-ready' || !candidate?.stagedDeploymentId || candidate.releaseDigest !== input.candidateDigest || candidate.baseCurrentDigest !== input.baseCurrentDigest || !reviewIsSufficient(candidate)
      || (input.stagingOperationId !== undefined && candidate.stagingOperationId !== input.stagingOperationId)) {
      throw new PluginArtifactError('Plugin candidate is not ready for this activation.');
    }
    if (input.configurationRevision !== current.configurationRevision || candidate.configurationRevision !== current.configurationRevision) {
      throw new PluginArtifactError('Plugin configuration revision is stale.');
    }
    const release = this.verified(candidate.envelope);
    if (!await this.currentlyTrusted(release, candidate.secretAssignments)) {
      const cleanup = await this.discardRevokedCandidate({ installationId: input.installationId, candidate });
      throw new PluginArtifactError(cleanup.cleaned
        ? 'Plugin release or its credentials are no longer trusted; the staged candidate was discarded.'
        : 'Plugin release or its credentials are no longer trusted; staged candidate cleanup remains unresolved.');
    }
    await this.assertReviewAuthorized(input.installationId, candidate);
    const liveRevision = await this.liveConfigurationRevision(input.installationId);
    if (liveRevision !== input.configurationRevision) throw new PluginArtifactError('Plugin configuration revision is stale.');

    const operationId = randomUUID();
    const pending: PendingOperation = {
      kind: 'activate',
      operationId,
      baseCurrentDigest: current.current?.releaseDigest ?? null,
      configurationRevision: current.configurationRevision,
      candidateDigest: candidate.releaseDigest,
    };
    const activating: DeploymentState = { ...current, status: 'activating', pending };
    validateStateInvariants(activating);
    await this.compareAndSet(key, revision, activating);
    try {
      await this.currentSnapshot(activating, current.configurationRevision);
      const healthy = await this.options.driver.check({
        installationId: input.installationId,
        deploymentId: candidate.stagedDeploymentId,
        releaseDigest: candidate.releaseDigest,
      });
      if (!healthy) throw new PluginArtifactError('Staged plugin candidate is no longer healthy.');
    } catch (error) {
      await this.mutateOperation(input.installationId, operationId, 'activate', state => ({ ...state, status: 'candidate-ready', pending: null }));
      if (error instanceof PluginArtifactError) throw error;
      throw new PluginArtifactError('Plugin activation authorization changed before deployment.');
    }

    if (!await this.currentlyTrusted(release, candidate.secretAssignments)) {
      const cleanup = await this.discardRevokedCandidate({
        installationId: input.installationId,
        candidate,
        expectedActivationOperationId: operationId,
      });
      throw new PluginArtifactError(cleanup.cleaned
        ? 'Plugin release or its credentials were revoked; the staged candidate was discarded.'
        : 'Plugin release or its credentials were revoked; staged candidate cleanup remains unresolved.');
    }
    try {
      await this.assertReviewAuthorized(input.installationId, candidate);
    } catch (error) {
      await this.mutateOperation(input.installationId, operationId, 'activate', state => ({ ...state, status: 'candidate-ready', pending: null }));
      throw error;
    }
    // Recheck after the reviewer callback, immediately before handing the
    // operation to the routing controller.
    if (!await this.currentlyTrusted(release, candidate.secretAssignments)) {
      const cleanup = await this.discardRevokedCandidate({
        installationId: input.installationId,
        candidate,
        expectedActivationOperationId: operationId,
      });
      throw new PluginArtifactError(cleanup.cleaned
        ? 'Plugin release or its credentials were revoked; the staged candidate was discarded.'
        : 'Plugin release or its credentials were revoked; staged candidate cleanup remains unresolved.');
    }

    try {
      await this.options.driver.activate({
        installationId: input.installationId,
        operationId,
        candidateDeploymentId: candidate.stagedDeploymentId,
        previousDeploymentId: current.current?.deploymentId ?? null,
        baseCurrentDigest: current.current?.releaseDigest ?? null,
        configurationRevision: current.configurationRevision,
      });
    } catch (error) {
      if (error instanceof DeploymentDriverError && error.outcome === 'failed') {
        const ready = await this.mutateOperation(input.installationId, operationId, 'activate', state => ({ ...state, status: 'candidate-ready', pending: null }));
        return { outcome: 'known-failure', operationId, state: snapshot(ready) };
      }
      const unknown = await this.mutateOperation(input.installationId, operationId, 'activate', state => ({ ...state, status: 'activation-unknown' }));
      return { outcome: 'unknown', operationId, state: snapshot(unknown) };
    }

    const activated = await this.mutateOperation(input.installationId, operationId, 'activate', state => {
      if (!state.candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
      const stagedCandidate = state.candidate;
      const stagedDeploymentId = stagedCandidate.stagedDeploymentId;
      if (!stagedDeploymentId) throw new PluginArtifactError('Plugin candidate state is invalid.');
      const promoted: StoredRelease = {
        envelope: stagedCandidate.envelope,
        releaseDigest: stagedCandidate.releaseDigest,
        deploymentId: stagedDeploymentId,
        secretAssignments: stagedCandidate.secretAssignments,
        effectsExpanded: stagedCandidate.effectsExpanded,
        permissionsExpanded: stagedCandidate.permissionsExpanded,
        ...(stagedCandidate.reviewApproval ? { reviewApproval: stagedCandidate.reviewApproval } : {}),
      };
      return {
        ...state,
        status: 'active',
        current: promoted,
        previous: state.current,
        candidate: null,
        pending: null,
      };
    });
    return { outcome: 'activated', operationId, state: snapshot(activated) };
  }

  async rollback(input: {
    readonly installationId: string;
    readonly targetDigest: string;
    readonly configurationRevision: string;
    readonly configurationCompatible: boolean;
  }): Promise<{ readonly outcome: 'rolled-back' | 'known-failure' | 'unknown'; readonly operationId: string; readonly state: PluginDeploymentSnapshot }> {
    const key = this.key(input.installationId);
    const { revision, state: current } = await this.read(input.installationId);
    if (current.status !== 'active' || !current.current || current.previous?.releaseDigest !== input.targetDigest) {
      throw new PluginArtifactError('Plugin rollback target is not available.');
    }
    const previousRelease = current.previous;
    if (!input.configurationCompatible || input.configurationRevision !== current.configurationRevision) {
      throw new PluginArtifactError('Plugin rollback configuration is incompatible or stale.');
    }
    const target = this.verified(previousRelease.envelope);
    await this.assertCurrentTrust(target, previousRelease.secretAssignments);
    await this.assertStoredReviewAuthorized(input.installationId, previousRelease);
    if (current.current.envelope.stateMigration === 'irreversible') {
      await this.assertStoredReviewAuthorized(input.installationId, current.current);
    }
    if (await this.liveConfigurationRevision(input.installationId) !== input.configurationRevision) {
      throw new PluginArtifactError('Plugin configuration revision is stale.');
    }

    const operationId = randomUUID();
    const pending: PendingOperation = {
      kind: 'rollback',
      operationId,
      baseCurrentDigest: current.current.releaseDigest,
      configurationRevision: current.configurationRevision,
      targetDigest: previousRelease.releaseDigest,
    };
    const rolling: DeploymentState = { ...current, status: 'rolling-back', pending };
    validateStateInvariants(rolling);
    await this.compareAndSet(key, revision, rolling);
    try {
      await this.currentSnapshot(rolling, current.configurationRevision);
      await this.assertCurrentTrust(target, previousRelease.secretAssignments);
      await this.assertStoredReviewAuthorized(input.installationId, previousRelease);
      if (current.current.envelope.stateMigration === 'irreversible') {
        await this.assertStoredReviewAuthorized(input.installationId, current.current);
      }
    } catch {
      await this.mutateOperation(input.installationId, operationId, 'rollback', state => ({ ...state, status: 'active', pending: null }));
      throw new PluginArtifactError('Plugin rollback authorization changed before deployment.');
    }

    try {
      await this.options.driver.rollback({
        installationId: input.installationId,
        operationId,
        currentDeploymentId: current.current.deploymentId,
        previousDeploymentId: current.previous.deploymentId,
        baseCurrentDigest: current.current.releaseDigest,
        configurationRevision: current.configurationRevision,
      });
    } catch (error) {
      if (error instanceof DeploymentDriverError && error.outcome === 'failed') {
        const active = await this.mutateOperation(input.installationId, operationId, 'rollback', state => ({ ...state, status: 'active', pending: null }));
        return { outcome: 'known-failure', operationId, state: snapshot(active) };
      }
      const unknown = await this.mutateOperation(input.installationId, operationId, 'rollback', state => ({ ...state, status: 'rollback-unknown' }));
      return { outcome: 'unknown', operationId, state: snapshot(unknown) };
    }

    const rolledBack = await this.mutateOperation(input.installationId, operationId, 'rollback', state => ({
      ...state,
      status: 'active',
      current: state.previous,
      previous: state.current,
      pending: null,
    }));
    return { outcome: 'rolled-back', operationId, state: snapshot(rolledBack) };
  }

  async reconcile(installationId: string): Promise<{ readonly outcome: 'resolved' | 'unknown'; readonly state: PluginDeploymentSnapshot }> {
    const { state: before } = await this.read(installationId);
    const pending = before.pending;
    if (!pending || !['staging', 'stage-unknown', 'discarding', 'discard-unknown', 'activating', 'activation-unknown', 'rolling-back', 'rollback-unknown'].includes(before.status)) {
      throw new PluginArtifactError('No unknown plugin deployment operation requires reconciliation.');
    }

    if (pending.kind === 'discard') {
      const candidate = before.candidate;
      if (!candidate?.stagedDeploymentId
        || candidate.stagingOperationId !== pending.stagingOperationId
        || candidate.stagedDeploymentId !== pending.stagedDeploymentId
        || candidate.releaseDigest !== pending.candidateDigest) {
        throw new PluginArtifactError('Plugin discard state is invalid.');
      }
      const unresolved = async () => {
        const state = await this.markDiscardUnknown(installationId, pending);
        return { outcome: 'unknown' as const, state: snapshot(state) };
      };

      let observation: DeploymentObservation;
      try {
        // The original stage token identifies the candidate's driver-owned
        // resource; the discard operation ID only fences coordinator state.
        observation = await this.options.driver.reconcile({ installationId, operationId: pending.stagingOperationId });
      } catch {
        return unresolved();
      }
      const activeId = observation.activeDeploymentId;
      const stagedId = observation.stagedDeploymentId;
      if ((activeId !== null && !isDeploymentId(activeId))
        || (stagedId !== null && !isDeploymentId(stagedId))
        || activeId !== (before.current?.deploymentId ?? null)
        || (stagedId !== null && stagedId !== candidate.stagedDeploymentId)) {
        return unresolved();
      }

      const cleanup = await this.executeDiscardIntent(installationId, pending, candidate);
      return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
    }

    let observation: DeploymentObservation;
    try { observation = await this.options.driver.reconcile({ installationId, operationId: pending.operationId }); } catch {
      return { outcome: 'unknown', state: snapshot(before) };
    }
    const activeId = observation.activeDeploymentId;
    const stagedId = observation.stagedDeploymentId;
    if (activeId !== null && !isDeploymentId(activeId)) return { outcome: 'unknown', state: snapshot(before) };
    if (stagedId !== null && !isDeploymentId(stagedId)) return { outcome: 'unknown', state: snapshot(before) };

    if (pending.kind === 'stage') {
      const currentId = before.current?.deploymentId ?? null;
      const candidate = before.candidate;
      if (!candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
      const observedStage = stagedId;
      if (activeId !== currentId
        || !observedStage
        || observedStage === currentId
        || (candidate.stagedDeploymentId !== undefined && candidate.stagedDeploymentId !== observedStage)
        || (candidate.stagingOperationId !== undefined && candidate.stagingOperationId !== pending.operationId)
        || pending.candidateDigest !== candidate.releaseDigest
        || pending.baseCurrentDigest !== candidate.baseCurrentDigest
        || pending.configurationRevision !== candidate.configurationRevision) {
        // A missing stage observation is inconclusive: the driver may still
        // finish a timed-out create, so keep its original pending fence.
        return { outcome: 'unknown', state: snapshot(before) };
      }

      const observedCandidate: Candidate = {
        ...candidate,
        stagingOperationId: pending.operationId,
        stagedDeploymentId: observedStage,
      };
      const discardObservedStage = async () => this.discardRevokedCandidate({
        installationId,
        candidate: observedCandidate,
        expectedStageOperationId: pending.operationId,
        observedStageDeploymentId: observedStage,
      });
      const configurationIsCurrent = async (): Promise<boolean | undefined> => {
        try { return await this.liveConfigurationRevision(installationId) === pending.configurationRevision; } catch { return undefined; }
      };

      const currentConfiguration = await configurationIsCurrent();
      if (currentConfiguration === undefined) return { outcome: 'unknown', state: snapshot(before) };
      if (!currentConfiguration) {
        const cleanup = await discardObservedStage();
        return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
      }

      let verified: VerifiedPluginRelease;
      try {
        verified = this.verified(candidate.envelope);
      } catch {
        const cleanup = await discardObservedStage();
        return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
      }
      if (!await this.currentlyTrusted(verified, candidate.secretAssignments)) {
        const cleanup = await discardObservedStage();
        return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
      }

      const healthy = await this.options.driver.check({ installationId, deploymentId: observedStage, releaseDigest: candidate.releaseDigest }).catch(() => undefined);
      if (healthy === undefined) return { outcome: 'unknown', state: snapshot(before) };
      if (!healthy) {
        const cleanup = await discardObservedStage();
        return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
      }

      const stillCurrentConfiguration = await configurationIsCurrent();
      if (stillCurrentConfiguration === undefined) return { outcome: 'unknown', state: snapshot(before) };
      if (!stillCurrentConfiguration || !await this.currentlyTrusted(verified, candidate.secretAssignments)) {
        const cleanup = await discardObservedStage();
        return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
      }

      const state = await this.mutateOperation(installationId, pending.operationId, 'stage', current => {
        if (!current.candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
        const stagedCandidate: Candidate = { ...current.candidate, stagedDeploymentId: observedStage };
        return { ...current, candidate: stagedCandidate, status: reviewIsSufficient(stagedCandidate) ? 'candidate-ready' : 'review-required', pending: null };
      });
      return { outcome: 'resolved', state: snapshot(state) };
    }

    try {
      if (await this.liveConfigurationRevision(installationId) !== pending.configurationRevision) {
        return { outcome: 'unknown', state: snapshot(before) };
      }
    } catch {
      return { outcome: 'unknown', state: snapshot(before) };
    }

    if (pending.kind === 'activate') {
      const candidate = before.candidate;
      if (!candidate?.stagedDeploymentId) throw new PluginArtifactError('Plugin candidate state is invalid.');
      if (observation.routeOperationOutcome !== 'committed' && observation.routeOperationOutcome !== 'not-committed') {
        return { outcome: 'unknown', state: snapshot(before) };
      }
      if (observation.routeOperationOutcome === 'committed' && activeId === candidate.stagedDeploymentId) {
        try {
          await this.assertCurrentTrust(this.verified(candidate.envelope), candidate.secretAssignments);
          await this.assertReviewAuthorized(installationId, candidate);
        } catch {
          return { outcome: 'unknown', state: snapshot(before) };
        }
        const activated = await this.mutateOperation(installationId, pending.operationId, 'activate', state => {
          if (!state.candidate) throw new PluginArtifactError('Plugin candidate state is invalid.');
          const stagedCandidate = state.candidate;
          const stagedDeploymentId = stagedCandidate.stagedDeploymentId;
          if (!stagedDeploymentId) throw new PluginArtifactError('Plugin candidate state is invalid.');
          const promoted: StoredRelease = {
            envelope: stagedCandidate.envelope,
            releaseDigest: stagedCandidate.releaseDigest,
            deploymentId: stagedDeploymentId,
            secretAssignments: stagedCandidate.secretAssignments,
            effectsExpanded: stagedCandidate.effectsExpanded,
            permissionsExpanded: stagedCandidate.permissionsExpanded,
            ...(stagedCandidate.reviewApproval ? { reviewApproval: stagedCandidate.reviewApproval } : {}),
          };
          return { ...state, status: 'active', current: promoted, previous: state.current, candidate: null, pending: null };
        });
        return { outcome: 'resolved', state: snapshot(activated) };
      }
      if (observation.routeOperationOutcome === 'not-committed' && activeId === (before.current?.deploymentId ?? null)) {
        if (!await this.currentlyTrusted(this.verified(candidate.envelope), candidate.secretAssignments)) {
          const cleanup = await this.discardRevokedCandidate({
            installationId,
            candidate,
            expectedActivationOperationId: pending.operationId,
          });
          return { outcome: cleanup.cleaned ? 'resolved' : 'unknown', state: snapshot(cleanup.state) };
        }
        const ready = await this.mutateOperation(installationId, pending.operationId, 'activate', state => ({ ...state, status: 'candidate-ready', pending: null }));
        return { outcome: 'resolved', state: snapshot(ready) };
      }
      return { outcome: 'unknown', state: snapshot(before) };
    }

    if (!before.current || !before.previous) throw new PluginArtifactError('Plugin rollback state is invalid.');
    if (observation.routeOperationOutcome !== 'committed' && observation.routeOperationOutcome !== 'not-committed') {
      return { outcome: 'unknown', state: snapshot(before) };
    }
    if (observation.routeOperationOutcome === 'committed' && activeId === before.previous.deploymentId) {
      try {
        await this.assertCurrentTrust(this.verified(before.previous.envelope), before.previous.secretAssignments);
      } catch {
        return { outcome: 'unknown', state: snapshot(before) };
      }
      const restored = await this.mutateOperation(installationId, pending.operationId, 'rollback', state => ({
        ...state,
        status: 'active',
        current: state.previous,
        previous: state.current,
        pending: null,
      }));
      return { outcome: 'resolved', state: snapshot(restored) };
    }
    if (observation.routeOperationOutcome === 'not-committed' && activeId === before.current.deploymentId) {
      const active = await this.mutateOperation(installationId, pending.operationId, 'rollback', state => ({ ...state, status: 'active', pending: null }));
      return { outcome: 'resolved', state: snapshot(active) };
    }
    return { outcome: 'unknown', state: snapshot(before) };
  }
}
