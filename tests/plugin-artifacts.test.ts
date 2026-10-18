import { generateKeyPairSync, sign } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
import { describe, expect, it } from 'vitest';
import {
  buildPluginContainerLaunchPolicy,
  DeploymentDriverError,
  PluginArtifactError,
  PluginDeploymentCoordinator,
  pluginReleaseSigningBytes,
  verifyPluginRelease,
  type DeploymentDriver,
  type DeploymentObservation,
  type PluginReleaseEnvelope,
  type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';

const IMAGE_DIGEST = 'a'.repeat(64);
const MANIFEST_DIGEST = 'b'.repeat(64);

const keys = generateKeyPairSync('ed25519');
const approval: PublisherApproval = {
  publisherId: 'hasi-publisher',
  publicKey: keys.publicKey,
  sourceRegistryPrefix: 'registry.example.test/hasi',
  allowedPluginIds: ['weather'],
};

function unsignedRelease(overrides: Partial<UnsignedPluginRelease> = {}): UnsignedPluginRelease {
  return {
    schemaVersion: 1,
    pluginId: 'weather',
    version: '1.2.3',
    manifestDigest: MANIFEST_DIGEST,
    image: `registry.example.test/hasi/weather@sha256:${IMAGE_DIGEST}`,
    publisherId: 'hasi-publisher',
    configSchemaVersion: 1,
    stateMigration: 'none',
    ...overrides,
  };
}

function envelope(overrides: Partial<UnsignedPluginRelease> = {}): PluginReleaseEnvelope {
  const unsigned = unsignedRelease(overrides);
  const signature = sign(null, pluginReleaseSigningBytes(unsigned), keys.privateKey).toString('base64url');
  return { ...unsigned, signature };
}

function resolvePublisher(publisherId: string): PublisherApproval | undefined {
  return publisherId === approval.publisherId ? approval : undefined;
}

class FakeDriver implements DeploymentDriver {
  stageCount = 0;
  activateCount = 0;
  rollbackCount = 0;
  discardCount = 0;
  activeDeploymentId: string | null = null;
  healthy = true;
  nextStageError: Error | undefined;
  nextActivateError: Error | undefined;
  nextRollbackError: Error | undefined;
  nextCheckError: Error | undefined;
  nextDiscardError: Error | undefined;
  stageGate: Promise<void> | undefined;
  checkGate: Promise<void> | undefined;
  onStageEntered: (() => void) | undefined;
  onCheckEntered: (() => void) | undefined;
  readonly stageOperationIds: string[] = [];
  readonly discardedOperationIds: string[] = [];
  private sequence = 0;
  private readonly operationStages = new Map<string, string>();
  private readonly operationOutcomes = new Map<string, DeploymentObservation['routeOperationOutcome']>();

  async stage(input: Parameters<DeploymentDriver['stage']>[0]): Promise<{ deploymentId: string }> {
    this.stageCount += 1;
    this.stageOperationIds.push(input.operationId);
    this.onStageEntered?.();
    if (this.stageGate) await this.stageGate;
    if (this.nextStageError) {
      const error = this.nextStageError;
      this.nextStageError = undefined;
      throw error;
    }
    const deploymentId = `deployment-${String(++this.sequence)}`;
    this.operationStages.set(input.operationId, deploymentId);
    return { deploymentId };
  }

  async check(): Promise<boolean> {
    this.onCheckEntered?.();
    if (this.checkGate) await this.checkGate;
    if (this.nextCheckError) {
      const error = this.nextCheckError;
      this.nextCheckError = undefined;
      throw error;
    }
    return this.healthy;
  }

  discard(input: Parameters<DeploymentDriver['discard']>[0]): Promise<void> {
    this.discardCount += 1;
    this.discardedOperationIds.push(input.operationId);
    if (this.nextDiscardError) {
      const error = this.nextDiscardError;
      this.nextDiscardError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  setOperationOutcome(operationId: string, outcome: DeploymentObservation['routeOperationOutcome']): void {
    this.operationOutcomes.set(operationId, outcome);
  }

  async activate(input: Parameters<DeploymentDriver['activate']>[0]): Promise<void> {
    this.activateCount += 1;
    if (this.nextActivateError) {
      const error = this.nextActivateError;
      this.nextActivateError = undefined;
      this.operationOutcomes.set(input.operationId, 'unknown');
      throw error;
    }
    this.activeDeploymentId = input.candidateDeploymentId;
    this.operationOutcomes.set(input.operationId, 'committed');
    return Promise.resolve();
  }

  async rollback(input: Parameters<DeploymentDriver['rollback']>[0]): Promise<void> {
    this.rollbackCount += 1;
    if (this.nextRollbackError) {
      const error = this.nextRollbackError;
      this.nextRollbackError = undefined;
      this.operationOutcomes.set(input.operationId, 'unknown');
      throw error;
    }
    this.activeDeploymentId = input.previousDeploymentId;
    this.operationOutcomes.set(input.operationId, 'committed');
    return Promise.resolve();
  }

  reconcile(input: { installationId: string; operationId: string }): Promise<DeploymentObservation> {
    return Promise.resolve({
      activeDeploymentId: this.activeDeploymentId,
      stagedDeploymentId: this.operationStages.get(input.operationId) ?? null,
      routeOperationOutcome: this.operationOutcomes.get(input.operationId) ?? 'unknown',
    });
  }
}

function createCoordinator(options: {
  readonly driver?: FakeDriver;
  readonly isTrusted?: (releaseDigest: string) => boolean;
  readonly config?: { revision: string };
} = {}) {
  const driver = options.driver ?? new FakeDriver();
  const config = options.config ?? { revision: 'cfg-1' };
  const coordinator = new PluginDeploymentCoordinator({
    store: new MemoryJsonStore(`artifact-tests-${String(Math.random())}`),
    driver,
    scope: 'test-scope',
    resolvePublisher,
    isCurrentlyTrusted: release => options.isTrusted?.(release.releaseDigest) ?? true,
    authorizeReview: ({ approval: changeReview }) => changeReview.reviewerId === 'operator-1',
    getConfigurationRevision: () => config.revision,
  });
  return { coordinator, driver, config };
}

async function initialize(coordinator: PluginDeploymentCoordinator, installationId = 'installation-1') {
  await coordinator.initialize({ installationId, pluginId: 'weather', configurationSchemaVersion: 1 });
}

function candidateDigest(result: { readonly state: { readonly candidate: { readonly releaseDigest: string } | null } }): string {
  const value = result.state.candidate?.releaseDigest;
  if (!value) throw new Error('Expected a plugin candidate release digest.');
  return value;
}

async function stage(coordinator: PluginDeploymentCoordinator, overrides: {
  readonly release?: PluginReleaseEnvelope;
  readonly configurationRevision?: string;
  readonly effectsExpanded?: boolean;
  readonly permissionsExpanded?: boolean;
  readonly reviewApproval?: { approvalId: string; reviewerId: string; restorePlanId?: string };
} = {}) {
  return coordinator.stageCandidate({
    installationId: 'installation-1',
    release: overrides.release ?? envelope(),
    configurationRevision: overrides.configurationRevision ?? 'cfg-1',
    configurationCompatible: true,
    effectsExpanded: overrides.effectsExpanded ?? false,
    permissionsExpanded: overrides.permissionsExpanded ?? false,
    ...(overrides.reviewApproval ? { reviewApproval: overrides.reviewApproval } : {}),
    launch: { network: { mode: 'none' } },
  });
}

async function activate(coordinator: PluginDeploymentCoordinator, candidateDigest: string, baseCurrentDigest: string | null = null) {
  return coordinator.activate({
    installationId: 'installation-1',
    candidateDigest,
    baseCurrentDigest,
    configurationRevision: 'cfg-1',
  });
}

describe('signed plugin release admission', () => {
  it('verifies a canonical Ed25519 release and exposes its immutable identity', () => {
    const verified = verifyPluginRelease(envelope(), resolvePublisher);
    expect(verified.releaseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.imageDigest).toBe(IMAGE_DIGEST);
    expect(verified.publisherId).toBe(approval.publisherId);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('rejects forged signatures and signed-field mutation', () => {
    const valid = envelope();
    expect(() => verifyPluginRelease({ ...valid, signature: Buffer.alloc(64, 1).toString('base64url') }, resolvePublisher)).toThrow(PluginArtifactError);
    expect(() => verifyPluginRelease({ ...valid, manifestDigest: 'c'.repeat(64) }, resolvePublisher)).toThrow(PluginArtifactError);
  });

  it('rejects mutable tags, unapproved publisher/plugin/source, and malformed image digests', () => {
    const valid = envelope();
    expect(() => verifyPluginRelease({ ...valid, image: `registry.example.test/hasi/weather:latest@sha256:${IMAGE_DIGEST}` }, resolvePublisher)).toThrow(PluginArtifactError);
    expect(() => verifyPluginRelease(envelope({ image: `registry.evil.test/hasi/weather@sha256:${IMAGE_DIGEST}` }), resolvePublisher)).toThrow(PluginArtifactError);
    expect(() => verifyPluginRelease(envelope({ pluginId: 'other-plugin' }), resolvePublisher)).toThrow(PluginArtifactError);
    expect(() => verifyPluginRelease({ ...valid, publisherId: 'unknown-publisher' }, resolvePublisher)).toThrow(PluginArtifactError);
    expect(() => verifyPluginRelease(envelope({ image: 'registry.example.test/hasi/weather@sha256:bad' }), resolvePublisher)).toThrow(PluginArtifactError);
  });

  it('builds a deterministic restricted launch policy from an admitted image only', () => {
    const release = verifyPluginRelease(envelope(), resolvePublisher);
    const policy = buildPluginContainerLaunchPolicy(release, { network: { mode: 'internal', name: 'hasi-plugin-net' }, hostPort: 43121, containerPort: 3000 });
    expect(policy).toMatchObject({
      image: release.image,
      imageDigest: IMAGE_DIGEST,
      user: { uid: 65_532, gid: 65_532 },
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      capDrop: ['ALL'],
      noNewPrivileges: true,
      privileged: false,
      network: { mode: 'internal', name: 'hasi-plugin-net', internal: true },
      publishedPort: { hostAddress: '127.0.0.1', hostPort: 43121, containerPort: 3000, protocol: 'tcp' },
      args: [],
      environment: [],
      mounts: [],
      devices: [],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => buildPluginContainerLaunchPolicy({ ...release, image: 'registry.example.test/hasi/other@sha256:' + IMAGE_DIGEST }, { network: { mode: 'none' } } as never)).toThrow(PluginArtifactError);
    expect(() => buildPluginContainerLaunchPolicy(release, { network: { mode: 'internal', name: 'host' }, hostPort: 43121 })).toThrow(PluginArtifactError);
  });
});

describe('plugin deployment coordinator', () => {
  it('keeps the current release when staging a replacement fails', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    const first = await stage(coordinator);
    expect(first.outcome).toBe('candidate-ready');
    const firstDigest = candidateDigest(first);
    await expect(activate(coordinator, firstDigest, 'e'.repeat(64))).rejects.toThrow(PluginArtifactError);
    expect((await activate(coordinator, firstDigest)).outcome).toBe('activated');
    const currentDigest = (await coordinator.get('installation-1')).current?.releaseDigest;

    driver.nextStageError = new DeploymentDriverError('failed');
    const failed = await stage(coordinator, { release: envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` }) });
    expect(failed.outcome).toBe('stage-failed');
    expect(failed.state.status).toBe('active');
    expect(failed.state.current?.releaseDigest).toBe(currentDigest);
  });

  it('records an unknown activation without repeating it and reconciles without retrying', async () => {
    const { coordinator, driver, config } = createCoordinator();
    await initialize(coordinator);
    const staged = await stage(coordinator);
    const releaseDigest = candidateDigest(staged);
    driver.nextActivateError = new Error('driver timed out after dispatch');

    const outcome = await activate(coordinator, releaseDigest);
    expect(outcome.outcome).toBe('unknown');
    expect(outcome.state.status).toBe('activation-unknown');
    expect(driver.activateCount).toBe(1);
    await expect(activate(coordinator, releaseDigest)).rejects.toThrow(PluginArtifactError);
    expect(driver.activateCount).toBe(1);

    config.revision = 'cfg-2';
    expect((await coordinator.reconcile('installation-1')).outcome).toBe('unknown');
    config.revision = 'cfg-1';
    driver.setOperationOutcome(outcome.operationId, 'pending');
    expect((await coordinator.reconcile('installation-1')).outcome).toBe('unknown');
    driver.setOperationOutcome(outcome.operationId, 'not-committed');
    const reconciled = await coordinator.reconcile('installation-1');
    expect(reconciled.outcome).toBe('resolved');
    expect(reconciled.state.status).toBe('candidate-ready');
    expect(driver.activateCount).toBe(1);
  });

  it('discards a staged container if publisher or secret trust is revoked while stage is awaiting the driver', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    let finishStage!: () => void;
    let stageEntered!: () => void;
    driver.stageGate = new Promise<void>(resolve => { finishStage = resolve; });
    const entered = new Promise<void>(resolve => { stageEntered = resolve; });
    driver.onStageEntered = stageEntered;
    const { coordinator } = createCoordinator({ driver, isTrusted: () => trusted });
    await initialize(coordinator);

    const pendingStage = stage(coordinator);
    await entered;
    trusted = false;
    finishStage();

    const result = await pendingStage;
    expect(result.outcome).toBe('stage-failed');
    expect(result.state.status).toBe('empty');
    expect(result.state.candidate).toBeNull();
    expect(driver.discardCount).toBe(1);
    expect(driver.discardedOperationIds).toEqual(driver.stageOperationIds);
  });

  it('rechecks trust after the health await and retains unknown state if exact discard fails', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    let finishCheck!: () => void;
    let checkEntered!: () => void;
    driver.checkGate = new Promise<void>(resolve => { finishCheck = resolve; });
    const entered = new Promise<void>(resolve => { checkEntered = resolve; });
    driver.onCheckEntered = checkEntered;
    driver.nextDiscardError = new Error('discard outcome was unknown');
    const { coordinator } = createCoordinator({ driver, isTrusted: () => trusted });
    await initialize(coordinator);

    const pendingStage = stage(coordinator);
    await entered;
    trusted = false;
    finishCheck();

    const result = await pendingStage;
    expect(result.outcome).toBe('stage-unknown');
    expect(result.state.status).toBe('stage-unknown');
    expect(result.state.candidate?.staged).toBe(true);
    expect(driver.discardCount).toBe(1);
    expect(driver.discardedOperationIds).toEqual(driver.stageOperationIds);
  });

  it('discards a ready candidate when activation is denied after trust revocation', async () => {
    let trusted = true;
    const { coordinator, driver } = createCoordinator({ isTrusted: () => trusted });
    await initialize(coordinator);
    const staged = await stage(coordinator);
    trusted = false;

    await expect(activate(coordinator, candidateDigest(staged))).rejects.toThrow(PluginArtifactError);
    expect(driver.activateCount).toBe(0);
    expect(driver.discardCount).toBe(1);
    expect(driver.discardedOperationIds).toEqual(driver.stageOperationIds);
    expect(await coordinator.get('installation-1')).toMatchObject({ status: 'empty', candidate: null });
  });

  it('reconciles a revoked stage by discarding it instead of promoting it to ready', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    driver.nextCheckError = new Error('health result unavailable');
    const { coordinator } = createCoordinator({ driver, isTrusted: () => trusted });
    await initialize(coordinator);
    const staged = await stage(coordinator);
    expect(staged.outcome).toBe('stage-unknown');

    trusted = false;
    const reconciled = await coordinator.reconcile('installation-1');
    expect(reconciled.outcome).toBe('resolved');
    expect(reconciled.state.status).toBe('empty');
    expect(reconciled.state.candidate).toBeNull();
    expect(driver.discardCount).toBe(1);
    expect(driver.discardedOperationIds).toEqual(driver.stageOperationIds);
  });

  it('does not resolve an old route snapshot while a timed-out route operation remains pending', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    const staged = await stage(coordinator);
    const digest = candidateDigest(staged);
    driver.nextActivateError = new Error('activation result was delayed');
    const outcome = await activate(coordinator, digest);
    expect(outcome.outcome).toBe('unknown');
    expect(outcome.state.status).toBe('activation-unknown');

    driver.setOperationOutcome(outcome.operationId, 'pending');
    expect((await coordinator.reconcile('installation-1')).outcome).toBe('unknown');
    expect((await coordinator.get('installation-1')).status).toBe('activation-unknown');

    driver.setOperationOutcome(outcome.operationId, 'not-committed');
    const terminal = await coordinator.reconcile('installation-1');
    expect(terminal.outcome).toBe('resolved');
    expect(terminal.state.status).toBe('candidate-ready');
  });

  it('requires explicit review for expanded permissions and a restore plan for irreversible migration', async () => {
    const { coordinator } = createCoordinator();
    await initialize(coordinator);
    const reviewed = await stage(coordinator, { effectsExpanded: true });
    expect(reviewed.outcome).toBe('review-required');
    await expect(activate(coordinator, candidateDigest(reviewed))).rejects.toThrow(PluginArtifactError);
    await expect(coordinator.approveCandidate({
      installationId: 'installation-1',
      candidateDigest: candidateDigest(reviewed),
      approval: { approvalId: 'forged-approval', reviewerId: 'attacker' },
    })).rejects.toThrow(PluginArtifactError);
    const ready = await coordinator.approveCandidate({
      installationId: 'installation-1',
      candidateDigest: candidateDigest(reviewed),
      approval: { approvalId: 'approval-1', reviewerId: 'operator-1' },
    });
    expect(ready.status).toBe('candidate-ready');

    const other = createCoordinator();
    await initialize(other.coordinator, 'installation-1');
    const irreversible = await stage(other.coordinator, { release: envelope({ version: '2.0.0', stateMigration: 'irreversible' }) });
    expect(irreversible.outcome).toBe('review-required');
    await expect(other.coordinator.approveCandidate({
      installationId: 'installation-1',
      candidateDigest: candidateDigest(irreversible),
      approval: { approvalId: 'approval-2', reviewerId: 'operator-1' },
    })).rejects.toThrow(PluginArtifactError);
    await expect(other.coordinator.approveCandidate({
      installationId: 'installation-1',
      candidateDigest: candidateDigest(irreversible),
      approval: { approvalId: 'approval-2', reviewerId: 'operator-1', restorePlanId: 'restore-1' },
    })).resolves.toMatchObject({ status: 'candidate-ready' });
  });

  it('rechecks current trust before rollback and rejects revoked credentials or releases', async () => {
    const revoked = new Set<string>();
    const { coordinator, driver } = createCoordinator({ isTrusted: hash => !revoked.has(hash) });
    await initialize(coordinator);
    const first = await stage(coordinator);
    const firstDigest = candidateDigest(first);
    await activate(coordinator, firstDigest);
    const secondRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const second = await stage(coordinator, { release: secondRelease });
    const secondDigest = candidateDigest(second);
    await activate(coordinator, secondDigest, firstDigest);

    revoked.add(firstDigest);
    await expect(coordinator.rollback({
      installationId: 'installation-1',
      targetDigest: firstDigest,
      configurationRevision: 'cfg-1',
      configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect(driver.rollbackCount).toBe(0);
    expect((await coordinator.get('installation-1')).current?.releaseDigest).toBe(secondDigest);
  });

  it('uses a per-installation CAS so concurrent stage requests cannot both call the driver', async () => {
    const driver = new FakeDriver();
    let releaseStage!: () => void;
    let stageEntered!: () => void;
    driver.stageGate = new Promise<void>(resolve => { releaseStage = resolve; });
    const entered = new Promise<void>(resolve => { stageEntered = resolve; });
    driver.onStageEntered = stageEntered;
    const { coordinator } = createCoordinator({ driver });
    await initialize(coordinator);
    const first = stage(coordinator);
    await entered;
    await expect(stage(coordinator)).rejects.toThrow(PluginArtifactError);
    expect(driver.stageCount).toBe(1);
    releaseStage();
    await expect(first).resolves.toMatchObject({ outcome: 'candidate-ready' });
  });

  it('pins the live configuration revision across staging and activation', async () => {
    const config = { revision: 'cfg-1' };
    const { coordinator, driver } = createCoordinator({ config });
    await initialize(coordinator);
    const staged = await stage(coordinator);
    config.revision = 'cfg-2';
    await expect(activate(coordinator, candidateDigest(staged))).rejects.toThrow(PluginArtifactError);
    expect(driver.activateCount).toBe(0);
    expect((await coordinator.get('installation-1')).status).toBe('candidate-ready');
  });

  it('rechecks candidate health immediately before activation', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    driver.healthy = false;
    const unhealthy = await stage(coordinator);
    expect(unhealthy.outcome).toBe('stage-failed');
    expect(driver.discardCount).toBe(1);
    driver.healthy = true;
    const staged = await stage(coordinator);
    driver.healthy = false;
    await expect(activate(coordinator, candidateDigest(staged))).rejects.toThrow(PluginArtifactError);
    expect(driver.activateCount).toBe(0);
    expect((await coordinator.get('installation-1')).status).toBe('candidate-ready');
  });
});
