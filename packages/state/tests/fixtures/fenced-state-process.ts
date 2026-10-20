import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { PostgresJsonStore } from '../../src/index.js';

const fence = z.strictObject({ key: z.string(), revision: z.uuid() });
const inputSchema = z.strictObject({
  databaseUrl: z.string().max(2048),
  namespace: z.string().min(1).max(128),
  schema: z.string().regex(/^fenced_it_[a-f0-9]{32}$/u),
  dropAcknowledgement: z.boolean().default(false),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('read'), key: z.string(), fences: z.array(fence) }),
    z.strictObject({ kind: z.literal('write'), key: z.string(), revision: z.uuid().nullable(), value: z.unknown(), fences: z.array(fence) }),
    z.strictObject({ kind: z.literal('unfenced-write'), key: z.string(), revision: z.uuid().nullable(), value: z.unknown() }),
  ]),
});

let pool: Pool | undefined;
let finished = false;
const deadline = setTimeout(() => { void stop(1); }, 10_000);

async function stop(code: number): Promise<void> {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try { await pool?.end(); } finally {
    process.exitCode = code;
    if (process.connected) process.disconnect();
  }
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error('Parent unavailable')); return; }
    process.send(message, error => { if (error) reject(error); else resolve(); });
  });
}

async function run(raw: unknown): Promise<void> {
  try {
    const input = inputSchema.parse(raw);
    const url = new URL(input.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || !url.port || url.pathname.length < 2 || url.search || url.hash) throw new Error('Loopback database required');
    pool = new Pool({ connectionString: input.databaseUrl, options: `-c search_path=${input.schema}`, max: 1, connectionTimeoutMillis: 2000 });
    const store = new PostgresJsonStore(input.namespace, { pool });
    await store.initialize();
    const backend = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await send({ kind: 'ready', pid: process.pid, backendPid: backend.rows[0]?.pid, bootId: randomUUID() });
    await new Promise<void>((resolve, reject) => {
      process.once('message', value => {
        if (typeof value === 'object' && value !== null && 'go' in value && value.go === true) resolve();
        else reject(new Error('Invalid start signal'));
      });
    });
    const operation = input.operation;
    const result = operation.kind === 'read'
      ? await store.readWithFence(operation.key, operation.fences)
      : operation.kind === 'write'
        ? await store.compareAndSetWithFence(operation.key, operation.revision, operation.value, operation.fences)
        : await store.compareAndSet(operation.key, operation.revision, operation.value);
    if (!input.dropAcknowledgement) await send({ kind: 'result', result });
    await stop(0);
  } catch {
    try { await send({ kind: 'error' }); } finally { await stop(1); }
  }
}

process.once('message', value => { void run(value); });
process.once('disconnect', () => { if (!finished) void stop(1); });
