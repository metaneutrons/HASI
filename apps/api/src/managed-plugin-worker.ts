import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PostgresJsonStore } from '@hasi/state';
import { digest, manifestSchema } from '@hasi/plugin-sdk';
import { createDockerPluginDriver } from './docker-plugin-driver.js';
import { PluginRouteController } from './plugin-route-controller.js';
import { PluginDeploymentBinding } from './plugin-deployment-binding.js';
import { createPluginDeploymentGateway } from './plugin-deployment-proxy.js';
import { createManagedPluginPreflight } from './managed-plugin-preflight.js';
import { ManagedPluginInstaller, managedPluginInstallerCatalogSchema } from './managed-plugin-installer.js';
import { createManagedPluginRpcServer } from './managed-plugin-rpc.js';
import { managedPluginRuntimeContractSchema, type ManagedPluginRuntimeContract } from './managed-plugin-contract.js';
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
    type DockerEndpoint = NonNullable<Awaited<ReturnType<typeof driver.resolveActiveEndpoint>>>;
    type ActiveEndpoint = Omit<DockerEndpoint, 'stageOperationId'> & { readonly stageOperationId: string; readonly deploymentRevision: string };
    const findApprovedRelease = (config: Awaited<ReturnType<typeof load>>, installationId: string, releaseDigest: string) => {
      const installation = config.installations.find(item => item.id === installationId);
      if (!installation) return undefined;
      for (const release of installation.releases) {
        try {
          const verified = verifyPluginRelease(release.envelope, publisherId => config.publishers.find(publisher => publisher.publisherId === publisherId));
          const manifest = manifestSchema.parse(release.manifest);
          if (verified.pluginId === installation.pluginId && verified.releaseDigest === releaseDigest
            && verified.manifestDigest === digest(manifest) && manifest.id === installation.pluginId && manifest.version === verified.version) {
            return { release, manifest, verified };
          }
        } catch { /* An invalid, unapproved or revoked release is never active authority. */ }
      }
      return undefined;
    };
    const resolveActiveEndpoint = async (input: { readonly installationId: string }): Promise<ActiveEndpoint | null> => {
      const config = await reload();
      const endpoint = await driver.resolveActiveEndpoint(input);
      if (!endpoint?.stageOperationId) return null;
      await runtimeCredentials.assertCurrent({ installationId: input.installationId, operationId: endpoint.stageOperationId, releaseDigest: endpoint.releaseDigest });
      const state = await installer.coordinator.get(input.installationId);
      if (state.installationId !== input.installationId || state.current?.releaseDigest !== endpoint.releaseDigest) return null;
      const approved = findApprovedRelease(config, input.installationId, endpoint.releaseDigest);
      if (state.current.manifestDigest !== approved?.verified.manifestDigest) return null;
      const settings = await installer.configuration(input.installationId, endpoint.releaseDigest);
      const configurationRevision = Number(state.configurationRevision);
      if (!settings.ready || !Number.isSafeInteger(configurationRevision) || settings.activeRevision !== configurationRevision) return null;
      await binding.assertCurrent(input.installationId, configurationRevision);
      const route = await routes.read({ ownerId: config.ownerId, installationId: input.installationId });
      if (route.configurationRevision !== state.configurationRevision || route.active?.deploymentId !== endpoint.deploymentId
        || route.active.releaseDigest !== endpoint.releaseDigest) return null;
      if (!await driver.assertActiveEndpoint({ installationId: input.installationId, endpoint })) return null;
      const deploymentRevision = digest({ endpoint, current: state.current, configurationRevision: state.configurationRevision, route });
      return { ...endpoint, stageOperationId: endpoint.stageOperationId, deploymentRevision };
    };

    const readRuntimeContract = async (installationId: string): Promise<ManagedPluginRuntimeContract | null> => {
      const endpoint = await resolveActiveEndpoint({ installationId });
      if (!endpoint) return null;
      const config = await reload();
      const state = await installer.coordinator.get(installationId);
      const route = await routes.read({ ownerId: config.ownerId, installationId });
      const approved = findApprovedRelease(config, installationId, endpoint.releaseDigest);
      const configurationRevision = Number(state.configurationRevision);
      if (!approved || state.current?.releaseDigest !== endpoint.releaseDigest
        || state.current.manifestDigest !== approved.verified.manifestDigest
        || route.active?.deploymentId !== endpoint.deploymentId || route.active.releaseDigest !== endpoint.releaseDigest
        || route.configurationRevision !== state.configurationRevision
        || !Number.isSafeInteger(configurationRevision)) return null;

      const settings = await installer.configuration(installationId, endpoint.releaseDigest);
      if (!settings.ready || settings.activeRevision !== configurationRevision) return null;
      await binding.assertCurrent(installationId, configurationRevision);

      const transport = (await custody(installationId, true)).status('service');
      if (!transport.configured || !transport.revision) return null;
      const secrets = await custody(installationId);
      const assignments = new Map(approved.release.secretAssignments.map(assignment => [assignment.name, assignment.secretRef]));
      const secretStatuses = (approved.manifest.manifestVersion === 2 ? approved.manifest.secrets ?? [] : []).map(secret => {
        const reference = assignments.get(secret.name);
        const status = reference ? secrets.status(reference) : { configured: false, revision: null };
        return { name: secret.name, configured: status.configured, revision: status.revision };
      });
      await runtimeCredentials.assertCurrent({ installationId, operationId: endpoint.stageOperationId, releaseDigest: endpoint.releaseDigest });
      if (digest({ endpoint: withoutRevision(endpoint), current: state.current, configurationRevision: state.configurationRevision, route }) !== endpoint.deploymentRevision) return null;

      const rawContract = managedPluginRuntimeContractSchema.parse({
        installationId,
        manifest: approved.manifest,
        manifestDigest: approved.verified.manifestDigest,
        configurationRevision,
        deploymentRevision: endpoint.deploymentRevision,
        transportCredentialRevision: transport.revision,
        secretStatuses,
        enabled: true,
      });

      // Re-read all authorities after assembling the DTO. An observed update,
      // route move, publisher revocation or credential rotation denies this snapshot.
      const latestEndpoint = await resolveActiveEndpoint({ installationId });
      if (latestEndpoint?.deploymentRevision !== endpoint.deploymentRevision) return null;
      const latestConfig = await reload();
      const latestState = await installer.coordinator.get(installationId);
      const latestRoute = await routes.read({ ownerId: latestConfig.ownerId, installationId });
      const latestApproved = findApprovedRelease(latestConfig, installationId, endpoint.releaseDigest);
      if (!latestApproved || latestState.current?.releaseDigest !== endpoint.releaseDigest
        || latestState.current.manifestDigest !== rawContract.manifestDigest
        || latestState.configurationRevision !== state.configurationRevision
        || digest(latestRoute) !== digest(route)
        || latestApproved.verified.manifestDigest !== rawContract.manifestDigest) return null;
      const latestSettings = await installer.configuration(installationId, endpoint.releaseDigest);
      if (!latestSettings.ready || latestSettings.activeRevision !== configurationRevision) return null;
      await binding.assertCurrent(installationId, configurationRevision);
      const latestTransport = (await custody(installationId, true)).status('service');
      const latestSecrets = await custody(installationId);
      const latestSecretStatuses = (latestApproved.manifest.manifestVersion === 2 ? latestApproved.manifest.secrets ?? [] : []).map(secret => {
        const reference = new Map(latestApproved.release.secretAssignments.map(assignment => [assignment.name, assignment.secretRef])).get(secret.name);
        const status = reference ? latestSecrets.status(reference) : { configured: false, revision: null };
        return { name: secret.name, configured: status.configured, revision: status.revision };
      });
      if (digest(latestTransport) !== digest(transport) || digest(latestSecretStatuses) !== digest(secretStatuses)) return null;
      await runtimeCredentials.assertCurrent({ installationId, operationId: latestEndpoint.stageOperationId, releaseDigest: endpoint.releaseDigest });
      return rawContract;
    };

    function withoutRevision(endpoint: ActiveEndpoint): DockerEndpoint {
      return { stageOperationId: endpoint.stageOperationId, deploymentId: endpoint.deploymentId,
        relayDeploymentId: endpoint.relayDeploymentId, releaseDigest: endpoint.releaseDigest,
        host: endpoint.host, port: endpoint.port, containerPort: endpoint.containerPort };
    }
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
    rpc = await createManagedPluginRpcServer({ service: installer, runtimeContract: readRuntimeContract, publicKey: createPublicKey(privateKey), privateKey, scope: configuration.scope, port: configuration.rpcPort });
    return { close: async () => { await rpc?.close(); await gateway?.close(); await store.close(); } };
  } catch { await rpc?.close(); await gateway?.close(); await store.close(); throw new Error('Installer startup failed'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startManagedPluginWorker(process.env).then(worker => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.close().catch(() => { process.exitCode = 1; }); });
    console.info('HASI managed plugin installer ready');
  }).catch(() => { console.error('HASI managed plugin installer startup failed; check operator configuration.'); process.exitCode = 1; });
}
