import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import type { IdentityProvider, Persona } from '../apps/api/src/identity.js';
import {
  createApi,
  createRegistryKnowledgeContexts,
  KnowledgeIngestionWorker,
  PluginRegistry,
} from '../apps/api/src/index.js';
import {
  InstitutionalKnowledgeRepository,
  type InstitutionalKnowledgeSource,
} from '../apps/knowledge-plugin/src/institutional-repository.js';
import { createInstitutionalKnowledgePlugin, institutionalKnowledgeManifest } from '../apps/knowledge-plugin/src/institutional-plugin.js';
import type {
  KnowledgeDocumentExport,
  KnowledgeSourceExport,
  KnowledgeSourceSystem,
  SignedKnowledgeExport,
} from '../apps/knowledge-plugin/src/institutional-contracts.js';

const pluginKeys = generateKeyPairSync('ed25519');
const contextKeys = generateKeyPairSync('ed25519');
const sourceKeys = {
  service_it: generateKeyPairSync('ed25519'),
  intranet: generateKeyPairSync('ed25519'),
};
const serviceToken = 'synthetic-knowledge-plugin-token';
const pluginOrigin = 'https://knowledge-plugin.example.edu';
const sourceOrigins = {
  service_it: 'https://service.example.edu/knowledge/it',
  intranet: 'https://intranet.example.edu/knowledge',
};
const exportUrls = {
  service_it: `${sourceOrigins.service_it}/export.json`,
  intranet: `${sourceOrigins.intranet}/export.json`,
};
const studentDocumentId = 'svc-student-wireless-001';
const privateDocumentId = 'svc-private-image-002';
const studentTitle = 'Student campus wireless setup';
const studentSnippet = 'Use the fictional campus wireless profile.';
const privateTitle = 'PRIVATE_TITLE_FIXTURE_82A1';
const privateSnippet = 'PRIVATE_SNIPPET_FIXTURE_82A1';
const privateImageAlt = 'PRIVATE_IMAGE_ALT_FIXTURE_82A1';
const privateImageTranscript = 'PRIVATE_IMAGE_TRANSCRIPT_FIXTURE_82A1';
const requestHeaders = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
const activeCleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of activeCleanups.splice(0).reverse()) await cleanup();
});

