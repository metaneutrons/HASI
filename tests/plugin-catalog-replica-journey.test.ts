import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginServer, digest, type ActorContext, type PluginManifest } from '../packages/plugin-sdk/src/index.js';
import { MemoryJsonStore } from '../packages/state/src/index.js';
import { PluginRegistry } from '../apps/api/src/registry.js';

const keys = generateKeyPairSync('ed25519');
const pluginId = 'catalog-replica-fixture';
const serviceToken = 'synthetic-catalog-replica-service';
const actor: ActorContext = { subject: 'synthetic-user', permissions: ['fixture:read'] };
const servers: ReturnType<typeof createPluginServer>[] = [];
const registries: PluginRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('approved plugin catalog connections across registry replicas', () => {
  it('adopts a newly connected source during refresh and withdraws it after removal', async () => {
    const { registryA, registryB } = await fixture('plugin-catalog-replica-journey');

    await registryA.connectSource(pluginId);
    await registryB.refreshAll();

    expect(registryB.catalog()).toEqual([{ id: pluginId, label: 'Synthetic read fixture', connected: true }]);
    expect(registryB.list()).toMatchObject([{ id: pluginId, enabled: true, healthy: true, ready: true }]);
    expect((await registryB.authorizedModelTools(actor)).map(tool => [tool.pluginId, tool.name])).toEqual([[pluginId, 'fixture.read']]);
    await expect(registryB.invoke(pluginId, 'fixture.read', {}, actor)).resolves.toEqual({ value: 'synthetic read fixture' });

    await registryA.removeSource(pluginId);
    await registryB.refreshAll();

    expect(registryB.catalog()).toEqual([{ id: pluginId, label: 'Synthetic read fixture', connected: false }]);
    expect(registryB.list()).toEqual([]);
    expect(await registryB.authorizedModelTools(actor)).toEqual([]);
    await expect(registryB.invoke(pluginId, 'fixture.read', {}, actor)).rejects.toMatchObject({ status: 404 });
  });

  it('does not adopt a shared connection when the source is absent from the operator-approved catalog', async () => {
    const { registryA, registryB } = await fixture('plugin-catalog-replica-unapproved', { approveReplicaB: false });

    await registryA.connectSource(pluginId);
    await registryB.refreshAll();

    expect(registryB.catalog()).toEqual([]);
    expect(registryB.list()).toEqual([]);
    expect(await registryB.authorizedModelTools(actor)).toEqual([]);
    await expect(registryB.invoke(pluginId, 'fixture.read', {}, actor)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['wrong key', 'wrong scope', 'tampered connection'] as const)(
    'does not advertise tools for a %s connection record',
    async failure => {
      const scope = `plugin-catalog-replica-invalid-${failure.replaceAll(' ', '-')}`;
      const replicaBKey = failure === 'wrong key' ? generateKeyPairSync('ed25519').privateKey : undefined;
      const replicaBScope = failure === 'wrong scope' ? `${scope}-other` : scope;
      const { registryA, registryB, store } = await fixture(scope, { ...(replicaBKey ? { replicaBKey } : {}), replicaBScope });

      await registryA.connectSource(pluginId);

      if (failure === 'tampered connection') {
        const key = `plugin-connection:v1:${digest({ scope, id: pluginId })}`;
        const stored = await store.read(key);
        if (!stored) throw new Error('Missing signed synthetic connection record');
        expect(await store.compareAndSet(key, stored.revision, {
          value: { version: 1, scope, id: pluginId, connected: true },
          signature: 'tampered',
        })).toBe(true);
      }

      await registryB.refreshAll();

      expect(registryB.catalog()).toEqual([{ id: pluginId, label: 'Synthetic read fixture', connected: false }]);
      expect(registryB.list()).toEqual([]);
      expect(await registryB.authorizedModelTools(actor)).toEqual([]);
    },
  );

  it('adopts a signed connected source in disabled state without exposing tools', async () => {
    const { registryA, registryB } = await fixture('plugin-catalog-replica-disabled');

    await registryA.connectSource(pluginId);
    await registryA.setEnabled(pluginId, false);
    await registryB.refreshAll();

    expect(registryB.catalog()).toEqual([{ id: pluginId, label: 'Synthetic read fixture', connected: true }]);
    expect(registryB.list()).toMatchObject([{ id: pluginId, enabled: false, healthy: true, ready: true }]);
    expect(await registryB.authorizedModelTools(actor)).toEqual([]);
    await expect(registryB.invoke(pluginId, 'fixture.read', {}, actor)).rejects.toMatchObject({ status: 409 });
  });

  it('does not auto-connect an approved source on refresh when the registry has no JsonStore', async () => {
    const { registryB } = await fixture('plugin-catalog-replica-without-store', { replicaBUsesStore: false });

    await registryB.refreshAll();

    expect(registryB.catalog()).toEqual([{ id: pluginId, label: 'Synthetic read fixture', connected: false }]);
    expect(registryB.list()).toEqual([]);
    expect(await registryB.authorizedModelTools(actor)).toEqual([]);
    await expect(registryB.invoke(pluginId, 'fixture.read', {}, actor)).rejects.toMatchObject({ status: 404 });
  });
});

async function fixture(
  scope: string,
  options: { replicaBKey?: KeyObject; replicaBScope?: string; approveReplicaB?: boolean; replicaBUsesStore?: boolean } = {},
) {
  const pluginManifest: PluginManifest = {
    manifestVersion: 2,
    id: pluginId,
    name: 'Synthetic catalog replica fixture',
    description: 'Read-only generic fixture for replica reconciliation.',
    version: '1.0.0',
    apiVersion: '2.0.0',
    mcpVersion: '2026-07-28',
    tools: [{
      name: 'fixture.read',
      title: 'Read synthetic fixture',
      description: 'Return the fixed synthetic read fixture.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      effect: 'read',
      requiredPermissions: ['fixture:read'],
      visibility: ['model'],
      resultSemantics: { kind: 'generic' },
    }],
  };
  const server = createPluginServer({
    manifest: pluginManifest,
    publicKey: keys.publicKey,
    serviceToken,
    acceptedInstallationIds: [pluginId],
    handlers: { 'fixture.read': () => Promise.resolve({ value: 'synthetic read fixture' }) },
  });
  servers.push(server);
  await server.listen({ host: '127.0.0.1', port: 0 });
  server.server.keepAliveTimeout = 1;
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic plugin server did not bind a TCP port');

  const store = new MemoryJsonStore(scope);
  const registration = {
    instanceId: pluginId,
    endpoint: `http://127.0.0.1:${String(address.port)}/mcp`,
    serviceToken,
    expectedManifestDigest: digest(pluginManifest),
    allowLoopback: true,
  };
  const source = { id: pluginId, label: 'Synthetic read fixture', registration };
  const registryA = new PluginRegistry(keys.privateKey, { store, scope });
  const registryBOptions = options.replicaBUsesStore === false
    ? { scope: options.replicaBScope ?? scope }
    : { store, scope: options.replicaBScope ?? scope };
  const registryB = new PluginRegistry(options.replicaBKey ?? keys.privateKey, registryBOptions);
  registries.push(registryA, registryB);
  registryA.configureCatalog([source]);
  if (options.approveReplicaB ?? true) registryB.configureCatalog([source]);
  return { registryA, registryB, store };
}
