import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { FencedReadResult, FencedJsonStore, StateFence } from './store.js';
import {
  cloneJsonValue,
  isUuidRevision,
  snapshotStateFences,
  validateExpiry,
  validateKey,
  validateNamespace,
} from './store.js';

export interface PostgresJsonStoreOptions {
  /** An injected pool remains owned by the caller and is not ended by close(). */
  readonly pool?: Pool;
  /** Configuration used when this store creates and owns its pool. */
  readonly poolConfig?: PoolConfig;
}

interface JsonStateRow {
  readonly revision: string;
  readonly value: unknown;
}

interface StateFenceRow {
  readonly key: string;
  readonly revision: string;
}

interface LockedKeyRow {
  readonly key: string;
}

type FencedTransactionResult<T> =
  | { readonly matched: false }
  | { readonly matched: true; readonly value: T };

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS hasi_state_v1 (
    namespace text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    revision uuid NOT NULL,
    expires_at timestamptz,
    PRIMARY KEY (namespace, key)
  )
`;
const CREATE_EXPIRY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS hasi_state_v1_expires_idx
  ON hasi_state_v1 (namespace, expires_at)
  WHERE expires_at IS NOT NULL
`;
const LOCK_FENCED_KEYS_SQL = `
  SELECT key
  FROM hasi_state_v1
  WHERE namespace = $1
    AND key = ANY($2::text[])
  ORDER BY key COLLATE "C"
  FOR UPDATE
`;
const VERIFY_FENCES_SQL = `
  SELECT key, revision
  FROM hasi_state_v1
  WHERE namespace = $1
    AND key = ANY($2::text[])
    AND (expires_at IS NULL OR expires_at > clock_timestamp())
`;
const READ_FENCED_TARGET_SQL = `
  SELECT revision, value
  FROM hasi_state_v1
  WHERE namespace = $1
    AND key = $2
    AND (expires_at IS NULL OR expires_at > clock_timestamp())
`;

const SCHEMA_LOCK_CLASS = 1_212_242_761;
const SCHEMA_LOCK_ID = 1_448_232_001;
const MAX_EXPIRED_ROWS_PER_BATCH = 1_000;

