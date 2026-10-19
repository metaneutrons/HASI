import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginServer, digest, type PluginManifest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '../packages/state/src/index.js';
import { PluginRegistry } from '../apps/api/src/registry.js';
import type { ManagedPluginRuntimeContract } from '../apps/api/src/managed-plugin-contract.js';

const keys = generateKeyPairSync('ed25519');
const serviceToken = 'action-observation-test-service';
const pluginId = 'records';
const activeServers: ReturnType<typeof createPluginServer>[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.close()));
});

function manifest(version = '1.0.0'): PluginManifest {
  return {
    manifestVersion: 1,
    id: pluginId,
    name: 'Records',
    description: 'Action observation fixture',
    version,
    apiVersion: '1.0.0',
    mcpVersion: '2026-07-28',
    tools: [{
      name: 'records.read',
      title: `Read records ${version}`,
      description: 'Read a record summary.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      effect: 'read',
      requiredPermissions: ['records:read'],
    }],
  };
}

function createServer(value: PluginManifest): ReturnType<typeof createPluginServer> {
  const server = createPluginServer({
    manifest: value,
    publicKey: keys.publicKey,
    serviceToken,
    handlers: { 'records.read': () => Promise.resolve({ value: `served-${value.version}` }) },
  });
  server.server.keepAliveTimeout = 1;
  activeServers.push(server);
  return server;
}

