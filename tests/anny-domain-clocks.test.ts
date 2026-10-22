import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyMock, MOCK_IDS, type AnnyMockCatalog } from '@hasi/anny-mock';
import { annyManifest, createAnnyPlugin, type Presentation } from '@hasi/anny-plugin';
import { createInvocationToken, type ActorContext } from '@hasi/plugin-sdk';

const MOCK_TOKEN = 'anny-domain-clock-contract-token';
const PLUGIN_TOKEN = 'anny-domain-clock-plugin-token';
const RESOURCE_ID = 'clock-room';
const SERVICE_ID = 'clock-service';
const DOMAIN_NOW = Date.parse('1999-12-31T00:00:00.000Z');
const START = '2000-01-02T09:00:00.000Z';
const END = '2000-01-02T10:00:00.000Z';
const ARGUMENTS = { resourceId: RESOURCE_ID, serviceId: SERVICE_ID, startDate: START, endDate: END };
const ACTOR: ActorContext = {
  subject: 'clock-test-user',
  permissions: ['rooms:prepare'],
  resourceIds: [RESOURCE_ID],
};
const CATALOG: AnnyMockCatalog = {
  resources: [{
    id: RESOURCE_ID,
    name: 'Clock test room',
    description: 'A local contract-test room.',
    capacity: 4,
    location: 'Synthetic campus',
    features: [],
    serviceId: SERVICE_ID,
  }],
  services: [{ id: SERVICE_ID, name: 'Clock test booking' }],
};
const PRESENTATION: Record<string, Presentation> = {
  [RESOURCE_ID]: { capacity: 4, location: 'Synthetic campus', features: [], serviceId: SERVICE_ID },
};

describe('Anny domain clock seams', () => {
  it('allows a past-real interval under the trusted domain clock and verifies a native signed proposal', async () => {
    expect(Date.parse(START)).toBeLessThan(Date.now());
    const mock = createAnnyMock({
      token: MOCK_TOKEN,
      scope: 'domain-clock-frozen',
      catalog: CATALOG,
      availabilityNow: () => DOMAIN_NOW,
    });
    const clientFixture = clientFor(mock);
    const keys = generateKeyPairSync('ed25519');
    const frozenPlugin = createAnnyPlugin({
      client: clientFixture.client,
      bookingNow: () => DOMAIN_NOW,
      publicKey: keys.publicKey,
      serviceToken: PLUGIN_TOKEN,
      presentation: PRESENTATION,
    });
    const defaultPlugin = createAnnyPlugin({
      client: clientFixture.client,
      publicKey: keys.publicKey,
      serviceToken: PLUGIN_TOKEN,
      presentation: PRESENTATION,
    });
    const defaultMock = createAnnyMock({
      token: MOCK_TOKEN,
      scope: 'domain-clock-default',
      catalog: CATALOG,
    });

    try {
      await Promise.all([mock.ready(), frozenPlugin.ready(), defaultPlugin.ready(), defaultMock.ready()]);

      const frozenAvailability = await availabilityFor(mock);
      expect(frozenAvailability).toContainEqual(expect.objectContaining({ start_date: START, end_date: END, available: true }));

      const proposal = await signedPluginCall(frozenPlugin, keys.privateKey, 'anny.propose_booking', ARGUMENTS);
      expect(proposal.isError).not.toBe(true);
      expect(proposal.structuredContent).toMatchObject({
        draft: { executionTool: 'anny.execute_booking', arguments: ARGUMENTS },
      });

      const defaultPluginProposal = await signedPluginCall(defaultPlugin, keys.privateKey, 'anny.propose_booking', ARGUMENTS);
      expect(defaultPluginProposal.isError).toBe(true);

      const defaultAvailability = await availabilityFor(defaultMock);
      expect(defaultAvailability).toEqual([]);
      expect(clientFixture.requests.some((url) => url.includes('/api/v1/availability/'))).toBe(true);
    } finally {
      await Promise.all([mock.close(), frozenPlugin.close(), defaultPlugin.close(), defaultMock.close()]);
    }
  });

  it('fails closed for invalid clocks while keeping invocation authentication on real time', async () => {
    const mock = createAnnyMock({
      token: MOCK_TOKEN,
      scope: 'domain-clock-invalid',
      catalog: CATALOG,
      availabilityNow: () => Number.NaN,
    });
    const clientFixture = clientFor(mock);
    const keys = generateKeyPairSync('ed25519');
    const plugin = createAnnyPlugin({
      client: clientFixture.client,
      bookingNow: () => Number.MAX_SAFE_INTEGER,
      publicKey: keys.publicKey,
      serviceToken: PLUGIN_TOKEN,
      presentation: PRESENTATION,
    });

    try {
      await Promise.all([mock.ready(), plugin.ready()]);
      const invalidAvailability = await availabilityReply(mock);
      expect(invalidAvailability.statusCode).toBe(500);

      const result = await signedPluginCall(plugin, keys.privateKey, 'anny.propose_booking', ARGUMENTS);
      expect(result.isError).toBe(true);
      expect(clientFixture.requests).toEqual([]);
    } finally {
      await Promise.all([mock.close(), plugin.close()]);
    }
  });
});

function clientFor(mock: ReturnType<typeof createAnnyMock>): {
  client: AnnyClient;
  requests: string[];
} {
  const requests: string[] = [];
  const client = new AnnyClient({
    baseUrl: 'http://127.0.0.1',
    organizationId: MOCK_IDS.organization,
    token: MOCK_TOKEN,
    allowLoopback: true,
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(`${url.pathname}${url.search}`);
      const response = await mock.inject({
        method: init?.method === 'POST' ? 'POST' : 'GET',
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
      });
    },
  });
  return { client, requests };
}

async function availabilityFor(mock: ReturnType<typeof createAnnyMock>): Promise<{ start_date?: string; end_date?: string; available?: boolean }[]> {
  const response = await availabilityReply(mock);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { start_date?: string; end_date?: string; available?: boolean }[] }>().data;
}

function availabilityReply(mock: ReturnType<typeof createAnnyMock>) {
  return mock.inject({
    method: 'GET',
    url: `/api/v1/availability/upcoming-intervals?service_id=${SERVICE_ID}&resource_id=${RESOURCE_ID}&start_date=${encodeURIComponent(START)}&duration=60`,
  });
}

async function signedPluginCall(
  plugin: ReturnType<typeof createAnnyPlugin>,
  privateKey: KeyObject,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const invocation = await createInvocationToken({
    actor: ACTOR,
    pluginId: annyManifest.id,
    pluginVersion: annyManifest.version,
    tool,
    args,
  }, privateKey);
  const response = await plugin.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${PLUGIN_TOKEN}`,
      'x-hasi-invocation': invocation,
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const event = response.body.split('\n').find((line) => line.startsWith('data: '));
  const envelope = JSON.parse(event ? event.slice('data: '.length) : response.body) as { result?: unknown };
  if (envelope.result === null || typeof envelope.result !== 'object') throw new Error('Missing MCP tool result.');
  return envelope.result;
}
