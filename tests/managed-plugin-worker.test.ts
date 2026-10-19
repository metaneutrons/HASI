import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PostgresJsonStore } from '@hasi/state';
import { digest, type PluginManifest } from '@hasi/plugin-sdk';
import { startManagedPluginWorker } from '../apps/api/src/managed-plugin-worker.js';
import { createManagedPluginRpcClient } from '../apps/api/src/managed-plugin-rpc.js';
import { ProductionAuthorityDirectory } from '../apps/api/src/production-runtime.js';
import { pluginReleaseSigningBytes, type UnsignedPluginRelease } from '../apps/api/src/plugin-artifacts.js';

async function port() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('port unavailable');
  await new Promise<void>((resolve, reject) => { listener.close(error => { if (error) reject(error); else resolve(); }); });
  return address.port;
}

describe('separate managed installer composition', () => {
  it('requires explicit opt-in before reading configuration or accessing state', async () => {
    await expect(startManagedPluginWorker({ HASI_MODE: 'production' })).rejects.toThrow('Explicit installer opt-in');
  });
  it.skipIf(!process.env.TEST_DATABASE_URL)('serves authenticated setup over real HTTP, persists configuration through restart and rechecks signed admin revocation', async () => {
    const database = process.env.TEST_DATABASE_URL;
    if (!database) throw new Error('isolated PostgreSQL required');
    const scope = `installer-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), 'hasi-installer-'));
    const privateKeys = generateKeyPairSync('ed25519');
    const publisherKeys = generateKeyPairSync('ed25519');
    const store = new PostgresJsonStore(`production:${scope}`, { poolConfig: { connectionString: database } });
    await store.initialize();
    const authority = new ProductionAuthorityDirectory(store, privateKeys.privateKey, scope);
    const subject = 'synthetic-operator';
    const authorityKey = `authority:v1:${createHash('sha256').update(subject).digest('hex')}`;
    const user = { id: subject, displayName: 'Synthetic Operator', role: 'admin' as const, actor: { subject, permissions: ['plugins:manage'] } };
    await authority.replace(subject, null, user);
    const rpcPort = await port(); let gatewayPort = await port();
    while (gatewayPort === rpcPort) gatewayPort = await port();
    const manifest: PluginManifest = { manifestVersion: 2, id: 'reference', version: '1.0.0', name: 'Synthetic', description: 'Setup only', apiVersion: '2.0.0', mcpVersion: '2026-07-28', tools: [] };
    const unsigned: UnsignedPluginRelease = { schemaVersion: 1, pluginId: manifest.id, version: manifest.version, manifestDigest: digest(manifest), image: `registry.example.test/hasi/reference@sha256:${'a'.repeat(64)}`, publisherId: 'publisher', configSchemaVersion: 1, stateMigration: 'none' };
    const configuration = { version: 1, scope, ownerId: 'synthetic-owner', rpcPort, gatewayPort, socketPath: '/tmp/hasi-installer-not-a-real-docker.sock', internalNetworks: ['hasi-synthetic-internal'], relayNetwork: 'hasi-synthetic-relay',
      publishers: [{ publisherId: 'publisher', publicKey: publisherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), sourceRegistryPrefix: 'registry.example.test/hasi', allowedPluginIds: ['reference'] }],
      installations: [{ id: 'installation', label: 'Synthetic setup', pluginId: manifest.id, configurationSchemaVersion: 1, restorePlans: [], releases: [{ id: 'release-a', envelope: { ...unsigned, signature: sign(null, pluginReleaseSigningBytes(unsigned), publisherKeys.privateKey).toString('base64url') }, manifest, launch: { network: { mode: 'none' } }, secretAssignments: [], license: 'GPL-3.0-only', inventoryDigest: 'b'.repeat(64) }] }],
      credentials: { installation: { transport: { environmentName: 'HASI_PLUGIN_SECRET_TRANSPORT', revision: 'v1' }, slots: {} } } };
    const configPath = join(directory, 'operator.json');
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' });
    const environment = { HASI_MODE: 'production', HASI_MANAGED_INSTALLER: '1', HASI_INSTALLER_CONFIG: configPath, DATABASE_URL: database, HASI_PRIVATE_KEY: privateKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), HASI_PLUGIN_SECRET_TRANSPORT: 'synthetic-service-only' };
    let worker: Awaited<ReturnType<typeof startManagedPluginWorker>> | undefined;
    try {
      worker = await startManagedPluginWorker(environment);
      const client = createManagedPluginRpcClient({ origin: `http://127.0.0.1:${String(rpcPort)}`, privateKey: privateKeys.privateKey, scope });
      const catalog = await client.list(subject);
      expect(catalog.installations[0]?.status).toBe('empty');
      expect(JSON.stringify(catalog)).not.toMatch(/HASI_PLUGIN_SECRET|synthetic-service-only|socketPath|secretRef/u);
      expect(await client.saveConfigurationDraft?.('installation', { revision: 0, values: {}, disabledTools: [] }, subject)).toEqual({ revision: 1, activeRevision: 0 });
      expect(await client.activateConfiguration?.('installation', 1, subject)).toEqual({ revision: 2, activeRevision: 1 });
      await worker.close(); worker = undefined;
      worker = await startManagedPluginWorker(environment);
      expect((await client.list(subject)).installations[0]?.configurationRevision).toBe('1');
      expect((await client.describeConfiguration?.('installation', subject))?.activeRevision).toBe(1);
      const grant = await store.read(authorityKey);
      expect(grant).toBeDefined();
      if (!grant) throw new Error('grant unavailable');
      await authority.replace(subject, grant.revision, null);
      await expect(client.list(subject)).rejects.toThrow('Installer request unavailable');
    } finally {
      await worker?.close();
      for (const key of [authorityKey, `plugin-settings:v1:${digest({ scope, instanceId: 'installation' })}`, `hasi:plugin-deployment:v1:${digest(scope)}:${digest('installation')}`, `hasi:plugin-route:v1:${digest(scope)}:${digest(['synthetic-owner', 'installation'])}`]) await store.delete(key);
      await store.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});
