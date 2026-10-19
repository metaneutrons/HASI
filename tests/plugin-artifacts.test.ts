import { generateKeyPairSync, sign } from 'node:crypto';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
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
  type LogicalSecretAssignment,
  type PluginReleaseEnvelope,
  type PublisherApproval,
  type PublisherApprovalResolver,
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
  nextDiscardErrorAfterCleanup: Error | undefined;
  nextStageErrorAfterCreate = false;
  stageGate: Promise<void> | undefined;
  checkGate: Promise<void> | undefined;
  discardGate: Promise<void> | undefined;
  onStageEntered: (() => void) | undefined;
  onCheckEntered: (() => void) | undefined;
  onDiscardEntered: (() => void) | undefined;
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
      if (!this.nextStageErrorAfterCreate) throw error;
      this.nextStageErrorAfterCreate = false;
      const deploymentId = `deployment-${String(++this.sequence)}`;
      this.operationStages.set(input.operationId, deploymentId);
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

  async discard(input: Parameters<DeploymentDriver['discard']>[0]): Promise<void> {
    this.discardCount += 1;
    this.discardedOperationIds.push(input.operationId);
    this.onDiscardEntered?.();
    if (this.discardGate) await this.discardGate;
    if (this.nextDiscardError) {
      const error = this.nextDiscardError;
      this.nextDiscardError = undefined;
      throw error;
    }
    if (this.activeDeploymentId === input.deploymentId) throw new Error('active deployment cannot be discarded');
    const ownedDeploymentId = this.operationStages.get(input.operationId);
    if (ownedDeploymentId !== undefined && ownedDeploymentId !== input.deploymentId) {
      throw new Error('stage operation does not own the requested deployment');
    }
    if (ownedDeploymentId === input.deploymentId) this.operationStages.delete(input.operationId);
    if (this.nextDiscardErrorAfterCleanup) {
      const error = this.nextDiscardErrorAfterCleanup;
      this.nextDiscardErrorAfterCleanup = undefined;
      throw error;
    }
  }

  setOperationStage(operationId: string, deploymentId: string): void {
    this.operationStages.set(operationId, deploymentId);
  }

  clearOperationStage(operationId: string): void {
    this.operationStages.delete(operationId);
  }

  operationStage(operationId: string): string | null {
    return this.operationStages.get(operationId) ?? null;
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
  readonly isTrusted?: (releaseDigest: string, secretAssignments: readonly LogicalSecretAssignment[]) => boolean;
  readonly resolvePublisher?: PublisherApprovalResolver;
  readonly config?: { revision: string };
  readonly getConfigurationRevision?: () => string | Promise<string>;
  readonly store?: JsonStore;
} = {}) {
  const driver = options.driver ?? new FakeDriver();
  const config = options.config ?? { revision: 'cfg-1' };
  const store = options.store ?? new MemoryJsonStore(`artifact-tests-${String(Math.random())}`);
  const coordinator = new PluginDeploymentCoordinator({
    store,
    driver,
    scope: 'test-scope',
    resolvePublisher: options.resolvePublisher ?? resolvePublisher,
    isCurrentlyTrusted: (release, secretAssignments) => options.isTrusted?.(release.releaseDigest, secretAssignments) ?? true,
    authorizeReview: ({ approval: changeReview }) => changeReview.reviewerId === 'operator-1',
    getConfigurationRevision: () => options.getConfigurationRevision?.() ?? config.revision,
  });
  return { coordinator, driver, config, store };
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
  readonly secretAssignments?: readonly LogicalSecretAssignment[];
  readonly reviewApproval?: { approvalId: string; reviewerId: string; restorePlanId?: string };
} = {}) {
  return coordinator.stageCandidate({
    installationId: 'installation-1',
    release: overrides.release ?? envelope(),
    configurationRevision: overrides.configurationRevision ?? 'cfg-1',
    configurationCompatible: true,
    effectsExpanded: overrides.effectsExpanded ?? false,
    permissionsExpanded: overrides.permissionsExpanded ?? false,
    ...(overrides.secretAssignments ? { secretAssignments: overrides.secretAssignments } : {}),
    ...(overrides.reviewApproval ? { reviewApproval: overrides.reviewApproval } : {}),
    launch: { network: { mode: 'none' } },
  });
}

async function activate(
  coordinator: PluginDeploymentCoordinator,
  candidateDigest: string,
  baseCurrentDigest: string | null = null,
  configurationRevision = 'cfg-1',
) {
  return coordinator.activate({
    installationId: 'installation-1',
    candidateDigest,
    baseCurrentDigest,
    configurationRevision,
  });
}