describe('institutional knowledge pilot authorization boundaries', () => {
  it('issues and revalidates subject-bound source contexts across the API, registry, signed MCP and signed exports', async () => {
    const now = { value: Date.parse('2026-10-18T10:00:00.000Z') };
    const store = new MemoryJsonStore(`knowledge-pilot-boundaries-${randomUUID()}`);
    const actors = new Map<string, ActorContext>([
      ['pilot-student', { subject: 'pilot-student', permissions: ['knowledge:read'] }],
      ['pilot-outsider', { subject: 'pilot-outsider', permissions: ['knowledge:read'] }],
    ]);
    const identity = createIdentity(actors);
    const repository = new InstitutionalKnowledgeRepository({
      store,
      scope: 'knowledge-pilot-repository',
      sources: sourceConfiguration(),
      embedding: {
        modelId: 'pilot-approved-embedder-v1',
        dimensions: 3,
        allowedDataClasses: ['public', 'internal', 'confidential'],
        embedQuery: () => Promise.resolve([1, 0, 0]),
      },
      clock: () => now.value,
    });
    const exports = new Map<string, SignedKnowledgeExport>();
    exports.set(exportUrls.service_it, signedExport('service_it', 1, now.value, [
      studentDocument(1, now.value),
      privateDocument(now.value),
    ], [{ subject: 'pilot-student', groups: ['students'] }]));
    exports.set(exportUrls.intranet, signedExport('intranet', 1, now.value, [], [
      { subject: 'pilot-student', groups: ['students'] },
    ]));

    const worker = new KnowledgeIngestionWorker({
      sources: [
        { id: 'service_it', exportUrl: exportUrls.service_it },
        { id: 'intranet', exportUrl: exportUrls.intranet },
      ],
      repository,
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        const payload = exports.get(url);
        return payload
          ? Promise.resolve(new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }))
          : Promise.resolve(new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
      },
      clock: () => new Date(now.value),
    });
    activeCleanups.push(() => worker.close());
    expect((await worker.runOnce()).sources.map(({ status }) => status)).toEqual(['ingested', 'ingested']);

    const plugin = createInstitutionalKnowledgePlugin({
      repository,
      publicKey: pluginKeys.publicKey,
      serviceToken,
      allowedHosts: [new URL(pluginOrigin).hostname],
    });
    activeCleanups.push(() => plugin.close());
    const manifestProbe = await plugin.inject({
      method: 'GET',
      url: '/.well-known/hasi-plugin.json',
      headers: { host: new URL(pluginOrigin).host, authorization: `Bearer ${serviceToken}` },
    });
    expect(manifestProbe.statusCode, manifestProbe.body).toBe(200);
    const mcpFetch = pluginFetch(plugin);
    const registry = new PluginRegistry(pluginKeys.privateKey, {
      store,
      scope: 'knowledge-pilot-registry',
      resolveActor: subject => Promise.resolve(actors.get(subject)),
      fetch: mcpFetch,
    });
    const registration = {
      endpoint: `${pluginOrigin}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(institutionalKnowledgeManifest),
      allowLoopback: false,
    };
    await registry.install(registration);
    const contexts = createRegistryKnowledgeContexts({
      registry,
      store,
      privateKey: contextKeys.privateKey,
      scope: 'knowledge-pilot-contexts',
      resolveActor: subject => Promise.resolve(actors.get(subject)),
    });
    const api = await createApi({
      mode: 'test',
      registry,
      identity,
      store,
      knowledgeContexts: contexts,
      knowledgeOriginalOrigins: {
        service_it: new URL(sourceOrigins.service_it).origin,
        intranet: new URL(sourceOrigins.intranet).origin,
      },
    });
    activeCleanups.push(() => api.close());

    const studentCookie = await login(api, 'student');
    const outsiderCookie = await login(api, 'outsider');
    const modelToolsResponse = await api.inject({ url: '/api/tools', headers: { ...requestHeaders, cookie: studentCookie } });
    expect(modelToolsResponse.statusCode, modelToolsResponse.body).toBe(200);
    const modelTools = modelToolsResponse.json<{ tools: { pluginId: string; name: string }[] }>().tools;
    expect(modelTools.map(({ name }) => name)).toEqual(['knowledge.search']);
    expect(modelTools[0]?.pluginId).toBe(institutionalKnowledgeManifest.id);

    const search = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...requestHeaders, cookie: studentCookie },
      payload: {
        pluginId: institutionalKnowledgeManifest.id,
        name: 'knowledge.search',
        arguments: { query: 'student campus wireless setup', sourceSystem: 'service_it', limit: 3 },
      },
    });
    expect(search.statusCode, search.body).toBe(200);
    const searchResult = search.json<{ documents: Record<string, unknown>[]; contextId: string }>();
    expect(searchResult.contextId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(searchResult.documents).toHaveLength(1);
    expect(searchResult.documents[0]).toMatchObject({
      id: studentDocumentId,
      title: studentTitle,
      text: studentSnippet,
      synthetic: false,
      revision: 1,
      images: [{ alt: 'Fictional campus Wi-Fi profile screen', transcript: 'Choose the student network profile.' }],
    });

    const outsiderSearch = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: { ...requestHeaders, cookie: outsiderCookie },
      payload: {
        pluginId: institutionalKnowledgeManifest.id,
        name: 'knowledge.search',
        arguments: { query: 'student campus wireless setup', sourceSystem: 'service_it', limit: 3 },
      },
    });
    expect(outsiderSearch.statusCode, outsiderSearch.body).toBe(200);
    expect(outsiderSearch.body).not.toContain(studentTitle);
    expect(outsiderSearch.body).not.toContain(studentSnippet);
    expect(outsiderSearch.body).not.toContain(privateTitle);
    expect(outsiderSearch.body).not.toContain(privateImageAlt);
    expect(outsiderSearch.body).not.toContain(privateImageTranscript);
    expect(outsiderSearch.json<{ documents: unknown[] }>().documents).toEqual([]);

    const resolve = (cookie: string, contextId: string) => api.inject({
      method: 'POST',
      url: '/api/knowledge/contexts/resolve',
      headers: { ...requestHeaders, cookie },
      payload: { contextIds: [contextId] },
    });
    const authorizedContext = await resolve(studentCookie, searchResult.contextId);
    expect(authorizedContext.statusCode, authorizedContext.body).toBe(200);
    expect(authorizedContext.json<{ contexts: { status: string; documents?: Record<string, unknown>[] }[] }>().contexts[0])
      .toMatchObject({ status: 'valid', documents: [{ id: studentDocumentId, revision: 1 }] });

    const wrongUserContext = await resolve(outsiderCookie, searchResult.contextId);
    expect(wrongUserContext.statusCode, wrongUserContext.body).toBe(200);
    const wrongUserBody = wrongUserContext.json<{ contexts: { contextId: string; status: string }[] }>();
    expect(wrongUserBody).toMatchObject({ contexts: [{ contextId: searchResult.contextId, status: 'unavailable' }] });
    expect(JSON.stringify(wrongUserBody)).not.toContain(studentTitle);
    expect(JSON.stringify(wrongUserBody)).not.toContain(studentSnippet);

    const deniedDocument = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}`,
      headers: { ...requestHeaders, cookie: outsiderCookie },
    });
    expect(deniedDocument.statusCode).toBe(404);
    const deniedBody = deniedDocument.body;
    for (const marker of [studentTitle, studentSnippet, privateTitle, privateSnippet, privateImageAlt, privateImageTranscript]) {
      expect(deniedBody).not.toContain(marker);
    }

    const hiddenImageDocument = await api.inject({
      url: `/api/knowledge/documents/${privateDocumentId}`,
      headers: { ...requestHeaders, cookie: studentCookie },
    });
    expect(hiddenImageDocument.statusCode).toBe(404);
    const hiddenImageBody = hiddenImageDocument.body;
    expect(hiddenImageBody).not.toContain(privateTitle);
    expect(hiddenImageBody).not.toContain(privateImageAlt);
    expect(hiddenImageBody).not.toContain(privateImageTranscript);

    const original = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}/original?revision=1`,
      headers: { ...requestHeaders, cookie: studentCookie },
    });
    expect(original.statusCode).toBe(302);
    expect(original.headers.location).toBe(`${sourceOrigins.service_it}/${studentDocumentId}`);
    const deniedOriginal = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}/original?revision=1`,
      headers: { ...requestHeaders, cookie: outsiderCookie },
    });
    expect(deniedOriginal.statusCode).toBe(404);
    expect(deniedOriginal.body).not.toContain(studentTitle);
    expect(deniedOriginal.headers.location).toBeUndefined();

    actors.set('pilot-student', { subject: 'pilot-student', permissions: [] });
    const operatorRevokedContext = await resolve(studentCookie, searchResult.contextId);
    expect(operatorRevokedContext.json()).toMatchObject({ contexts: [{ status: 'unavailable' }] });
    const operatorRevokedDocument = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}`,
      headers: { ...requestHeaders, cookie: studentCookie },
    });
    expect(operatorRevokedDocument.statusCode).toBe(404);

    now.value += 1_000;
    exports.set(exportUrls.service_it, signedExport('service_it', 2, now.value, [
      studentDocument(2, now.value, 'Updated wireless guide after source permission review.'),
      privateDocument(Date.parse('2026-10-18T10:00:00.000Z')),
    ], []));
    exports.set(exportUrls.intranet, signedExport('intranet', 2, now.value, [], [
      { subject: 'pilot-student', groups: ['students'] },
    ]));
    expect((await worker.runOnce()).sources.map(({ status }) => status)).toEqual(['ingested', 'ingested']);
    actors.set('pilot-student', { subject: 'pilot-student', permissions: ['knowledge:read'] });

    const sourceRevokedContext = await resolve(studentCookie, searchResult.contextId);
    expect(sourceRevokedContext.statusCode, sourceRevokedContext.body).toBe(200);
    const sourceRevokedBody = sourceRevokedContext.json<{ contexts: { contextId: string; status: string }[] }>();
    expect(sourceRevokedBody).toMatchObject({ contexts: [{ contextId: searchResult.contextId, status: 'unavailable' }] });
    expect(JSON.stringify(sourceRevokedBody)).not.toContain(studentTitle);
    expect(JSON.stringify(sourceRevokedBody)).not.toContain(studentSnippet);

    const staleRevision = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}?revision=1`,
      headers: { ...requestHeaders, cookie: studentCookie },
    });
    expect(staleRevision.statusCode).toBe(404);
    expect(staleRevision.body).not.toContain(studentTitle);
    const revokedOriginal = await api.inject({
      url: `/api/knowledge/documents/${studentDocumentId}/original?revision=1`,
      headers: { ...requestHeaders, cookie: studentCookie },
    });
    expect(revokedOriginal.statusCode).toBe(404);
    expect(revokedOriginal.headers.location).toBeUndefined();
  });
});

