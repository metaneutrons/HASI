import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { createApi, PluginRegistry, type ApiOptions } from '../apps/api/src/index.js';
import type { Registration } from '../apps/api/src/registry.js';
import { MockIdentityProvider } from '../apps/api/src/identity.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pluginId = 'lifecycle.fixture';
const serviceToken = 'plugin-lifecycle-test-token';
const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
const emptyObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
const executionInputSchema = {
  type: 'object',
  properties: { recordId: { type: 'string' } },
  required: ['recordId'],
  additionalProperties: false,
};
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  id: pluginId,
  name: 'Lifecycle fixture',
  description: 'Exercises configuration and connection lifecycle bindings.',
  version: '1.0.0',
  configuration: {
    schema: {
      type: 'object',
      properties: { target: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['target'],
      additionalProperties: false,
    },
    fields: [{ name: 'target', label: 'Target' }],
  },
  identity: { claims: ['tenant.id'] },
  tools: [
    {
      name: 'lifecycle.prepare',
      title: 'Prepare operation',
      description: 'Creates a confirmation proposal for the configured target.',
      effect: 'prepare',
      requiredPermissions: ['rooms:prepare'],
      inputSchema: emptyObjectSchema,
      outputSchema: {
        type: 'object',
        properties: {
          draft: {
            type: 'object',
            properties: {
              executionTool: { type: 'string' },
              arguments: executionInputSchema,
              resourceName: { type: 'string' },
            },
            required: ['executionTool', 'arguments', 'resourceName'],
            additionalProperties: false,
          },
        },
        required: ['draft'],
        additionalProperties: false,
      },
      visibility: ['model'],
    },
    {
      name: 'lifecycle.execute',
      title: 'Execute operation',
      description: 'Executes the prepared operation.',
      effect: 'execute',
      requiredPermissions: ['rooms:execute'],
      inputSchema: executionInputSchema,
      outputSchema: {
        type: 'object',
        properties: { executed: { type: 'boolean' } },
        required: ['executed'],
        additionalProperties: false,
      },
      visibility: ['model'],
    },
    {
      name: 'lifecycle.read',
      title: 'Read target',
      description: 'Reads the configured target.',
      effect: 'read',
      requiredPermissions: ['rooms:read'],
      inputSchema: emptyObjectSchema,
      outputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
        additionalProperties: false,
      },
      visibility: ['model'],
    },
  ],
};

type TestApi = Awaited<ReturnType<typeof createApi>>;
type PluginServer = ReturnType<typeof createPluginServer>;
const activeApis: TestApi[] = [];
const activePlugins: PluginServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeApis.splice(0).map(api => api.close()));
  await Promise.all(activePlugins.splice(0).map(plugin => plugin.close()));
});