function discardRequest(staged: Awaited<ReturnType<typeof stage>>, overrides: {
  readonly candidateDigest?: string;
  readonly stagingOperationId?: string;
  readonly configurationRevision?: string;
} = {}) {
  const candidate = staged.state.candidate;
  if (!candidate) throw new Error('Expected a plugin candidate to discard.');
  const stagingOperationId = overrides.stagingOperationId ?? candidate.stagingOperationId;
  if (!stagingOperationId) throw new Error('Expected a plugin candidate staging operation ID.');
  return {
    installationId: 'installation-1',
    candidateDigest: overrides.candidateDigest ?? candidate.releaseDigest,
    stagingOperationId,
    configurationRevision: overrides.configurationRevision ?? staged.state.configurationRevision,
  };
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
      ingress: { hostAddress: '127.0.0.1', hostPort: 43121, containerPort: 3000, protocol: 'tcp' },
      args: [],
      environment: [],
      mounts: [],
      devices: [],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(buildPluginContainerLaunchPolicy(release, { network: { mode: 'none' } }).ingress).toBeNull();
    expect(() => buildPluginContainerLaunchPolicy({ ...release, image: 'registry.example.test/hasi/other@sha256:' + IMAGE_DIGEST }, { network: { mode: 'none' } } as never)).toThrow(PluginArtifactError);
    expect(() => buildPluginContainerLaunchPolicy(release, { network: { mode: 'internal', name: 'host' }, hostPort: 43121 })).toThrow(PluginArtifactError);
  });
});

