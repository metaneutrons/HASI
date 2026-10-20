import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgresJsonStore, type StateFence } from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const fixture = fileURLToPath(new URL('./fixtures/fenced-state-process.ts', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
type Operation =
  | { kind: 'read'; key: string; fences: readonly StateFence[] }
  | { kind: 'write'; key: string; revision: string | null; value: unknown; fences: readonly StateFence[] }
  | { kind: 'unfenced-write'; key: string; revision: string | null; value: unknown };
interface Ready { pid: number; backendPid: number; bootId: string }
interface Worker {
  child: ChildProcess;
  ready: Ready;
  finished: Promise<{ code: number | null; acknowledged: boolean; result: unknown }>;
  go(): void;
}

if (databaseUrl === undefined) {
  describe.skip('Fenced PostgreSQL state (requires TEST_DATABASE_URL)', () => {
    it('requires an explicit disposable loopback database', () => undefined);
  });
} else {
  describe('Fenced PostgreSQL state', () => {
    const schema = `fenced_it_${randomUUID().replaceAll('-', '')}`;
    const namespace = `fenced-state-${randomUUID()}`;
    const workers: Worker[] = [];
    let admin: Pool;
    let pool: Pool;
    let store: PostgresJsonStore;
    let schemaCreated = false;
    const cleanup: { admin?: Pool; pool?: Pool } = {};

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
        || !url.port || url.pathname.length < 2 || url.search || url.hash) throw new Error('Explicit loopback test database required');
      admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
      cleanup.admin = admin;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 2000 });
      cleanup.pool = pool;
      store = new PostgresJsonStore(namespace, { pool });
      await store.initialize();
    });

    afterAll(async () => {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM');
      }
      await Promise.all(workers.map(worker => worker.finished));
      await cleanup.pool?.end();
      try { if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await cleanup.admin?.end(); }
    });

    async function entry(key: string): Promise<{ revision: string; value: unknown }> {
      const value = await store.read(key);
      if (!value) throw new Error('Expected active synthetic state');
      return value;
    }

    async function seed(label: string) {
      const suffix = randomUUID();
      const route = `a-route-${label}-${suffix}`;
      const settings = `b-settings-${label}-${suffix}`;
      const target = `z-state-${label}-${suffix}`;
      expect(await store.compareAndSet(route, null, { version: 1 })).toBe(true);
      expect(await store.compareAndSet(settings, null, { revision: 1 })).toBe(true);
      const fences = [{ key: route, revision: (await entry(route)).revision }, { key: settings, revision: (await entry(settings)).revision }];
      return { route, settings, target, fences };
    }

    async function worker(operation: Operation, dropAcknowledgement = false): Promise<Worker> {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: root, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let resolveReady!: (value: Ready) => void;
      let rejectReady!: (error: Error) => void;
      let acknowledged = false;
      let result: unknown;
      const ready = new Promise<Ready>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const timer = setTimeout(() => { rejectReady(new Error('State worker readiness timed out')); child.kill('SIGTERM'); }, 8000);
      child.on('message', raw => {
        if (!raw || typeof raw !== 'object' || !('kind' in raw)) return;
        if (raw.kind === 'ready' && 'pid' in raw && typeof raw.pid === 'number' && 'backendPid' in raw
          && typeof raw.backendPid === 'number' && 'bootId' in raw && typeof raw.bootId === 'string') {
          clearTimeout(timer);
          resolveReady({ pid: raw.pid, backendPid: raw.backendPid, bootId: raw.bootId });
        } else if (raw.kind === 'result' && 'result' in raw) {
          acknowledged = true;
          result = raw.result;
        }
      });
      const finished = new Promise<{ code: number | null; acknowledged: boolean; result: unknown }>(resolve => {
        child.once('error', () => { clearTimeout(timer); rejectReady(new Error('State worker failed to start')); });
        child.once('exit', code => {
          clearTimeout(timer);
          rejectReady(new Error('State worker exited before readiness'));
          resolve({ code, acknowledged, result });
        });
      });
      child.send({ databaseUrl, namespace, schema, operation, dropAcknowledgement });
      const readyValue = await ready;
      const handle: Worker = { child, ready: readyValue, finished, go: () => { child.send({ go: true }); } };
      workers.push(handle);
      return handle;
    }

    async function waitForBlocking(pid: number, blocker: number): Promise<void> {
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const result = await pool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [pid]);
        if (result.rows[0]?.blockers.includes(blocker)) return;
        await new Promise(resolve => { setTimeout(resolve, 5); });
      }
      throw new Error('Expected actual PostgreSQL lock wait was not observed');
    }

    async function lock(key: string): Promise<{ client: PoolClient; pid: number }> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT key FROM hasi_state_v1 WHERE namespace=$1 AND key=$2 FOR UPDATE', [namespace, key]);
        const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pid = result.rows[0]?.pid;
        if (!pid) throw new Error('Missing control backend');
        return { client, pid };
      } catch (error) { await client.query('ROLLBACK'); client.release(); throw error; }
    }

    it('reads and mutates only with every active fence and preserves ordinary CAS semantics', async () => {
      const s = await seed('positive');
      expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: true });
      expect(await store.compareAndSetWithFence(s.target, null, { count: 0 }, s.fences)).toBe(true);
      const initial = await entry(s.target);
      expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: true, entry: initial });
      expect(await store.compareAndSetWithFence(s.target, initial.revision, { count: 1 }, s.fences)).toBe(true);
      expect(await store.compareAndSetWithFence(s.target, initial.revision, { count: 2 }, s.fences)).toBe(false);
      expect((await entry(s.target)).value).toEqual({ count: 1 });
    });

    it('does not return content or mutate state for stale, missing or expired fences', async () => {
      for (const kind of ['stale', 'missing', 'expired'] as const) {
        const s = await seed(kind);
        expect(await store.compareAndSet(s.target, null, { privateValue: 'synthetic' })).toBe(true);
        const before = await entry(s.target);
        if (kind === 'missing') await store.delete(s.route);
        else expect(await store.compareAndSet(s.route, s.fences[0]!.revision, { version: 2 }, kind === 'expired' ? 0 : undefined)).toBe(true);
        expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: false });
        expect(await store.compareAndSetWithFence(s.target, before.revision, { privateValue: 'overwritten' }, s.fences)).toBe(false);
        expect(await entry(s.target)).toEqual(before);
      }
    });

    it('keeps target and fence lookup inside the store namespace', async () => {
      const s = await seed('namespace');
      expect(await store.compareAndSetWithFence(s.target, null, { privateValue: 'first namespace' }, s.fences)).toBe(true);
      const other = new PostgresJsonStore(`${namespace}-other`, { pool });
      await other.initialize();
      expect(await other.readWithFence(s.target, s.fences)).toEqual({ matched: false });
      expect(await other.compareAndSetWithFence(s.target, null, { privateValue: 'other namespace' }, s.fences)).toBe(false);
      expect(await other.read(s.target)).toBeUndefined();
      expect((await entry(s.target)).value).toEqual({ privateValue: 'first namespace' });
    });

    it('treats an expired target as absent without accepting its old revision', async () => {
      const s = await seed('target-expiry');
      expect(await store.compareAndSet(s.target, null, { count: 0 }, 0)).toBe(true);
      const expired = await pool.query<{ revision: string }>('SELECT revision FROM hasi_state_v1 WHERE namespace=$1 AND key=$2', [namespace, s.target]);
      const oldRevision = expired.rows[0]?.revision;
      expect(oldRevision).toBeDefined();
      expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: true });
      expect(await store.compareAndSetWithFence(s.target, oldRevision!, { count: 1 }, s.fences)).toBe(false);
      expect(await store.compareAndSetWithFence(s.target, null, { count: 2 }, s.fences)).toBe(true);
      expect((await entry(s.target)).value).toEqual({ count: 2 });
    });

    it('snapshots caller input before waiting to acquire a database connection', async () => {
      const s = await seed('input-snapshot');
      const singlePool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 2000 });
      const singleStore = new PostgresJsonStore(namespace, { pool: singlePool });
      await singleStore.initialize();
      const held = await singlePool.connect();
      const fences = s.fences.map(fence => ({ ...fence }));
      const submitted = { nested: { count: 1 } };
      let released = false;
      try {
        const pending = singleStore.compareAndSetWithFence(s.target, null, submitted, fences);
        expect(singlePool.waitingCount).toBe(1);
        fences[0]!.key = 'wrong-authority';
        fences[0]!.revision = randomUUID();
        submitted.nested.count = 2;
        held.release(); released = true;
        expect(await pending).toBe(true);
        expect((await entry(s.target)).value).toEqual({ nested: { count: 1 } });
      } finally { if (!released) held.release(); await singlePool.end(); }
    });

    it('has one CAS winner across independent OS processes and survives reader replacement', async () => {
      const s = await seed('process-race');
      expect(await store.compareAndSet(s.target, null, { count: 0 })).toBe(true);
      const initial = await entry(s.target);
      const first = await worker({ kind: 'write', key: s.target, revision: initial.revision, value: { count: 1 }, fences: s.fences });
      const second = await worker({ kind: 'write', key: s.target, revision: initial.revision, value: { count: 2 }, fences: s.fences });
      expect(first.ready.pid).not.toBe(second.ready.pid);
      expect(first.ready.backendPid).not.toBe(second.ready.backendPid);
      first.go(); second.go();
      const results = await Promise.all([first.finished, second.finished]);
      expect(results.map(result => result.code)).toEqual([0, 0]);
      expect(results.every(result => result.acknowledged)).toBe(true);
      expect(results.map(result => result.result).filter(Boolean)).toHaveLength(1);
      const replacement = await worker({ kind: 'read', key: s.target, fences: s.fences });
      expect(replacement.ready.bootId).not.toBe(first.ready.bootId);
      replacement.go();
      const read = await replacement.finished;
      expect(read.code).toBe(0);
      expect(read.result).toEqual({ matched: true, entry: await entry(s.target) });
      expect([1, 2]).toContain(((await entry(s.target)).value as { count: number }).count);
    });

    it('rechecks a route changed while waiting for its row lock', async () => {
      const s = await seed('route-first');
      const pending = await worker({ kind: 'write', key: s.target, revision: null, value: { count: 1 }, fences: s.fences });
      const held = await lock(s.route);
      try {
        pending.go();
        await waitForBlocking(pending.ready.backendPid, held.pid);
        await held.client.query('UPDATE hasi_state_v1 SET revision=$3::uuid, value=$4::jsonb WHERE namespace=$1 AND key=$2', [namespace, s.route, randomUUID(), JSON.stringify({ version: 2 })]);
        await held.client.query('COMMIT');
        expect(await pending.finished).toEqual({ code: 0, acknowledged: true, result: false });
        expect(await store.read(s.target)).toBeUndefined();
      } finally { await held.client.query('ROLLBACK'); held.client.release(); }
    });

    it('holds the route fence through the state commit, even against an ordinary route CAS', async () => {
      const s = await seed('state-first');
      expect(await store.compareAndSet(s.target, null, { count: 0 })).toBe(true);
      const pending = await worker({ kind: 'write', key: s.target, revision: (await entry(s.target)).revision, value: { count: 1 }, fences: s.fences });
      const activation = await worker({ kind: 'unfenced-write', key: s.route, revision: s.fences[0]!.revision, value: { version: 2 } });
      const held = await lock(s.target);
      try {
        pending.go();
        await waitForBlocking(pending.ready.backendPid, held.pid);
        activation.go();
        await waitForBlocking(activation.ready.backendPid, pending.ready.backendPid);
        await held.client.query('COMMIT');
        expect(await pending.finished).toEqual({ code: 0, acknowledged: true, result: true });
        expect(await activation.finished).toEqual({ code: 0, acknowledged: true, result: true });
        expect((await entry(s.target)).value).toEqual({ count: 1 });
        expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: false });
      } finally { await held.client.query('ROLLBACK'); held.client.release(); }
    });

    it('rejects a fence that expires during an observed database lock wait', async () => {
      const s = await seed('expiry-wait');
      const pending = await worker({ kind: 'write', key: s.target, revision: null, value: { count: 1 }, fences: s.fences });
      await pool.query("UPDATE hasi_state_v1 SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE namespace=$1 AND key=$2", [namespace, s.route]);
      const held = await lock(s.route);
      try {
        const active = await pool.query<{ active: boolean }>('SELECT expires_at>clock_timestamp() AS active FROM hasi_state_v1 WHERE namespace=$1 AND key=$2', [namespace, s.route]);
        expect(active.rows[0]?.active).toBe(true);
        pending.go();
        await waitForBlocking(pending.ready.backendPid, held.pid);
        const deadline = Date.now() + 1200;
        let expired = false;
        while (Date.now() < deadline) {
          const check = await pool.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM hasi_state_v1 WHERE namespace=$1 AND key=$2', [namespace, s.route]);
          if (check.rows[0]?.expired) { expired = true; break; }
          await new Promise(resolve => { setTimeout(resolve, 5); });
        }
        expect(expired).toBe(true);
        await held.client.query('COMMIT');
        expect(await pending.finished).toEqual({ code: 0, acknowledged: true, result: false });
        expect(await store.read(s.target)).toBeUndefined();
      } finally { await held.client.query('ROLLBACK'); held.client.release(); }
    });

    it('does not accept an authority row inserted after the locking snapshot', async () => {
      const s = await seed('missing-then-inserted');
      expect(await store.compareAndSet(s.target, null, { count: 0 })).toBe(true);
      const original = await entry(s.target);
      const pending = await worker({ kind: 'write', key: s.target, revision: original.revision, value: { count: 1 }, fences: s.fences });
      await store.delete(s.route);
      const held = await lock(s.target);
      try {
        pending.go();
        await waitForBlocking(pending.ready.backendPid, held.pid);
        // Reusing a known revision is deliberate: accepting the second read alone
        // would validate this newly inserted row without ever holding its lock.
        await pool.query('INSERT INTO hasi_state_v1(namespace,key,value,revision) VALUES($1,$2,$3::jsonb,$4::uuid)',
          [namespace, s.route, JSON.stringify({ version: 1 }), s.fences[0]!.revision]);
        await held.client.query('COMMIT');
        expect(await pending.finished).toEqual({ code: 0, acknowledged: true, result: false });
        expect(await entry(s.target)).toEqual(original);
        expect(await store.readWithFence(s.target, s.fences)).toEqual({ matched: true, entry: original });
      } finally { await held.client.query('ROLLBACK'); held.client.release(); }
    });

    it('bounds lock waiting, rolls back and restores the connection settings', async () => {
      const s = await seed('lock-timeout');
      const singlePool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 2000 });
      const singleStore = new PostgresJsonStore(namespace, { pool: singlePool });
      await singleStore.initialize();
      const settingsSql = "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout";
      const before = (await singlePool.query(settingsSql)).rows;
      const held = await lock(s.route);
      try {
        let failure: unknown;
        try { await singleStore.compareAndSetWithFence(s.target, null, { count: 1 }, s.fences); }
        catch (error) { failure = error; }
        expect(failure).toBeDefined();
        expect(typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined).toMatch(/^(55P03|57014)$/u);
        await held.client.query('COMMIT');
        expect((await singlePool.query(settingsSql)).rows).toEqual(before);
        expect(await singleStore.read(s.target)).toBeUndefined();
        expect(await singleStore.compareAndSetWithFence(s.target, null, { count: 1 }, s.fences)).toBe(true);
      } finally { await held.client.query('ROLLBACK'); held.client.release(); await singlePool.end(); }
    });

    it('recovers a committed write after a deliberately omitted process acknowledgement without repeating CAS', async () => {
      const s = await seed('lost-ack');
      const writer = await worker({ kind: 'write', key: s.target, revision: null, value: { count: 1 }, fences: s.fences }, true);
      writer.go();
      expect(await writer.finished).toEqual({ code: 0, acknowledged: false, result: undefined });
      const reader = await worker({ kind: 'read', key: s.target, fences: s.fences });
      reader.go();
      const recovered = await reader.finished;
      expect(recovered.code).toBe(0);
      expect(recovered.result).toEqual({ matched: true, entry: await entry(s.target) });
      expect(await store.compareAndSetWithFence(s.target, null, { count: 2 }, s.fences)).toBe(false);
      expect((await entry(s.target)).value).toEqual({ count: 1 });
    });
  });
}
