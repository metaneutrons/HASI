import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPluginServer, digest, manifestSchema, type ActorContext, type ExecutionBinding, type ExecutionStore, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type FencedJsonStore } from '@hasi/state';
import { PluginRegistry } from '../../apps/api/src/registry.js';
import { PluginAccountService, type PluginAccountAdapter } from '../../apps/api/src/plugin-accounts.js';
import { PluginDeploymentBinding } from '../../apps/api/src/plugin-deployment-binding.js';
import { PluginRouteController } from '../../apps/api/src/plugin-route-controller.js';
import { createPluginDeploymentGateway } from '../../apps/api/src/plugin-deployment-proxy.js';
import { ProductionAuthorityDirectory } from '../../apps/api/src/production-runtime.js';
import type { ManagedPluginRuntimeContract } from '../../apps/api/src/managed-plugin-contract.js';

const close: (() => Promise<unknown>)[] = [];
export async function closeManagedStateFixtures() { for (const cleanup of close.splice(0).reverse()) await cleanup(); }
const permissions = ['reference:read', 'reference:prepare', 'reference:execute'];
const actor: ActorContext = { subject: 'synthetic-managed-user', permissions };
const id = 'reference-installation';
const ownerId = 'test-operator';
const serviceToken = 'managed-state-registry-synthetic';
const bindingSchema = { type: 'object', properties: {
  subject: { type: 'string' }, installationId: { type: 'string' }, executionId: { type: 'string', format: 'uuid' },
  tool: { type: 'string' }, argsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, configurationRevision: { type: 'integer', minimum: 0 },
}, required: ['subject', 'installationId', 'executionId', 'tool', 'argsHash', 'configurationRevision'], additionalProperties: false };
const resultSchema = { type: 'object', properties: { confirmed: { const: true }, actionCount: { type: 'integer', minimum: 1 }, label: { type: 'string' }, account: { type: 'string' } }, required: ['confirmed', 'actionCount', 'label', 'account'], additionalProperties: false };
const applicationSchema = { type: 'object', properties: {
  version: { const: 1 }, actionCount: { type: 'integer', minimum: 0 },
  receipts: { type: 'object', patternProperties: { '^[a-f0-9]{64}$': { type: 'object', properties: { binding: bindingSchema, account: { type: 'string' }, result: resultSchema }, required: ['binding', 'account', 'result'], additionalProperties: false } }, additionalProperties: false },
}, required: ['version', 'actionCount', 'receipts'], additionalProperties: false };

interface Source {
  count(installation: string, user: ActorContext): Promise<number>;
  mark(binding: ExecutionBinding, args: Record<string, unknown>, user: ActorContext): Promise<Record<string, unknown>>;
  resolve(binding: ExecutionBinding, user: ActorContext): Promise<Record<string, unknown> | undefined>;
}