describe('plugin installation lifecycle bindings', () => {
  it('persists signed invalidation after disable/re-enable without exposing the proposal to another owner', async () => {
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-durable-invalidation');
    const fixture = await startPlugin(events);
    const registry = new PluginRegistry(privateKey, { store });
    await registry.install(fixture.registration);
    const runtime = await startApi({ registry, store, identity: new MockIdentityProvider('test') });
    await setTarget(runtime.api, runtime.adminCookie, 'private-original-target', 0);
    const prepared = await runtime.api.inject({ method: 'POST', url: '/api/tools/call',
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const id = prepared.json<{ proposal: { id: string } }>().proposal.id;
    await registry.setEnabled(pluginId, false);
    await registry.setEnabled(pluginId, true);

    const observer = vi.spyOn(registry, 'observeActionBinding');
    const foreign = await runtime.api.inject({ url: `/api/proposals/${id}`, headers: { ...headers, cookie: runtime.adminCookie } });
    expect(foreign.statusCode).toBe(404);
    expect(observer).not.toHaveBeenCalled();
    expect((await store.read(`proposal:${id}`))?.value).toMatchObject({ status: 'pending' });

    const read = await runtime.api.inject({ url: `/api/proposals/${id}`, headers: { ...headers, cookie: runtime.studentCookie } });
    expect(read.statusCode, read.body).toBe(409);
    expect(read.json()).toMatchObject({ code: 'proposal_invalidated' });
    expect(read.body).not.toContain('private-original-target');
    const invalidated = await store.read(`proposal:${id}`);
    expect(invalidated?.value).toMatchObject({ status: 'invalidated', invalidation: { event: { reason: 'binding_changed' } } });
    const confirm = await runtime.api.inject({ method: 'POST', url: `/api/proposals/${id}/confirm`,
      headers: { ...headers, cookie: runtime.studentCookie }, payload: {} });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toMatchObject({ code: 'proposal_invalidated' });
    expect((await store.read(`proposal:${id}`))?.revision).toBe(invalidated?.revision);
    expect(events).toEqual(['prepare:private-original-target']);
  });

  it('does not recreate invalidated state or execute after its storage retention ends', async () => {
    let storageNow = Date.now();
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-expired-invalidation', { clock: () => storageNow });
    const fixture = await startPlugin(events);
    const registry = new PluginRegistry(privateKey, { store });
    await registry.install(fixture.registration);
    const runtime = await startApi({ registry, store, identity: new MockIdentityProvider('test') });
    await setTarget(runtime.api, runtime.adminCookie, 'expired-private-target', 0);
    const prepared = await runtime.api.inject({ method: 'POST', url: '/api/tools/call',
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const proposal = prepared.json<{ proposal: { id: string; expiresAt: string } }>().proposal;
    await registry.setEnabled(pluginId, false);
    const invalidated = await runtime.api.inject({ url: `/api/proposals/${proposal.id}`,
      headers: { ...headers, cookie: runtime.studentCookie } });
    expect(invalidated.statusCode, invalidated.body).toBe(409);
    expect(invalidated.json()).toMatchObject({ code: 'proposal_invalidated' });
    expect(await store.read(`proposal:${proposal.id}`)).toBeDefined();

    // Advance only the storage clock. The mock login remains valid, so a 404
    // proves proposal retention expiry rather than an authentication failure.
    storageNow = Date.parse(proposal.expiresAt) + 86_400_001;
    const writer = vi.spyOn(store, 'compareAndSet');
    const observer = vi.spyOn(registry, 'observeActionBinding');
    for (const method of ['GET', 'POST'] as const) {
      const response = await runtime.api.inject({ method,
        url: `/api/proposals/${proposal.id}${method === 'POST' ? '/confirm' : ''}`,
        headers: { ...headers, cookie: runtime.studentCookie }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('expired-private-target');
    }
    expect(await store.read(`proposal:${proposal.id}`)).toBeUndefined();
    expect(writer).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(events).toEqual(['prepare:expired-private-target']);
  });

  it('preserves a pending proposal during unavailable authority and executes it once after recovery', async () => {
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-observation-outage');
    const fixture = await startPlugin(events);
    const registry = new PluginRegistry(privateKey, { store });
    await registry.install(fixture.registration);
    const runtime = await startApi({ registry, store, identity: new MockIdentityProvider('test') });
    await setTarget(runtime.api, runtime.adminCookie, 'recoverable-target', 0);
    const prepared = await runtime.api.inject({ method: 'POST', url: '/api/tools/call',
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const id = prepared.json<{ proposal: { id: string } }>().proposal.id;
    const before = await store.read(`proposal:${id}`);
    const outage = vi.spyOn(registry, 'observeActionBinding').mockResolvedValue({ status: 'unavailable' });
    for (const method of ['GET', 'POST'] as const) {
      const response = await runtime.api.inject({ method, url: `/api/proposals/${id}${method === 'POST' ? '/confirm' : ''}`,
        headers: { ...headers, cookie: runtime.studentCookie }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode, response.body).toBe(503);
      expect(await store.read(`proposal:${id}`)).toEqual(before);
    }
    expect(events).toEqual(['prepare:recoverable-target']);
    outage.mockRestore();
    const current = await runtime.api.inject({ url: `/api/proposals/${id}`, headers: { ...headers, cookie: runtime.studentCookie } });
    expect(current.statusCode, current.body).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const confirmed = await runtime.api.inject({ method: 'POST', url: `/api/proposals/${id}/confirm`,
        headers: { ...headers, cookie: runtime.studentCookie }, payload: {} });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ proposal: { status: 'confirmed' } });
    }
    expect(events).toEqual(['prepare:recoverable-target', 'execute:recoverable-target']);
  });

  it('rejects a confirmation when configuration changes after the route check but before invoke', async () => {
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-config-race');
    const identity = new MockIdentityProvider('test');
    const fixture = await startPlugin(events);
    const registry = new PluginRegistry(privateKey, { store });
    await registry.install(fixture.registration);
    const runtime = await startApi({ registry, store, identity });
    await setTarget(runtime.api, runtime.adminCookie, 'target-before', 0);

    const prepare = await runtime.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} },
    });
    expect(prepare.statusCode, prepare.body).toBe(200);
    const proposal = prepare.json<{ proposal: { id: string; arguments: { recordId: string } } }>().proposal;
    expect(proposal.arguments.recordId).toBe('target-before');

    const originalInvoke = registry.invoke.bind(registry);
    let changedAfterRouteCheck = false;
    vi.spyOn(registry, 'invoke').mockImplementation(async (...parameters) => {
      const [id, name, args, actor, execution, source, expectedBinding] = parameters;
      if (execution && expectedBinding !== undefined && !changedAfterRouteCheck) {
        changedAfterRouteCheck = true;
        await setTarget(runtime.api, runtime.adminCookie, 'target-after', 2);
      }
      return originalInvoke(id, name, args, actor, execution, source, expectedBinding);
    });

    const confirmation = await runtime.api.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/confirm`,
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: {},
    });

    expect(changedAfterRouteCheck).toBe(true);
    expect(confirmation.statusCode, confirmation.body).toBe(409);
    expect(confirmation.body).not.toContain('target-before');
    expect((await store.read(`proposal:${proposal.id}`))?.value).toMatchObject({ status: 'outcome_unknown' });
    expect(events).toEqual(['prepare:target-before']);
  });

  it('invalidates pending proposals when a connected catalog source moves to another endpoint', async () => {
    const eventsAtOriginalEndpoint: string[] = [];
    const eventsAtReplacementEndpoint: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-endpoint-swap');
    const identity = new MockIdentityProvider('test');
    const original = await startPlugin(eventsAtOriginalEndpoint);
    const originalSource = source(original.registration);
    const firstRegistry = new PluginRegistry(privateKey, { store });
    const firstRuntime = await startApi({ registry: firstRegistry, store, identity, pluginCatalog: [originalSource] });
    await connectSource(firstRuntime.api, firstRuntime.adminCookie);
    await setTarget(firstRuntime.api, firstRuntime.adminCookie, 'target-original', 0);

    const prepare = await firstRuntime.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...headers, cookie: firstRuntime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} },
    });
    expect(prepare.statusCode, prepare.body).toBe(200);
    const proposal = prepare.json<{ proposal: { id: string } }>().proposal;

    const replacement = await startPlugin(eventsAtReplacementEndpoint);
    const replacementSource = source(replacement.registration);
    const secondRegistry = new PluginRegistry(privateKey, { store });
    const secondRuntime = await startApi({ registry: secondRegistry, store, identity, pluginCatalog: [replacementSource] });
    const confirmation = await secondRuntime.api.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/confirm`,
      headers: { ...headers, cookie: firstRuntime.studentCookie },
      payload: {},
    });

    expect(confirmation.statusCode, confirmation.body).toBe(409);
    expect(eventsAtOriginalEndpoint).toEqual(['prepare:target-original']);
    expect(eventsAtReplacementEndpoint).toEqual([]);
  });

  it('keeps a removed catalog source unavailable on another registry sharing the store', async () => {
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-remove-replica');
    const identity = new MockIdentityProvider('test');
    const fixture = await startPlugin(events);
    const approvedSource = source(fixture.registration);
    const registryA = new PluginRegistry(privateKey, { store });
    const runtimeA = await startApi({ registry: registryA, store, identity, pluginCatalog: [approvedSource] });
    await connectSource(runtimeA.api, runtimeA.adminCookie);
    await setTarget(runtimeA.api, runtimeA.adminCookie, 'target-shared', 0);

    const registryB = new PluginRegistry(privateKey, { store });
    const runtimeB = await startApi({ registry: registryB, store, identity, pluginCatalog: [approvedSource] });
    const beforeRemoval = await runtimeB.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...headers, cookie: runtimeB.studentCookie },
      payload: { pluginId, name: 'lifecycle.read', arguments: {} },
    });
    expect(beforeRemoval.statusCode, beforeRemoval.body).toBe(200);

    const removed = await runtimeA.api.inject({
      method: 'POST',
      url: `/api/admin/plugins/${pluginId}/remove`,
      headers: { ...headers, cookie: runtimeA.adminCookie },
      payload: { confirm: true },
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const reenable = await runtimeB.api.inject({
      method: 'POST',
      url: `/api/admin/plugins/${pluginId}/enabled`,
      headers: { ...headers, cookie: runtimeB.adminCookie },
      payload: { enabled: true },
    });
    // Reconciliation withdraws the removed source before the mutation is resolved.
    expect(reenable.statusCode, reenable.body).toBe(404);

    const tools = await runtimeB.api.inject({ url: '/api/tools', headers: { ...headers, cookie: runtimeB.studentCookie } });
    expect(tools.statusCode, tools.body).toBe(200);
    expect(tools.json<{ tools: unknown[] }>().tools).toEqual([]);
    const afterRemoval = await runtimeB.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...headers, cookie: runtimeB.studentCookie },
      payload: { pluginId, name: 'lifecycle.read', arguments: {} },
    });
    expect(afterRemoval.statusCode).toBe(404);
    expect(events).toEqual(['read:target-shared']);
  });

  it('rejects confirmation after the user authority claims change', async () => {
    const events: string[] = [];
    const store = new MemoryJsonStore('plugin-lifecycle-authority-change');
    const identity = new MockIdentityProvider('test');
    const originalResolve = identity.resolve.bind(identity);
    let tenant = 'tenant-before';
    vi.spyOn(identity, 'resolve').mockImplementation(token => {
      const user = originalResolve(token);
      return user ? {
        ...user,
        actor: { ...user.actor, claims: { ...user.actor.claims, 'tenant.id': tenant } },
      } : undefined;
    });
    const fixture = await startPlugin(events);
    const registry = new PluginRegistry(privateKey, { store });
    await registry.install(fixture.registration);
    const runtime = await startApi({ registry, store, identity });
    await setTarget(runtime.api, runtime.adminCookie, 'target-shared', 0);

    const prepare = await runtime.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: { pluginId, name: 'lifecycle.prepare', arguments: {} },
    });
    expect(prepare.statusCode, prepare.body).toBe(200);
    const proposal = prepare.json<{ proposal: { id: string } }>().proposal;
    tenant = 'tenant-after';

    const confirmation = await runtime.api.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/confirm`,
      headers: { ...headers, cookie: runtime.studentCookie },
      payload: {},
    });

    expect(confirmation.statusCode, confirmation.body).toBe(409);
    expect(events).toEqual(['prepare:target-shared']);
  });
});

async function startPlugin(events: string[]): Promise<{
  readonly registration: Registration;
}> {
  const plugin = createPluginServer({
    manifest,
    publicKey,
    serviceToken,
    handlers: {
      'lifecycle.prepare': (_args, _actor, context) => {
        const target = context?.configuration.target;
        const configuredTarget = typeof target === 'string' ? target : 'missing-target';
        events.push(`prepare:${configuredTarget}`);
        return Promise.resolve({
          draft: {
            executionTool: 'lifecycle.execute',
            arguments: { recordId: configuredTarget },
            resourceName: 'Lifecycle target',
          },
        });
      },
      'lifecycle.execute': (_args, _actor, context) => {
        const target = context?.configuration.target;
        events.push(`execute:${typeof target === 'string' ? target : 'missing-target'}`);
        return Promise.resolve({ executed: true });
      },
      'lifecycle.read': (_args, _actor, context) => {
        const target = context?.configuration.target;
        const configuredTarget = typeof target === 'string' ? target : 'missing-target';
        events.push(`read:${configuredTarget}`);
        return Promise.resolve({ target: configuredTarget });
      },
    },
  });
  activePlugins.push(plugin);
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  const address = plugin.server.address();
  if (!address || typeof address === 'string') throw new Error('Plugin server did not bind a TCP port.');
  return {
    registration: {
      instanceId: pluginId,
      endpoint: `http://127.0.0.1:${String(address.port)}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(manifest),
      allowLoopback: true,
    },
  };
}

