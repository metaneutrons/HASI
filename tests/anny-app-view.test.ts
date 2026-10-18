import { createHash, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyMock, MOCK_IDS } from '@hasi/anny-mock';
import { hshDemoCatalog, hshDemoPresentation } from '../fixtures/catalog.js';
import {
  annyAppManifest,
  annyAppPresentationId,
  annyAppResourceUri,
  annyAppViewSha256,
  annyManifest,
  createAnnyPlugin,
  demoPresentation,
  loadAnnyAppView,
} from '@hasi/anny-plugin';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { PluginRegistry, createApi } from '../apps/api/src/index.js';
import type { Persona } from '../apps/api/src/identity.js';

const active: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of active.splice(0).reverse()) await close(); });

describe('Anny read-only MCP App', () => {
  it('does not let a pinned manifest approve its own browser code', async () => {
    const setup = await createSetup(false, false);
    active.push(() => setup.close());
    const response = await setup.api.inject({ url: `/api/plugin-apps/${annyAppManifest.id}/${annyAppPresentationId}`, headers: setup.headers });
    expect(response.statusCode).toBe(404);
    const native = await setup.api.inject({ url: '/api/resources', headers: setup.headers });
    expect(native.statusCode, native.body).toBe(200);
  });
  it('serves the approved resource and invokes only its signed, claim-scoped app read tool', async () => {
    const setup = await createSetup();
    active.push(() => setup.close());

    expect(annyManifest.manifestVersion).toBe(1);
    expect(annyManifest.apiVersion).toBe('1.0.0');
    expect(digest(annyManifest)).toBe('ab4c535240f30f18b3447639ccdab042969753d7e9e2a984ed238ab5c05383bd');
    expect(annyAppManifest.manifestVersion).toBe(2);
    expect(annyAppManifest.identity?.claims).toEqual(['anny.customerId', 'anny.resourceIds']);
    expect(annyAppManifest.presentations?.[0]).toMatchObject({
      id: annyAppPresentationId,
      resourceUri: annyAppResourceUri,
      sha256: annyAppViewSha256,
    });
    expect(createHash('sha256').update(loadAnnyAppView(), 'utf8').digest('hex')).toBe(annyAppViewSha256);
    expect(loadAnnyAppView()).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(loadAnnyAppView()).toContain('name: "anny.view_resources"');
    expect(loadAnnyAppView()).toContain('"Arbeitsplatz"');
    expect(loadAnnyAppView()).toContain('"Besprechungsraum"');
    expect(loadAnnyAppView()).toContain('requestedStartDate');
    expect(loadAnnyAppView()).toContain('Diese Ansicht prüft keine Verfügbarkeit.');

    const read = await setup.api.inject({ url: `/api/plugin-apps/${annyAppManifest.id}/${annyAppPresentationId}`, headers: setup.headers });
    expect(read.statusCode, read.body).toBe(200);
    const presentation = read.json<{ resourceHtml: string; resourceSha256: string; tools: { name: string; effect: string; visibility: string[] }[] }>();
    expect(presentation.resourceHtml).toBe(loadAnnyAppView());
    expect(createHash('sha256').update(presentation.resourceHtml, 'utf8').digest('hex')).toBe(presentation.resourceSha256);
    expect(presentation.resourceSha256).toBe(annyAppViewSha256);
    expect(presentation.tools).toEqual([{ name: 'anny.view_resources', effect: 'read', visibility: ['app'] }]);

    const result = await setup.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: setup.headers,
      payload: {
        pluginId: annyAppManifest.id,
        name: 'anny.view_resources',
        arguments: {
          page: 0,
          pageSize: 6,
          requestedStartDate: '2026-10-20T09:00:00+02:00',
          requestedEndDate: '2026-10-20T10:00:00+02:00',
        },
        source: 'app',
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<{
      resources: { id: string; available?: unknown }[];
      total: number;
      page: number;
      pageSize: number;
      availabilityChecked: boolean;
      requestedStartDate: string;
      requestedEndDate: string;
    }>()).toMatchObject({
      resources: [{ id: MOCK_IDS.resources.seminarRoom }],
      total: 1,
      page: 0,
      pageSize: 6,
      availabilityChecked: false,
      requestedStartDate: '2026-10-20T09:00:00+02:00',
      requestedEndDate: '2026-10-20T10:00:00+02:00',
    });
    expect(result.json<{ resources: { available?: unknown }[] }>().resources.every(resource => !('available' in resource))).toBe(true);

    const modelTools = await setup.api.inject({ url: '/api/tools', headers: setup.headers });
    expect(modelTools.json<{ tools: { name: string }[] }>().tools.some(({ name }) => name === 'anny.view_resources')).toBe(false);

    const oldSearch = await setup.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: setup.headers,
      payload: { pluginId: annyAppManifest.id, name: 'anny.search_resources', arguments: {}, source: 'app' },
    });
    expect(oldSearch.statusCode).toBe(403);

    const unapprovedTool = await setup.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: setup.headers,
      payload: { pluginId: annyAppManifest.id, name: 'anny.get_availability', arguments: {}, source: 'app' },
    });
    expect(unapprovedTool.statusCode).toBe(403);
    const writeCall = await setup.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: setup.headers,
      payload: { pluginId: annyAppManifest.id, name: 'anny.propose_booking', arguments: {}, source: 'app' },
    });
    expect(writeCall.statusCode).toBe(403);
    const unknownResource = await setup.api.inject({ url: `/api/plugin-apps/${annyAppManifest.id}/unapproved`, headers: setup.headers });
    expect(unknownResource.statusCode).toBe(404);
  });

  it('rejects a plugin resource served by a different version after the view was approved', async () => {
    const setup = await createSetup();
    active.push(() => setup.close());
    const address = setup.plugin.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing plugin listener address');
    await setup.plugin.close();
    const replacement = createAnnyPlugin({
      client: setup.client,
      publicKey: setup.publicKey,
      serviceToken: 'anny-app-test-service-token',
      presentation: demoPresentation,
      enableAppView: true,
      version: '0.5.1',
    });
    await replacement.listen({ host: '127.0.0.1', port: address.port });
    setup.replacePlugin(replacement);

    const response = await setup.api.inject({
      url: `/api/plugin-apps/${annyAppManifest.id}/${annyAppPresentationId}`,
      headers: setup.headers,
    });
    expect(response.statusCode, response.body).toBe(409);
  });

  it('accepts and authorizes all 43 catalog resources across bounded app pages', async () => {
    const setup = await createSetup(true);
    active.push(() => setup.close());
    const pages: { resources: { id: string }[]; total: number }[] = [];
    for (let page = 0; page < Math.ceil(hshDemoCatalog.resources.length / 6); page += 1) {
      const response = await setup.api.inject({
        method: 'POST',
        url: '/api/tools/call',
        headers: setup.headers,
        payload: { pluginId: annyAppManifest.id, name: 'anny.view_resources', arguments: { page, pageSize: 6 }, source: 'app' },
      });
      expect(response.statusCode, response.body).toBe(200);
      pages.push(response.json<{ resources: { id: string }[]; total: number }>());
    }
    expect(pages.every(result => result.total === 43)).toBe(true);
    expect(pages.flatMap(result => result.resources.map(({ id }) => id)))
      .toEqual(hshDemoCatalog.resources.map(({ id }) => id));
  });

  it('filters and pages only authorized bookable resources without claiming availability', async () => {
    const setup = await createSetup(true);
    active.push(() => setup.close());
    const workplaceIds = hshDemoCatalog.resources.filter(resource => resource.kind === 'workplace').map(({ id }) => id);
    const request = (page: number, query?: string) => setup.api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: setup.headers,
      payload: {
        pluginId: annyAppManifest.id,
        name: 'anny.view_resources',
        arguments: { page, pageSize: 2, kind: 'workplace', ...(query ? { query } : {}) },
        source: 'app',
      },
    });

    const first = await request(0);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ resources: { id: string; kind: string }[]; total: number; page: number; pageSize: number; availabilityChecked: boolean }>()).toMatchObject({
      resources: [{ id: workplaceIds[0], kind: 'workplace' }, { id: workplaceIds[1], kind: 'workplace' }],
      total: workplaceIds.length,
      page: 0,
      pageSize: 2,
      availabilityChecked: false,
    });
    const second = await request(1);
    expect(second.statusCode, second.body).toBe(200);
    const secondIds = second.json<{ resources: { id: string }[] }>().resources.map(({ id }) => id);
    expect(secondIds).toEqual(workplaceIds.slice(2, 4));
    expect(secondIds.some(id => first.json<{ resources: { id: string }[] }>().resources.some(resource => resource.id === id))).toBe(false);

    const query = hshDemoCatalog.resources.find(resource => resource.kind === 'workplace')?.name.slice(0, 8) ?? 'Arbeitsplatz';
    const normalizedQuery = query.toLocaleLowerCase('de-DE');
    const expected = hshDemoCatalog.resources.filter(resource => resource.kind === 'workplace'
      && [resource.name, resource.description, resource.location, ...resource.features].some(value => value.toLocaleLowerCase('de-DE').includes(normalizedQuery)));
    const filtered = await request(0, query);
    expect(filtered.statusCode, filtered.body).toBe(200);
    const filteredResources = filtered.json<{ resources: { id: string }[]; total: number }>();
    expect(filteredResources.total).toBe(expected.length);
    expect(filteredResources.resources.map(({ id }) => id)).toEqual(expected.slice(0, 2).map(({ id }) => id));
  });

  it('rejects malformed dates and prevents an app call from reading another resource claim', async () => {
    const setup = await createSetup();
    active.push(() => setup.close());
    const base = { pluginId: annyAppManifest.id, name: 'anny.view_resources', source: 'app' };
    const invalidDate = await setup.api.inject({
      method: 'POST', url: '/api/tools/call', headers: setup.headers,
      payload: { ...base, arguments: { page: 0, pageSize: 6, requestedStartDate: 'not-a-date' } },
    });
    expect(invalidDate.statusCode).toBe(400);

    const deniedResource = await setup.api.inject({
      method: 'POST', url: '/api/tools/call', headers: setup.headers,
      payload: { ...base, arguments: { page: 0, pageSize: 6, kind: 'workplace' } },
    });
    expect(deniedResource.statusCode, deniedResource.body).toBe(200);
    expect(deniedResource.json<{ resources: { id: string }[]; total: number }>()).toMatchObject({ resources: [], total: 0 });
  });
});