function sourceConfiguration(): InstitutionalKnowledgeSource[] {
  return [
    {
      sourceSystem: 'service_it',
      origin: sourceOrigins.service_it,
      publicKey: sourceKeys.service_it.publicKey,
      policyRevision: 'service-it-policy-v1',
      maxAgeMs: 3_600_000,
    },
    {
      sourceSystem: 'intranet',
      origin: sourceOrigins.intranet,
      publicKey: sourceKeys.intranet.publicKey,
      policyRevision: 'intranet-policy-v1',
      maxAgeMs: 3_600_000,
    },
  ];
}

function createIdentity(actors: ReadonlyMap<string, ActorContext>): IdentityProvider {
  const personas = new Map<string, Persona>([
    ['student', { id: 'student', displayName: 'Student fixture', role: 'student', actor: structuredClone(actors.get('pilot-student')!) }],
    ['outsider', { id: 'outsider', displayName: 'Outsider fixture', role: 'employee', actor: structuredClone(actors.get('pilot-outsider')!) }],
  ]);
  const sessions = new Map<string, Persona>();
  return {
    login(id) {
      const persona = personas.get(id);
      if (!persona) throw new Error('Unknown synthetic persona.');
      const token = randomUUID();
      const user = structuredClone(persona);
      sessions.set(token, user);
      return { token, user };
    },
    resolve(token) {
      const persona = token ? sessions.get(token) : undefined;
      return persona ? structuredClone(persona) : undefined;
    },
    logout(token) {
      if (token) sessions.delete(token);
    },
  };
}

