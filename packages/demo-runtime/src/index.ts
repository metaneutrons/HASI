import { createHmac, createPrivateKey, createPublicKey, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyPlugin, annyManifest, demoPresentation } from '@hasi/anny-plugin';
import { createAnnyMock, MOCK_IDS, type AnnyMockCatalog } from '@hasi/anny-mock';
import { createKnowledgePlugin, knowledgeManifest } from '@hasi/knowledge-plugin';
import { digest } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { createApi, PluginRegistry } from '@hasi/api';
import { DurableDemoIdentity } from './identity.js';

const workspaceCookie = '__Host-hasi-demo-workspace';
const sessionCookie = '__Host-hasi-session';
const lifetime = 7 * 86400000;
const uuid = z.uuid();

export class ScopedJsonStore implements JsonStore {
  constructor(private readonly store: JsonStore, private readonly prefix: string) {}
  read(key: string) { return this.store.read(`${this.prefix}:${key}`); }
  compareAndSet(key: string, revision: string | null, value: unknown, expiresAt?: number) { return this.store.compareAndSet(`${this.prefix}:${key}`, revision, value, expiresAt ?? Date.now() + lifetime); }
  delete(key: string) { return this.store.delete(`${this.prefix}:${key}`); }
}

export interface DemoRuntimeOptions {
  origin: string;
  store: JsonStore;
  /** Dedicated demo secret, never an institutional integration credential. */
  secret: string;
  fetch?: typeof fetch;
  catalog?: AnnyMockCatalog;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | null, name: string): string | undefined {
  return header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function createDemoRuntime(options: DemoRuntimeOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password || (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Invalid configured demo origin.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.secret)) throw new Error('A dedicated 256-bit demo secret is required.');
  const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', Buffer.from(options.secret, 'base64url'), 'hasi-demo-v1', purpose, 32));
  const seed = derive('invocation-signing');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const pluginToken = derive('plugin-service').toString('base64url');
  const knowledgeToken = derive('knowledge-service').toString('base64url');
  const mockToken = derive('mock-anny-service').toString('base64url');
  const cookieKey = derive('workspace-cookie');
  const sign = (value: string) => createHmac('sha256', cookieKey).update(value).digest('base64url');
  const transport = options.fetch ?? fetch;
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? workspaceCookie : 'hasi-demo-workspace';
  const sessionName = secure ? sessionCookie : 'hasi-session';
  const internalFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin.origin) throw new Error('Unapproved demo integration destination.');
    return transport(input, { ...init, redirect: 'error' });
  };
  const workspaceStore = (workspaceId: string) => new ScopedJsonStore(options.store, `workspace:${uuid.parse(workspaceId)}`);
  const subjectWorkspace = (subject: string) => {
    const parts = subject.split(':');
    if (parts.length !== 3 || parts[0] !== 'demo' || !['student', 'employee', 'admin'].includes(parts[2] ?? '')) throw new Error('Invalid demo actor.');
    return uuid.parse(parts[1]);
  };
  const plugin = createAnnyPlugin({
    publicKey, serviceToken: pluginToken, presentation: options.catalog ? Object.fromEntries(options.catalog.resources.map(({ id, capacity, location, features, serviceId, kind, parentId, parentName }) => [id, { capacity, location, features, serviceId, ...(kind ? { kind } : {}), ...(parentId !== undefined ? { parentId } : {}), ...(parentName !== undefined ? { parentName } : {}) }])) : demoPresentation, allowedHosts: [origin.hostname],
    consumeInvocation: (jti, expiresAt) => options.store.compareAndSet(`invocation:${jti}`, null, { consumed: true }, expiresAt * 1000),
    client: actor => {
      const workspaceId = subjectWorkspace(actor.subject);
      const scopedFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('x-hasi-demo-workspace', workspaceId);
        // Anonymous vendor routes are private inside this isolated mock service.
        if (!headers.has('authorization')) headers.set('authorization', `Bearer ${mockToken}`);
        return internalFetch(input, { ...init, headers });
      };
      return new AnnyClient({ baseUrl: origin.origin, organizationId: MOCK_IDS.organization, token: mockToken, allowLoopback: !secure, allowWrites: true, fetchImpl: scopedFetch });
    },
  });

  const knowledge = createKnowledgePlugin({ publicKey, serviceToken: knowledgeToken, allowedHosts: [origin.hostname], consumeInvocation: (jti, expiresAt) => options.store.compareAndSet(`invocation:${jti}`, null, { consumed: true }, expiresAt * 1000) });

  function handleKnowledgePlugin(request: Request) {
    const url = new URL(request.url);
    if (url.origin !== origin.origin || !url.pathname.startsWith('/plugins/knowledge/')) return Promise.resolve(failure(403));
    url.pathname = url.pathname.slice('/plugins/knowledge'.length);
    return forward(knowledge, new Request(url, request));
  }

  function workspace(request: Request) {
    const signed = cookieValue(request.headers.get('cookie'), cookieName);
    const parts = signed?.split('.') ?? [];
    const id = parts[0]; const expiry = Number(parts[1]); const signature = parts[2];
    if (parts.length === 3 && uuid.safeParse(id).success && Number.isSafeInteger(expiry) && expiry > Date.now() && signature && equal(sign(`${id ?? ''}.${String(expiry)}`), signature)) return { id: uuid.parse(id), cookie: undefined };
    const nextId = randomUUID(); const nextExpiry = Date.now() + lifetime;
    const value = `${nextId}.${String(nextExpiry)}`;
    return { id: nextId, cookie: `${cookieName}=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}` };
  }

  async function handleCore(request: Request): Promise<Response> {
    if (new URL(request.url).origin !== origin.origin) return failure(403);
    const space = workspace(request);
    const store = workspaceStore(space.id);
    const registry = new PluginRegistry(privateKey, { store, scope: space.id, fetch: internalFetch });
    await registry.install({ endpoint: `${origin.origin}/mcp`, serviceToken: pluginToken, expectedManifestDigest: digest(annyManifest), approvedPreviousManifestDigests: ['61b8360b00745238bbdfc1dfa134bb20d7e4790581d47bb46091e27ef1c691fb', '325f50953082e8b1156d3c1807a1310b492e61bbcdc84d9d6fd9cd48952db66b'], allowLoopback: !secure });
    await registry.install({ endpoint: `${origin.origin}/plugins/knowledge/mcp`, serviceToken: knowledgeToken, expectedManifestDigest: digest(knowledgeManifest), allowLoopback: !secure });
    const app = await createApi({ mode: secure ? 'public-demo' : 'test', registry, identity: new DurableDemoIdentity(store, space.id, options.catalog?.resources.map(resource => resource.id)), store, origin: origin.origin, allowedHosts: [origin.hostname], secureCookies: secure, sessionCookieName: sessionName });
    try {
      const response = await forward(app, request);
      if (space.cookie) response.headers.append('set-cookie', space.cookie);
      return response;
    } finally { await app.close(); }
  }

  async function handleMock(request: Request): Promise<Response> {
    if (!equal(request.headers.get('authorization') ?? '', `Bearer ${mockToken}`)) return failure(401);
    const scope = uuid.safeParse(request.headers.get('x-hasi-demo-workspace'));
    if (!scope.success) return failure(403);
    const app = createAnnyMock({ token: mockToken, store: workspaceStore(scope.data), scope: 'anny', ...(options.catalog ? { catalog: options.catalog } : {}) });
    try { return await forward(app, request); } finally { await app.close(); }
  }

  async function chatScope(request: Request): Promise<string | null> {
    const space = workspace(request);
    if (space.cookie) return null;
    const user = await new DurableDemoIdentity(workspaceStore(space.id), space.id, options.catalog?.resources.map(resource => resource.id)).resolve(cookieValue(request.headers.get('cookie'), sessionName));
    return user ? `${space.id}:${user.id}` : null;
  }

  async function hasSession(request: Request): Promise<boolean> {
    return (await chatScope(request)) !== null;
  }

  return { handleCore, handleMock, hasSession, chatScope, handleKnowledgePlugin, handlePlugin: (request: Request) => forward(plugin, request), close: async () => { await Promise.all([plugin.close(), knowledge.close()]); } };
}

function failure(status: number) { return Response.json({ error: 'Die Anfrage konnte nicht abgeschlossen werden.' }, { status, headers: { 'cache-control': 'private, no-store' } }); }

async function forward(app: FastifyInstance, request: Request): Promise<Response> {
  const headers = Object.fromEntries(request.headers);
  const url = new URL(request.url);
  headers.host = url.host;
  const chunks: Uint8Array[] = []; let bytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        const value: unknown = part.value;
        if (!(value instanceof Uint8Array)) return failure(400);
        bytes += value.byteLength;
        if (bytes > 65536) return failure(413);
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  const reply = await app.inject({ method: request.method, url: `${url.pathname}${url.search}`, headers, ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}) });
  const outgoing = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined || ['content-length', 'connection', 'transfer-encoding'].includes(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) outgoing.append(name, String(entry));
  }
  outgoing.set('cache-control', 'private, no-store');
  return new Response([204, 205, 304].includes(reply.statusCode) || request.method === 'HEAD' ? null : reply.rawPayload, { status: reply.statusCode, headers: outgoing });
}
