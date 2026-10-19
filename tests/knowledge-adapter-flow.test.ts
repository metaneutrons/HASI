import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { createApi, createRegistryKnowledgeContexts, PluginRegistry } from '../apps/api/src/index.js';
import type { IdentityProvider, Persona } from '../apps/api/src/identity.js';
import { ContentSnapshotProducer, contentReviewDigest, signContentSnapshot,
  type ContentAcquisitionPolicy } from '../apps/knowledge-plugin/src/content/acquisition.js';
import { MediaWikiContentAdapter, WebContentAdapter } from '../apps/knowledge-plugin/src/content/adapters.js';
import type { ContentAdapter, ContentTransport } from '../apps/knowledge-plugin/src/content/contracts.js';
import { InstitutionalKnowledgeRepository } from '../apps/knowledge-plugin/src/institutional-repository.js';
import { createInstitutionalKnowledgePlugin, institutionalKnowledgeManifest } from '../apps/knowledge-plugin/src/institutional-plugin.js';
import type { KnowledgeDocumentExport, KnowledgeSourceSystem } from '../apps/knowledge-plugin/src/institutional-contracts.js';

// Synthetic source transport and reviewed image transcripts; no image bytes, OCR or external model calls.
const origins = { service_it: 'https://service.example.edu', intranet: 'https://wiki.example.edu' };
const pluginOrigin = 'https://knowledge.example.edu';
const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
const privateMarker = 'INTERNAL_IMAGE_GUIDANCE_71: Wähle im Dialog das Beschäftigtenprofil.';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function identityFor(actors: ReadonlyMap<string, ActorContext>): IdentityProvider {
  const sessions = new Map<string, Persona>();
  return {
    login(id) {
      const actor = actors.get(id);
      if (!actor) throw new Error('Unknown synthetic subject.');
      const user: Persona = { id, displayName: id, role: 'student', actor: structuredClone(actor) };
      const token = randomUUID();
      sessions.set(token, user);
      return { token, user };
    },
    resolve(token) { return token ? structuredClone(sessions.get(token)) : undefined; },
    logout(token) { if (token) sessions.delete(token); },
  };
}

function mcpTransport(plugin: ReturnType<typeof createInstitutionalKnowledgePlugin>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== pluginOrigin) throw new Error('Unapproved synthetic plugin origin.');
    const response = await plugin.inject({
      method: request.method, url: `${url.pathname}${url.search}`,
      headers: { ...Object.fromEntries(request.headers), host: url.host },
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { payload: await request.text() }),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase()))
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response([204, 205, 304].includes(response.statusCode) ? null : response.body,
      { status: response.statusCode, headers: responseHeaders });
  };
}

