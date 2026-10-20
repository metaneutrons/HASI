import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { createApi, PluginRegistry } from '../apps/api/src/index.js';
import type { Registration } from '../apps/api/src/registry.js';
import { MockIdentityProvider } from '../apps/api/src/identity.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pluginId = 'replica.api-fixture';
const serviceToken = 'plugin-catalog-api-replica-token';
const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
const emptyObjectSchema = { type: 'object', properties: {}, additionalProperties: false };
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  id: pluginId,
  name: 'Replica API fixture',
  description: 'Synthetic read-only plugin for the API replica journey.',
  version: '1.0.0',
  configuration: {
    schema: {
      type: 'object',
      properties: { target: { type: 'string', minLength: 1, maxLength: 64 } },
      additionalProperties: false,
    },
    fields: [{ name: 'target', label: 'Target' }],
  },
  tools: [{
    name: 'replica.read',
    title: 'Read synthetic replica fixture',
    description: 'Returns a fixed synthetic value.',
    effect: 'read',
    requiredPermissions: ['rooms:read'],
    inputSchema: emptyObjectSchema,
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    visibility: ['model'],
    resultSemantics: { kind: 'generic' },
  }],
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

describe('plugin catalog reconciliation through two API replicas', () => {
  it('refreshes catalog administration before use and preserves admin authorization ordering', async () => {
    let pluginRequests = 0;
    const plugin = createPluginServer({
      manifest,
      publicKey,
      serviceToken,
      acceptedInstallationIds: [pluginId],
      handlers: { 'replica.read': () => Promise.resolve({ value: 'synthetic replica value' }) },
    });
    activePlugins.push(plugin);
    await plugin.listen({ host: '127.0.0.1', port: 0 });
    plugin.server.keepAliveTimeout = 1;
    plugin.server.on('request', () => { pluginRequests++; });
    const address = plugin.server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic plugin server did not bind a TCP port');

    const store = new MemoryJsonStore('plugin-catalog-api-replica');
    const scope = 'plugin-catalog-api-replica';
    const registration: Registration = {
      instanceId: pluginId,
      endpoint: `http://127.0.0.1:${String(address.port)}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(manifest),
      allowLoopback: true,
    };
    const catalog = [{ id: pluginId, label: 'Synthetic API fixture', registration }];
    const identity = new MockIdentityProvider('test');
    const registryA = new PluginRegistry(privateKey, { store, scope });
    const registryB = new PluginRegistry(privateKey, { store, scope });
    const apiA = await startApi(registryA, store, identity, catalog);
    const apiB = await startApi(registryB, store, identity, catalog);

    const refreshB = vi.spyOn(registryB, 'refreshAll');
    const configPath = `/api/admin/plugins/${pluginId}/configuration`;
    const unauthenticated = await apiB.api.inject({ url: configPath, headers });
    expect(unauthenticated.statusCode).toBe(401);
    const student = await apiB.api.inject({ url: configPath, headers: { ...headers, cookie: apiB.studentCookie } });
    expect(student.statusCode).toBe(403);
    expect(refreshB).not.toHaveBeenCalled();
    expect(pluginRequests).toBe(0);

    const connected = await apiA.api.inject({
      method: 'POST',
      url: '/api/admin/plugin-catalog/connect',
      headers: { ...headers, cookie: apiA.adminCookie },
      payload: { sourceId: pluginId },
    });
    expect(connected.statusCode, connected.body).toBe(200);

    const configuration = await apiB.api.inject({
      url: configPath,
      headers: { ...headers, cookie: apiB.adminCookie },
    });
    expect(configuration.statusCode, configuration.body).toBe(200);
    expect(configuration.json<{ ready: boolean; configuration: Record<string, unknown> }>()).toMatchObject({ ready: true, configuration: {} });

    const testConnection = await apiB.api.inject({
      method: 'POST',
      url: `/api/admin/plugins/${pluginId}/test-connection`,
      headers: { ...headers, cookie: apiB.adminCookie },
      payload: {},
    });
    expect(testConnection.statusCode, testConnection.body).toBe(200);
    expect(testConnection.json()).toMatchObject({ instanceId: pluginId, configured: 'ready', reachable: 'verified' });

    const catalogResponse = await apiB.api.inject({
      url: '/api/admin/plugin-catalog',
      headers: { ...headers, cookie: apiB.adminCookie },
    });
    expect(catalogResponse.statusCode, catalogResponse.body).toBe(200);
    expect(catalogResponse.json<{ sources: { id: string; connected: boolean }[] }>().sources).toMatchObject([{ id: pluginId, connected: true }]);

    const toolsBeforeDisable = await apiB.api.inject({ url: '/api/tools', headers: { ...headers, cookie: apiB.studentCookie } });
    expect(toolsBeforeDisable.statusCode, toolsBeforeDisable.body).toBe(200);
    expect(toolsBeforeDisable.json<{ tools: { pluginId: string; name: string }[] }>().tools.map(tool => [tool.pluginId, tool.name])).toEqual([[pluginId, 'replica.read']]);

    const disabled = await apiA.api.inject({
      method: 'POST',
      url: `/api/admin/plugins/${pluginId}/enabled`,
      headers: { ...headers, cookie: apiA.adminCookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const toolsAfterDisable = await apiB.api.inject({ url: '/api/tools', headers: { ...headers, cookie: apiB.studentCookie } });
    expect(toolsAfterDisable.statusCode, toolsAfterDisable.body).toBe(200);
    expect(toolsAfterDisable.json<{ tools: unknown[] }>().tools).toEqual([]);

    const removed = await apiA.api.inject({
      method: 'POST',
      url: `/api/admin/plugins/${pluginId}/remove`,
      headers: { ...headers, cookie: apiA.adminCookie },
      payload: { confirm: true },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const configurationAfterRemoval = await apiB.api.inject({
      url: configPath,
      headers: { ...headers, cookie: apiB.adminCookie },
    });
    expect(configurationAfterRemoval.statusCode).toBe(404);
  });
});

async function startApi(
  registry: PluginRegistry,
  store: MemoryJsonStore,
  identity: MockIdentityProvider,
  pluginCatalog: { id: string; label: string; registration: Registration }[],
): Promise<{ api: TestApi; adminCookie: string; studentCookie: string }> {
  const api = await createApi({ mode: 'test', registry, store, identity, pluginCatalog });
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
