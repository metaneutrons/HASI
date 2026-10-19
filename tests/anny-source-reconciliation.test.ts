import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJsonStore, PostgresJsonStore, type JsonStore } from '@hasi/state';
import { createDemoRuntime } from '@hasi/demo-runtime';
import { hshDemoCatalog } from '../fixtures/catalog.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

for (const storage of ['memory', ...(databaseUrl ? ['postgres'] : [])]) {
  describe(`source-correlated Anny outcome recovery (${storage})`, () => {
    let server: Server;
    let origin: string;
    let store: JsonStore;
    let database: PostgresJsonStore | undefined;
    const runtimes: ReturnType<typeof createDemoRuntime>[] = [];
    const cookies = new Map<string, Map<string, string>>();
    const drops = new Set<string>();
    let mutations = 0;
    let sourceStatusReads = 0;
    let hideSourceEvidence = false;
    let nextRuntime = 0;

    beforeAll(async () => {
      if (storage === 'postgres') {
        database = new PostgresJsonStore(`anny-source-test:${randomUUID()}`, { poolConfig: { connectionString: databaseUrl } });
        await database.initialize(); store = database;
      } else store = new MemoryJsonStore(`anny-source-test:${randomUUID()}`);
      server = createServer((incoming, outgoing) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
          const path = incoming.url ?? '/';
          const pathname = new URL(path, origin).pathname;
          if ((incoming.method === 'POST' && pathname === '/api/v1/orders/from-config')
            || (incoming.method === 'GET' && /^\/api\/v1\/bookings\/[^/]+\/cancel$/u.test(pathname))) mutations += 1;
          if (path === '/api/v1/_hasi-demo/execution-status') sourceStatusReads += 1;
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          const request = new Request(`${origin}${path}`, { method: incoming.method ?? 'GET', headers,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
          const runtime = runtimes[nextRuntime++ % runtimes.length];
          if (!runtime) throw new Error('Missing test runtime');
          const response = path.startsWith('/api/v1/') ? await runtime.handleMock(request)
            : path.startsWith('/plugins/knowledge/') ? await runtime.handleKnowledgePlugin(request)
              : pathname === '/mcp' || pathname === '/.well-known/hasi-plugin.json' || pathname.startsWith('/hasi/actions/') ? await runtime.handlePlugin(request)
                : await runtime.handleCore(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => { if (name !== 'set-cookie') outgoing.setHeader(name, value); });
          if (response.headers.getSetCookie().length) outgoing.setHeader('set-cookie', response.headers.getSetCookie());
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })().catch(() => { outgoing.statusCode = 500; outgoing.end('Synthetic transport failure'); });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      origin = `http://127.0.0.1:${String(address.port)}`;
      const privateFetch: typeof fetch = async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        const response = await fetch(input, init);
        if (target.pathname === '/api/v1/_hasi-demo/execution-status' && hideSourceEvidence) {
          await response.body?.cancel();
          return Response.json({ schemaVersion: 1, receipts: [] });
        }
        const operation = target.pathname === '/api/v1/orders/from-config' ? 'create'
          : /^\/api\/v1\/bookings\/[^/]+\/cancel$/u.test(target.pathname) ? 'cancel' : undefined;
        if (response.ok && operation && drops.delete(operation)) {
          // The actual HTTP mock has committed; the Anny client receives no result.
          await response.body?.cancel();
          throw new TypeError('Synthetic source response lost after commit');
        }
        return response;
      };
      const secret = randomBytes(32).toString('base64url');
      runtimes.push(createDemoRuntime({ origin, store, secret, fetch: privateFetch, catalog: hshDemoCatalog }),
        createDemoRuntime({ origin, store, secret, fetch: privateFetch, catalog: hshDemoCatalog }));
    });

    afterAll(async () => {
      await Promise.all(runtimes.map(runtime => runtime.close()));
      await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
      await database?.close();
    });

    async function request(visitor: string, path: string, body?: unknown): Promise<Response> {
      const jar = cookies.get(visitor) ?? new Map<string, string>(); cookies.set(visitor, jar);
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { origin, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0];
        if (pair) { const separator = pair.indexOf('='); jar.set(pair.slice(0, separator), pair.slice(separator + 1)); }
      }
      return response;
    }

    async function login(visitor: string) {
      expect((await request(visitor, '/api/dev/login', { personaId: 'employee' })).status).toBe(200);
      const start = await request(visitor, '/api/plugin-accounts/de.hsh.hasi.anny/authorization', { operation: 'consent', returnTo: '/' });
      const authorization = await start.json() as { authorizationUrl: string };
      const state = new URL(authorization.authorizationUrl, origin).searchParams.get('state');
      expect((await request(visitor, '/api/plugin-accounts/de.hsh.hasi.anny/consent', { state, approved: true })).status).toBe(200);
    }

    async function proposal(visitor: string) {
      const resource = hshDemoCatalog.resources.find(item => item.kind === 'workplace');
      if (!resource) throw new Error('Missing workplace fixture');
      const start = new Date(Date.now() + 8 * 86_400_000); start.setUTCHours(9, 0, 0, 0);
      const response = await request(visitor, '/api/proposals', { resourceId: resource.id, serviceId: resource.serviceId,
        startDate: start.toISOString(), endDate: new Date(start.getTime() + 3_600_000).toISOString() });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json() as { proposal: { id: string } }).proposal.id;
    }

    it('recovers committed create and cancel after source reply loss without replaying either write', async () => {
      await login('owner'); await login('foreign');
      const id = await proposal('owner');
      const initialMutations = mutations;
      drops.add('create');
      const confirm = await request('owner', `/api/proposals/${id}/confirm`, {});
      expect(confirm.status).toBe(200);
      expect((await confirm.json() as { proposal: { status: string } }).proposal.status).toBe('outcome_unknown');
      expect(mutations).toBe(initialMutations + 1);
      const readsBeforeForeign = sourceStatusReads;
      expect((await request('foreign', `/api/proposals/${id}/reconcile`, {})).status).toBe(404);
      expect(sourceStatusReads).toBe(readsBeforeForeign);
      hideSourceEvidence = true;
      try {
        const unresolved = await request('owner', `/api/proposals/${id}/reconcile`, {});
        expect(unresolved.status).toBe(200);
        expect(await unresolved.json()).toMatchObject({ proposal: { status: 'outcome_unknown' } });
        expect(mutations).toBe(initialMutations + 1);
      } finally { hideSourceEvidence = false; }
      expect((await request('owner', `/api/proposals/${id}/reconcile`, {})).status).toBe(429);
      await setTimeout(10_010);
      const recovered = await request('owner', `/api/proposals/${id}/reconcile`, {});
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      const created = await recovered.json() as { bookingId: string; proposal: { status: string } };
      expect(created.proposal.status).toBe('confirmed'); expect(created.bookingId).toBeTruthy();
      expect(sourceStatusReads).toBeGreaterThan(readsBeforeForeign); expect(mutations).toBe(initialMutations + 1);
      expect((await request('owner', `/api/proposals/${id}/confirm`, {})).status).toBe(200);
      expect(mutations).toBe(initialMutations + 1);

      const cancellation = await request('owner', '/api/cancellations', { bookingId: created.bookingId });
      expect(cancellation.status).toBe(200);
      const cancellationId = (await cancellation.json() as { proposal: { id: string } }).proposal.id;
      drops.add('cancel');
      const cancelled = await request('owner', `/api/proposals/${cancellationId}/confirm`, {});
      expect((await cancelled.json() as { proposal: { status: string } }).proposal.status).toBe('outcome_unknown');
      expect(mutations).toBe(initialMutations + 2);
      const resolved = await request('owner', `/api/proposals/${cancellationId}/reconcile`, {});
      expect(resolved.status, await resolved.clone().text()).toBe(200);
      expect(await resolved.json()).toMatchObject({ bookingId: created.bookingId, status: 'cancelled', proposal: { status: 'confirmed' } });
      expect((await request('owner', `/api/proposals/${cancellationId}/confirm`, {})).status).toBe(200);
      expect(mutations).toBe(initialMutations + 2);
    });

    it('makes no source write when personal eligibility is revoked after preparing a booking', async () => {
      await login('revoked');
      const id = await proposal('revoked');
      const before = mutations;
      const accounts = await (await request('revoked', '/api/plugin-accounts')).json() as { accounts: { installationId: string; authorityRevision: number }[] };
      const account = accounts.accounts.find(item => item.installationId === 'de.hsh.hasi.anny');
      expect(account).toBeDefined();
      expect((await request('revoked', '/api/plugin-accounts/de.hsh.hasi.anny/disconnect', { expectedAuthorityRevision: account?.authorityRevision })).status).toBe(200);
      expect((await request('revoked', `/api/proposals/${id}/confirm`, {})).status).toBe(403);
      expect(mutations).toBe(before);
    });
  });
}
