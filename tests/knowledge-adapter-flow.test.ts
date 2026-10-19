import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('revokes incident contexts and citations on resolution and expiry, then recovers from a fresh signed snapshot', async () => {
    let now = Date.parse('2026-10-19T10:00:00Z');
    const sourceKeys = { service_it: generateKeyPairSync('ed25519'), intranet: generateKeyPairSync('ed25519') };
    const pluginKeys = generateKeyPairSync('ed25519');
    const contextKeys = generateKeyPairSync('ed25519');
    const store = new MemoryJsonStore('incident-transition-' + randomUUID());
    const subject = 'incident-reader';
    const actor: ActorContext = { subject, permissions: ['knowledge:read'] };
    const actors = new Map([[subject, actor]]);
    const page: ContentAcquisitionPolicy['pages'][number] = {
      id: 'svc-status', url: origins.service_it + '/messages/synthetic-network',
      language: 'en', classification: 'public',
      acl: { authenticated: false, groups: ['students'], subjects: [] },
      incident: { status: 'active', validUntil: new Date(now + 5_000).toISOString() },
    };
    const policy: ContentAcquisitionPolicy = {
      completeInventory: true,
      validUntil: new Date(now + 30_000).toISOString(),
      pages: [page],
      subjects: [{ subject, groups: ['students'] }],
    };
    const policies: Record<KnowledgeSourceSystem, ContentAcquisitionPolicy> = {
      service_it: policy,
      intranet: { completeInventory: true, validUntil: new Date(now + 600_000).toISOString(), pages: [], subjects: [] },
    };
    const adapter = new WebContentAdapter({
      origin: origins.service_it,
      transport: { get: url => {
        expect(url.href).toBe(page.url);
        return Promise.resolve({ status: 200, contentType: 'text/html',
          body: '<html lang="en"><head><title>Synthetic network incident</title></head><body><main><p>Fictional campus network incident status.</p></main></body></html>' });
      } },
      clock: () => new Date(now),
    });
    const acquired = await adapter.read({ url: page.url }, new AbortController().signal);
    expect(acquired.requiresContentReview).toBe(true);
    policy.pages = [{ ...page, reviews: { web: { digest: contentReviewDigest(acquired, page, 'incident-policy-v1') } } }];
    const embedding = {
      modelId: 'synthetic-incident-v1', dimensions: 3, allowedDataClasses: ['public', 'internal'] as const,
      embedDocument: vi.fn((_text: string) => Promise.resolve([1, 0, 0])),
      embedQuery: () => Promise.resolve([1, 0, 0]),
    };
    const producer = (sourceSystem: KnowledgeSourceSystem) => new ContentSnapshotProducer({
      sourceSystem, origin: origins[sourceSystem], scope: 'incident-transition-producer',
      policyRevision: 'incident-policy-v1', maxAgeMs: 600_000, policy: policies[sourceSystem],
      adapter, store, embedding,
      clock: () => new Date(now),
      signSnapshot: snapshot => Promise.resolve(signContentSnapshot(snapshot, sourceKeys[sourceSystem].privateKey)),
    });
    const repository = new InstitutionalKnowledgeRepository({
      store, scope: 'incident-transition-repository',
      sources: (['service_it', 'intranet'] as const).map(sourceSystem => ({
        sourceSystem, origin: origins[sourceSystem] + '/', publicKey: sourceKeys[sourceSystem].publicKey,
        policyRevision: 'incident-policy-v1', maxAgeMs: 600_000,
      })),
      embedding, clock: () => now,
    });
    await repository.ingest('service_it', await producer('service_it').acquire(new AbortController().signal));
    await repository.ingest('intranet', await producer('intranet').acquire(new AbortController().signal));

    const plugin = createInstitutionalKnowledgePlugin({
      repository, publicKey: pluginKeys.publicKey, serviceToken: 'synthetic-incident-token',
      allowedHosts: [new URL(pluginOrigin).hostname],
    });
    cleanups.push(() => plugin.close());
    const registry = new PluginRegistry(pluginKeys.privateKey, {
      store, scope: 'incident-transition-registry',
      resolveActor: candidate => Promise.resolve(actors.get(candidate)),
      fetch: mcpTransport(plugin),
    });
    await registry.install({
      endpoint: pluginOrigin + '/mcp', serviceToken: 'synthetic-incident-token',
      expectedManifestDigest: digest(institutionalKnowledgeManifest), allowLoopback: false,
    });
    const contexts = createRegistryKnowledgeContexts({
      registry, store, privateKey: contextKeys.privateKey, scope: 'incident-transition-contexts',
      resolveActor: candidate => Promise.resolve(actors.get(candidate)),
    });
    const api = await createApi({ mode: 'test', registry, identity: identityFor(actors), store,
      knowledgeContexts: contexts, knowledgeOriginalOrigins: origins });
    cleanups.push(() => api.close());
    const login = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId: subject } });
    expect(login.statusCode, login.body).toBe(200);
    const sessionCookie = login.cookies.find(value => value.name === 'hasi-session');
    if (!sessionCookie) throw new Error('Synthetic incident session cookie missing.');
    const cookie = sessionCookie.name + '=' + sessionCookie.value;
    const search = async () => {
      const response = await api.inject({
        method: 'POST', url: '/api/tools/call', headers: { ...headers, cookie },
        payload: { pluginId: institutionalKnowledgeManifest.id, name: 'knowledge.search',
          arguments: { query: 'synthetic network incident', sourceSystem: 'service_it', limit: 3 } },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ documents: { id: string; citationId: string; revision: number;
        incident?: { status: string; validUntil: string } }[]; contextId: string }>();
    };
    const resolve = async (contextId: string) => api.inject({
      method: 'POST', url: '/api/knowledge/contexts/resolve', headers: { ...headers, cookie },
      payload: { contextIds: [contextId] },
    });
    const original = async (revision: number) => api.inject({
      url: '/api/knowledge/documents/svc-status-c1/original?revision=' + String(revision),
      headers: { ...headers, cookie },
    });

    const active = await search();
    expect(active.documents).toMatchObject([{
      id: 'svc-status-c1', citationId: 'knowledge:service_it:svc-status-c1:1',
      revision: 1, incident: { status: 'active' },
    }]);
    expect((await resolve(active.contextId)).json()).toMatchObject({
      contexts: [{ status: 'valid', documents: [{ revision: 1, incident: { status: 'active' } }] }],
    });

    now += 1_000;
    const resolvedUntil = new Date(now + 2_000).toISOString();
    policy.pages = [{ ...policy.pages[0]!, incident: { status: 'resolved', validUntil: resolvedUntil } }];
    const resolvedSnapshot = await producer('service_it').acquire(new AbortController().signal);
    expect(resolvedSnapshot.snapshot.sequence).toBe(2);
    expect(resolvedSnapshot.snapshot.documents[0]?.revision).toBe(2);
    await repository.ingest('service_it', resolvedSnapshot);
    const resolved = await search();
    expect(resolved.documents).toMatchObject([{
      id: 'svc-status-c1', citationId: 'knowledge:service_it:svc-status-c1:2',
      revision: 2, incident: { status: 'resolved', validUntil: resolvedUntil },
    }]);
    expect((await resolve(active.contextId)).json()).toEqual({
      contexts: [{ contextId: active.contextId, status: 'unavailable' }],
    });
    expect((await original(1)).statusCode).toBe(404);
    expect(embedding.embedDocument).toHaveBeenCalledTimes(1);

    now += 2_001;
    await expect(repository.getDocument(actor, { documentId: 'svc-status-c1' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(repository.search(actor, { query: 'synthetic network incident', sourceSystem: 'service_it', limit: 3 }))
      .resolves.toMatchObject({ documents: [] });
    expect((await resolve(resolved.contextId)).json()).toEqual({
      contexts: [{ contextId: resolved.contextId, status: 'unavailable' }],
    });
    expect((await original(2)).statusCode).toBe(404);

    now = Date.parse('2026-10-19T10:00:30.001Z');
    await expect(repository.search(actor, { query: 'synthetic network incident', sourceSystem: 'service_it', limit: 3 }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect((await resolve(resolved.contextId)).json()).toEqual({
      contexts: [{ contextId: resolved.contextId, status: 'unavailable' }],
    });

    policy.validUntil = new Date(now + 60_000).toISOString();
    const recoveredUntil = new Date(now + 60_000).toISOString();
    policy.pages = [{ ...policy.pages[0]!, incident: { status: 'active', validUntil: recoveredUntil } }];
    const recoveredSnapshot = await producer('service_it').acquire(new AbortController().signal);
    expect(recoveredSnapshot.snapshot.sequence).toBe(3);
    expect(recoveredSnapshot.snapshot.documents[0]?.revision).toBe(3);
    await repository.ingest('service_it', recoveredSnapshot);
    const recovered = await search();
    expect(recovered.documents).toMatchObject([{
      id: 'svc-status-c1', citationId: 'knowledge:service_it:svc-status-c1:3',
      revision: 3, incident: { status: 'active', validUntil: recoveredUntil },
    }]);
    expect((await resolve(active.contextId)).json()).toEqual({
      contexts: [{ contextId: active.contextId, status: 'unavailable' }],
    });
    expect((await resolve(resolved.contextId)).json()).toEqual({
      contexts: [{ contextId: resolved.contextId, status: 'unavailable' }],
    });
    expect((await original(2)).statusCode).toBe(404);
    expect((await original(3)).headers.location).toBe(page.url);
    expect(embedding.embedDocument).toHaveBeenCalledTimes(1);
  });
});
