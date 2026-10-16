import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresJsonStore } from '../src/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl === undefined) {
  describe.skip('PostgresJsonStore integration (requires TEST_DATABASE_URL)', () => {
    it('is skipped because TEST_DATABASE_URL is not set', () => undefined);
  });
} else {
  describe('PostgresJsonStore integration', () => {
    const namespace = `state-test-${randomUUID()}`;
    const otherNamespace = `${namespace}-other`;
    const schemaName = `state_it_${randomUUID().replaceAll('-', '')}`;
    let adminPool: Pool | undefined;
    let pool: Pool | undefined;
    let store: PostgresJsonStore | undefined;
    let sameNamespaceStore: PostgresJsonStore | undefined;
    let otherNamespaceStore: PostgresJsonStore | undefined;
    let schemaCreated = false;

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: testDatabaseUrl });
      await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
      schemaCreated = true;
      pool = new Pool({
        connectionString: testDatabaseUrl,
        options: `-c search_path=${schemaName}`,
      });
      store = new PostgresJsonStore(namespace, { pool });
      sameNamespaceStore = new PostgresJsonStore(namespace, { pool });
      otherNamespaceStore = new PostgresJsonStore(otherNamespace, { pool });
    });

    afterAll(async () => {
      try {
        if (schemaCreated && adminPool !== undefined) await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await Promise.all([pool?.end(), adminPool?.end()]);
      }
    });

    it('creates a clean table safely during concurrent initialization', async () => {
      const before = await pool!.query<{ table_name: string | null }>("SELECT to_regclass('hasi_state_v1') AS table_name");
      expect(before.rows[0]?.table_name).toBeNull();
      await Promise.all([store!.initialize(), sameNamespaceStore!.initialize(), otherNamespaceStore!.initialize()]);
      const after = await pool!.query<{ table_name: string | null }>("SELECT to_regclass('hasi_state_v1') AS table_name");
      expect(after.rows[0]?.table_name).toBe('hasi_state_v1');
    });

    it('allows one concurrent revision update and rejects its stale revision', async () => {
      await Promise.all([store!.initialize(), sameNamespaceStore!.initialize(), otherNamespaceStore!.initialize()]);
      const activeStore = store!;
      const concurrentStore = sameNamespaceStore!;
      expect(await activeStore.compareAndSet('race', null, { count: 0 })).toBe(true);
      const original = await activeStore.read('race');
      expect(original).toBeDefined();

      const attempts = await Promise.all([
        activeStore.compareAndSet('race', original!.revision, { count: 1 }),
        concurrentStore.compareAndSet('race', original!.revision, { count: 2 }),
      ]);

      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(await activeStore.compareAndSet('race', original!.revision, { count: 3 })).toBe(false);
    });

    it('replaces expired data and isolates rows by namespace', async () => {
      await Promise.all([store!.initialize(), sameNamespaceStore!.initialize(), otherNamespaceStore!.initialize()]);
      const activeStore = store!;
      const isolatedStore = otherNamespaceStore!;
      expect(await activeStore.compareAndSet('expires', null, { value: 'old' })).toBe(true);
      const original = await activeStore.read('expires');
      expect(original).toBeDefined();
      expect(await activeStore.compareAndSet('expires', original!.revision, { value: 'expired' }, Date.now() - 1)).toBe(true);
      expect(await activeStore.read('expires')).toBeUndefined();
      expect(await activeStore.compareAndSet('expires', null, { value: 'replacement' })).toBe(true);
      const replacement = await activeStore.read('expires');
      expect(replacement?.revision).not.toBe(original!.revision);
      expect(await activeStore.compareAndSet('expires', original!.revision, { value: 'stale' })).toBe(false);

      expect(await isolatedStore.compareAndSet('expires', null, { value: 'other namespace' })).toBe(true);
      expect((await isolatedStore.read('expires'))?.value).toEqual({ value: 'other namespace' });
      expect((await activeStore.read('expires'))?.value).toEqual({ value: 'replacement' });
    });

    it('deletes expired rows in bounded batches within this namespace', async () => {
      await Promise.all([store!.initialize(), sameNamespaceStore!.initialize(), otherNamespaceStore!.initialize()]);
      const activeStore = store!;
      const isolatedStore = otherNamespaceStore!;
      expect(await activeStore.compareAndSet('expired-a', null, { value: 1 }, Date.now() - 1)).toBe(true);
      expect(await activeStore.compareAndSet('expired-b', null, { value: 2 }, Date.now() - 1)).toBe(true);
      expect(await activeStore.compareAndSet('active', null, { value: 3 })).toBe(true);
      expect(await isolatedStore.compareAndSet('expired-other', null, { value: 4 }, Date.now() - 1)).toBe(true);

      expect(await activeStore.deleteExpired(1)).toBe(1);
      expect(await activeStore.deleteExpired()).toBe(1);
      expect(await activeStore.deleteExpired()).toBe(0);
      expect(await activeStore.read('active')).toBeDefined();
      expect(await isolatedStore.read('expired-other')).toBeUndefined();
      expect(await isolatedStore.deleteExpired()).toBe(1);
      await expect(activeStore.deleteExpired(1_001)).rejects.toThrow(RangeError);
    });
  });
}
