import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJsonStore, PostgresJsonStore, type JsonStore } from '@hasi/state';
import { hshDemoCatalog } from '../fixtures/catalog.js';
import { createDemoRuntime } from '@hasi/demo-runtime';

const url = process.env.TEST_DATABASE_URL;

for (const adapter of ['memory', 'snapshot', ...(url ? ['postgres', 'snapshot-postgres'] : [])]) {
  const snapshot = adapter === 'snapshot' || adapter === 'snapshot-postgres';
  describe(`deployed demo HTTP/MCP parity (${adapter})`, () => {
    let server: Server;
    let origin: string;
    let store: JsonStore;
    let database: PostgresJsonStore | undefined;
    const runtimes: ReturnType<typeof createDemoRuntime>[] = [];
    const paths: string[] = [];
    let next = 0;
    const secret = randomBytes(32).toString('base64url');
    const cookies = new Map<string, Map<string, string>>();

    beforeAll(async () => {
      if (adapter.endsWith('postgres')) {
        database = new PostgresJsonStore(`demo-test:${randomUUID()}`, { poolConfig: { connectionString: url } });
        await database.initialize(); store = database;
      } else store = new MemoryJsonStore('demo-http');
      server = createServer((incoming, outgoing) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
          const path = incoming.url ?? '/'; paths.push(path.split('?')[0]!);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          const request = new Request(`${origin}${path}`, { method: incoming.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
          const runtime = runtimes[next++ % runtimes.length]!;
          const response = path.startsWith('/plugins/knowledge/') ? await runtime.handleKnowledgePlugin(request) : path.startsWith('/api/v1/') ? await runtime.handleMock(request) : path === '/mcp' || path.startsWith('/.well-known/') ? await runtime.handlePlugin(request) : await runtime.handleCore(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => { if (name !== 'set-cookie') outgoing.setHeader(name, value); });
          if (response.headers.getSetCookie().length) outgoing.setHeader('set-cookie', response.headers.getSetCookie());
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })().catch(() => { outgoing.statusCode = 500; outgoing.end('Test transport failed'); });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
      runtimes.push(createDemoRuntime({ origin, store, secret, ...(snapshot ? { catalog: hshDemoCatalog } : {}) }), createDemoRuntime({ origin, store, secret, ...(snapshot ? { catalog: hshDemoCatalog } : {}) }));
    });

    afterAll(async () => {
      await Promise.all(runtimes.map(runtime => runtime.close()));
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
      await database?.close();
    });

    async function request(visitor: string, path: string, body?: unknown) {
      const jar = cookies.get(visitor) ?? new Map<string, string>(); cookies.set(visitor, jar);
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const entry of response.headers.getSetCookie()) {
        const [pair] = entry.split(';'); const split = pair!.indexOf('=');
        jar.set(pair!.slice(0, split), pair!.slice(split + 1));
      }
      return response;
    }

    it('uses actual signed MCP and HTTP mock calls across independent instances', async () => {
      expect((await request('a', '/api/resources')).status).toBe(401);
      const login = await request('a', '/api/dev/login', { personaId: 'student' });
      expect(login.status).toBe(200);
      const resources = await request('a', '/api/resources');
      expect(resources.status).toBe(200);
      expect((await resources.json() as { resources: unknown[] }).resources).toHaveLength(snapshot ? 43 : 2);
      expect(paths).toContain('/mcp'); expect(paths).toContain('/api/v1/resources');
      expect((await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      expect((await fetch(`${origin}/api/v1/resources`)).status).toBe(401);
    });

    it('retrieves synthetic sources through MCP and rechecks document access after a persona change', async () => {
      await request('knowledge', '/api/dev/login', { personaId: 'admin' });
      const allowed = await request('knowledge', '/api/knowledge/documents/int-013');
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('cache-control')).toBe('private, no-store');
      expect((await allowed.json() as { document: { id: string; synthetic: boolean } }).document).toMatchObject({ id: 'int-013', synthetic: true });
      const search = await request('knowledge', '/api/tools/call', { pluginId: 'de.hsh.hasi.knowledge', name: 'knowledge.search', arguments: { query: 'WLAN Morgenstern' } });
      expect(search.status).toBe(200);
      expect(JSON.stringify(await search.json())).toContain('svc-001');
      expect(paths).toContain('/plugins/knowledge/mcp');
      await request('knowledge', '/api/dev/login', { personaId: 'student' });
      const denied = await request('knowledge', '/api/knowledge/documents/int-013');
      const absent = await request('knowledge', '/api/knowledge/documents/int-999');
      expect(denied.status).toBe(404); expect(absent.status).toBe(404);
      expect(await denied.json()).toEqual(await absent.json());
      await request('knowledge', '/api/logout', {});
      expect((await request('knowledge', '/api/knowledge/documents/svc-001')).status).toBe(401);
    });

    if (snapshot) it('books one desk without reserving the office or its sibling, and rejects office containers', async () => {
      await request('desks', '/api/dev/login', { personaId: 'employee' });
      const catalog = await request('desks', '/api/resources');
      const { resources } = await catalog.json() as { resources: { id: string; kind: string; parentId: string | null; parentName: string | null; serviceId: string; capacity: number | null }[] };
      expect(resources.filter(r => r.kind === 'workplace')).toHaveLength(37);
      expect(resources.filter(r => r.kind === 'meeting_room')).toHaveLength(6);
      expect(resources.some(r => r.id === '179669')).toBe(false);
      const first = resources.find(r => r.id === '180116')!;
      const sibling = resources.find(r => r.id === '180117')!;
      expect(first).toMatchObject({ parentId: '179669', capacity: null, serviceId: '76878' });
      expect(sibling.parentId).toBe(first.parentId);
      const start = new Date(Date.now() + 8 * 86400000); start.setUTCHours(9, 0, 0, 0);
      const args = { resourceId: first.id, serviceId: first.serviceId, startDate: start.toISOString(), endDate: new Date(start.getTime() + 3600000).toISOString() };
      expect((await request('desks', '/api/proposals', { ...args, resourceId: '179669' })).status).toBe(403);
      expect((await request('desks', '/api/availability', { resourceId: '179669', serviceId: first.serviceId, startDate: args.startDate, durationMinutes: 60 })).status).toBe(403);
      const prepared = await request('desks', '/api/proposals', args);
      expect(prepared.status).toBe(200);
      const { proposal } = await prepared.json() as { proposal: { id: string; resourceName: string } };
      expect(proposal.resourceName).toContain('Arbeitsplatz');
      expect(proposal.resourceName).toContain('Amrum 1');
      expect(proposal.resourceName).toContain(first.parentName);
      expect((await request('desks', `/api/proposals/${proposal.id}/confirm`, {})).status).toBe(200);
      const availability = async (resourceId: string) => {
        const result = await request('desks', '/api/availability', { resourceId, serviceId: first.serviceId, startDate: args.startDate, durationMinutes: 60 });
        return (await result.json() as { intervals: { startDate: string; available: boolean }[] }).intervals.find(slot => Date.parse(slot.startDate) === start.getTime())?.available;
      };
      expect(await availability(first.id)).toBe(false);
      expect(await availability(sibling.id)).toBe(true);
      const list = await request('desks', '/api/bookings');
      const { bookings } = await list.json() as { bookings: { resourceName: string }[] };
      expect(bookings).toHaveLength(1);
      expect(bookings[0]?.resourceName).toBe(proposal.resourceName);
    });

    it('atomically confirms once, persists across cold runtimes and blocks foreign or altered confirmation', async () => {
      const start = new Date(Date.now() + 86400000); start.setUTCHours(9, 0, 0, 0);
      const args = { resourceId: snapshot ? '180224' : '00000000-0000-4000-8000-000000000101', serviceId: snapshot ? '65625' : '00000000-0000-4000-8000-000000000201', startDate: start.toISOString(), endDate: new Date(start.getTime() + 3600000).toISOString() };
      expect((await request('a', '/api/tools/call', { pluginId: 'de.hsh.hasi.anny', name: 'anny.execute_booking', arguments: args })).status).toBe(403);
      const prepared = await request('a', '/api/proposals', args);
      expect(prepared.status).toBe(200);
      const { proposal } = await prepared.json() as { proposal: { id: string } };
      const confirm = `/api/proposals/${proposal.id}/confirm`;
      await request('b', '/api/dev/login', { personaId: 'student' });
      expect((await request('b', confirm, {})).status).toBe(404);
      expect((await request('a', confirm, { ...args })).status).toBe(400);
      const race = await Promise.all([request('a', confirm, {}), request('a', confirm, {})]);
      expect(race.some(response => response.status === 200)).toBe(true);
      expect(race.every(response => [200, 409].includes(response.status))).toBe(true);
      runtimes.push(createDemoRuntime({ origin, store, secret, ...(snapshot ? { catalog: hshDemoCatalog } : {}) }));
      const repeated = await request('a', confirm, {});
      expect((await repeated.json() as { proposal: { status: string } }).proposal.status).toBe('confirmed');
      const bookings = await request('a', '/api/bookings');
      const list = await bookings.json() as { bookings: { startDate: string }[] };
      expect(list.bookings.filter(booking => booking.startDate === args.startDate)).toHaveLength(1);
      expect(paths).toContain('/api/v1/orders/from-config');
    });

    it('persists administration changes within one workspace and revokes logout', async () => {
      await request('a', '/api/dev/login', { personaId: 'admin' });
      expect((await request('a', '/api/admin/plugins/de.hsh.hasi.anny/check-update', {})).status).toBe(200);
      expect((await request('a', '/api/admin/plugins/de.hsh.hasi.anny/enabled', { enabled: false })).status).toBe(200);
      expect((await request('a', '/api/resources')).status).toBe(409);
      expect((await request('b', '/api/resources')).status).toBe(200);
      expect((await request('b', '/api/admin/plugins')).status).toBe(403);
      expect((await request('a', '/api/admin/plugins/de.hsh.hasi.anny/enabled', { enabled: true })).status).toBe(200);
      expect((await request('a', '/api/logout', {})).status).toBe(200);
      expect((await request('a', '/api/resources')).status).toBe(401);
    });
  });
}