function studentDocument(revision: number, updatedAt: number, text = studentSnippet): KnowledgeDocumentExport {
  return {
    id: studentDocumentId,
    revision,
    title: revision === 1 ? studentTitle : 'Updated student campus wireless setup',
    language: 'en',
    canonicalUrl: `${sourceOrigins.service_it}/${studentDocumentId}`,
    classification: 'internal',
    updatedAt: new Date(updatedAt).toISOString(),
    acl: { groups: ['students'], subjects: [], authenticated: false },
    text,
    vector: [1, 0, 0],
    images: [{
      id: 'student-wireless-screen',
      alt: 'Fictional campus Wi-Fi profile screen',
      transcript: 'Choose the student network profile.',
      reviewed: true,
      instructional: true,
    }],
  };
}

function privateDocument(updatedAt: number): KnowledgeDocumentExport {
  return {
    id: privateDocumentId,
    revision: 1,
    title: privateTitle,
    language: 'en',
    canonicalUrl: `${sourceOrigins.service_it}/${privateDocumentId}`,
    classification: 'confidential',
    updatedAt: new Date(updatedAt - 1_000).toISOString(),
    acl: { groups: ['administrators'], subjects: [], authenticated: false },
    text: privateSnippet,
    vector: [0, 1, 0],
    images: [{
      id: 'private-admin-image',
      alt: privateImageAlt,
      transcript: privateImageTranscript,
      reviewed: true,
      instructional: true,
    }],
  };
}

function signedExport(
  sourceSystem: KnowledgeSourceSystem,
  sequence: number,
  now: number,
  documents: KnowledgeDocumentExport[],
  subjects: KnowledgeSourceExport['subjects'],
): SignedKnowledgeExport {
  const snapshot: KnowledgeSourceExport = {
    version: 1,
    sourceSystem,
    sequence,
    policyRevision: sourceSystem === 'service_it' ? 'service-it-policy-v1' : 'intranet-policy-v1',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    embeddingModelId: 'pilot-approved-embedder-v1',
    dimensions: 3,
    subjects,
    documents,
    retiredDocumentIds: [],
  };
  const privateKey: KeyObject = sourceKeys[sourceSystem].privateKey;
  return { snapshot, signature: sign(null, Buffer.from(digest(snapshot), 'utf8'), privateKey).toString('base64url') };
}

function pluginFetch(plugin: ReturnType<typeof createInstitutionalKnowledgePlugin>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== pluginOrigin) return new Response('Unapproved fixture origin.', { status: 403 });
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    const payload = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const response = await plugin.inject({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    if (response.statusCode === 401) throw new Error(`Synthetic MCP rejected ${request.method} ${url.pathname}: ${response.body}`);
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined || ['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) continue;
      responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const emptyStatus = [204, 205, 304].includes(response.statusCode);
    return new Response(emptyStatus ? null : response.body, { status: response.statusCode, headers: responseHeaders });
  };
}

async function login(api: Awaited<ReturnType<typeof createApi>>, personaId: string): Promise<string> {
  const response = await api.inject({
    method: 'POST',
    url: '/api/dev/login',
    headers: requestHeaders,
    payload: { personaId },
  });
  expect(response.statusCode, response.body).toBe(200);
  const session = response.cookies.find(({ name }) => name === 'hasi-session');
  if (!session) throw new Error('Synthetic login did not issue a session cookie.');
  return `${session.name}=${session.value}`;
}
