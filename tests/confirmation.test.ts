import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, type PluginManifest } from '@hasi/plugin-sdk';
import { createApi, PluginRegistry } from '../apps/api/src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pluginId = 'rooms-booking';
const serviceToken = 'confirmation-test-service-token';
const apiHeaders = { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:3000' };
const emptyObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
const bookingArgumentsSchema = {
  type: 'object',
  properties: { bookingId: { type: 'string' } },
  required: ['bookingId'],
  additionalProperties: false,
};
const manifest: PluginManifest = {
  manifestVersion: 1,
  id: pluginId,
  name: 'Room booking test plugin',
  description: 'Exercises prepare and execute confirmation through the real plugin runtime.',
  version: '0.1.0',
  apiVersion: '1.0.0',
  mcpVersion: '2026-07-28',
  tools: [
    {
      name: 'rooms.prepare',
      title: 'Prepare a room booking',
      description: 'Prepare a synthetic room booking.',
      inputSchema: emptyObjectSchema,
      outputSchema: {
        type: 'object',
        properties: {
          draft: {
            type: 'object',
            properties: {
              executionTool: { type: 'string' },
              arguments: bookingArgumentsSchema,
              resourceName: { type: 'string' },
            },
            required: ['executionTool', 'arguments', 'resourceName'],
            additionalProperties: false,
          },
        },
        required: ['draft'],
        additionalProperties: false,
      },
      effect: 'prepare',
      requiredPermissions: ['rooms:prepare'],
    },
    {
      name: 'rooms.execute',
      title: 'Execute a room booking',
      description: 'Execute a synthetic room booking.',
      inputSchema: bookingArgumentsSchema,
      outputSchema: {
        type: 'object',
        properties: { executed: { type: 'boolean' } },
        required: ['executed'],
        additionalProperties: false,
      },
      effect: 'execute',
      requiredPermissions: ['rooms:execute'],
    },
  ],
};

type TestApi = Awaited<ReturnType<typeof createApi>>;
const activePlugins: ReturnType<typeof createPluginServer>[] = [];
const activeApis: TestApi[] = [];

afterEach(async () => {
  await Promise.all(activeApis.splice(0).map((api) => api.close()));
  await Promise.all(activePlugins.splice(0).map((plugin) => plugin.close()));
});

describe('proposal confirmation outcome handling', () => {
  it('never retries an execute call after its outcome becomes unknown', async () => {
    const sideEffect = { count: 0 };
    const { api, cookie } = await setupApi(sideEffect);
    const prepare = await createProposal(api, cookie);
    const confirmUrl = `/api/proposals/${prepare.id}/confirm`;

    const first = await api.inject({
      method: 'POST',
      url: confirmUrl,
      headers: { ...apiHeaders, cookie },
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ proposal: { status: string } }>().proposal.status).toBe('outcome_unknown');
    expect(sideEffect.count).toBe(1);

    const replay = await api.inject({
      method: 'POST',
      url: confirmUrl,
      headers: { ...apiHeaders, cookie },
      payload: {},
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<{ proposal: { status: string } }>().proposal.status).toBe('outcome_unknown');
    expect(sideEffect.count).toBe(1);
  });

  it('rejects an expired proposal before invoking the execute handler', async () => {
    const sideEffect = { count: 0 };
    const { api, cookie } = await setupApi(sideEffect);
    const prepare = await createProposal(api, cookie);
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 301_000);
    let response;
    try {
      response = await api.inject({
        method: 'POST',
        url: `/api/proposals/${prepare.id}/confirm`,
        headers: { ...apiHeaders, cookie },
        payload: {},
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(response.statusCode, response.body).toBe(409);
    expect(sideEffect.count).toBe(0);
  });
});

async function setupApi(sideEffect: { count: number }): Promise<{ api: TestApi; cookie: string }> {
  const plugin = createPluginServer({
    manifest,
    publicKey,
    serviceToken,
    handlers: {
      'rooms.prepare': async () => await Promise.resolve({
        draft: {
          executionTool: 'rooms.execute',
          arguments: { bookingId: 'synthetic-booking-123' },
          resourceName: 'Seminarraum',
        },
      }),
      'rooms.execute': async () => {
        sideEffect.count += 1;
        await Promise.resolve();
        throw new Error('Synthetic execution failure after the side effect.');
      },
    },
  });
  plugin.server.keepAliveTimeout = 1;
  activePlugins.push(plugin);
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  const address = plugin.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Plugin server did not bind a TCP port');
  }
  const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;
  const registry = new PluginRegistry(privateKey);
  await registry.install({ endpoint, serviceToken, expectedManifestDigest: digest(manifest), allowLoopback: true });
  const api = await createApi({ mode: 'test', registry });
  activeApis.push(api);
  const login = await api.inject({
    method: 'POST',
    url: '/api/dev/login',
    headers: apiHeaders,
    payload: { personaId: 'student' },
  });
  expect(login.statusCode, login.body).toBe(200);
  const sessionCookie = login.cookies[0];
  if (!sessionCookie) {
    throw new Error('Test login did not return a session cookie');
  }
  return { api, cookie: `${sessionCookie.name}=${sessionCookie.value}` };
}

async function createProposal(api: TestApi, cookie: string): Promise<{ id: string }> {
  const response = await api.inject({
    method: 'POST',
    url: '/api/tools/call',
    headers: { ...apiHeaders, cookie },
    payload: { pluginId, name: 'rooms.prepare', arguments: {} },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ proposal: { id: string } }>().proposal;
}