/** A PostgreSQL-backed JSON store. Call initialize() before using it. */
export class PostgresJsonStore implements FencedJsonStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private initialized = false;
  private closed = false;

  constructor(private readonly namespace: string, options: PostgresJsonStoreOptions = {}) {
    validateNamespace(namespace);
    if (options.pool !== undefined && options.poolConfig !== undefined) {
      throw new TypeError('Pass either a pool or poolConfig, not both');
    }
    this.ownsPool = options.pool === undefined;
    this.pool = options.pool ?? new Pool(options.poolConfig);
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error('PostgresJsonStore is closed');
    const client = await this.pool.connect();
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SCHEMA_LOCK_CLASS, SCHEMA_LOCK_ID]);
        await client.query(CREATE_TABLE_SQL);
        await client.query(CREATE_EXPIRY_INDEX_SQL);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroyClient = true;
        }
        throw error;
      }
      this.initialized = true;
    } finally {
      client.release(destroyClient);
    }
  }

  async read(key: string): Promise<{ revision: string; value: unknown } | undefined> {
    validateKey(key);
    this.ensureInitialized();
    const result = await this.pool.query<JsonStateRow>(
      `SELECT revision, value
       FROM hasi_state_v1
       WHERE namespace = $1
         AND key = $2
         AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [this.namespace, key],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { revision: row.revision, value: cloneJsonValue(row.value) };
  }

  async readWithFence(key: string, fences: readonly StateFence[]): Promise<FencedReadResult> {
    validateKey(key);
    const fenceSnapshot = snapshotStateFences(key, fences);
    this.ensureInitialized();

    const result = await this.withFencedRowsLocked(key, fenceSnapshot, async (client) => {
      const target = await client.query<JsonStateRow>(READ_FENCED_TARGET_SQL, [this.namespace, key]);
      const row = target.rows[0];
      if (row === undefined) return undefined;
      return { revision: row.revision, value: cloneJsonValue(row.value) };
    });
    if (!result.matched) return { matched: false };
    if (result.value === undefined) return { matched: true };
    return { matched: true, entry: result.value };
  }

  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number): Promise<boolean> {
    validateKey(key);
    this.ensureInitialized();
    const storedValue = cloneJsonValue(value);
    const expiration = validateExpiry(expiresAt);
    if (expectedRevision !== null && !isUuidRevision(expectedRevision)) return false;

    const revision = randomUUID();
    const values = [this.namespace, key, JSON.stringify(storedValue), revision, expiration === null ? null : new Date(expiration)];

    if (expectedRevision === null) {
      const result = await this.pool.query(
        `INSERT INTO hasi_state_v1 (namespace, key, value, revision, expires_at)
         VALUES ($1, $2, $3::jsonb, $4::uuid, $5::timestamptz)
         ON CONFLICT (namespace, key) DO UPDATE
         SET value = EXCLUDED.value,
             revision = EXCLUDED.revision,
             expires_at = EXCLUDED.expires_at
         WHERE hasi_state_v1.expires_at IS NOT NULL
           AND hasi_state_v1.expires_at <= clock_timestamp()
         RETURNING revision`,
        values,
      );
      return (result.rowCount ?? result.rows.length) > 0;
    }

    const result = await this.pool.query(
      `UPDATE hasi_state_v1
       SET value = $3::jsonb,
           revision = $4::uuid,
           expires_at = $5::timestamptz
       WHERE namespace = $1
         AND key = $2
         AND revision = $6::uuid
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
       RETURNING revision`,
      [...values, expectedRevision],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async compareAndSetWithFence(
    key: string,
    expectedRevision: string | null,
    value: unknown,
    fences: readonly StateFence[],
    expiresAt?: number,
  ): Promise<boolean> {
    validateKey(key);
    const fenceSnapshot = snapshotStateFences(key, fences);
    this.ensureInitialized();
    const storedValue = cloneJsonValue(value);
    const expiration = validateExpiry(expiresAt);
    if (expectedRevision !== null && !isUuidRevision(expectedRevision)) return false;

    const revision = randomUUID();
    const values = [this.namespace, key, JSON.stringify(storedValue), revision, expiration === null ? null : new Date(expiration)];
    const result = await this.withFencedRowsLocked(key, fenceSnapshot, async (client) => {
      if (expectedRevision === null) {
        const inserted = await client.query(
          `INSERT INTO hasi_state_v1 (namespace, key, value, revision, expires_at)
           VALUES ($1, $2, $3::jsonb, $4::uuid, $5::timestamptz)
           ON CONFLICT (namespace, key) DO UPDATE
           SET value = EXCLUDED.value,
               revision = EXCLUDED.revision,
               expires_at = EXCLUDED.expires_at
           WHERE hasi_state_v1.expires_at IS NOT NULL
             AND hasi_state_v1.expires_at <= clock_timestamp()
           RETURNING revision`,
          values,
        );
        return (inserted.rowCount ?? inserted.rows.length) > 0;
      }

      const updated = await client.query(
        `UPDATE hasi_state_v1
         SET value = $3::jsonb,
             revision = $4::uuid,
             expires_at = $5::timestamptz
         WHERE namespace = $1
           AND key = $2
           AND revision = $6::uuid
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
         RETURNING revision`,
        [...values, expectedRevision],
      );
      return (updated.rowCount ?? updated.rows.length) > 0;
    });
    return result.matched && result.value;
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    this.ensureInitialized();
    await this.pool.query('DELETE FROM hasi_state_v1 WHERE namespace = $1 AND key = $2', [this.namespace, key]);
  }

  /** Deletes up to 1,000 expired rows in this namespace; cleanup is never implicit. */
  async deleteExpired(limit = MAX_EXPIRED_ROWS_PER_BATCH): Promise<number> {
    this.ensureInitialized();
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPIRED_ROWS_PER_BATCH) {
      throw new RangeError('limit must be an integer between 1 and 1000');
    }
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT ctid
         FROM hasi_state_v1
         WHERE namespace = $1
           AND expires_at IS NOT NULL
           AND expires_at <= clock_timestamp()
         ORDER BY expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM hasi_state_v1
       WHERE ctid IN (SELECT ctid FROM expired)
       RETURNING 1`,
      [this.namespace, limit],
    );
    return result.rowCount ?? result.rows.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }

  private ensureInitialized(): void {
    if (this.closed) throw new Error('PostgresJsonStore is closed');
    if (!this.initialized) throw new Error('PostgresJsonStore.initialize() must complete before use');
  }

  private async withFencedRowsLocked<T>(
    targetKey: string,
    fences: readonly StateFence[],
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<FencedTransactionResult<T>> {
    const client = await this.pool.connect();
    let destroyClient = false;
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      const lockedRows = await client.query<LockedKeyRow>(LOCK_FENCED_KEYS_SQL, [
        this.namespace,
        [targetKey, ...fences.map((fence) => fence.key)],
      ]);
      const lockedKeys = new Set(lockedRows.rows.map((row) => row.key));
      if (!fences.every((fence) => lockedKeys.has(fence.key))) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { matched: false };
      }

      const currentFences = await client.query<StateFenceRow>(VERIFY_FENCES_SQL, [
        this.namespace,
        fences.map((fence) => fence.key),
      ]);
      const revisionsByKey = new Map(currentFences.rows.map((row) => [row.key, row.revision.toLowerCase()]));
      if (!fences.every((fence) => revisionsByKey.get(fence.key) === fence.revision.toLowerCase())) {
        await client.query('COMMIT');
        transactionOpen = false;
        return { matched: false };
      }

      const value = await operation(client);
      await client.query('COMMIT');
      transactionOpen = false;
      return { matched: true, value };
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch {
          destroyClient = true;
        }
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }
}
