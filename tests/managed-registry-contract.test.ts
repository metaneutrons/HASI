import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, type ActorContext, type PluginManifest } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '../packages/state/src/index.js';
import { PluginRegistry } from '../apps/api/src/registry.js';
import type { ManagedPluginRuntimeContract } from '../apps/api/src/managed-plugin-contract.js';
import { createPluginDeploymentGateway } from '../apps/api/src/plugin-deployment-proxy.js';
import { createManagedPluginRpcServer, createManagedPluginContractClient } from '../apps/api/src/managed-plugin-rpc.js';
import { createProductionRuntime } from '../apps/api/src/production-runtime.js';
import { PluginDeploymentBinding } from '../apps/api/src/plugin-deployment-binding.js';

const keys = generateKeyPairSync('ed25519');
const actor: ActorContext = { subject: 'synthetic-user', permissions: ['records:read', 'records:admin'] };
const serviceToken = 'synthetic-managed-transport';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function manifest(version = '1.0.0', id = 'records', permission = 'records:read'): PluginManifest {
  return { manifestVersion: 2, id, name: 'Synthetic records', description: 'Managed contract test', version,
    apiVersion: '2.0.0', mcpVersion: '2026-07-28', secrets: [{ name: 'api', required: true }],
    tools: [{ name: 'records.read', title: `Read ${version}`, description: 'Read synthetic content', effect: 'read', requiredPermissions: [permission],
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] };
}

async function fixture() {
  const first = manifest(); const second = manifest('2.0.0', 'records', 'records:admin');
  let nativeCalls = 0;
  const servers = await Promise.all([first, second].map(async value => {
    const server = createPluginServer({ manifest: value, publicKey: keys.publicKey, serviceToken, acceptedInstallationIds: ['installation'],
      handlers: { 'records.read': () => { nativeCalls++; return Promise.resolve({ value: value.version }); } } });
    await server.listen({ host: '127.0.0.1', port: 0 }); cleanups.push(() => server.close());
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    return address.port;
  }));
  let active = 0;
  const contracts = [first, second].map((value, index): ManagedPluginRuntimeContract => ({
    installationId: 'installation', manifest: value, manifestDigest: digest(value), configurationRevision: 0,
    deploymentRevision: digest({ routeRevision: index, manifest: digest(value) }), transportCredentialRevision: 'transport-1',
    secretStatuses: [{ name: 'api', configured: true, revision: 'api-1' }], enabled: true,
  }));
  let contract: ManagedPluginRuntimeContract | null = contracts[0] ?? null;
  let readHook: (() => void | Promise<void>) | undefined;
  let reads = 0;
  const endpoint = () => {
    const port = servers[active]; const deploymentRevision = contracts[active]?.deploymentRevision;
    if (!port || !deploymentRevision) throw new Error('Missing synthetic server');
    return { deploymentId: String(active + 1).repeat(64), relayDeploymentId: 'd'.repeat(64), releaseDigest: String(active + 2).repeat(64),
      host: '127.0.0.1', port, containerPort: 3000, deploymentRevision };
  };
  const gateway = await createPluginDeploymentGateway({ port: 0, authorize: input => input.authorization === `Bearer ${serviceToken}`,
    endpointResolver: { resolveActiveEndpoint: () => Promise.resolve(endpoint()), assertActiveEndpoint: input => Promise.resolve(digest(input.endpoint) === digest(endpoint())) } });
  cleanups.push(() => gateway.close());
  const store = new MemoryJsonStore('managed-contract-test');
  const denyAdmin = () => Promise.reject(new Error('No administrator in the runtime contract test'));
  const rpc = await createManagedPluginRpcServer({ service: { list: denyAdmin, command: denyAdmin, commandStatus: denyAdmin },
    privateKey: keys.privateKey, publicKey: keys.publicKey, scope: 'test', port: 0,
    runtimeContract: async () => { reads++; await readHook?.(); return structuredClone(contract); } });
  cleanups.push(() => rpc.close());
  const contractClient = createManagedPluginContractClient({ origin: rpc.origin, privateKey: keys.privateKey, scope: 'test' });
  const source = { id: 'installation', label: 'Synthetic managed', registration: {
    instanceId: 'installation', endpoint: `${gateway.origin}/api/plugin-deployments/installation/mcp`, serviceToken,
    allowLoopback: false, expectedManifestDigest: digest(first),
  } };
  const construct = () => {
    const registry = new PluginRegistry(keys.privateKey, { store, scope: 'test', operatorManagedLoopbackOrigin: gateway.origin,
      managedContracts: new Map([['installation', { initialManifest: first, read: () => contractClient.read('installation') }]]) });
    registry.configureCatalog([source]); cleanups.push(() => registry.close()); return registry;
  };
  const registry = construct(); await registry.connectSource('installation');
  return { registry, construct, first, second, contracts, source, store,
    update: () => { active = 1; contract = structuredClone(contracts[1] ?? null); },
    setContract: (value: ManagedPluginRuntimeContract | null) => { contract = value; },
    onRead: (hook?: () => void | Promise<void>) => { reads = 0; readHook = hook; }, getReads: () => reads,
    moveRouteOnly: () => { active = 1; },
    nativeCalls: () => nativeCalls,
  };
}

describe('managed contract adoption in the actual registry and native MCP gateway', () => {
  it('rejects a production managed gateway without its private contract authority before any state I/O', async () => {
    let stateCalls = 0;
    const denied = () => { stateCalls++; return Promise.reject(new Error('No state I/O expected')); };
    const settingsBinding = new PluginDeploymentBinding({ ownerId: 'test-owner', readAuthoritativeRevision: () => Promise.resolve(0),
      routes: { read: denied, updateConfigurationRevision: denied } });
    await expect(createProductionRuntime({ privateKey: keys.privateKey, scope: 'test',
      store: { read: denied, compareAndSet: denied, delete: denied }, webOrigin: 'https://web.example.test', apiHostname: 'api.example.test',
      plugins: [{ id: 'installation', label: 'Synthetic', registration: { instanceId: 'installation', endpoint: 'https://plugin.example.test/mcp',
        serviceToken, expectedManifestDigest: digest(manifest()), allowLoopback: false } }],
      identity: { issuer: 'https://idp.example.test', clientId: 'synthetic' },
      deploymentBindings: new Map([['installation', settingsBinding]]), externalManagedGateway: { origin: 'http://127.0.0.1:48001', installationIds: ['installation'] },
    })).rejects.toThrow('Managed contracts must match managed gateway installations');
    expect(stateCalls).toBe(0);
  });

  it('adopts an explicitly approved major contract and worker-only secret readiness without restarting the host', async () => {
    const test = await fixture();
    const before = await test.registry.binding('installation');
    await expect(test.registry.invoke('installation', 'records.read', {}, actor)).resolves.toEqual({ value: '1.0.0' });
    test.update(); await test.registry.refreshAll();
    expect(test.registry.list()[0]?.version).toBe('2.0.0');
    expect(await test.registry.binding('installation')).not.toBe(before);
    expect((await test.registry.authorizedModelTools({ ...actor, permissions: ['records:read'] }))).toHaveLength(0);
    await expect(test.registry.invoke('installation', 'records.read', {}, { ...actor, permissions: ['records:read'] })).rejects.toMatchObject({ status: 403 });
    await expect(test.registry.invoke('installation', 'records.read', {}, actor)).resolves.toEqual({ value: '2.0.0' });
    const restarted = test.construct(); await restarted.restoreConnections();
    await expect(restarted.invoke('installation', 'records.read', {}, actor)).resolves.toEqual({ value: '2.0.0' });
    expect(restarted.registration('installation').secretCustody).toBeUndefined();
  });

  it('withdraws stale capabilities on missing private authority and restores only after a fresh valid contract', async () => {
    const test = await fixture();
    test.setContract(null);
    expect(await test.registry.authorizedModelTools(actor)).toHaveLength(0);
    await test.registry.refreshAll();
    expect(test.registry.list()[0]?.ready).toBe(false);
    await expect(test.registry.invoke('installation', 'records.read', {}, actor)).rejects.toMatchObject({ status: 409 });
    const restarted = test.construct(); await restarted.restoreConnections();
    expect(restarted.list()).toHaveLength(0);
    test.setContract(structuredClone(test.contracts[0] ?? null)); await restarted.refreshAll();
    await expect(restarted.invoke('installation', 'records.read', {}, actor)).resolves.toEqual({ value: '1.0.0' });
    await expect(restarted.removeSource('installation')).resolves.toBeUndefined();
    await restarted.refreshAll(); expect(restarted.list()).toHaveLength(0);
  });

  it('preserves an unrelated source and permits managed withdrawal while the worker is unavailable', async () => {
    const test = await fixture();
    const other = manifest('1.0.0', 'other-records');
    const server = createPluginServer({ manifest: other, publicKey: keys.publicKey, serviceToken,
      handlers: { 'records.read': () => Promise.resolve({ value: 'unrelated' }) } });
    await server.listen({ host: '127.0.0.1', port: 0 }); cleanups.push(() => server.close());
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
    await test.registry.install({ endpoint: `http://127.0.0.1:${String(address.port)}/mcp`, serviceToken, allowLoopback: true,
      expectedManifestDigest: digest(other), secretReady: () => true, secretRevision: () => 'other-api-1' });
    test.setContract(null); await test.registry.refreshAll();
    expect((await test.registry.authorizedModelTools(actor)).map(tool => tool.pluginId)).toEqual(['other-records']);
    await expect(test.registry.invoke('other-records', 'records.read', {}, actor)).resolves.toEqual({ value: 'unrelated' });
    await test.registry.removeSource('installation');
    test.setContract(structuredClone(test.contracts[0] ?? null)); await test.registry.refreshAll();
    expect(test.registry.catalog()[0]?.connected).toBe(false);
    expect(test.registry.list().map(plugin => plugin.id)).toEqual(['other-records']);
  });

  it('rejects wrong identities, digest substitution, missing secret grants and configuration disagreement', async () => {
    const test = await fixture(); const original = test.contracts[0]; if (!original) throw new Error('Missing test contract');
    for (const changed of [
      { ...original, installationId: 'other-installation' },
      { ...original, manifest: manifest('1.0.0', 'other-package'), manifestDigest: digest(manifest('1.0.0', 'other-package')) },
      { ...original, manifestDigest: 'f'.repeat(64) },
      { ...original, configurationRevision: 1 },
      { ...original, secretStatuses: [{ name: 'api', configured: false, revision: null }] },
    ]) {
      test.setContract(changed);
      await expect(test.registry.binding('installation')).rejects.toMatchObject({ status: 409 });
    }
    test.setContract(original); await test.registry.refreshAll();
    await expect(test.registry.checkUpdate('installation')).rejects.toMatchObject({ status: 409 });
    await expect(test.registry.activateUpdate('installation')).rejects.toMatchObject({ status: 409 });
  });

  it('denies a contract race and a route-only replacement instead of dispatching to the new runtime', async () => {
    const test = await fixture();
    test.onRead(() => { if (test.getReads() === 2) test.update(); });
    await expect(test.registry.binding('installation')).rejects.toMatchObject({ status: 409 });
    test.onRead(); test.setContract(structuredClone(test.contracts[0] ?? null));
    await expect(test.registry.invoke('installation', 'records.read', {}, actor)).rejects.toThrow();
  });

  it('rejects a local connection withdrawal racing the private contract read', async () => {
    const test = await fixture();
    test.onRead(async () => { if (test.getReads() === 2) await test.registry.removeSource('installation'); });
    await expect(test.registry.binding('installation')).rejects.toMatchObject({ status: 409 });
    test.onRead(); await test.registry.refreshAll();
    expect(await test.registry.authorizedModelTools(actor)).toHaveLength(0);
    expect(test.registry.catalog()[0]?.connected).toBe(false);
  });

  it('denies a signed disconnected record observed after the initial connection check on another replica', async () => {
    const test = await fixture(); const remover = test.construct();
    const key = `plugin-connection:v1:${digest({ scope: 'test', id: 'installation' })}`;
    const read = test.store.read.bind(test.store); let connectionReads = 0;
    const hook = vi.spyOn(test.store, 'read').mockImplementation(async requested => {
      const record = await read(requested);
      if (requested === key && ++connectionReads === 1) await remover.removeSource('installation');
      return record;
    });
    try {
      await expect(test.registry.invoke('installation', 'records.read', {}, actor)).rejects.toMatchObject({ status: 409 });
      expect(test.nativeCalls()).toBe(0);
    } finally { hook.mockRestore(); }
    await test.registry.refreshAll(); expect(await test.registry.authorizedModelTools(actor)).toHaveLength(0);
    await test.registry.connectSource('installation');
    await expect(test.registry.invoke('installation', 'records.read', {}, actor)).resolves.toEqual({ value: '1.0.0' });
  });

  it('fails closed for a corrupted connection record without aborting managed refresh or restart', async () => {
    const test = await fixture();
    const key = `plugin-connection:v1:${digest({ scope: 'test', id: 'installation' })}`;
    const record = await test.store.read(key); if (!record) throw new Error('Missing synthetic connection record');
    await test.store.compareAndSet(key, record.revision, { value: { version: 1, scope: 'test', id: 'installation', connected: true }, signature: 'tampered' });
    await expect(test.registry.refreshAll()).resolves.toBeUndefined();
    expect(await test.registry.authorizedModelTools(actor)).toHaveLength(0);
    const restarted = test.construct(); await expect(restarted.restoreConnections()).resolves.toBeUndefined();
    expect(restarted.list()).toHaveLength(0);
  });
});
