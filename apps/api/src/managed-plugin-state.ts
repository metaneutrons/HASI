import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  MANAGED_STATE_METHODS, MANAGED_STATE_MCP_VERSION, digest, managedStateValidator,
  managedStateReadParams, managedStateCasParams, managedStateConsumeParams,
  managedStateReadResult, managedStateCasResult, managedStateConsumeResult,
  type ActorContext, type PluginManifestV2, type ExecutionBinding, type VerifiedInvocation,
} from '@hasi/plugin-sdk';
import type { FencedJsonStore, StateFence } from '@hasi/state';

const MAX_OPERATIONS = 64;
const MAX_ENTRY_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_ENTRIES = 256;
const MAX_ACTIVE_NONCES = 128;
const receiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ binding: z.string(), status: z.literal('executing') }),
  z.strictObject({ binding: z.string(), status: z.literal('outcome_unknown') }),
  z.strictObject({ binding: z.string(), status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }),
]);
const entrySchema = z.strictObject({
  area: z.enum(['application', 'journal']), key: z.string().min(1).max(192),
  revision: z.uuid(), value: z.unknown(),
});
const blobSchema = z.strictObject({
  version: z.literal(1), contract: z.string().regex(/^[a-f0-9]{64}$/u),
  entries: z.record(z.string().regex(/^[a-f0-9]{64}$/u), entrySchema),
  nonces: z.record(z.uuid(), z.number().int().positive()),
});
type Blob = z.infer<typeof blobSchema>;
type ReadParams = z.infer<typeof managedStateReadParams>;
type CasParams = z.infer<typeof managedStateCasParams>;

export interface ManagedPluginStateOptions {
  store: FencedJsonStore;
  scope: string;
  installationId: string;
  manifest: PluginManifestV2;
  actor: ActorContext;
  invocation: VerifiedInvocation;
  /** Captured exclusively from the host's verified durable authority snapshots. */
  fences: readonly StateFence[];
  authorityExpiresAt?: number;
  hasPersonalAccount: boolean;
  mode: 'read' | 'prepare' | 'execute' | 'status';
  executionBinding?: ExecutionBinding;
  validateExecutionResult?: (result: Record<string, unknown>) => boolean;
  /** Re-resolve account and runtime eligibility; durable fences guard the final commit. */
  assertCurrent: () => Promise<void>;
}

/** Host-only invocation capability. Nothing here is selected by a plugin/model payload. */
export class ManagedPluginStateSession {
  private open = false;
  private closed = false;
  private operations = 0;
  private consumed = false;
  private readonly target: string;
  private readonly contract: string;
  private readonly leaseKey: string;
  private fences: StateFence[] = [];
  private readonly validateApplication: (value: unknown) => boolean;
  private readonly expiresAt: number;

  private constructor(private readonly options: ManagedPluginStateOptions) {
    const declaration = options.manifest.managedState;
    if (!declaration || options.manifest.mcpVersion !== MANAGED_STATE_MCP_VERSION
      || options.invocation.context?.installationId !== options.installationId || digest(options.actor) !== digest(options.invocation.actor) || !options.fences.length) throw new Error('Managed state authority unavailable');
    const identity = declaration.accountIdentity;
    let account: string;
    if (identity.kind === 'subject') {
      if (options.hasPersonalAccount) throw new Error('Personal state requires a stable external account identity');
      account = options.actor.subject;
    } else {
      const value = identity.kind === 'customerId' ? options.actor.customerId : options.actor.claims?.[identity.name];
      if (!options.hasPersonalAccount || typeof value !== 'string' || !value || value.length > 1024) throw new Error('Stable state account identity unavailable');
      account = value;
    }
    this.contract = digest(declaration);
    this.target = `managed-plugin-state:v1:${digest({ scope: options.scope, installation: options.installationId, package: options.manifest.id, subject: options.actor.subject, account })}`;
    this.leaseKey = `managed-plugin-state-lease:v1:${digest({ scope: options.scope, installation: options.installationId, jti: options.invocation.jti })}`;
    this.expiresAt = Math.min(Date.now() + 30_000, options.invocation.expiresAt * 1000, options.authorityExpiresAt ?? Infinity);
    if (!Number.isFinite(this.expiresAt) || this.expiresAt <= Date.now()) throw new Error('Managed state authority expired');
    this.validateApplication = managedStateValidator(declaration.applicationSchema);
  }

  static async create(options: ManagedPluginStateOptions): Promise<ManagedPluginStateSession> {
    const session = new ManagedPluginStateSession({ ...options, manifest: structuredClone(options.manifest), actor: structuredClone(options.actor), invocation: structuredClone(options.invocation), ...(options.executionBinding ? { executionBinding: { ...options.executionBinding } } : {}), fences: options.fences.map(fence => ({ ...fence })) });
    await options.assertCurrent();
    if (!await options.store.compareAndSet(session.leaseKey, null, { version: 1, invocation: options.invocation.jti }, session.expiresAt)) throw new Error('Managed state invocation already exists');
    try {
      const lease = await options.store.read(session.leaseKey);
      if (!lease || Date.now() >= session.expiresAt) throw new Error('Managed state lease unavailable');
      session.fences = [...session.options.fences, { key: session.leaseKey, revision: lease.revision }];
      return session;
    } catch (error) { await options.store.delete(session.leaseKey); throw error; }
  }

  register(client: Client): void {
    client.setRequestHandler(MANAGED_STATE_METHODS.read, { params: managedStateReadParams, result: managedStateReadResult }, params => this.wire(() => this.read(params)));
    client.setRequestHandler(MANAGED_STATE_METHODS.compareAndSet, { params: managedStateCasParams, result: managedStateCasResult }, params => this.wire(() => this.compareAndSet(params)));
    client.setRequestHandler(MANAGED_STATE_METHODS.consumeInvocation, { params: managedStateConsumeParams, result: managedStateConsumeResult }, params => this.wire(() => this.consume(params.invocationId)));
  }

