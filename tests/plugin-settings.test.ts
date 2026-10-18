import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginServer, digest, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { PluginRegistry, createApi } from '../apps/api/src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const empty = { type: 'object', properties: {}, additionalProperties: false };
const manifest: PluginManifestV2 = {
  manifestVersion: 2, apiVersion: '2.0.0', mcpVersion: '2026-07-28', id: 'independent.reference', name: 'Reference', description: 'Reference configuration contract', version: '1.0.0',
  configuration: { schema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 50 } }, required: ['label'], additionalProperties: false }, fields: [{ name: 'label', label: 'Label' }] },
  tools: [
    { name: 'reference.read', title: 'Read', description: 'Reads the active public configuration.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: empty, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, visibility: ['model', 'app'] },
    { name: 'reference.refresh', title: 'Refresh', description: 'App-only refresh.', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: empty, outputSchema: empty, visibility: ['app'] },
  ],
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const server = createPluginServer({ manifest, publicKey, serviceToken: 'fixture-service-token', handlers: {
    'reference.read': (_args, _actor, context) => Promise.resolve({ value: context?.configuration.label }),
    'reference.refresh': () => Promise.resolve({}),
  } });
  await server.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => server.close());
  const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const store = new MemoryJsonStore('plugin-settings');
  const registration = { endpoint: `http://127.0.0.1:${String(address.port)}/mcp`, serviceToken: 'fixture-service-token', expectedManifestDigest: digest(manifest), allowLoopback: true };
  const registry = new PluginRegistry(privateKey, { store }); await registry.install(registration); cleanup.push(() => registry.close());
  const api = await createApi({ mode: 'test', registry, store }); cleanup.push(() => api.close());
  const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
  const login = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId: 'admin' } });
  const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  return { api, registry, store, registration, headers: { ...headers, cookie } };
}

describe('durable plugin configuration and policy', () => {
  it('requires a valid draft and explicit activation; transmits configuration only in signed context', async () => {
    const { api, registry, headers } = await setup();
    const path = '/api/admin/plugins/independent.reference/configuration';
    expect((await api.inject({ url: path, headers })).json<{ ready: boolean }>().ready).toBe(false);
    expect((await api.inject({ method: 'POST', url: '/api/tools/call', headers, payload: { pluginId: manifest.id, name: 'reference.read', arguments: {} } })).statusCode).toBe(409);
    expect((await api.inject({ method: 'POST', url: `${path}/draft`, headers, payload: { revision: 0, values: { label: 'Approved' }, disabledTools: [] } })).statusCode).toBe(200);
    expect((await api.inject({ url: path, headers })).json<{ ready: boolean }>().ready).toBe(false);
    expect((await api.inject({ method: 'POST', url: `${path}/activate`, headers, payload: { revision: 1 } })).statusCode).toBe(200);
    const result = await api.inject({ method: 'POST', url: '/api/tools/call', headers, payload: { pluginId: manifest.id, name: 'reference.read', arguments: {} } });
    expect(result.statusCode, result.body).toBe(200); expect(result.json()).toEqual({ value: 'Approved' });
    await registry.refreshAll();
    expect(registry.modelTools({ subject: 'person', permissions: ['rooms:read'] }).map(tool => tool.name)).toEqual(['reference.read']);
  });

  it('rejects stale revisions, unknown fields, unauthorized admins and app calls outside their read visibility', async () => {
    const { api, headers } = await setup(); const path = '/api/admin/plugins/independent.reference/configuration';
    const draft = (revision: number, values: unknown, disabledTools: string[] = []) => api.inject({ method: 'POST', url: `${path}/draft`, headers, payload: { revision, values, disabledTools } });
    expect((await draft(0, { label: 'good', credentialRef: 'env:SECRET' })).statusCode).toBe(400);
    expect((await draft(0, { label: 'good' }, ['invented'])).statusCode).toBe(400);
    expect((await draft(0, { label: 'good' })).statusCode).toBe(200);
    expect((await draft(0, { label: 'stale' })).statusCode).toBe(409);
    expect((await api.inject({ url: path, headers: { host: '127.0.0.1' } })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: `${path}/activate`, headers, payload: { revision: 1 } })).statusCode).toBe(200);
    const call = (source: 'app' | 'model') => api.inject({ method: 'POST', url: '/api/tools/call', headers, payload: { pluginId: manifest.id, name: 'reference.refresh', arguments: {}, source } });
    expect((await call('model')).statusCode).toBe(403); expect((await call('app')).statusCode).toBe(200);
  });

  it('enforces active tool policy and configuration across concurrent registry instances', async () => {
    const { registry, store, registration } = await setup();
    const second = new PluginRegistry(privateKey, { store }); cleanup.push(() => second.close()); await second.install(registration);
    await registry.settings.saveDraft(manifest.id, manifest, { revision: 0, values: { label: 'active' }, disabledTools: [] }, 'operator');
    await registry.settings.activate(manifest.id, manifest, 1, 'operator');
    const actor = { subject: 'person', permissions: ['rooms:read'] };
    await expect(second.invoke(manifest.id, 'reference.read', {}, actor)).resolves.toEqual({ value: 'active' });
    const binding = await second.binding(manifest.id);
    await registry.settings.saveDraft(manifest.id, manifest, { revision: 2, values: { label: 'changed' }, disabledTools: ['reference.read'] }, 'operator');
    expect(await second.binding(manifest.id)).toBe(binding);
    await registry.settings.activate(manifest.id, manifest, 3, 'operator');
    expect(await second.binding(manifest.id)).not.toBe(binding);
    await expect(second.invoke(manifest.id, 'reference.read', {}, actor)).rejects.toMatchObject({ status: 403 });
  });
});
