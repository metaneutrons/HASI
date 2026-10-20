import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { digest, type PluginManifest } from '@hasi/plugin-sdk';
import { managedPluginCommandResultSchema, type ManagedPluginCommand } from '@hasi/plugin-sdk/deployment-admin';
import { ManagedPluginInstaller, type ManagedPluginInstallerOptions } from '../apps/api/src/managed-plugin-installer.js';
import { DeploymentDriverError, pluginReleaseSigningBytes, type DeploymentDriver, type UnsignedPluginRelease } from '../apps/api/src/plugin-artifacts.js';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const manifest = (version = '1.0.0', pluginId = 'reference'): PluginManifest => ({ manifestVersion: 2, id: pluginId, version, name: pluginId, description: 'Synthetic', apiVersion: '2.0.0', mcpVersion: '2026-07-28', tools: [{ name: `${pluginId}.read`, title: 'Read', description: 'Synthetic read', effect: 'read', requiredPermissions: ['read'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] });
function release(id: string, version: string, configSchemaVersion = 1, pluginId = 'reference', publisherId = 'publisher', signingKey = keys.privateKey) {
  const m = manifest(version, pluginId);
  const unsigned: UnsignedPluginRelease = { schemaVersion: 1, pluginId: m.id, version, manifestDigest: digest(m), publisherId, image: `registry.example.test/hasi/${pluginId}@sha256:${id.repeat(64)}`, configSchemaVersion, stateMigration: 'none' };
  return { id, manifest: m, envelope: { ...unsigned, signature: sign(null, pluginReleaseSigningBytes(unsigned), signingKey).toString('base64url') }, launch: { network: { mode: 'none' as const } }, secretAssignments: [], license: 'GPL-3.0-only', inventoryDigest: 'c'.repeat(64) };
}
async function fixture(store: JsonStore = new MemoryJsonStore('installer-test')) {
  const active = new Map<string, string>();
  let sequence = 0;
  let admin = true;
  let publisherRevoked = false;
  let publisherAvailable = true;
  const stages = new Map<string, string>();
  const stage = vi.fn<DeploymentDriver['stage']>(input => {
    const deploymentId = `deployment-${String(++sequence)}`;
    stages.set(input.operationId, deploymentId);
    return Promise.resolve({ deploymentId });
  });
  const check = vi.fn<DeploymentDriver['check']>(() => Promise.resolve(true));
  const discard = vi.fn<DeploymentDriver['discard']>(() => Promise.resolve());
  const activate = vi.fn<DeploymentDriver['activate']>(input => {
    active.set(input.installationId, input.candidateDeploymentId);
    return Promise.resolve();
  });
  const rollback = vi.fn<DeploymentDriver['rollback']>(input => {
    if (input.previousDeploymentId) active.set(input.installationId, input.previousDeploymentId);
    else active.delete(input.installationId);
    return Promise.resolve();
  });
  const reconcile = vi.fn<DeploymentDriver['reconcile']>(input => Promise.resolve({
    activeDeploymentId: active.get(input.installationId) ?? null,
    stagedDeploymentId: stages.get(input.operationId) ?? null,
    routeOperationOutcome: 'unknown',
  }));
  const driver: DeploymentDriver = {
    stage, check, discard, activate, rollback, reconcile,
  };
  const catalog = [
    { id: 'installation', label: 'Synthetic reference', pluginId: 'reference', configurationSchemaVersion: 1, releases: [release('a', '1.0.0'), release('b', '1.1.0')], restorePlans: [] as string[] },
    { id: 'other-installation', label: 'Independent plugin', pluginId: 'other', configurationSchemaVersion: 1, releases: [release('d', '1.0.0', 1, 'other', 'other-publisher', otherKeys.privateKey)], restorePlans: [] as string[] },
  ];
  const preflight = vi.fn<ManagedPluginInstallerOptions['preflight']>(() => Promise.resolve(true));
  const synchronizeRoute = vi.fn<ManagedPluginInstallerOptions['synchronizeRoute']>(() => Promise.resolve());
  const create = () => new ManagedPluginInstaller({ store, scope: 'test', privateKey: keys.privateKey, driver, readCatalog: () => Promise.resolve(catalog),
    resolvePublisher: id => id === 'publisher'
      ? publisherAvailable ? { publisherId: id, publicKey: keys.publicKey, sourceRegistryPrefix: 'registry.example.test/hasi', allowedPluginIds: ['reference'], revoked: publisherRevoked } : undefined
      : id === 'other-publisher' ? { publisherId: id, publicKey: otherKeys.publicKey, sourceRegistryPrefix: 'registry.example.test/hasi', allowedPluginIds: ['other'] } : undefined,
    authorizeAdmin: subject => Promise.resolve(admin && subject === 'admin'), secretsAuthorized: () => Promise.resolve(true), secretReady: () => true, preflight, synchronizeRoute });
  const service = create(); await service.initialize();
  const view = async (id = 'installation', current = service) => (await current.list('admin')).installations.find(item => item.id === id)!;
  const command = async (operation: ManagedPluginCommand['operation'], extra: object = {}, current = service, id = 'installation') => current.command(id, { commandId: randomUUID(), expectedState: (await view(id, current)).stateToken, operation, ...extra } as ManagedPluginCommand, 'admin');
  return { service, create, view, command, driver, stage, check, discard, activate, rollback, reconcile, preflight, synchronizeRoute, catalog, store, stages, activeRoute: (id: string) => active.get(id) ?? null,
    revoke: () => { admin = false; }, revokePublisher: () => { publisherRevoked = true; }, removePublisher: () => { publisherAvailable = false; } };
}

describe('trusted managed installer', () => {
  it('requires staged manifest preflight and explicit fresh review before activation, then supports update and rollback', async () => {
    const f = await fixture();
    expect((await f.command('stage', { releaseId: 'a' })).view.status).toBe('review-required');
    expect((await f.command('activate')).status).toBe('uncertain');
    expect(f.activate).not.toHaveBeenCalled();
    expect((await f.command('approve')).view.status).toBe('candidate-ready');
    expect((await f.command('activate')).view.current?.version).toBe('1.0.0');
    await f.command('stage', { releaseId: 'b' }); await f.command('approve');
    expect((await f.command('activate')).view.current?.version).toBe('1.1.0');
    expect((await f.command('rollback')).view.current?.version).toBe('1.0.0');
    expect(f.preflight).toHaveBeenCalledTimes(5);
  });
  it('reuses an existing command result after process reconstruction without redispatch', async () => {
    const f = await fixture();
    const input = { operation: 'stage' as const, releaseId: 'a', commandId: randomUUID(), expectedState: (await f.view()).stateToken };
    const first = await f.service.command('installation', input, 'admin');
    const restart = f.create(); await restart.initialize();
    expect(await restart.command('installation', input, 'admin')).toEqual(first);
    expect(f.stage).toHaveBeenCalledTimes(1);
    await expect(restart.command('installation', { ...input, releaseId: 'b' }, 'admin')).rejects.toThrow();
  });
  it('does not redispatch when the intent committed but its acknowledgement was lost', async () => {
    const memory = new MemoryJsonStore('lost-intent'); let lose = true;
    const store: JsonStore = { read: key => memory.read(key), delete: key => memory.delete(key), compareAndSet: async (key, revision, value, expires) => {
      const result = await memory.compareAndSet(key, revision, value, expires);
      if (result && lose && key.endsWith(':intent')) { lose = false; throw new Error('lost acknowledgement'); }
      return result;
    } };
    const f = await fixture(store);
    const input = { operation: 'stage' as const, releaseId: 'a', commandId: randomUUID(), expectedState: (await f.view()).stateToken };
    await expect(f.service.command('installation', input, 'admin')).rejects.toThrow();
    expect((await f.create().command('installation', input, 'admin')).status).toBe('uncertain');
    expect(f.stage).not.toHaveBeenCalled();
  });
  it('preserves uncertain stage outcomes and never turns replay into another create', async () => {
    const f = await fixture();
    f.stage.mockRejectedValue(new DeploymentDriverError('unknown'));
    const input = { operation: 'stage' as const, releaseId: 'a', commandId: randomUUID(), expectedState: (await f.view()).stateToken };
    const result = await f.service.command('installation', input, 'admin');
    expect(result.status).toBe('uncertain'); expect(result.view.status).toBe('stage-unknown');
    expect((await f.service.command('installation', input, 'admin')).status).toBe('uncertain');
    expect(f.stage).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown command audit uncertain after a separate reconcile command resolves state', async () => {
    const f = await fixture();
    f.stage.mockImplementation(input => {
      f.stages.set(input.operationId, 'deployment-recovered');
      return Promise.reject(new DeploymentDriverError('unknown'));
    });
    const stageCommand = {
      operation: 'stage' as const,
      releaseId: 'a',
      commandId: randomUUID(),
      expectedState: (await f.view()).stateToken,
    };

    const originalResult = await f.service.command('installation', stageCommand, 'admin');
    expect(originalResult.status).toBe('uncertain');
    expect(originalResult.view.status).toBe('stage-unknown');

    const recovery = await f.command('reconcile');
    expect(recovery.status).toBe('completed');
    expect(recovery.view.status).toBe('review-required');

    const originalAudit = await f.service.commandStatus('installation', stageCommand.commandId, 'admin');
    expect(originalAudit.status).toBe('uncertain');
    expect(originalAudit.view.status).toBe('review-required');
    expect(f.stage).toHaveBeenCalledTimes(1);
  });
  it('does not report a failed or unresolved candidate cleanup as completed', async () => {
    const f = await fixture();
    await f.command('stage', { releaseId: 'a' });
    await f.command('approve');
    f.discard.mockRejectedValue(new DeploymentDriverError('unknown'));

    const result = await f.command('cancel');

    expect(result.status).toBe('uncertain');
    expect(result.view.status).toBe('discard-unknown');
    expect(result.view.candidate).not.toBeNull();
    expect(managedPluginCommandResultSchema.parse(result)).toEqual(result);
    expect(f.discard).toHaveBeenCalledTimes(1);
  });
  it('rejects a signed completion copied from another command key', async () => {
    const f = await fixture();
    const completedCommand = {
      operation: 'stage' as const,
      releaseId: 'a',
      commandId: randomUUID(),
      expectedState: (await f.view()).stateToken,
    };
    await f.service.command('installation', completedCommand, 'admin');

    f.preflight.mockResolvedValue(false);
    const uncertainCommand = {
      operation: 'approve' as const,
      commandId: randomUUID(),
      expectedState: (await f.view()).stateToken,
    };
    await expect(f.service.command('installation', uncertainCommand, 'admin')).resolves.toMatchObject({ status: 'uncertain' });

    const prefix = `managed-plugin-command:v1:${digest('test')}:`;
    const completionKey = (commandId: string) => `${prefix}${digest(['installation', commandId])}:completion`;
    const completedRecord = await f.store.read(completionKey(completedCommand.commandId));
    expect(completedRecord).toBeDefined();
    await f.store.delete(completionKey(uncertainCommand.commandId));
    if (!completedRecord) throw new Error('Expected a persisted signed completion.');
    expect(await f.store.compareAndSet(completionKey(uncertainCommand.commandId), null, completedRecord.value)).toBe(true);

    await expect(f.service.commandStatus('installation', uncertainCommand.commandId, 'admin')).rejects.toThrow();
  });
  it('rejects stale state and arbitrary image/secret/actor additions before dispatch', async () => {
    const f = await fixture();
    await expect(f.service.command('installation', { operation: 'stage', releaseId: 'a', commandId: randomUUID(), expectedState: '0'.repeat(64) }, 'admin')).rejects.toThrow();
    const input = { operation: 'stage', releaseId: 'a', commandId: randomUUID(), expectedState: (await f.view()).stateToken, image: 'unapproved', subject: 'admin' } as unknown as ManagedPluginCommand;
    await expect(f.service.command('installation', input, 'admin')).rejects.toThrow();
    expect(f.stage).not.toHaveBeenCalled();
  });
  it('blocks approval/activation on failed manifest preflight and rechecks reviewer authority', async () => {
    const f = await fixture(); await f.command('stage', { releaseId: 'a' });
    f.preflight.mockResolvedValue(false);
    expect((await f.command('approve')).status).toBe('uncertain');
    expect((await f.view()).status).toBe('review-required');
    f.preflight.mockResolvedValue(true); await f.command('approve'); f.revoke();
    await expect(f.command('activate')).rejects.toThrow();
    expect(f.activate).not.toHaveBeenCalled();
  });
  it('does not approve a replacement candidate staged during preflight', async () => {
    const f = await fixture();
    await f.command('stage', { releaseId: 'a' });
    const original = await f.service.coordinator.get('installation');
    const originalCandidate = original.candidate;
    if (!originalCandidate?.stagingOperationId) throw new Error('Expected a staged candidate.');

    f.preflight.mockImplementation(async ({ snapshot }) => {
      const candidate = snapshot.candidate;
      if (!candidate?.stagingOperationId) throw new Error('Expected the preflight candidate to be staged.');
      await f.service.coordinator.discardCandidate({
        installationId: 'installation',
        candidateDigest: candidate.releaseDigest,
        stagingOperationId: candidate.stagingOperationId,
        configurationRevision: snapshot.configurationRevision,
      });
      const replacement = f.catalog[0]!.releases[0]!;
      const staged = await f.service.coordinator.stageCandidate({
        installationId: 'installation',
        baseCurrentDigest: null,
        release: replacement.envelope,
        configurationRevision: snapshot.configurationRevision,
        configurationCompatible: true,
        effectsExpanded: true,
        permissionsExpanded: true,
        secretAssignments: replacement.secretAssignments,
        launch: replacement.launch,
      });
      expect(staged.outcome).toBe('review-required');
      return true;
    });

    const result = await f.command('approve');
    const after = await f.service.coordinator.get('installation');

    expect(result.status).toBe('uncertain');
    expect(result.view.status).toBe('review-required');
    expect(after.candidate?.releaseDigest).toBe(originalCandidate.releaseDigest);
    expect(after.candidate?.stagingOperationId).not.toBe(originalCandidate.stagingOperationId);
  });
  it('does not synchronize route authority while a candidate is staged', async () => {
    const f = await fixture();
    await f.command('stage', { releaseId: 'a' });

    const result = await f.command('synchronize');

    expect(result.status).toBe('uncertain');
    expect(result.view.status).toBe('review-required');
    expect(f.synchronizeRoute).not.toHaveBeenCalled();
  });
  it('keeps cancellation pinned and does not erase a retained current release', async () => {
    const f = await fixture(); await f.command('stage', { releaseId: 'a' }); await f.command('approve'); await f.command('activate');
    await f.command('stage', { releaseId: 'b' });
    const result = await f.command('cancel');
    expect(result.status).toBe('completed'); expect(result.view.current?.version).toBe('1.0.0'); expect(result.view.candidate).toBeNull(); expect(f.discard).toHaveBeenCalledTimes(1);
  });
  it('keeps revoked or removed publisher installations visible, blocks execution, and permits exact cleanup', async () => {
    const f = await fixture();
    await f.command('stage', { releaseId: 'a' });
    await f.command('approve');
    await f.command('activate');
    const retainedActive = await f.service.coordinator.get('installation');
    const retainedCurrentDigest = retainedActive.current?.releaseDigest;
    const activeRoute = f.activeRoute('installation');
    if (!retainedCurrentDigest || !activeRoute) throw new Error('Expected an active first installation.');

    await f.command('stage', { releaseId: 'b' });
    await f.command('stage', { releaseId: 'd' }, f.service, 'other-installation');
    await f.command('approve', {}, f.service, 'other-installation');
    await f.command('activate', {}, f.service, 'other-installation');
    const activationCount = f.activate.mock.calls.length;

    f.revokePublisher();
    const revokedList = await f.service.list('admin');
    expect(revokedList.installations).toHaveLength(2);
    expect(revokedList.installations[0]).toMatchObject({
      id: 'installation',
      status: 'review-required',
      configurationReady: false,
      candidate: { version: '1.1.0', approved: false },
      releases: [],
    });
    expect(revokedList.installations[1]).toMatchObject({
      id: 'other-installation',
      status: 'active',
      current: { approved: true },
      releases: [{ approved: true }],
    });

    const approval = await f.command('approve');
    expect(approval.status).toBe('uncertain');
    const activation = await f.command('activate');
    expect(activation.status).toBe('uncertain');
    expect(f.activate).toHaveBeenCalledTimes(activationCount);

    // Once the trust record is unavailable, explicit cleanup must still work
    // from the retained signed candidate identity without admitting execution.
    f.removePublisher();
    const cancelled = await f.command('cancel');
    expect(cancelled.status).toBe('completed');
    expect(cancelled.view.candidate).toBeNull();
    expect(cancelled.view.current?.approved).toBe(false);
    expect(f.discard).toHaveBeenCalledTimes(1);

    const restarted = f.create();
    await restarted.initialize();
    const afterRestart = await restarted.coordinator.get('installation');
    expect(afterRestart.current?.releaseDigest).toBe(retainedCurrentDigest);
    expect(f.activeRoute('installation')).toBe(activeRoute);
    expect(f.activate).toHaveBeenCalledTimes(activationCount);
    expect((await f.view('other-installation', restarted)).current?.approved).toBe(true);
  });
  it('rejects a tampered operator manifest and missing selected release', async () => {
    const f = await fixture();
    expect((await f.command('stage', { releaseId: 'missing' })).status).toBe('uncertain');
    f.catalog[0]!.releases[0]!.manifest.name = 'tampered';
    await expect(f.service.list('admin')).rejects.toThrow();
    expect(f.stage).not.toHaveBeenCalled();
  });
  it('keeps the active release usable when a signed candidate changes the managed state contract', async () => {
    const f = await fixture();
    await f.command('stage', { releaseId: 'a' }); await f.command('approve'); await f.command('activate');
    const active = f.activeRoute('installation');
    const original = structuredClone(f.catalog[0]!.releases[1]!);
    const candidate = f.catalog[0]!.releases[1]!;
    if (candidate.manifest.manifestVersion !== 2) throw new Error('Expected v2 fixture');
    candidate.manifest.mcpVersion = '2025-11-25';
    candidate.manifest.managedState = { schemaVersion: 1, accountIdentity: { kind: 'subject' }, applicationSchema: { type: 'object', properties: {}, additionalProperties: false } };
    candidate.envelope.manifestDigest = digest(candidate.manifest);
    const unsigned = { ...candidate.envelope } as Partial<typeof candidate.envelope>;
    delete unsigned.signature;
    candidate.envelope.signature = sign(null, pluginReleaseSigningBytes(unsigned), keys.privateKey).toString('base64url');
    const blocked = await f.command('stage', { releaseId: 'b' });
    expect(blocked.status).toBe('uncertain');
    expect(blocked.view.current?.version).toBe('1.0.0');
    expect(blocked.view.status).toBe('active');
    expect(f.activeRoute('installation')).toBe(active);
    expect(f.stage).toHaveBeenCalledTimes(1);
    f.catalog[0]!.releases[1] = original;
    expect((await f.command('stage', { releaseId: 'b' })).view.status).toBe('review-required');
    expect(f.stage).toHaveBeenCalledTimes(2);
  });
  it('rejects a catalog release with a configuration schema version outside the installation contract', async () => {
    const f = await fixture();
    f.catalog[0]!.releases[1] = release('b', '1.1.0', 2);

    const result = await f.command('stage', { releaseId: 'b' });

    expect(result.status).toBe('uncertain');
    expect(result.view.status).toBe('empty');
    expect(f.stage).not.toHaveBeenCalled();
  });
});
