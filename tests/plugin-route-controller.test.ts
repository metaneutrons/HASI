import { MemoryJsonStore } from '@hasi/state';
import { describe, expect, it } from 'vitest';
import { MAX_PLUGIN_ROUTE_OPERATIONS_PER_INSTALLATION, PluginRouteController, PluginRouteControllerError } from '../apps/api/src/plugin-route-controller.js';

const OWNER = 'operator-1';
const INSTALLATION = 'installation-1';
const CONFIG = 'configuration-revision-1';
const OLD_DIGEST = 'a'.repeat(64);
const NEXT_DIGEST = 'b'.repeat(64);
const THIRD_DIGEST = 'c'.repeat(64);

function controllers(store = new MemoryJsonStore(`plugin-route-${String(Math.random())}`)) {
  const options = { store, scope: 'operator-scope', ownerId: OWNER } as const;
  return { store, first: new PluginRouteController(options), second: new PluginRouteController(options) };
}

function activation(overrides: Partial<Parameters<PluginRouteController['activate']>[0]> = {}) {
  return {
    ownerId: OWNER,
    installationId: INSTALLATION,
    operationId: 'activate-1',
    candidateDeploymentId: 'container-candidate-1',
    candidateReleaseDigest: NEXT_DIGEST,
    previousDeploymentId: null,
    baseCurrentDigest: null,
    configurationRevision: CONFIG,
    ...overrides,
  };
}

function withdrawal(overrides: Partial<Parameters<PluginRouteController['withdraw']>[0]> = {}) {
  return {
    ownerId: OWNER,
    installationId: INSTALLATION,
    operationId: 'withdraw-1',
    currentDeploymentId: 'container-current',
    currentReleaseDigest: OLD_DIGEST,
    configurationRevision: CONFIG,
    ...overrides,
  };
}

