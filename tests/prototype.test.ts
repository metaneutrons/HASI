import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAnnyMock, MOCK_IDS } from '@hasi/anny-mock';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyPlugin, annyManifest, demoPresentation } from '@hasi/anny-plugin';
import { digest, manifestSchema } from '@hasi/plugin-sdk';
import { createApi, PluginRegistry, assertMockMode, compatibleUpdate } from '../apps/api/src/index.js';

describe('prototype identity, plugin and external API boundaries', () => {
  it('rejects mock authentication outside development or test', () => {
    expect(() => { assertMockMode('production'); }).toThrow();
    expect(() => { assertMockMode('development'); }).not.toThrow();
  });
  it('allows compatible patch updates but blocks changed permissions and schemas', () => {
    const patch = { ...annyManifest, version: '0.2.1' };
    expect(compatibleUpdate(annyManifest, patch)).toBe(true);
    expect(manifestSchema.safeParse({ ...patch, apiVersion: '2.0.0' }).success).toBe(false);
    expect(compatibleUpdate(annyManifest, { ...patch, tools: patch.tools.map(tool => ({ ...tool, requiredPermissions: ['administrator'] })) })).toBe(false);
  });
  it('uses actual HTTP through MCP, isolates users and binds confirmation to a single external booking', async () => {
    const mock = createAnnyMock({ token: 'synthetic-anny-token' });
    await mock.listen({ host: '127.0.0.1', port: 0 });
    const mockOrigin = `http://127.0.0.1:${String((mock.server.address() as { port: number }).port)}`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const client = new AnnyClient({ baseUrl: mockOrigin, organizationId: '00000000-0000-4000-8000-000000000001', token: 'synthetic-anny-token', allowLoopback: true, allowWrites: true });
    const plugin = createAnnyPlugin({ client, publicKey, serviceToken: 'synthetic-plugin-token', presentation: demoPresentation });
    await plugin.listen({ host: '127.0.0.1', port: 0 });
    const endpoint = `http://127.0.0.1:${String((plugin.server.address() as { port: number }).port)}/mcp`;
    const registry = new PluginRegistry(privateKey);
    await registry.install({ endpoint, serviceToken: 'synthetic-plugin-token', expectedManifestDigest: digest(annyManifest), allowLoopback: true });
    const api = await createApi({ mode: 'test', registry });
    const headers = { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:3000' };
    const login = async (personaId: string) => {
      const response = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId } });
      expect(response.statusCode).toBe(200);
      return response.cookies[0]!.name + '=' + response.cookies[0]!.value;
    };
    try {
      expect((await api.inject({ method: 'GET', url: '/api/resources', headers })).statusCode).toBe(401);
      expect((await api.inject({ method: 'POST', url: '/api/dev/login', headers: { host: headers.host, origin: 'https://attacker.invalid' }, payload: { personaId: 'admin' } })).statusCode).toBe(403);
      const student = await login('student');
      const employee = await login('employee');
      const resources = await api.inject({ url: '/api/resources', headers: { ...headers, cookie: student } });
      expect(resources.statusCode).toBe(200);
      const data = resources.json<{ resources: { id: string; serviceId: string }[] }>();
      expect(data.resources).toHaveLength(2);
      expect((await api.inject({ url: '/api/admin/plugins', headers: { ...headers, cookie: student } })).statusCode).toBe(403);
      const tomorrow = new Date(Date.now() + 86400000); tomorrow.setUTCHours(9, 0, 0, 0);
      const args = { resourceId: data.resources[0]!.id, serviceId: data.resources[0]!.serviceId, startDate: tomorrow.toISOString(), endDate: new Date(tomorrow.getTime() + 3600000).toISOString() };
      const forbidden = await api.inject({ method: 'POST', url: '/api/proposals', headers: { ...headers, cookie: student }, payload: { ...args, resourceId: '00000000-0000-4000-8000-000000000103' } });
      expect(forbidden.statusCode).toBe(403);
      expect((await api.inject({ method: 'POST', url: '/api/tools/call', headers: { ...headers, cookie: student }, payload: { pluginId: annyManifest.id, name: 'anny.execute_booking', arguments: args } })).statusCode).toBe(403);
      const response = await api.inject({ method: 'POST', url: '/api/proposals', headers: { ...headers, cookie: student }, payload: args });
      expect(response.statusCode, response.body).toBe(200);
      const { proposal } = response.json<{ proposal: { id: string } }>();
      const confirm = `/api/proposals/${proposal.id}/confirm`;
      expect((await api.inject({ method: 'POST', url: confirm, headers: { ...headers, cookie: employee }, payload: {} })).statusCode).toBe(404);
      expect((await api.inject({ method: 'POST', url: confirm, headers: { ...headers, cookie: student }, payload: { resourceId: args.resourceId } })).statusCode).toBe(400);
      const execution = await api.inject({ method: 'POST', url: confirm, headers: { ...headers, cookie: student }, payload: {} });
      expect(execution.json<{ proposal: { status: string } }>().proposal.status, execution.body).toBe('confirmed');
      const replay = await api.inject({ method: 'POST', url: confirm, headers: { ...headers, cookie: student }, payload: {} });
      expect(replay.json<{ proposal: { status: string } }>().proposal.status).toBe('confirmed');
      const bookings = await client.listBookings('00000000-0000-4000-8000-000000000301');
      expect(bookings.filter(booking => booking.resourceId === args.resourceId && booking.startDate === args.startDate)).toHaveLength(1);
      await registry.setEnabled(annyManifest.id, false);
      expect((await api.inject({ url: '/api/resources', headers: { ...headers, cookie: student } })).statusCode).toBe(409);
      expect(MOCK_IDS).toBeDefined();
    } finally { await api.close(); await plugin.close(); await mock.close(); }
  });
});
