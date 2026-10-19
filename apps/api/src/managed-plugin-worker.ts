import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PostgresJsonStore } from '@hasi/state';
import { digest } from '@hasi/plugin-sdk';
import { createDockerPluginDriver } from './docker-plugin-driver.js';
import { PluginRouteController } from './plugin-route-controller.js';
import { PluginDeploymentBinding } from './plugin-deployment-binding.js';
import { createPluginDeploymentGateway } from './plugin-deployment-proxy.js';
import { createManagedPluginPreflight } from './managed-plugin-preflight.js';
import { ManagedPluginInstaller, managedPluginInstallerCatalogSchema } from './managed-plugin-installer.js';
import { createManagedPluginRpcServer } from './managed-plugin-rpc.js';
import { EnvironmentPluginSecretCustody } from './plugin-secrets.js';
import { ProductionAuthorityDirectory } from './production-runtime.js';
import { PluginRuntimeCredentials } from './plugin-runtime-credentials.js';
import { DeploymentDriverError, verifyPluginRelease } from './plugin-artifacts.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const network = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
const slot = z.strictObject({ environmentName: z.string().regex(/^HASI_PLUGIN_SECRET_[A-Z0-9_]{1,80}$/u), revision: id });
const schema = z.strictObject({
  version: z.literal(1), scope: id, ownerId: id,
  rpcPort: z.number().int().min(1024).max(65535), gatewayPort: z.number().int().min(1024).max(65535),
  socketPath: z.string().regex(/^\/[A-Za-z0-9/._-]+$/u).max(1024),
  internalNetworks: z.array(network).min(1).max(64), relayNetwork: network,
  publishers: z.array(z.strictObject({ publisherId: id, publicKey: z.string().max(4096), sourceRegistryPrefix: z.string().max(512), allowedPluginIds: z.array(id).max(32), revoked: z.boolean().default(false) })).max(32),
  installations: managedPluginInstallerCatalogSchema,
  credentials: z.record(id, z.strictObject({ transport: slot, slots: z.record(id, slot) })),
});

/** Operator entry point. It is intentionally absent from the public API startup.
 * Run as a separate trusted host process with the Docker socket; never mount
 * that socket into the public API, web app or any plugin container.
 */