function source(registration: Registration) {
  return { id: pluginId, label: 'Lifecycle fixture', registration };
}

async function startApi(input: {
  readonly registry: PluginRegistry;
  readonly store: MemoryJsonStore;
  readonly identity: MockIdentityProvider;
  readonly pluginCatalog?: ApiOptions['pluginCatalog'];
}): Promise<{ readonly api: TestApi; readonly adminCookie: string; readonly studentCookie: string }> {
  const api = await createApi({
    mode: 'test',
    registry: input.registry,
    store: input.store,
    identity: input.identity,
    ...(input.pluginCatalog ? { pluginCatalog: input.pluginCatalog } : {}),
  });
  activeApis.push(api);
  const adminCookie = await login(api, 'admin');
  const studentCookie = await login(api, 'student');
  return { api, adminCookie, studentCookie };
}

async function login(api: TestApi, personaId: 'admin' | 'student'): Promise<string> {
  const response = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId } });
  expect(response.statusCode, response.body).toBe(200);
  const sessionCookie = response.cookies.find(cookie => cookie.name === 'hasi-session');
  if (!sessionCookie) throw new Error('Login did not return a session cookie.');
  return `${sessionCookie.name}=${sessionCookie.value}`;
}

async function connectSource(api: TestApi, adminCookie: string): Promise<void> {
  const response = await api.inject({
    method: 'POST',
    url: '/api/admin/plugin-catalog/connect',
    headers: { ...headers, cookie: adminCookie },
    payload: { sourceId: pluginId },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function setTarget(api: TestApi, adminCookie: string, target: string, revision: number): Promise<void> {
  const path = `/api/admin/plugins/${pluginId}/configuration`;
  const draft = await api.inject({
    method: 'POST',
    url: `${path}/draft`,
    headers: { ...headers, cookie: adminCookie },
    payload: { revision, values: { target }, disabledTools: [] },
  });
  expect(draft.statusCode, draft.body).toBe(200);
  const activation = await api.inject({
    method: 'POST',
    url: `${path}/activate`,
    headers: { ...headers, cookie: adminCookie },
    payload: { revision: revision + 1 },
  });
  expect(activation.statusCode, activation.body).toBe(200);
}