async function listen(server: ReturnType<typeof createPluginServer>, port = 0): Promise<string> {
  await server.listen({ host: '127.0.0.1', port });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Plugin server did not bind a TCP port');
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

function registration(endpoint: string, id = pluginId) {
  const value = manifest();
  return { instanceId: id, endpoint, serviceToken, expectedManifestDigest: digest(value), allowLoopback: true };
}

function stateKey(scope: string, id = pluginId): string {
  return `hasi:plugin-registry:v1:${digest({ scope, pluginId: id })}`;
}

function connectionKey(scope: string, id = pluginId): string {
  return `plugin-connection:v1:${digest({ scope, id })}`;
}

function pauseFirstSettingsBinding(registry: PluginRegistry) {
  let signalEntered!: () => void;
  let signalRelease!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const release = new Promise<void>(resolve => { signalRelease = resolve; });
  const settings = registry.settings as unknown as { binding: typeof registry.settings.binding };
  const original = registry.settings.binding.bind(registry.settings);
  let paused = false;
  settings.binding = (...args) => {
    if (paused) return original(...args);
    paused = true;
    signalEntered();
    return release.then(() => original(...args));
  };
  return { entered, release: signalRelease };
}

describe('trusted action binding observation', () => {
  it('keeps the active binding stable across a no-op and compatible candidate discovery', async () => {
    const firstManifest = manifest();
    const firstServer = createServer(firstManifest);
    const endpoint = await listen(firstServer);
    const store = new MemoryJsonStore('action-observation-candidate');
    const registry = new PluginRegistry(keys.privateKey, { store, scope: 'candidate' });
    await registry.install(registration(endpoint));

    const initial = await registry.observeActionBinding(pluginId);
    expect(initial.status).toBe('current');
    await registry.setEnabled(pluginId, true);
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual(initial);

    const port = Number(new URL(endpoint).port);
    await firstServer.close();
    const cleanupIndex = activeServers.indexOf(firstServer);
    if (cleanupIndex >= 0) activeServers.splice(cleanupIndex, 1);
    const candidateServer = createServer(manifest('1.0.1'));
    await listen(candidateServer, port);
    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'available' });
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual(initial);
    await registry.close();
  });

  it('returns unavailable instead of mixing manifest and settings across concurrent activation', async () => {
    const firstServer = createServer(manifest());
    const endpoint = await listen(firstServer);
    const registry = new PluginRegistry(keys.privateKey, { store: new MemoryJsonStore('action-observation-activation-race'), scope: 'activation-race' });
    await registry.install(registration(endpoint));

    const port = Number(new URL(endpoint).port);
    await firstServer.close();
    const cleanupIndex = activeServers.indexOf(firstServer);
    if (cleanupIndex >= 0) activeServers.splice(cleanupIndex, 1);
    const nextServer = createServer(manifest('1.0.1'));
    await listen(nextServer, port);
    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'available' });

    const barrier = pauseFirstSettingsBinding(registry);
    const observation = registry.observeActionBinding(pluginId);
    await barrier.entered;
    await registry.activateUpdate(pluginId);
    barrier.release();

    await expect(observation).resolves.toEqual({ status: 'unavailable' });
    await expect(registry.observeActionBinding(pluginId)).resolves.toMatchObject({ status: 'current' });
    const fresh = await registry.observeActionBinding(pluginId);
    expect(fresh.status).toBe('current');
    expect(fresh.status === 'current' ? fresh.binding : undefined).toBe(await registry.binding(pluginId));
    expect(registry.version(pluginId)).toBe('1.0.1');
    await registry.close();
  });

  it('rejects a catalogue disconnect that races a current binding observation', async () => {
    const value = manifest();
    const server = createServer(value);
    const endpoint = await listen(server);
    const scope = 'catalog-race';
    const store = new MemoryJsonStore('action-observation-catalog-race');
    const registry = new PluginRegistry(keys.privateKey, { store, scope });
    registry.configureCatalog([{ id: pluginId, label: 'Records', registration: registration(endpoint) }]);
    await registry.connectSource(pluginId);

    const barrier = pauseFirstSettingsBinding(registry);
    const observation = registry.observeActionBinding(pluginId);
    await barrier.entered;
    const connection = await store.read(connectionKey(scope));
    if (!connection) throw new Error('Expected signed catalogue connection record');
    const disconnected = { version: 1, scope, id: pluginId, connected: false };
    expect(await store.compareAndSet(connectionKey(scope), connection.revision, {
      value: disconnected,
      signature: sign(null, Buffer.from(digest(disconnected)), keys.privateKey).toString('base64url'),
    })).toBe(true);
    barrier.release();

    await expect(observation).resolves.toEqual({ status: 'unavailable' });
    await expect(registry.observeActionBinding(pluginId)).resolves.toMatchObject({ status: 'withdrawn', reason: 'plugin_removed' });
    await registry.close();
  });

  it('observes a signed disable from another registry replica with a stable epoch digest', async () => {
    const value = manifest();
    const server = createServer(value);
    const endpoint = await listen(server);
    const store = new MemoryJsonStore('action-observation-replicas');
    const registrationValue = registration(endpoint);
    const first = new PluginRegistry(keys.privateKey, { store, scope: 'replicas' });
    const second = new PluginRegistry(keys.privateKey, { store, scope: 'replicas' });
    await first.install(registrationValue);
    await second.install(registrationValue);
    expect((await second.observeActionBinding(pluginId)).status).toBe('current');

    await first.setEnabled(pluginId, false);
    const withdrawn = await second.observeActionBinding(pluginId);
    expect(withdrawn).toMatchObject({ status: 'withdrawn', reason: 'plugin_disabled' });
    await expect(second.observeActionBinding(pluginId)).resolves.toEqual(withdrawn);
    await first.setEnabled(pluginId, true);
    const reenabled = await second.observeActionBinding(pluginId);
    expect(reenabled.status).toBe('current');
    if (withdrawn.status === 'withdrawn' && reenabled.status === 'current') expect(reenabled.binding).not.toBe(withdrawn.binding);
    await Promise.all([first.close(), second.close()]);
  });

  it('reports removal only from a verified signed catalogue disconnect', async () => {
    const value = manifest();
    const server = createServer(value);
    const endpoint = await listen(server);
    const scope = 'catalog-removal';
    const store = new MemoryJsonStore('action-observation-removal');
    const registry = new PluginRegistry(keys.privateKey, { store, scope });
    registry.configureCatalog([{ id: pluginId, label: 'Records', registration: registration(endpoint) }]);
    await registry.connectSource(pluginId);
    expect((await registry.observeActionBinding(pluginId)).status).toBe('current');
    await registry.removeSource(pluginId);

    const withdrawn = await registry.observeActionBinding(pluginId);
    expect(withdrawn).toMatchObject({ status: 'withdrawn', reason: 'plugin_removed' });
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual(withdrawn);

    const connection = await store.read(connectionKey(scope));
    if (!connection) throw new Error('Expected signed catalogue connection record');
    expect(await store.compareAndSet(connectionKey(scope), connection.revision, {
      ...(connection.value as object),
      value: { ...((connection.value as { value: Record<string, unknown> }).value), connected: true },
    })).toBe(true);
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });
    await registry.close();
  });

  it('returns unavailable for tampered signed local state and storage outages', async () => {
    const value = manifest();
    const server = createServer(value);
    const endpoint = await listen(server);
    const backing = new MemoryJsonStore('action-observation-failures');
    let unavailable = false;
    const store: JsonStore = {
      read: key => unavailable ? Promise.reject(new Error('temporary store outage')) : backing.read(key),
      compareAndSet: (key, revision, next, expiresAt) => backing.compareAndSet(key, revision, next, expiresAt),
      delete: key => backing.delete(key),
    };
    const registry = new PluginRegistry(keys.privateKey, { store, scope: 'failures' });
    await registry.install(registration(endpoint));
    const state = await backing.read(stateKey('failures'));
    if (!state) throw new Error('Expected signed plugin state');
    expect(await backing.compareAndSet(stateKey('failures'), state.revision, {
      ...(state.value as Record<string, unknown>),
      enabled: false,
    })).toBe(true);
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });

    unavailable = true;
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });
    await registry.close();
  });

  it('does not infer withdrawal from managed worker or configuration unavailability', async () => {
    const value = manifest();
    const store = new MemoryJsonStore('action-observation-managed');
    const registrationValue = {
      instanceId: pluginId,
      endpoint: 'https://records.example/mcp',
      serviceToken,
      expectedManifestDigest: digest(value),
      allowLoopback: false,
    };
    let contract: ManagedPluginRuntimeContract | null = {
      installationId: pluginId,
      manifest: value,
      manifestDigest: digest(value),
      configurationRevision: 0,
      deploymentRevision: digest({ deployment: 1 }),
      transportCredentialRevision: 'transport-1',
      secretStatuses: [],
      enabled: true,
    };
    let reads = 0;
    const registry = new PluginRegistry(keys.privateKey, {
      store,
      scope: 'managed',
      managedContracts: new Map([[pluginId, { initialManifest: value, read: () => { reads++; return Promise.resolve(structuredClone(contract)); } }]]),
    });
    await registry.install(registrationValue);

    contract = null;
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });
    contract = {
      installationId: pluginId,
      manifest: value,
      manifestDigest: digest(value),
      configurationRevision: 1,
      deploymentRevision: digest({ deployment: 2 }),
      transportCredentialRevision: 'transport-2',
      secretStatuses: [],
      enabled: true,
    };
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });

    contract = {
      installationId: pluginId,
      manifest: value,
      manifestDigest: digest(value),
      configurationRevision: 0,
      deploymentRevision: digest({ deployment: 1 }),
      transportCredentialRevision: 'transport-1',
      secretStatuses: [],
      enabled: true,
    };
    await registry.setEnabled(pluginId, false);
    contract = null;
    reads = 0;
    await expect(registry.observeActionBinding(pluginId)).resolves.toMatchObject({ status: 'withdrawn', reason: 'plugin_disabled' });
    expect(reads).toBe(0);
    await registry.close();
  });

  it('does not treat a missing managed worker contract as a signed removal', async () => {
    const value = manifest();
    const store = new MemoryJsonStore('action-observation-null-managed');
    let contract: ManagedPluginRuntimeContract | null = {
      installationId: pluginId,
      manifest: value,
      manifestDigest: digest(value),
      configurationRevision: 0,
      deploymentRevision: digest({ deployment: 'managed-catalogue' }),
      transportCredentialRevision: 'transport-1',
      secretStatuses: [],
      enabled: true,
    };
    const registry = new PluginRegistry(keys.privateKey, {
      store,
      scope: 'null-managed',
      managedContracts: new Map([[pluginId, { initialManifest: value, read: () => Promise.resolve(structuredClone(contract)) }]]),
    });
    registry.configureCatalog([{
      id: pluginId,
      label: 'Records',
      registration: { instanceId: pluginId, endpoint: 'https://records.example/mcp', serviceToken, expectedManifestDigest: digest(value), allowLoopback: false },
    }]);
    await registry.connectSource(pluginId);
    contract = null;
    await expect(registry.observeActionBinding(pluginId)).resolves.toEqual({ status: 'unavailable' });
    await registry.close();
  });
});