export async function startManagedPluginWorker(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.HASI_MODE !== 'production' || environment.HASI_MANAGED_INSTALLER !== '1') throw new Error('Explicit installer opt-in required');
  const path = environment.HASI_INSTALLER_CONFIG;
  const database = environment.DATABASE_URL;
  const pem = environment.HASI_PRIVATE_KEY;
  if (!path || !database || !pem) throw new Error('Installer configuration unavailable');
  const load = async () => {
    const file = await readFile(path, 'utf8');
    if (Buffer.byteLength(file) > 1024 * 1024) throw new Error('Installer configuration too large');
    return schema.parse(JSON.parse(file) as unknown);
  };
  let configuration = await load();
  const topology = digest({ scope: configuration.scope, ownerId: configuration.ownerId, socketPath: configuration.socketPath, rpcPort: configuration.rpcPort, gatewayPort: configuration.gatewayPort, networks: configuration.internalNetworks, relay: configuration.relayNetwork });
  const reload = async () => {
    const next = await load();
    if (digest({ scope: next.scope, ownerId: next.ownerId, socketPath: next.socketPath, rpcPort: next.rpcPort, gatewayPort: next.gatewayPort, networks: next.internalNetworks, relay: next.relayNetwork }) !== topology) throw new Error('Installer topology changed; restart required');
    configuration = next;
    return next;
  };
  const privateKey = createPrivateKey(pem);
  const store = new PostgresJsonStore(`production:${configuration.scope}`, { poolConfig: { connectionString: database, max: 6, connectionTimeoutMillis: 5000 } });
  await store.initialize();
  const routes = new PluginRouteController({ store, scope: configuration.scope, ownerId: configuration.ownerId });
  const directory = new ProductionAuthorityDirectory(store, privateKey, configuration.scope);
  const custody = async (installationId: string, transport = false) => {
    const config = await reload();
    const bindings = Object.hasOwn(config.credentials, installationId) ? config.credentials[installationId] : undefined;
    if (!bindings) throw new Error('Installer credential binding unavailable');
    return new EnvironmentPluginSecretCustody(transport ? { service: bindings.transport } : bindings.slots, environment);
  };
  const driver = createDockerPluginDriver({ enabled: true, deploymentTarget: 'operator-local', socketPath: configuration.socketPath, ownerId: configuration.ownerId,
    allowedInternalNetworks: configuration.internalNetworks, relayNetwork: configuration.relayNetwork, routing: routes,
    authorizeRuntime: async input => {
      await runtimeCredentials.assertCurrent({ installationId: input.installationId, operationId: input.stagingOperationId, releaseDigest: input.releaseDigest });
      return true;
    },
    resolveSecret: async input => {
      if (input.ownerId !== configuration.ownerId) return undefined;
      const entry = (await reload()).installations.find(item => item.id === input.installationId && item.pluginId === input.pluginId);
      if (!entry?.releases.some(item => item.secretAssignments.some(ref => ref.name === input.secretName && ref.secretRef === input.secretRef))) return undefined;
      return (await custody(entry.id)).use(input.secretRef, value => Promise.resolve(value));
    },
  });
  const binding = new PluginDeploymentBinding({ routes, ownerId: configuration.ownerId, readAuthoritativeRevision: async installationId => (await installer.configuration(installationId)).activeRevision });
  const runtimeCredentials = new PluginRuntimeCredentials({ store, scope: configuration.scope, privateKey, status: async (installationId, assignments, releaseDigest) => {
    const config = await reload();
    const approved = config.installations.find(item => item.id === installationId)?.releases.find(item =>
      verifyPluginRelease(item.envelope, publisherId => config.publishers.find(publisher => publisher.publisherId === publisherId)).releaseDigest === releaseDigest);
    if (!approved || digest([...approved.secretAssignments].sort((a, b) => a.name.localeCompare(b.name))) !== digest(assignments)) throw new Error('Runtime assignments no longer approved');
    const transport = (await custody(installationId, true)).status('service');
    const secrets = await custody(installationId);
    return { transport, secrets: assignments.map(item => secrets.status(item.secretRef)) };
  } });
  const installer = new ManagedPluginInstaller({ store, scope: configuration.scope, privateKey, driver: { ...driver, stage: async input => {
    try { await runtimeCredentials.capture({ installationId: input.installationId, operationId: input.operationId, releaseDigest: input.release.releaseDigest, assignments: input.secretAssignments }); }
    catch { throw new DeploymentDriverError('failed'); } // No Docker call was dispatched.
    return driver.stage(input);
  } },
    readCatalog: async () => (await reload()).installations,
    resolvePublisher: publisherId => {
      const publisher = configuration.publishers.find(item => item.publisherId === publisherId);
      return publisher;
    },
    authorizeAdmin: async subject => { const user = await directory.resolve(subject); return user?.role === 'admin' && user.actor.permissions.includes('plugins:manage'); },
    secretsAuthorized: async (installationId, assignments) => { const secrets = await custody(installationId); return assignments.every(item => secrets.status(item.secretRef).configured); },
    secretReady: (installationId, name, assignments) => {
      const bindings = Object.hasOwn(configuration.credentials, installationId) ? configuration.credentials[installationId] : undefined;
      const slotName = assignments?.find(item => item.name === name)?.secretRef;
      return bindings && slotName ? new EnvironmentPluginSecretCustody(bindings.slots, environment).status(slotName).configured : false;
    },
    preflight: createManagedPluginPreflight({ driver, useServiceCredential: async (installationId, operation) => (await custody(installationId, true)).use('service', operation) }),
    synchronizeRoute: async (installationId, revision) => { await binding.configurationActivated(installationId, revision); },
  });
  let gateway: Awaited<ReturnType<typeof createPluginDeploymentGateway>> | undefined;
  let rpc: Awaited<ReturnType<typeof createManagedPluginRpcServer>> | undefined;
  try {
    await installer.initialize();
    for (const entry of configuration.installations) {
      // A restart must read an existing active route, never initialize over it.
      try { await routes.read({ ownerId: configuration.ownerId, installationId: entry.id }); }
      catch { await routes.initializeInstallation({ installationId: entry.id, configurationRevision: String((await installer.configuration(entry.id)).activeRevision) }); }
    }
    const resolveActiveEndpoint: typeof driver.resolveActiveEndpoint = async input => {
          await reload();
          const endpoint = await driver.resolveActiveEndpoint(input);
          if (!endpoint) return null;
          if (!endpoint.stageOperationId) return null;
          await runtimeCredentials.assertCurrent({ installationId: input.installationId, operationId: endpoint.stageOperationId, releaseDigest: endpoint.releaseDigest });
          const state = await installer.coordinator.get(input.installationId);
          const catalog = configuration.installations.find(item => item.id === input.installationId);
          const release = catalog?.releases.find(item => verifyPluginRelease(item.envelope, publisherId => configuration.publishers.find(publisher => publisher.publisherId === publisherId)).releaseDigest === endpoint.releaseDigest
            && state.current?.releaseDigest === endpoint.releaseDigest && state.current.manifestDigest === digest(item.manifest));
          if (!release || !(await installer.configuration(input.installationId, state.current?.releaseDigest)).ready) return null;
          await binding.assertCurrent(input.installationId, Number(state.configurationRevision));
          return endpoint;
    };
    gateway = await createPluginDeploymentGateway({ port: configuration.gatewayPort,
      endpointResolver: {
        resolveActiveEndpoint,
        assertActiveEndpoint: async input => {
          const current = await resolveActiveEndpoint(input);
          return current !== null && digest(current) === digest(input.endpoint) && await driver.assertActiveEndpoint(input);
        },
      },
      authorize: async ({ installationId, authorization }) => {
        if (!authorization) return false;
        return (await custody(installationId, true)).use('service', credential => {
          const a = Buffer.from(authorization); const b = Buffer.from(`Bearer ${credential}`);
          return Promise.resolve(a.length === b.length && timingSafeEqual(a, b));
        });
      },
    });
    rpc = await createManagedPluginRpcServer({ service: installer, publicKey: createPublicKey(privateKey), privateKey, scope: configuration.scope, port: configuration.rpcPort });
    return { close: async () => { await rpc?.close(); await gateway?.close(); await store.close(); } };
  } catch { await rpc?.close(); await gateway?.close(); await store.close(); throw new Error('Installer startup failed'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startManagedPluginWorker(process.env).then(worker => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.close().catch(() => { process.exitCode = 1; }); });
    console.info('HASI managed plugin installer ready');
  }).catch(() => { console.error('HASI managed plugin installer startup failed; check operator configuration.'); process.exitCode = 1; });
}
