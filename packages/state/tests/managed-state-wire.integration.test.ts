import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJsonStore } from '../src/index.js';
import { closeManagedStateFixtures, fixture } from '../../../tests/helpers/managed-state-registry.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  describe.skip('managed MCP state through PostgreSQL', () => {
    it('requires an explicit disposable loopback database', () => undefined);
  });
} else {
  describe('managed MCP state through PostgreSQL', () => {
    const schema = `managed_wire_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool | undefined; let pool: Pool | undefined; let created = false;
    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
        || !url.port || url.pathname.length < 2 || url.search || url.hash) throw new Error('Explicit loopback test database required');
      admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
      await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6, connectionTimeoutMillis: 2000 });
    });
    afterEach(closeManagedStateFixtures);
    afterAll(async () => {
      await pool?.end();
      try { if (created) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin?.end(); }
    });
    async function durableFixture() {
      if (!pool) throw new Error('Test database unavailable');
      const store = new PostgresJsonStore(`managed-wire-${randomUUID()}`, { pool });
      await store.initialize();
      return fixture(store);
    }
    it('reads the v1 committed state through v2, rollback and a reconstructed registry', async () => {
      const f = await durableFixture();
      const executionId = randomUUID();
      expect(await f.execute(executionId)).toMatchObject({ actionCount: 1 });
      await f.update(); expect(await f.read()).toMatchObject({ actionCount: 1, version: '1.1.0' });
      await f.rollback();
      const restarted = f.construct(); await restarted.restoreConnections();
      expect(await f.read(restarted)).toMatchObject({ actionCount: 1, version: '1.0.0' });
      expect(await f.status(executionId, restarted)).toMatchObject({ status: 'confirmed', result: { actionCount: 1 } });
      expect(f.executions()).toBe(1);
    });
    it('keeps a committed source receipt despite a lost acknowledgment and never repeats the effect', async () => {
      const f = await durableFixture(); const executionId = randomUUID(); f.loseAck();
      await expect(f.execute(executionId)).rejects.toThrow();
      const restarted = f.construct(); await restarted.restoreConnections();
      expect(await f.status(executionId, restarted)).toMatchObject({ status: 'confirmed', result: { actionCount: 1 } });
      expect(await f.execute(executionId, restarted)).toMatchObject({ actionCount: 1 });
      expect(f.executions()).toBe(1);
    });
  });
}