describe('reviewed source adapters through signed knowledge MCP and host API', () => {
  it('enforces review, source ACLs, image guidance and revocation across acquisition, contexts and citations', async () => {
    let now = Date.parse('2026-10-19T09:00:00Z');
    const sourceKeys = { service_it: generateKeyPairSync('ed25519'), intranet: generateKeyPairSync('ed25519') };
    const pluginKeys = generateKeyPairSync('ed25519');
    const contextKeys = generateKeyPairSync('ed25519');
    const store = new MemoryJsonStore(`adapter-flow-${randomUUID()}`);
    const actors = new Map<string, ActorContext>(['student', 'staff'].map(subject =>
      [subject, { subject, permissions: ['knowledge:read'] }]));
    const pages: Record<KnowledgeSourceSystem, ContentAcquisitionPolicy['pages'][number]> = {
      service_it: { id: 'svc-vpn', url: `${origins.service_it}/de/services/vpn`, language: 'en',
        classification: 'public', acl: { authenticated: false, groups: ['students'], subjects: [] } },
      intranet: { id: 'int-vpn', url: `${origins.intranet}/wiki/VPN`, title: 'VPN', language: 'de',
        classification: 'internal', acl: { authenticated: false, groups: ['employees'], subjects: [] } },
    };
    const calls: { source: KnowledgeSourceSystem; url: URL; accept: string }[] = [];
    let wikiChanged = false;
    let wikiInfoReads = 0;
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const transport: ContentTransport = { get(url, accept) {
      const source = url.origin === origins.service_it ? 'service_it' : 'intranet';
      calls.push({ source, url: new URL(url), accept });
      if (source === 'service_it') {
        expect(url.href).toBe(pages.service_it.url);
        expect(accept).toBe('html');
        return Promise.resolve({ status: 200, contentType: 'text/html', body:
          '<html lang="en"><head><title>Student VPN setup</title></head><body><main><p>Install the fictional campus VPN profile for students.</p></main></body></html>' });
      }
      expect(url.origin).toBe(origins.intranet);
      expect(url.pathname).toBe('/w/api.php');
      expect(accept).toBe('json');
      expect(url.searchParams.get('assert')).toBe('user');
      switch (url.searchParams.get('action')) {
        case 'paraminfo':
          wikiInfoReads = 0;
          return Promise.resolve(json({ paraminfo: { modules: [
          { path: 'parse', prefix: '', parameters: [{ name: 'oldid' }, { name: 'prop' }] },
          { path: 'query+info', prefix: 'in', parameters: [{ name: 'prop' }] },
          { path: 'query+revisions', prefix: 'rv', parameters: [{ name: 'prop' }, { name: 'limit' }] },
        ] } }));
        case 'query':
          wikiInfoReads += 1;
          return Promise.resolve(json({ query: { pages: [{ pageid: 42, ns: 0, title: 'VPN',
            fullurl: pages.intranet.url, revisions: [{ revid: wikiChanged && wikiInfoReads === 2 ? 72 : 71,
              timestamp: '2026-10-19T08:00:00Z' }] }] } }));
        case 'parse':
          expect(url.searchParams.get('oldid')).toBe('71');
          return Promise.resolve(json({ parse: { title: 'VPN', pageid: 42, revid: 71, templates: [],
            text: '<h1>VPN für Beschäftigte</h1><p>Fiktive Anleitung zur VPN-Einrichtung.</p><img src="/images/vpn.png" alt="Profilwahl im VPN-Dialog">' } }));
        default: throw new Error('Unexpected synthetic MediaWiki request.');
      }
    } };
    const adapters: Record<KnowledgeSourceSystem, ContentAdapter> = {
      service_it: new WebContentAdapter({ origin: origins.service_it, transport, clock: () => new Date(now) }),
      intranet: new MediaWikiContentAdapter({ origin: origins.intranet, apiUrl: `${origins.intranet}/w/api.php`,
        transport, requireAuthenticated: true, clock: () => new Date(now) }),
    };
    const policies: Record<KnowledgeSourceSystem, ContentAcquisitionPolicy> = {
      service_it: { completeInventory: true, validUntil: new Date(now + 600_000).toISOString(), pages: [pages.service_it],
        subjects: [{ subject: 'student', groups: ['students'] }, { subject: 'staff', groups: ['students'] }] },
      intranet: { completeInventory: true, validUntil: new Date(now + 600_000).toISOString(), pages: [pages.intranet],
        subjects: [{ subject: 'staff', groups: ['employees'] }] },
    };
    const embedded: string[] = [];
    const embedding = { modelId: 'synthetic-adapter-flow-v1', dimensions: 3, allowedDataClasses: ['public', 'internal'] as const,
      embedDocument: (text: string) => { embedded.push(text); return Promise.resolve([1, 0, 0]); } };
    const producer = (sourceSystem: KnowledgeSourceSystem) => new ContentSnapshotProducer({
      sourceSystem, origin: origins[sourceSystem], scope: 'adapter-flow-producer', policyRevision: 'review-policy-v1',
      maxAgeMs: 600_000, policy: policies[sourceSystem], adapter: adapters[sourceSystem], store, embedding,
      clock: () => new Date(now),
      signSnapshot: snapshot => Promise.resolve(signContentSnapshot(snapshot, sourceKeys[sourceSystem].privateKey)),
    });
    for (const source of ['service_it', 'intranet'] as const) {
      await expect(producer(source).acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'review_required' });
      expect(embedded).toEqual([]);
      expect(await store.read(`content-producer:adapter-flow-producer:${source}`)).toBeUndefined();
      const page = pages[source];
      const acquired = await adapters[source].read({ url: page.url, ...(page.title ? { title: page.title } : {}) }, new AbortController().signal);
      expect(acquired.requiresContentReview).toBe(true);
      const approvedImages: KnowledgeDocumentExport['images'] = source === 'intranet'
        ? [{ id: 'vpn-profile', alt: 'Profilwahl im VPN-Dialog', transcript: privateMarker, instructional: true, reviewed: true }]
        : [];
      policies[source].pages = [{ ...pages[source], reviews: { [acquired.adapter]: {
        digest: contentReviewDigest(acquired, pages[source], 'review-policy-v1', approvedImages),
        ...(approvedImages.length > 0 ? { images: approvedImages } : {}),
      } } }];
    }
    wikiChanged = true;
    await expect(producer('intranet').acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'changed' });
    expect(embedded).toEqual([]);
    expect(await store.read('content-producer:adapter-flow-producer:intranet')).toBeUndefined();
    wikiChanged = false;
    const repository = new InstitutionalKnowledgeRepository({
      store, scope: 'adapter-flow-repository',
      sources: (['service_it', 'intranet'] as const).map(sourceSystem => ({ sourceSystem, origin: `${origins[sourceSystem]}/`,
        publicKey: sourceKeys[sourceSystem].publicKey, policyRevision: 'review-policy-v1', maxAgeMs: 600_000 })),
      embedding: { ...embedding, embedQuery: () => Promise.resolve([1, 0, 0]) }, clock: () => now,
    });
    for (const source of ['service_it', 'intranet'] as const) {
      const envelope = await producer(source).acquire(new AbortController().signal);
      expect(envelope.snapshot.documents[0]?.language).toBe(source === 'service_it' ? 'en' : 'de');
      await repository.ingest(source, envelope);
    }
    expect(embedded).toHaveLength(2);
    const serviceToken = 'synthetic-adapter-flow-token';
    const plugin = createInstitutionalKnowledgePlugin({ repository, publicKey: pluginKeys.publicKey, serviceToken,
      allowedHosts: [new URL(pluginOrigin).hostname] });
    cleanups.push(() => plugin.close());
    const registry = new PluginRegistry(pluginKeys.privateKey, { store, scope: 'adapter-flow-registry',
      resolveActor: subject => Promise.resolve(actors.get(subject)), fetch: mcpTransport(plugin) });
    await registry.install({ endpoint: `${pluginOrigin}/mcp`, serviceToken,
      expectedManifestDigest: digest(institutionalKnowledgeManifest), allowLoopback: false });
    const contexts = createRegistryKnowledgeContexts({ registry, store, privateKey: contextKeys.privateKey,
      scope: 'adapter-flow-contexts', resolveActor: subject => Promise.resolve(actors.get(subject)) });
    const api = await createApi({ mode: 'test', registry, identity: identityFor(actors), store,
      knowledgeContexts: contexts, knowledgeOriginalOrigins: origins });
    cleanups.push(() => api.close());
    const cookies = new Map<string, string>();
    for (const subject of actors.keys()) {
      const response = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId: subject } });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.cookies.find(value => value.name === 'hasi-session');
      if (!cookie) throw new Error('Synthetic session cookie missing.');
      cookies.set(subject, `${cookie.name}=${cookie.value}`);
    }
    const search = async (subject: string, sourceSystem: KnowledgeSourceSystem, query = 'VPN') => {
      const result = await api.inject({ method: 'POST', url: '/api/tools/call',
        headers: { ...headers, cookie: cookies.get(subject)! }, payload: {
          pluginId: institutionalKnowledgeManifest.id, name: 'knowledge.search', arguments: { query, sourceSystem, limit: 3 },
        } });
      expect(result.statusCode, result.body).toBe(200);
      return result.json<{ documents: { id: string; title: string; revision: number; images: unknown[] }[]; contextId: string }>();
    };
    const studentService = await search('student', 'service_it');
    expect(studentService.documents).toMatchObject([{ id: 'svc-vpn-c1', title: 'Student VPN setup', revision: 1 }]);
    const studentPrivate = await search('student', 'intranet');
    expect(studentPrivate.documents).toEqual([]);
    expect(JSON.stringify(studentPrivate)).not.toContain(privateMarker);
    const staff = await search('staff', 'intranet', 'INTERNAL_IMAGE_GUIDANCE_71');
    expect(staff.documents).toMatchObject([{ id: 'int-vpn-c1', revision: 1, images: [{ transcript: privateMarker }] }]);
    expect(JSON.stringify(staff)).not.toContain('/images/vpn.png');
    const resolve = (subject: string) => api.inject({ method: 'POST', url: '/api/knowledge/contexts/resolve',
      headers: { ...headers, cookie: cookies.get(subject)! }, payload: { contextIds: [staff.contextId] } });
    expect((await resolve('staff')).json()).toMatchObject({ contexts: [{ status: 'valid', documents: [{ id: 'int-vpn-c1' }] }] });
    const wrongSubject = await resolve('student');
    expect(wrongSubject.json()).toMatchObject({ contexts: [{ status: 'unavailable' }] });
    expect(wrongSubject.body).not.toContain(privateMarker);
    const original = (subject: string) => api.inject({ url: '/api/knowledge/documents/int-vpn-c1/original?revision=1',
      headers: { ...headers, cookie: cookies.get(subject)! } });
    expect((await original('staff')).headers.location).toBe(pages.intranet.url);
    expect((await original('student')).statusCode).toBe(404);

    now += 1_000;
    policies.intranet.subjects = [];
    const revoked = await producer('intranet').acquire(new AbortController().signal);
    expect(revoked.snapshot.sequence).toBe(2);
    expect(revoked.snapshot.documents[0]?.revision).toBe(1);
    expect(embedded).toHaveLength(2);
    await repository.ingest('intranet', revoked);
    const revokedContext = await resolve('staff');
    expect(revokedContext.json()).toMatchObject({ contexts: [{ status: 'unavailable' }] });
    expect(revokedContext.body).not.toContain(privateMarker);
    expect((await original('staff')).statusCode).toBe(404);
    expect((await search('staff', 'intranet')).documents).toEqual([]);
    expect(calls.some(call => call.accept === 'html' && call.source === 'intranet')).toBe(false);
    const wikiActions = calls.filter(call => call.source === 'intranet').map(call => call.url.searchParams.get('action'));
    expect(wikiActions.length % 4).toBe(0);
    for (let offset = 0; offset < wikiActions.length; offset += 4)
      expect(wikiActions.slice(offset, offset + 4)).toEqual(['paraminfo', 'query', 'parse', 'query']);
    expect(calls.every(call => !call.url.pathname.startsWith('/images/'))).toBe(true);
  });
});