describe('durable plugin route controller', () => {
  it('shares an atomic route and terminal operation journal across controller instances', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({ installationId: INSTALLATION, configurationRevision: CONFIG });

    await first.activate(activation());
    expect(await second.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-candidate-1');
    expect(await second.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: 'activate-1' })).toBe('committed');

    const secondActivation = activation({
      operationId: 'activate-2',
      candidateDeploymentId: 'container-candidate-2',
      candidateReleaseDigest: THIRD_DIGEST,
      previousDeploymentId: 'container-candidate-1',
      baseCurrentDigest: NEXT_DIGEST,
    });
    await second.activate(secondActivation);

    // A retry after a later route change resolves from the durable journal and
    // cannot move traffic back to the earlier deployment.
    await first.activate(activation());
    expect(await first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-candidate-2');
  });

  it('fences concurrent activation attempts from the same base revision', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({ installationId: INSTALLATION, configurationRevision: CONFIG });
    const left = activation({ operationId: 'activate-left', candidateDeploymentId: 'container-left', candidateReleaseDigest: NEXT_DIGEST });
    const right = activation({ operationId: 'activate-right', candidateDeploymentId: 'container-right', candidateReleaseDigest: THIRD_DIGEST });

    const results = await Promise.allSettled([first.activate(left), second.activate(right)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const leftStatus = await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: left.operationId });
    const rightStatus = await second.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: right.operationId });
    expect([leftStatus, rightStatus].sort()).toEqual(['committed', 'not-committed']);
    const active = await first.read({ ownerId: OWNER, installationId: INSTALLATION });
    expect(active.active?.deploymentId).toBe(leftStatus === 'committed' ? left.candidateDeploymentId : right.candidateDeploymentId);
  });

  it('retains a terminal rejection and fences stale configuration revisions', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({ installationId: INSTALLATION, configurationRevision: CONFIG });
    await first.updateConfigurationRevision({
      ownerId: OWNER,
      installationId: INSTALLATION,
      expectedRevision: CONFIG,
      configurationRevision: 'configuration-revision-2',
    });

    const stale = activation({ operationId: 'activate-stale' });
    await expect(second.activate(stale)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: stale.operationId })).toBe('not-committed');
    await expect(first.activate(activation({ ...stale, configurationRevision: 'configuration-revision-2' }))).rejects.toBeInstanceOf(PluginRouteControllerError);
    expect(await second.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBeNull();
  });

  it('restores a retained route only when both deployment and digest pins match', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({
      installationId: INSTALLATION,
      configurationRevision: CONFIG,
      activeDeploymentId: 'container-old',
      activeReleaseDigest: OLD_DIGEST,
    });
    await first.activate(activation({
      operationId: 'activate-new',
      candidateDeploymentId: 'container-new',
      candidateReleaseDigest: NEXT_DIGEST,
      previousDeploymentId: 'container-old',
      baseCurrentDigest: OLD_DIGEST,
    }));

    const rollback = {
      ownerId: OWNER,
      installationId: INSTALLATION,
      operationId: 'rollback-new',
      currentDeploymentId: 'container-new',
      currentReleaseDigest: NEXT_DIGEST,
      previousDeploymentId: 'container-old',
      previousReleaseDigest: OLD_DIGEST,
      baseCurrentDigest: NEXT_DIGEST,
      configurationRevision: CONFIG,
    } as const;
    const staleRollback = { ...rollback, operationId: 'rollback-stale', currentDeploymentId: 'container-stale' };
    await expect(second.rollback(staleRollback)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: staleRollback.operationId })).toBe('not-committed');

    await second.rollback(rollback);
    expect(await first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-old');
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: rollback.operationId })).toBe('committed');
  });

  it('withdraws only the exact active deployment and keeps the committed operation idempotent', async () => {
    const { first } = controllers();
    await first.initializeInstallation({
      installationId: INSTALLATION,
      configurationRevision: CONFIG,
      activeDeploymentId: 'container-current',
      activeReleaseDigest: OLD_DIGEST,
    });
    const operation = withdrawal();

    await first.withdraw(operation);
    expect((await first.read({ ownerId: OWNER, installationId: INSTALLATION })).active).toBeNull();
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: operation.operationId })).toBe('committed');

    // A retry with the same operation is acknowledged, while payload reuse is fenced.
    await first.withdraw(operation);
    await expect(first.withdraw(withdrawal({ ...operation, currentReleaseDigest: NEXT_DIGEST })))
      .rejects.toMatchObject({ outcome: 'failed' });

    await first.activate(activation({
      operationId: 'activate-after-withdrawal',
      candidateDeploymentId: 'container-next',
      candidateReleaseDigest: NEXT_DIGEST,
    }));
    // A delayed retry cannot apply the old withdrawal to a later deployment.
    await first.withdraw(operation);
    expect(await first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-next');
  });

  it('records stale withdrawals as not committed and never clears another route', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({
      installationId: INSTALLATION,
      configurationRevision: CONFIG,
      activeDeploymentId: 'container-current',
      activeReleaseDigest: OLD_DIGEST,
    });
    const nextConfig = 'configuration-revision-2';
    await first.updateConfigurationRevision({
      ownerId: OWNER,
      installationId: INSTALLATION,
      expectedRevision: CONFIG,
      configurationRevision: nextConfig,
    });

    const staleConfiguration = withdrawal({ operationId: 'withdraw-stale-config' });
    await expect(first.withdraw(staleConfiguration)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: staleConfiguration.operationId })).toBe('not-committed');

    const wrongDeployment = withdrawal({
      operationId: 'withdraw-wrong-deployment',
      currentDeploymentId: 'container-other',
      configurationRevision: nextConfig,
    });
    await expect(second.withdraw(wrongDeployment)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: wrongDeployment.operationId })).toBe('not-committed');

    const wrongDigest = withdrawal({
      operationId: 'withdraw-wrong-digest',
      currentReleaseDigest: NEXT_DIGEST,
      configurationRevision: nextConfig,
    });
    await expect(first.withdraw(wrongDigest)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: wrongDigest.operationId })).toBe('not-committed');

    await expect(first.withdraw(withdrawal({ operationId: 'withdraw-wrong-owner', ownerId: 'operator-2' })))
      .rejects.toBeInstanceOf(PluginRouteControllerError);
    expect(await first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-current');

    await expect(first.withdraw(withdrawal({ operationId: 'withdraw-invalid-id', currentDeploymentId: 'bad id' })))
      .rejects.toMatchObject({ outcome: 'failed' });
    await expect(first.withdraw(withdrawal({ operationId: 'withdraw-invalid-digest', currentReleaseDigest: 'not-a-digest' })))
      .rejects.toMatchObject({ outcome: 'failed' });
    await expect(first.withdraw(withdrawal({ operationId: 'withdraw-invalid-revision', configurationRevision: '' })))
      .rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).toBe('container-current');
  });

  it('fences concurrent withdrawal and activation attempts from the same active route', async () => {
    const { first, second } = controllers();
    await first.initializeInstallation({
      installationId: INSTALLATION,
      configurationRevision: CONFIG,
      activeDeploymentId: 'container-current',
      activeReleaseDigest: OLD_DIGEST,
    });
    const withdraw = withdrawal({ operationId: 'withdraw-concurrent' });
    const activate = activation({
      operationId: 'activate-concurrent',
      candidateDeploymentId: 'container-next',
      candidateReleaseDigest: NEXT_DIGEST,
      previousDeploymentId: 'container-current',
      baseCurrentDigest: OLD_DIGEST,
    });

    const results = await Promise.allSettled([first.withdraw(withdraw), second.activate(activate)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const withdrawStatus = await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: withdraw.operationId });
    const activateStatus = await second.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: activate.operationId });
    expect([withdrawStatus, activateStatus].sort()).toEqual(['committed', 'not-committed']);
    const active = await first.read({ ownerId: OWNER, installationId: INSTALLATION });
    if (withdrawStatus === 'committed') expect(active.active).toBeNull();
    else expect(active.active?.deploymentId).toBe('container-next');
  });

  it('does not claim an absent installation is an empty route', async () => {
    const { first } = controllers();
    await expect(first.readActiveDeploymentId({ ownerId: OWNER, installationId: INSTALLATION })).rejects.toBeInstanceOf(PluginRouteControllerError);
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: 'unknown-operation' })).toBe('unknown');
  });

  it('fails closed at the finite journal limit without pruning terminal fences', async () => {
    const { first } = controllers();
    await first.initializeInstallation({ installationId: INSTALLATION, configurationRevision: CONFIG });
    for (let index = 0; index < MAX_PLUGIN_ROUTE_OPERATIONS_PER_INSTALLATION; index += 1) {
      const operation = activation({
        operationId: `route-op-${String(index)}`,
        configurationRevision: 'stale-configuration',
      });
      await expect(first.activate(operation)).rejects.toMatchObject({ outcome: 'failed' });
    }

    const exhausted = activation({ operationId: 'route-op-after-capacity' });
    await expect(first.activate(exhausted)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: 'route-op-0' })).toBe('not-committed');
    expect(await first.readOperationStatus({ ownerId: OWNER, installationId: INSTALLATION, operationId: exhausted.operationId })).toBe('unknown');
    expect((await first.read({ ownerId: OWNER, installationId: INSTALLATION })).active).toBeNull();
  });
});