  private async wire<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new Error('Managed state request denied'); }
  }

  activate(): void {
    if (this.closed || Date.now() >= this.expiresAt) throw new Error('Managed state invocation unavailable');
    this.open = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    await this.options.store.delete(this.leaseKey);
  }

  private assertOpen(): void {
    if (!this.open || this.closed || Date.now() >= this.expiresAt) throw new Error('Managed state invocation unavailable');
  }

  private async authorize(invocationId: string): Promise<void> {
    this.assertOpen();
    if (invocationId !== this.options.invocation.jti || ++this.operations > MAX_OPERATIONS) throw new Error('Managed state request denied');
    await this.options.assertCurrent();
    this.assertOpen();
  }

  private address(params: ReadParams): string {
    if (params.area === 'journal') {
      const binding = this.options.executionBinding;
      if (!binding || !['execute', 'status'].includes(this.options.mode)
        || params.key !== `execution:v1:${digest({ namespace: this.options.manifest.id, subject: binding.subject, installationId: binding.installationId, executionId: binding.executionId })}`) throw new Error('Managed journal address denied');
    }
    return digest([params.area, params.key]);
  }

  private async current(): Promise<{ blob: Blob; revision: string | null }> {
    const result = await this.options.store.readWithFence(this.target, this.fences);
    if (!result.matched) throw new Error('Managed state authority changed');
    if (!result.entry) return { blob: { version: 1, contract: this.contract, entries: {}, nonces: {} }, revision: null };
    const blob = blobSchema.parse(result.entry.value);
    if (blob.contract !== this.contract || Object.keys(blob.entries).length > MAX_ENTRIES
      || Object.keys(blob.nonces).length > MAX_ACTIVE_NONCES || Buffer.byteLength(JSON.stringify(blob)) > MAX_TOTAL_BYTES) throw new Error('Managed state contract or capacity changed');
    for (const [key, entry] of Object.entries(blob.entries)) {
      if (key !== digest([entry.area, entry.key])) throw new Error('Managed state address changed');
    }
    return { blob, revision: result.entry.revision };
  }

  private async read(input: ReadParams) {
    const params = structuredClone(input);
    await this.authorize(params.invocationId);
    if (!this.consumed) throw new Error('Invocation has not been consumed');
    const address = this.address(params);
    const { blob } = await this.current();
    const entry = blob.entries[address];
    if (entry) this.validateValue(params.area, entry.value);
    return { entry: entry ? { revision: entry.revision, value: entry.value } : null };
  }

  private validateValue(area: ReadParams['area'], value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_ENTRY_BYTES) throw new Error('Managed state entry too large');
    if (area === 'application') {
      if (!this.validateApplication(value)) throw new Error('Managed application state does not match its approved schema');
    } else {
      const receipt = receiptSchema.parse(value);
      if (!this.options.executionBinding || receipt.binding !== digest(this.options.executionBinding)
        || receipt.status === 'confirmed' && !this.options.validateExecutionResult?.(receipt.result)) throw new Error('Managed journal binding or result invalid');
    }
  }

  private async compareAndSet(input: CasParams) {
    const params = structuredClone(input);
    await this.authorize(params.invocationId);
    if (!this.consumed) throw new Error('Invocation has not been consumed');
    const address = this.address(params);
    if (params.area === 'application' && this.options.mode !== 'execute') throw new Error('Application state mutation requires confirmed execution');
    this.validateValue(params.area, params.value);
    for (let attempt = 0; attempt < 8; attempt++) {
      this.assertOpen();
      const { blob, revision } = await this.current();
      const current = blob.entries[address];
      if ((current?.revision ?? null) !== params.revision) return { updated: false };
      if (params.area === 'journal') {
        const nextReceipt = receiptSchema.parse(params.value);
        if (current) {
          this.validateValue('journal', current.value);
          if (receiptSchema.parse(current.value).status === 'confirmed' || nextReceipt.status === 'executing') throw new Error('Managed receipt cannot be restarted or replaced');
        } else if (this.options.mode !== 'execute' || nextReceipt.status !== 'executing') throw new Error('Managed receipt must start with an authorized execution');
      }
      const next: Blob = { ...blob, entries: { ...blob.entries, [address]: { area: params.area, key: params.key, revision: randomUUID(), value: params.value } } };
      if (Object.keys(next.entries).length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(next)) > MAX_TOTAL_BYTES) throw new Error('Managed state capacity exceeded');
      if (await this.options.store.compareAndSetWithFence(this.target, revision, next, this.fences)) return { updated: true };
    }
    throw new Error('Managed state changed concurrently');
  }

  private async consume(invocationId: string) {
    await this.authorize(invocationId);
    for (let attempt = 0; attempt < 8; attempt++) {
      this.assertOpen();
      const { blob, revision } = await this.current();
      if (Object.hasOwn(blob.nonces, invocationId)) return { consumed: false };
      const nonces = Object.fromEntries(Object.entries(blob.nonces).filter(([, expiry]) => expiry > Math.floor(Date.now() / 1000)));
      nonces[invocationId] = this.options.invocation.expiresAt;
      if (Object.keys(nonces).length > MAX_ACTIVE_NONCES) throw new Error('Managed invocation capacity exceeded');
      const next = { ...blob, nonces };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_TOTAL_BYTES) throw new Error('Managed state capacity exceeded');
      if (await this.options.store.compareAndSetWithFence(this.target, revision, next, this.fences)) { this.consumed = true; return { consumed: true }; }
    }
    throw new Error('Managed state changed concurrently');
  }
}