describe('plugin deployment coordinator', () => {
  it('synchronizes an empty installation revision without writing when already current', async () => {
    let authorityReads = 0;
    let compareAndSetCalls = 0;
    const backing = new MemoryJsonStore(`artifact-sync-noop-${String(Math.random())}`);
    const store: JsonStore = {
      read: key => backing.read(key),
      compareAndSet: (key, revision, value, expiresAt) => {
        compareAndSetCalls += 1;
        return backing.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => backing.delete(key),
    };
    const { coordinator, driver, config } = createCoordinator({
      store,
      getConfigurationRevision: () => {
        authorityReads += 1;
        return config.revision;
      },
    });
    await initialize(coordinator);
    const before = await coordinator.get('installation-1');
    compareAndSetCalls = 0;
    authorityReads = 0;

    const synchronized = await coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-1',
      configurationCompatible: true,
    });
    expect(synchronized).toEqual(before);
    expect(compareAndSetCalls).toBe(0);
    expect(authorityReads).toBeGreaterThan(1);

    authorityReads = 0;
    await expect(coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'stale-cfg',
      approvedConfigurationRevision: 'cfg-1',
      configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    await expect(coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-1',
      configurationCompatible: false,
    })).rejects.toThrow(PluginArtifactError);
    expect(authorityReads).toBe(0);
    expect(await coordinator.get('installation-1')).toEqual(before);
    expect(driver.stageCount).toBe(0);
    expect(driver.activateCount).toBe(0);
  });

  it('synchronizes an empty installation before staging and activating at the new revision', async () => {
    const { coordinator, driver, config } = createCoordinator();
    await initialize(coordinator);
    config.revision = 'cfg-2';

    const synchronized = await coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    });
    expect(synchronized).toMatchObject({ status: 'empty', configurationRevision: 'cfg-2', current: null, previous: null, candidate: null });

    const staged = await stage(coordinator, { configurationRevision: 'cfg-2' });
    expect(staged.outcome).toBe('candidate-ready');
    const activated = await activate(coordinator, candidateDigest(staged), null, 'cfg-2');
    expect(activated.outcome).toBe('activated');
    expect(activated.state).toMatchObject({ status: 'active', configurationRevision: 'cfg-2' });
    expect(driver.stageCount).toBe(1);
    expect(driver.activateCount).toBe(1);
  });

  it('rejects a compatibility preflight bound to a revision that is no longer live at the first read', async () => {
    let authorityReads = 0;
    const { coordinator, driver, config } = createCoordinator({
      getConfigurationRevision: () => {
        authorityReads += 1;
        return config.revision;
      },
    });
    await initialize(coordinator);
    config.revision = 'cfg-3';
    authorityReads = 0;
    const before = await coordinator.get('installation-1');

    await expect(coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);

    expect(authorityReads).toBe(1);
    expect(await coordinator.get('installation-1')).toEqual(before);
    expect(before.configurationRevision).toBe('cfg-1');
    expect(driver.stageCount).toBe(0);
    expect(driver.activateCount).toBe(0);
    expect(driver.rollbackCount).toBe(0);
    expect(driver.discardCount).toBe(0);
  });

  it('synchronizes active metadata while preserving releases and allowing a freshly checked replacement', async () => {
    const trustedAssignments: { releaseDigest: string; secretRefs: string[] }[] = [];
    const { coordinator, driver, config } = createCoordinator({
      isTrusted: (releaseDigest, secretAssignments) => {
        trustedAssignments.push({ releaseDigest, secretRefs: secretAssignments.map(item => item.secretRef) });
        return true;
      },
    });
    await initialize(coordinator);
    const first = await stage(coordinator, {
      effectsExpanded: true,
      secretAssignments: [{ name: 'weather_token', secretRef: 'secret-1' }],
    });
    expect(first.outcome).toBe('review-required');
    const firstDigest = candidateDigest(first);
    await coordinator.approveCandidate({
      installationId: 'installation-1',
      candidateDigest: firstDigest,
      approval: { approvalId: 'approval-1', reviewerId: 'operator-1' },
    });
    await activate(coordinator, firstDigest);
    const activeBeforeSync = await coordinator.get('installation-1');
    config.revision = 'cfg-2';

    const synchronized = await coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    });
    expect(synchronized).toMatchObject({
      status: 'active',
      configurationRevision: 'cfg-2',
      configurationSchemaVersion: activeBeforeSync.configurationSchemaVersion,
      current: activeBeforeSync.current,
      previous: activeBeforeSync.previous,
      candidate: null,
    });

    const secondRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const second = await stage(coordinator, { release: secondRelease, configurationRevision: 'cfg-2' });
    expect(second.outcome).toBe('candidate-ready');
    const activated = await activate(coordinator, candidateDigest(second), firstDigest, 'cfg-2');
    expect(activated.outcome).toBe('activated');
    expect(activated.state).toMatchObject({ status: 'active', configurationRevision: 'cfg-2', previous: { releaseDigest: firstDigest } });
    expect(driver.stageCount).toBe(2);
    expect(driver.activateCount).toBe(2);

    // Only the fresh rollback check can prove retained credential bindings.
    trustedAssignments.length = 0;
    const rolledBack = await coordinator.rollback({
      installationId: 'installation-1',
      targetDigest: firstDigest,
      configurationRevision: 'cfg-2',
      configurationCompatible: true,
    });
    expect(rolledBack.outcome).toBe('rolled-back');
    expect(trustedAssignments).toContainEqual({ releaseDigest: firstDigest, secretRefs: ['secret-1'] });
    expect(driver.rollbackCount).toBe(1);
  });

  it('refuses synchronization for ready candidates and unknown operations', async () => {
    const candidate = createCoordinator();
    await initialize(candidate.coordinator);
    await stage(candidate.coordinator);
    candidate.config.revision = 'cfg-2';
    const readyBefore = await candidate.coordinator.get('installation-1');
    await expect(candidate.coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect(await candidate.coordinator.get('installation-1')).toEqual(readyBefore);

    const unknown = createCoordinator();
    await initialize(unknown.coordinator);
    const staged = await stage(unknown.coordinator);
    unknown.driver.nextActivateError = new Error('activation result unavailable');
    const activation = await activate(unknown.coordinator, candidateDigest(staged));
    expect(activation.outcome).toBe('unknown');
    unknown.config.revision = 'cfg-2';
    const unknownBefore = await unknown.coordinator.get('installation-1');
    await expect(unknown.coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect(await unknown.coordinator.get('installation-1')).toEqual(unknownBefore);
  });

  it('does not expose public candidate cancellation for stage, activation, or rollback unknown states', async () => {
    const staging = createCoordinator();
    await initialize(staging.coordinator);
    staging.driver.nextCheckError = new Error('stage health result unavailable');
    const stageUnknown = await stage(staging.coordinator);
    expect(stageUnknown.state.status).toBe('stage-unknown');
    await expect(staging.coordinator.discardCandidate(discardRequest(stageUnknown))).rejects.toThrow(PluginArtifactError);
    expect(staging.driver.discardCount).toBe(0);

    const activating = createCoordinator();
    await initialize(activating.coordinator);
    const activationCandidate = await stage(activating.coordinator);
    activating.driver.nextActivateError = new Error('activation result unavailable');
    const activationUnknown = await activate(activating.coordinator, candidateDigest(activationCandidate));
    expect(activationUnknown.state.status).toBe('activation-unknown');
    await expect(activating.coordinator.discardCandidate(discardRequest(activationCandidate))).rejects.toThrow(PluginArtifactError);
    expect(activating.driver.discardCount).toBe(0);

    const rollingBack = createCoordinator();
    await initialize(rollingBack.coordinator);
    const first = await stage(rollingBack.coordinator);
    const firstDigest = candidateDigest(first);
    await activate(rollingBack.coordinator, firstDigest);
    const secondRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const second = await stage(rollingBack.coordinator, { release: secondRelease });
    await activate(rollingBack.coordinator, candidateDigest(second), firstDigest);
    rollingBack.driver.nextRollbackError = new Error('rollback result unavailable');
    const rollbackUnknown = await rollingBack.coordinator.rollback({
      installationId: 'installation-1',
      targetDigest: firstDigest,
      configurationRevision: 'cfg-1',
      configurationCompatible: true,
    });
    expect(rollbackUnknown.state.status).toBe('rollback-unknown');
    await expect(rollingBack.coordinator.discardCandidate(discardRequest(first))).rejects.toThrow(PluginArtifactError);
    expect(rollingBack.driver.discardCount).toBe(0);
  });

  it('fails closed when configuration authority fails or changes during the synchronization CAS', async () => {
    let authorityUnavailable = false;
    const unavailable = createCoordinator({
      getConfigurationRevision: () => {
        if (authorityUnavailable) throw new Error('private settings backend detail');
        return 'cfg-1';
      },
    });
    await initialize(unavailable.coordinator);
    authorityUnavailable = true;
    await expect(unavailable.coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect((await unavailable.coordinator.get('installation-1')).configurationRevision).toBe('cfg-1');

    const backing = new MemoryJsonStore(`artifact-sync-settings-race-${String(Math.random())}`);
    const config = { revision: 'cfg-1' };
    let afterSuccessfulCas: (() => void) | undefined;
    const store: JsonStore = {
      read: key => backing.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        const committed = await backing.compareAndSet(key, revision, value, expiresAt);
        if (committed) {
          afterSuccessfulCas?.();
          afterSuccessfulCas = undefined;
        }
        return committed;
      },
      delete: key => backing.delete(key),
    };
    const changing = createCoordinator({ store, config });
    await initialize(changing.coordinator);
    config.revision = 'cfg-2';
    afterSuccessfulCas = () => { config.revision = 'cfg-3'; };
    await expect(changing.coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect((await changing.coordinator.get('installation-1')).configurationRevision).toBe('cfg-2');
    expect(changing.driver.stageCount).toBe(0);
  });

  it('rejects a concurrent state CAS instead of reporting a stale synchronized snapshot', async () => {
    const backing = new MemoryJsonStore(`artifact-sync-cas-race-${String(Math.random())}`);
    let raceNextWrite = false;
    const store: JsonStore = {
      read: key => backing.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (raceNextWrite && revision !== null) {
          raceNextWrite = false;
          const current = await backing.read(key);
          if (current?.revision === revision) {
            const changedByOtherWriter = {
              ...(current.value as Record<string, unknown>),
              configurationSchemaVersion: 2,
            };
            await backing.compareAndSet(key, revision, changedByOtherWriter);
          }
        }
        return backing.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => backing.delete(key),
    };
    const { coordinator, config, driver } = createCoordinator({ store });
    await initialize(coordinator);
    config.revision = 'cfg-2';
    raceNextWrite = true;

    await expect(coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect(await coordinator.get('installation-1')).toMatchObject({ configurationRevision: 'cfg-1', configurationSchemaVersion: 2 });
    expect(driver.stageCount).toBe(0);
  });

  it('resolves an uncertain synchronization CAS only from exact readback and current authority', async () => {
    interface StoreBehavior { mode: 'normal' | 'commit-then-throw' | 'throw-before-commit' | 'commit-then-stale' }
    const makeStore = (config: { revision: string }, behavior: StoreBehavior) => {
      const backing = new MemoryJsonStore(`artifact-sync-uncertain-${String(Math.random())}`);
      const store: JsonStore = {
        read: key => backing.read(key),
        compareAndSet: async (key, revision, value, expiresAt) => {
          if (revision !== null && behavior.mode !== 'normal') {
            const mode = behavior.mode;
            behavior.mode = 'normal';
            if (mode === 'throw-before-commit') throw new Error('write acknowledgement unavailable');
            const committed = await backing.compareAndSet(key, revision, value, expiresAt);
            if (committed && mode === 'commit-then-stale') config.revision = 'cfg-3';
            if (committed) throw new Error('write acknowledgement unavailable');
            return false;
          }
          return backing.compareAndSet(key, revision, value, expiresAt);
        },
        delete: key => backing.delete(key),
      };
      return store;
    };

    const prepare = async (mode: StoreBehavior['mode']) => {
      const config = { revision: 'cfg-1' };
      const behavior: StoreBehavior = { mode: 'normal' };
      const store = makeStore(config, behavior);
      const context = createCoordinator({ store, config });
      await initialize(context.coordinator);
      config.revision = 'cfg-2';
      behavior.mode = mode;
      return { ...context, behavior };
    };
    const synchronize = (coordinator: PluginDeploymentCoordinator) => coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    });

    const committed = await prepare('commit-then-throw');
    await expect(synchronize(committed.coordinator)).resolves.toMatchObject({ configurationRevision: 'cfg-2' });
    expect((await committed.coordinator.get('installation-1')).configurationRevision).toBe('cfg-2');

    const notCommitted = await prepare('throw-before-commit');
    await expect(synchronize(notCommitted.coordinator)).rejects.toThrow(PluginArtifactError);
    expect((await notCommitted.coordinator.get('installation-1')).configurationRevision).toBe('cfg-1');

    const staleAuthority = await prepare('commit-then-stale');
    await expect(synchronize(staleAuthority.coordinator)).rejects.toThrow(PluginArtifactError);
    expect((await staleAuthority.coordinator.get('installation-1')).configurationRevision).toBe('cfg-2');
  });

  it('does not restore trust in a previous release when synchronizing active metadata', async () => {
    const revoked = new Set<string>();
    const { coordinator, driver, config } = createCoordinator({ isTrusted: releaseDigest => !revoked.has(releaseDigest) });
    await initialize(coordinator);
    const first = await stage(coordinator);
    const firstDigest = candidateDigest(first);
    await activate(coordinator, firstDigest);
    const secondRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const second = await stage(coordinator, { release: secondRelease });
    const secondDigest = candidateDigest(second);
    await activate(coordinator, secondDigest, firstDigest);

    revoked.add(firstDigest);
    config.revision = 'cfg-2';
    const synchronized = await coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1', expectedRevision: 'cfg-1', approvedConfigurationRevision: 'cfg-2', configurationCompatible: true,
    });
    expect(synchronized).toMatchObject({ current: { releaseDigest: secondDigest }, previous: { releaseDigest: firstDigest } });
    await expect(coordinator.rollback({
      installationId: 'installation-1',
      targetDigest: firstDigest,
      configurationRevision: 'cfg-2',
      configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);
    expect(driver.rollbackCount).toBe(0);
    expect((await coordinator.get('installation-1')).current?.releaseDigest).toBe(secondDigest);
  });

  it('discards a ready candidate at its stored revision, then synchronizes and activates a fresh release', async () => {
    const { coordinator, driver, config } = createCoordinator();
    await initialize(coordinator);
    const canceled = await stage(coordinator);
    const request = discardRequest(canceled);
    config.revision = 'cfg-2';

    const discarded = await coordinator.discardCandidate(request);
    expect(discarded).toMatchObject({ status: 'empty', configurationRevision: 'cfg-1', current: null, previous: null, candidate: null });
    expect(driver.discardedOperationIds).toEqual([request.stagingOperationId]);

    const synchronized = await coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    });
    expect(synchronized.configurationRevision).toBe('cfg-2');
    const freshRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const fresh = await stage(coordinator, { release: freshRelease, configurationRevision: 'cfg-2' });
    expect(fresh.outcome).toBe('candidate-ready');
    const activated = await activate(coordinator, candidateDigest(fresh), null, 'cfg-2');
    expect(activated.outcome).toBe('activated');
    expect(activated.state.current?.releaseDigest).toBe(candidateDigest(fresh));
    expect(driver.stageCount).toBe(2);
    expect(driver.activateCount).toBe(1);
  });

  it('discards a review-required candidate and preserves current and previous releases', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    const first = await stage(coordinator);
    const firstDigest = candidateDigest(first);
    await activate(coordinator, firstDigest);
    const secondRelease = envelope({ version: '1.2.4', manifestDigest: 'c'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'d'.repeat(64)}` });
    const second = await stage(coordinator, { release: secondRelease });
    const secondDigest = candidateDigest(second);
    await activate(coordinator, secondDigest, firstDigest);
    const currentBeforeDiscard = await coordinator.get('installation-1');
    const reviewRelease = envelope({ version: '1.2.5', manifestDigest: 'e'.repeat(64), image: `registry.example.test/hasi/weather@sha256:${'f'.repeat(64)}` });
    const reviewedCandidate = await stage(coordinator, { release: reviewRelease, effectsExpanded: true });
    expect(reviewedCandidate.outcome).toBe('review-required');

    const discarded = await coordinator.discardCandidate(discardRequest(reviewedCandidate));
    expect(discarded).toMatchObject({
      status: 'active',
      current: currentBeforeDiscard.current,
      previous: currentBeforeDiscard.previous,
      candidate: null,
    });
    expect(driver.discardCount).toBe(1);
    expect(driver.activateCount).toBe(2);
  });

  it('rejects stale candidate identity and configuration guards without driver I/O', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    const staged = await stage(coordinator);
    const request = discardRequest(staged);
    const before = await coordinator.get('installation-1');

    await expect(coordinator.discardCandidate({ ...request, candidateDigest: 'f'.repeat(64) })).rejects.toThrow(PluginArtifactError);
    await expect(coordinator.discardCandidate({ ...request, stagingOperationId: 'stale-stage-operation' })).rejects.toThrow(PluginArtifactError);
    await expect(coordinator.discardCandidate({ ...request, configurationRevision: 'cfg-2' })).rejects.toThrow(PluginArtifactError);

    expect(await coordinator.get('installation-1')).toEqual(before);
    expect(driver.discardCount).toBe(0);
    expect(driver.activateCount).toBe(0);
  });

  it('persists discard intent before calling the driver', async () => {
    const driver = new FakeDriver();
    let releaseDiscard!: () => void;
    let signalDiscard!: () => void;
    driver.discardGate = new Promise<void>(resolve => { releaseDiscard = resolve; });
    const discardEntered = new Promise<void>(resolve => { signalDiscard = resolve; });
    driver.onDiscardEntered = signalDiscard;
    const { coordinator } = createCoordinator({ driver });
    await initialize(coordinator);
    const staged = await stage(coordinator);

    const discard = coordinator.discardCandidate(discardRequest(staged));
    await discardEntered;
    const persisted = await coordinator.get('installation-1');
    expect(persisted.status).toBe('discarding');
    expect(persisted.candidate).toMatchObject({ releaseDigest: candidateDigest(staged), staged: true });

    releaseDiscard();
    await expect(discard).resolves.toMatchObject({ status: 'empty', candidate: null });
  });

  it('fences an activation that races candidate cancellation with the original store CAS', async () => {
    let blockNextAuthorityRead = false;
    let releaseAuthorityRead!: () => void;
    let signalAuthorityRead!: () => void;
    const authorityGate = new Promise<void>(resolve => { releaseAuthorityRead = resolve; });
    const authorityEntered = new Promise<void>(resolve => { signalAuthorityRead = resolve; });
    const { coordinator, driver, config } = createCoordinator({
      getConfigurationRevision: async () => {
        if (blockNextAuthorityRead) {
          blockNextAuthorityRead = false;
          signalAuthorityRead();
          await authorityGate;
        }
        return config.revision;
      },
    });
    await initialize(coordinator);
    const staged = await stage(coordinator);
    blockNextAuthorityRead = true;
    const activation = activate(coordinator, candidateDigest(staged));
    await authorityEntered;

    const discarded = await coordinator.discardCandidate(discardRequest(staged));
    expect(discarded.status).toBe('empty');
    releaseAuthorityRead();
    await expect(activation).rejects.toThrow(PluginArtifactError);
    expect((await coordinator.get('installation-1')).status).toBe('empty');
    expect(driver.activateCount).toBe(0);
    expect(driver.discardCount).toBe(1);
  });

  it('reconciles a lost discard reply after restart and changed config without restoring a revoked candidate', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    const store = new MemoryJsonStore(`artifact-discard-restart-${String(Math.random())}`);
    const initial = createCoordinator({ driver, store, isTrusted: () => trusted });
    await initialize(initial.coordinator);
    const staged = await stage(initial.coordinator);
    const request = discardRequest(staged);
    const stageOperationId = request.stagingOperationId;
    trusted = false;
    driver.nextDiscardErrorAfterCleanup = new Error('delete committed but reply was lost');

    await expect(activate(initial.coordinator, candidateDigest(staged))).rejects.toThrow(PluginArtifactError);
    const pending = await initial.coordinator.get('installation-1');
    expect(pending.status).toBe('discard-unknown');
    expect(pending.candidate).toMatchObject({ releaseDigest: request.candidateDigest, stagingOperationId: stageOperationId, staged: true });
    expect(driver.discardCount).toBe(1);

    trusted = true;
    initial.config.revision = 'cfg-2';
    const restarted = createCoordinator({ driver, store, config: initial.config, isTrusted: () => trusted });
    await expect(activate(restarted.coordinator, candidateDigest(staged))).rejects.toThrow(PluginArtifactError);
    await expect(restarted.coordinator.synchronizeConfigurationRevision({
      installationId: 'installation-1',
      expectedRevision: 'cfg-1',
      approvedConfigurationRevision: 'cfg-2',
      configurationCompatible: true,
    })).rejects.toThrow(PluginArtifactError);

    const reconciled = await restarted.coordinator.reconcile('installation-1');
    expect(reconciled.outcome).toBe('resolved');
    expect(reconciled.state).toMatchObject({ status: 'empty', current: null, previous: null, candidate: null });
    expect(driver.discardCount).toBe(2);
    expect(driver.discardedOperationIds).toEqual([stageOperationId, stageOperationId]);
    expect(driver.activateCount).toBe(0);
  });

  it('keeps discard unknown when reconciliation sees an active or foreign deployment', async () => {
    const { coordinator, driver } = createCoordinator();
    await initialize(coordinator);
    const staged = await stage(coordinator);
    const request = discardRequest(staged);
    driver.nextDiscardError = new Error('delete outcome is unknown');
    const pending = await coordinator.discardCandidate(request);
    expect(pending.status).toBe('discard-unknown');
    expect(driver.discardCount).toBe(1);

    driver.activeDeploymentId = driver.operationStage(request.stagingOperationId);
    const activeMismatch = await coordinator.reconcile('installation-1');
    expect(activeMismatch.outcome).toBe('unknown');
    expect(activeMismatch.state.status).toBe('discard-unknown');
    expect(driver.discardCount).toBe(1);

    driver.activeDeploymentId = 'foreign-deployment';
    const foreignActive = await coordinator.reconcile('installation-1');
    expect(foreignActive.outcome).toBe('unknown');
    expect(foreignActive.state.status).toBe('discard-unknown');
    expect(driver.discardCount).toBe(1);

    driver.activeDeploymentId = null;
    driver.setOperationStage(request.stagingOperationId, 'foreign-staged-deployment');
    const foreignStage = await coordinator.reconcile('installation-1');
    expect(foreignStage.outcome).toBe('unknown');
    expect(foreignStage.state.status).toBe('discard-unknown');
    expect(foreignStage.state.candidate?.releaseDigest).toBe(request.candidateDigest);
    expect(driver.discardCount).toBe(1);
  });

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
    expect(result.state.status).toBe('discard-unknown');
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

  it.each(['trust revoked', 'publisher approval revoked', 'health failed', 'configuration changed'] as const)(
    'adopts and discards a positively observed post-create stage when %s',
    async condition => {
      let trusted = true;
      let publisherApproved = true;
      const driver = new FakeDriver();
      driver.nextStageError = new Error('stage reply was lost after create');
      driver.nextStageErrorAfterCreate = true;
      const { coordinator, config } = createCoordinator({
        driver,
        isTrusted: () => trusted,
        resolvePublisher: publisherId => publisherApproved ? resolvePublisher(publisherId) : undefined,
      });
      await initialize(coordinator);

      const staged = await stage(coordinator);
      expect(staged.outcome).toBe('stage-unknown');
      expect(staged.state.candidate?.staged).toBe(false);
      const operationId = staged.operationId;
      const observedId = driver.operationStage(operationId);
      expect(observedId).toBe('deployment-1');

      if (condition === 'trust revoked') trusted = false;
      if (condition === 'publisher approval revoked') publisherApproved = false;
      if (condition === 'health failed') driver.healthy = false;
      if (condition === 'configuration changed') config.revision = 'cfg-2';

      const reconciled = await coordinator.reconcile('installation-1');
      expect(reconciled.outcome).toBe('resolved');
      expect(reconciled.state).toMatchObject({ status: 'empty', candidate: null, current: null });
      expect(driver.discardCount).toBe(1);
      expect(driver.discardedOperationIds).toEqual([operationId]);
      expect(driver.operationStage(operationId)).toBeNull();
    },
  );

  it('keeps an unobserved stage pending so a later create can still be reconciled', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    driver.nextStageError = new Error('stage outcome is unknown before create');
    const { coordinator } = createCoordinator({ driver, isTrusted: () => trusted });
    await initialize(coordinator);

    const staged = await stage(coordinator);
    expect(staged.outcome).toBe('stage-unknown');
    const firstObservation = await coordinator.reconcile('installation-1');
    expect(firstObservation.outcome).toBe('unknown');
    expect(firstObservation.state.status).toBe('stage-unknown');
    expect(firstObservation.state.candidate?.staged).toBe(false);
    expect(driver.discardCount).toBe(0);

    trusted = false;
    driver.setOperationStage(staged.operationId, 'deployment-late');
    const lateObservation = await coordinator.reconcile('installation-1');
    expect(lateObservation.outcome).toBe('resolved');
    expect(lateObservation.state).toMatchObject({ status: 'empty', candidate: null });
    expect(driver.discardedOperationIds).toEqual([staged.operationId]);
  });

  it('persists adopted cleanup across restart and resolves a lost delete reply after config drift', async () => {
    let trusted = true;
    const driver = new FakeDriver();
    const store = new MemoryJsonStore(`artifact-adopted-discard-restart-${String(Math.random())}`);
    driver.nextStageError = new Error('stage reply was lost after create');
    driver.nextStageErrorAfterCreate = true;
    const initial = createCoordinator({ driver, store, isTrusted: () => trusted });
    await initialize(initial.coordinator);
    const staged = await stage(initial.coordinator);
    trusted = false;
    driver.nextDiscardErrorAfterCleanup = new Error('delete committed but reply was lost');

    const firstReconcile = await initial.coordinator.reconcile('installation-1');
    expect(firstReconcile.outcome).toBe('unknown');
    expect(firstReconcile.state.status).toBe('discard-unknown');
    expect(firstReconcile.state.candidate).toMatchObject({ staged: true, stagingOperationId: staged.operationId });
    expect(driver.discardCount).toBe(1);

    initial.config.revision = 'cfg-2';
    trusted = true;
    const restarted = createCoordinator({ driver, store, config: initial.config, isTrusted: () => trusted });
    const reconciled = await restarted.coordinator.reconcile('installation-1');
    expect(reconciled.outcome).toBe('resolved');
    expect(reconciled.state).toMatchObject({ status: 'empty', candidate: null, configurationRevision: 'cfg-1' });
    expect(driver.discardCount).toBe(2);
    expect(driver.discardedOperationIds).toEqual([staged.operationId, staged.operationId]);
  });

  it('does not adopt a stage observation that is active or conflicts with the stored stage ID', async () => {
    let trusted = true;
    const activeDriver = new FakeDriver();
    activeDriver.nextStageError = new Error('stage reply was lost after create');
    activeDriver.nextStageErrorAfterCreate = true;
    const active = createCoordinator({ driver: activeDriver, isTrusted: () => trusted });
    await initialize(active.coordinator);
    const unknownStage = await stage(active.coordinator);
    trusted = false;
    activeDriver.activeDeploymentId = 'foreign-active-deployment';
    const activeResult = await active.coordinator.reconcile('installation-1');
    expect(activeResult.outcome).toBe('unknown');
    expect(activeResult.state.status).toBe('stage-unknown');
    expect(activeDriver.discardCount).toBe(0);

    const foreignDriver = new FakeDriver();
    foreignDriver.nextCheckError = new Error('health result unavailable');
    const foreign = createCoordinator({ driver: foreignDriver, isTrusted: () => trusted });
    await initialize(foreign.coordinator);
    trusted = true;
    const storedStage = await stage(foreign.coordinator);
    trusted = false;
    const storedId = foreignDriver.operationStage(storedStage.operationId);
    expect(storedId).not.toBeNull();
    foreignDriver.setOperationStage(storedStage.operationId, 'foreign-staged-deployment');
    const foreignResult = await foreign.coordinator.reconcile('installation-1');
    expect(foreignResult.outcome).toBe('unknown');
    expect(foreignResult.state.status).toBe('stage-unknown');
    expect(foreignDriver.discardCount).toBe(0);
    expect(foreignDriver.operationStage(storedStage.operationId)).toBe('foreign-staged-deployment');
    expect(unknownStage.state.candidate?.staged).toBe(false);
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