async function createSetup(useFullCatalog = false, appReviewed = true) {
  const catalog = useFullCatalog ? hshDemoCatalog : undefined;
  const presentation = useFullCatalog ? hshDemoPresentation : demoPresentation;
  const mock = createAnnyMock({ token: 'anny-app-test-token', ...(catalog ? { catalog } : {}) });
  await mock.listen({ host: '127.0.0.1', port: 0 });
  const mockAddress = mock.server.address();
  if (!mockAddress || typeof mockAddress === 'string') throw new Error('Missing mock listener address');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const client = new AnnyClient({
    baseUrl: `http://127.0.0.1:${String(mockAddress.port)}`,
    organizationId: MOCK_IDS.organization,
    token: 'anny-app-test-token',
    allowLoopback: true,
  });
  let plugin = createAnnyPlugin({
    client,
    publicKey,
    serviceToken: 'anny-app-test-service-token',
    presentation,
    enableAppView: true,
  });
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  const pluginAddress = plugin.server.address();
  if (!pluginAddress || typeof pluginAddress === 'string') throw new Error('Missing plugin listener address');
  const registry = new PluginRegistry(privateKey, { reviewedAppDigests: appReviewed ? [annyAppViewSha256] : [] });
  await registry.install({
    endpoint: `http://127.0.0.1:${String(pluginAddress.port)}/mcp`,
    serviceToken: 'anny-app-test-service-token',
    expectedManifestDigest: digest(annyAppManifest),
    allowLoopback: true,
  });
  const actor: ActorContext = {
    subject: 'trusted-test-subject',
    permissions: ['rooms:read', 'rooms:prepare', 'rooms:execute'],
    customerId: MOCK_IDS.customers.employee,
    resourceIds: useFullCatalog ? hshDemoCatalog.resources.map(({ id }) => id) : [MOCK_IDS.resources.projectRoom],
    claims: {
      'anny.customerId': MOCK_IDS.customers.student,
      'anny.resourceIds': useFullCatalog
        ? hshDemoCatalog.resources.map(({ id }) => id)
        : [MOCK_IDS.resources.seminarRoom],
    },
  };
  const user: Persona = { id: 'trusted-test-user', displayName: 'Test', role: 'employee', actor };
  const identity = {
    login: () => ({ token: 'trusted-test-session', user }),
    resolve: (token: string | undefined) => token === 'trusted-test-session' ? user : undefined,
    logout: () => undefined,
  };
  const api = await createApi({ mode: 'test', registry, identity });
  const headers = {
    host: '127.0.0.1',
    origin: 'http://127.0.0.1:3000',
    cookie: 'hasi-session=trusted-test-session',
  };
  return {
    api,
    client,
    headers,
    plugin,
    publicKey,
    replacePlugin(replacement: FastifyInstance) { plugin = replacement; },
    async close() {
      await api.close();
      await plugin.close();
      await mock.close();
    },
  };
}