export async function fixture(store: FencedJsonStore = new MemoryJsonStore(`wire-${randomUUID()}`), accountKind: 'claim' | 'customerId' = 'claim') {
  const keys = generateKeyPairSync('ed25519');
  const scope = randomUUID();
  const directory = new ProductionAuthorityDirectory(store, keys.privateKey, scope);
  await directory.replace(actor.subject, null, { id: actor.subject, displayName: 'Synthetic', role: 'admin', actor });
  const sourceModule = await import(new URL('../../examples/reference-plugin/src/state.js', import.meta.url).href) as unknown as { createManagedReferenceState(store: ExecutionStore): Source };
  const plain = manifestSchema.parse(JSON.parse(await readFile(new URL('../../examples/reference-plugin/src/manifest.json', import.meta.url), 'utf8'))) as PluginManifestV2;
  delete plain.configuration;
  const first: PluginManifestV2 = { ...plain, mcpVersion: '2025-11-25', managedState: { schemaVersion: 1, accountIdentity: accountKind === 'claim' ? { kind: 'claim', name: 'reference.account' } : { kind: 'customerId' }, applicationSchema } };
  const second = { ...first, version: '1.1.0' };
  let active = 0; let lostAck = false; let executions = 0;
  let beforeWrite: (() => Promise<void>) | undefined;
  const ports: number[] = [];
  for (const manifest of [first, second]) {
    const server = createPluginServer({ manifest, serviceToken, publicKey: keys.publicKey, acceptedInstallationIds: [id],
      reconcileExecution: (binding, user, services) => {
        if (!services) throw new Error('Managed state required');
        return sourceModule.createManagedReferenceState(services.state).resolve(binding, user);
      }, handlers: {
        read_status: async (_args, user, context, services) => {
          if (!services || !context) throw new Error('Managed state required');
          return { label: 'Synthetic', version: manifest.version, account: user.claims?.['reference.account'], actionCount: await sourceModule.createManagedReferenceState(services.state).count(context.installationId, user) };
        },
        prepare_mark: () => Promise.resolve({ draft: { executionTool: 'execute_mark', arguments: { label: 'Synthetic' }, resourceName: 'Synthetic' } }),
        execute_mark: async (args, user, context, services) => {
          if (!services || !context?.executionId) throw new Error('Managed state required');
          await beforeWrite?.();
          const binding: ExecutionBinding = { subject: user.subject, installationId: context.installationId, executionId: context.executionId, tool: 'execute_mark', argsHash: digest(args), configurationRevision: context.configurationRevision };
          const value = await sourceModule.createManagedReferenceState(services.state).mark(binding, args, user);
          executions++;
          if (lostAck) { lostAck = false; throw new Error('Synthetic lost source acknowledgment'); }
          return value;
        },
      } });
    await server.listen({ host: '127.0.0.1', port: 0 }); close.push(() => server.close());
    const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port'); ports.push(address.port);
  }
  const routes = new PluginRouteController({ store, scope, ownerId });
  const release = (index: number) => digest({ release: index });
  await routes.initializeInstallation({ installationId: id, configurationRevision: '0', activeDeploymentId: 'deployment-0', activeReleaseDigest: release(0) });
  const currentContract = async (): Promise<ManagedPluginRuntimeContract> => {
    const route = await routes.read({ ownerId, installationId: id });
    const manifest = active === 0 ? first : second;
    return { installationId: id, manifest, manifestDigest: digest(manifest), configurationRevision: 0, deploymentRevision: digest(route), transportCredentialRevision: 'test-transport-1', secretStatuses: [], enabled: true };
  };
  const endpoint = async () => {
    const port = ports[active]; if (port === undefined) throw new Error('Missing active test port');
    return { deploymentId: `deployment-${String(active)}`, relayDeploymentId: 'd'.repeat(64), releaseDigest: release(active),
      host: '127.0.0.1' as const, port, containerPort: 3000, deploymentRevision: (await currentContract()).deploymentRevision };
  };
  const gateway = await createPluginDeploymentGateway({ port: 0, authorize: value => value.authorization === `Bearer ${serviceToken}`,
    endpointResolver: { resolveActiveEndpoint: endpoint, assertActiveEndpoint: async input => digest(input.endpoint) === digest(await endpoint()) } });
  close.push(() => gateway.close());
  let linked = false; let account = 'account-a'; let revision = 0;
  const adapter: PluginAccountAdapter = { trustLevel: 'trusted', authorizationOrigins: ['https://account.example.test'],
    begin: ({ state }) => Promise.resolve({ authorizationUrl: `https://account.example.test/authorize?state=${encodeURIComponent(state)}` }),
    complete: () => { revision++; linked = true; return Promise.resolve({ authorityRevision: revision, expiresAt: null }); },
    inspect: () => Promise.resolve(linked ? { status: 'active', authorityRevision: revision, expiresAt: null, projection: { permissions, customerId: account, claims: { 'reference.account': account } } } : { status: 'revoked', authorityRevision: revision, expiresAt: null }),
    revoke: () => { linked = false; return Promise.resolve(); },
  };
  const accounts = new PluginAccountService({ privateKey: keys.privateKey, store, scope, installationId: id, mode: 'test', adapter });
  const link = async () => { const start = await accounts.begin(actor.subject, { operation: 'consent', returnTo: '/' }); const state = new URL(start.authorizationUrl).searchParams.get('state'); if (!state) throw new Error('Missing consent state'); await accounts.complete(actor.subject, state, { state, code: 'synthetic' }); };
  await link();
  const construct = () => {
    const binding = new PluginDeploymentBinding({ routes, ownerId, readAuthoritativeRevision: async () => (await registry.settings.read(id, first)).activeRevision });
    const registry: PluginRegistry = new PluginRegistry(keys.privateKey, { store, scope, operatorManagedLoopbackOrigin: gateway.origin,
      resolveActor: async subject => (await directory.resolve(subject))?.actor,
      resolveActorSnapshot: async subject => { const value = await directory.resolveSnapshot(subject); return value ? { actor: value.persona.actor, fence: value.fence } : undefined; },
      accounts: new Map([[id, accounts]]), deploymentBindings: new Map([[id, binding]]), managedContracts: new Map([[id, { initialManifest: first, read: currentContract }]]) });
    registry.configureCatalog([{ id, label: 'Synthetic state wire', registration: { instanceId: id, endpoint: `${gateway.origin}/api/plugin-deployments/${id}/mcp`, serviceToken, allowLoopback: false, expectedManifestDigest: digest(first) } }]);
    close.push(() => registry.close()); return registry;
  };
  const registry = construct(); await registry.connectSource(id);
  return { registry, construct, store, accounts, subject: actor.subject,
    executions: () => executions, loseAck: () => { lostAck = true; }, beforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback; },
    read: (current = registry) => current.invoke(id, 'read_status', {}, actor),
    execute: async (executionId = randomUUID(), current = registry) => current.invoke(id, 'execute_mark', { label: 'Synthetic' }, actor, true, 'model', await current.binding(id), executionId),
    status: async (executionId: string, current = registry) => current.reconcile(id, 'execute_mark', { label: 'Synthetic' }, actor, executionId, await current.binding(id)),
    async update() { await routes.activate({ ownerId, installationId: id, operationId: randomUUID(), candidateDeploymentId: 'deployment-1', candidateReleaseDigest: release(1), previousDeploymentId: 'deployment-0', baseCurrentDigest: release(0), configurationRevision: '0' }); active = 1; },
    async rollback() { await routes.rollback({ ownerId, installationId: id, operationId: randomUUID(), currentDeploymentId: 'deployment-1', currentReleaseDigest: release(1), previousDeploymentId: 'deployment-0', previousReleaseDigest: release(0), baseCurrentDigest: release(1), configurationRevision: '0' }); active = 0; },
    async switchAccount() { const authority = await accounts.resolveAuthority(actor.subject); await accounts.disconnect(actor.subject, authority.authorityRevision); account = 'account-b'; await link(); },
  };
}

