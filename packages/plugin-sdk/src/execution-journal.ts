import { z } from 'zod';
import { digest, parseJsonRecord } from './canonical-json.js';

export interface ExecutionStore {
  read(key: string): Promise<{ revision: string; value: unknown } | undefined>;
  compareAndSet(key: string, revision: string | null, value: unknown, expiresAt?: number): Promise<boolean>;
}
export interface ExecutionBinding {
  subject: string;
  installationId: string;
  executionId: string;
  tool: string;
  argsHash: string;
  configurationRevision: number;
}
const receiptSchema = z.strictObject({
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['executing', 'confirmed', 'outcome_unknown']),
  result: z.record(z.string(), z.unknown()).optional(),
});
export type ExecutionReceipt = { status: 'confirmed'; result: Record<string, unknown> } | { status: 'outcome_unknown' };

/** Shared plugin-side receipts. Missing or unfinished records never prove a failed write. */
export class ExecutionJournal {
  constructor(private readonly store: ExecutionStore, private readonly namespace: string) {
    if (!namespace || namespace.length > 256) throw new TypeError('Invalid execution journal namespace');
  }
  private key(binding: ExecutionBinding) {
    if (!z.uuid().safeParse(binding.executionId).success) throw new TypeError('Invalid execution identity');
    return `execution:v1:${digest({ namespace: this.namespace, subject: binding.subject, installationId: binding.installationId, executionId: binding.executionId })}`;
  }
  async status(binding: ExecutionBinding): Promise<ExecutionReceipt> {
    const record = await this.store.read(this.key(binding));
    if (!record) return { status: 'outcome_unknown' };
    const receipt = receiptSchema.parse(record.value);
    if (receipt.binding !== digest(binding)) throw new Error('Execution binding changed');
    return receipt.status === 'confirmed' && receipt.result ? { status: 'confirmed', result: receipt.result } : { status: 'outcome_unknown' };
  }
  async execute(binding: ExecutionBinding, invoke: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const key = this.key(binding);
    const initial = { binding: digest(binding), status: 'executing' as const };
    // No automatic TTL: expiring an idempotency tombstone could permit a second write.
    if (!await this.store.compareAndSet(key, null, initial)) {
      const prior = await this.status(binding);
      if (prior.status === 'confirmed') return prior.result;
      throw new Error('Execution outcome requires reconciliation');
    }
    let result: Record<string, unknown>;
    try {
      result = parseJsonRecord(await invoke());
      if (Buffer.byteLength(JSON.stringify(result)) > 60 * 1024) throw new Error('Oversized execution receipt');
    } catch {
      const record = await this.store.read(key);
      if (record) await this.store.compareAndSet(key, record.revision, { ...initial, status: 'outcome_unknown' });
      throw new Error('Execution outcome requires reconciliation');
    }
    const record = await this.store.read(key);
    if (!record || !await this.store.compareAndSet(key, record.revision, { ...initial, status: 'confirmed', result })) throw new Error('Execution receipt not persisted');
    return result;
  }
}
