import { z } from 'zod';
import { canonicalJson, digest, parseJsonRecord } from './canonical-json.js';

const MAX_EXECUTION_RECEIPT_BYTES = 60 * 1_024;

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
const receiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ binding: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal('executing') }),
  z.strictObject({ binding: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal('outcome_unknown') }),
  z.strictObject({ binding: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }),
]);
export type ExecutionReceipt = { status: 'confirmed'; result: Record<string, unknown> } | { status: 'outcome_unknown' };

/** Shared plugin-side receipts. Missing or unfinished records never prove a failed write. */
export class ExecutionJournal {
  constructor(private readonly store: ExecutionStore, private readonly namespace: string) {
    if (!namespace || namespace.length > 256) throw new TypeError('Invalid execution journal namespace');
  }
  private key(binding: Readonly<ExecutionBinding>) {
    if (!z.uuid().safeParse(binding.executionId).success) throw new TypeError('Invalid execution identity');
    return `execution:v1:${digest({ namespace: this.namespace, subject: binding.subject, installationId: binding.installationId, executionId: binding.executionId })}`;
  }
  async status(binding: ExecutionBinding): Promise<ExecutionReceipt> {
    const record = await this.readBoundReceipt(this.snapshot(binding));
    return record?.receipt.status === 'confirmed' ? { status: 'confirmed', result: record.receipt.result } : { status: 'outcome_unknown' };
  }

  async reconcile(
    binding: ExecutionBinding,
    resolve: () => Promise<Record<string, unknown> | undefined>,
  ): Promise<ExecutionReceipt> {
    const bound = this.snapshot(binding);
    const key = this.key(bound);
    const existing = await this.readBoundReceipt(bound);
    if (!existing || existing.receipt.status === 'confirmed') return this.toPublicReceipt(existing?.receipt);

    const candidate = await resolve();
    if (candidate === undefined) return { status: 'outcome_unknown' };
    const result = parseJsonRecord(candidate, 'reconciliation result');
    if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_EXECUTION_RECEIPT_BYTES) {
      throw new Error('Oversized execution receipt');
    }

    const confirmed = { binding: digest(bound), status: 'confirmed' as const, result };
    if (await this.store.compareAndSet(key, existing.revision, confirmed)) return { status: 'confirmed', result };
    const raced = await this.readBoundReceipt(bound);
    return this.toPublicReceipt(raced?.receipt);
  }

  async execute(binding: ExecutionBinding, invoke: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const bound = this.snapshot(binding);
    const key = this.key(bound);
    const initial = { binding: digest(bound), status: 'executing' as const };
    // No automatic TTL: expiring an idempotency tombstone could permit a second write.
    if (!await this.store.compareAndSet(key, null, initial)) {
      const prior = await this.status(bound);
      if (prior.status === 'confirmed') return prior.result;
      throw new Error('Execution outcome requires reconciliation');
    }
    const started = await this.readBoundReceipt(bound);
    if (!started) throw new Error('Execution receipt not persisted');
    if (started.receipt.status === 'confirmed') return started.receipt.result;

    let result: Record<string, unknown>;
    try {
      result = parseJsonRecord(await invoke());
      if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_EXECUTION_RECEIPT_BYTES) throw new Error('Oversized execution receipt');
    } catch {
      try {
        const current = await this.readBoundReceipt(bound);
        if (current?.receipt.status === 'confirmed') return current.receipt.result;
        if (current?.revision === started.revision) {
          const changed = await this.store.compareAndSet(key, started.revision, { ...initial, status: 'outcome_unknown' });
          if (!changed) {
            const raced = await this.readBoundReceipt(bound);
            if (raced?.receipt.status === 'confirmed') return raced.receipt.result;
          }
        }
      } catch {
        // A failed read or CAS cannot establish an outcome.
      }
      throw new Error('Execution outcome requires reconciliation');
    }
    if (await this.store.compareAndSet(key, started.revision, { ...initial, status: 'confirmed', result })) return result;
    const raced = await this.readBoundReceipt(bound);
    if (raced?.receipt.status === 'confirmed') {
      if (canonicalJson(raced.receipt.result) === canonicalJson(result)) return raced.receipt.result;
      throw new Error('Conflicting execution result');
    }
    throw new Error('Execution receipt not persisted');
  }

  private async readBoundReceipt(binding: Readonly<ExecutionBinding>): Promise<{
    revision: string;
    receipt: z.infer<typeof receiptSchema>;
  } | undefined> {
    const record = await this.store.read(this.key(binding));
    if (!record) return undefined;
    const receipt = receiptSchema.parse(record.value);
    if (receipt.binding !== digest(binding)) throw new Error('Execution binding changed');
    return { revision: record.revision, receipt };
  }

  private snapshot(binding: ExecutionBinding): Readonly<ExecutionBinding> {
    return Object.freeze({ ...binding });
  }

  private toPublicReceipt(receipt: z.infer<typeof receiptSchema> | undefined): ExecutionReceipt {
    return receipt?.status === 'confirmed' ? { status: 'confirmed', result: receipt.result } : { status: 'outcome_unknown' };
  }
}
