import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { digest, canonicalJson } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { z } from 'zod';

const INVALIDATION_REASONS = [
  'plugin_updated',
  'binding_changed',
  'configuration_activated',
  'plugin_disabled',
  'plugin_removed',
  'authority_changed',
  'credential_changed',
  'endpoint_changed',
  'tool_policy_changed',
] as const;

export type ProposalInvalidationReason = typeof INVALIDATION_REASONS[number];

const reasonSchema = z.enum(INVALIDATION_REASONS);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const uuidSchema = z.uuid();
const opaquePluginIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const timestampSchema = z.iso.datetime({ offset: true });

const signedChangeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scopeDigest: sha256Schema,
  eventId: sha256Schema,
  proposalId: sha256Schema,
  pluginId: sha256Schema,
  subjectDigest: sha256Schema,
  beforeBindingDigest: sha256Schema,
  afterBindingDigest: sha256Schema,
  reason: reasonSchema,
  at: timestampSchema,
}).refine(value => value.beforeBindingDigest !== value.afterBindingDigest, {
  message: 'A binding change must have distinct before and after digests.',
  path: ['afterBindingDigest'],
});

const signedEventSchema = z.strictObject({
  event: signedChangeSchema,
  signature: signatureSchema,
});

const proposalHeaderSchema = z.looseObject({
  id: uuidSchema,
  subject: z.string().min(1).max(256),
  pluginId: opaquePluginIdSchema,
  bindingDigest: sha256Schema,
  status: z.string().min(1).max(32),
});

const MAX_SCOPE_LENGTH = 128;
const MAX_AGGREGATE_BYTES = 1024 * 1024;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64;
const MAX_CAS_ATTEMPTS = 12;
const CHANGE_DOMAIN = 'hasi:proposal-invalidation-change:v1';
const EVENT_DOMAIN = 'hasi:proposal-invalidation-event:v1';

export interface ProposalInvalidationChangeInput {
  readonly proposalId: string;
  readonly pluginId: string;
  readonly subject: string;
  readonly beforeBindingDigest: string;
  readonly afterBindingDigest: string;
  readonly reason: ProposalInvalidationReason;
  readonly at: string;
}

/** Only call this after trusted server code has established an active binding change. */
export function signProposalInvalidationChange(
  privateKey: KeyObject,
  scope: string,
  input: ProposalInvalidationChangeInput,
): SignedProposalInvalidationChange {
  const scopeDigest = scopeDigestFor(scope);
  assertPrivateKey(privateKey);
  const parsed = z.strictObject({
    proposalId: uuidSchema,
    pluginId: opaquePluginIdSchema,
    subject: z.string().min(1).max(256),
    beforeBindingDigest: sha256Schema,
    afterBindingDigest: sha256Schema,
    reason: reasonSchema,
    at: timestampSchema,
  }).parse(input);
  if (parsed.beforeBindingDigest === parsed.afterBindingDigest) {
    throw new TypeError('A binding change must have distinct before and after digests.');
  }

  const proposalId = digest(parsed.proposalId);
  const event = signedChangeSchema.parse({
    schemaVersion: 1,
    scopeDigest,
    eventId: eventIdFor(scopeDigest, proposalId),
    proposalId,
    pluginId: digest(parsed.pluginId),
    subjectDigest: digest(parsed.subject),
    beforeBindingDigest: parsed.beforeBindingDigest,
    afterBindingDigest: parsed.afterBindingDigest,
    reason: parsed.reason,
    at: parsed.at,
  });
  return signEnvelope(privateKey, CHANGE_DOMAIN, event);
}

export interface ProposalInvalidationEventPayload {
  readonly event: {
    readonly schemaVersion: 1;
    readonly scopeDigest: string;
    readonly eventId: string;
    /** Digest of the proposal UUID; raw proposal identifiers are not copied into audit data. */
    readonly proposalId: string;
    /** Digest of the plugin ID; audit data does not copy source identifiers. */
    readonly pluginId: string;
    readonly subjectDigest: string;
    readonly beforeBindingDigest: string;
    readonly afterBindingDigest: string;
    readonly reason: ProposalInvalidationReason;
    readonly at: string;
  };
}

export interface SignedProposalInvalidationEvent extends ProposalInvalidationEventPayload {
  readonly signature: string;
}

export interface SignedProposalInvalidationChange extends ProposalInvalidationEventPayload {
  readonly signature: string;
}

/** Minimal structural contract; other proposal fields are retained unchanged. */
export interface ProposalInvalidationAggregate extends Record<string, unknown> {
  readonly id: string;
  readonly subject: string;
  readonly pluginId: string;
  readonly bindingDigest: string;
  readonly status: string;
}

/** Server-owned policy returning an absolute JsonStore expiry timestamp in milliseconds. */
export type ProposalRetentionUntil = (proposal: ProposalInvalidationAggregate, now: number) => number;

export type ProposalBindingObservation =
  | { readonly status: 'unavailable' }
  | { readonly status: 'changed'; readonly descriptor: SignedProposalInvalidationChange };

export type AuditProjectionStatus = 'not-needed' | 'persisted' | 'pending';

export interface ProposalInvalidationRead<T extends ProposalInvalidationAggregate = ProposalInvalidationAggregate> {
  readonly proposal: T;
  readonly event?: SignedProposalInvalidationEvent;
  readonly auditProjection: AuditProjectionStatus;
}

export type ProposalInvalidationResult<T extends ProposalInvalidationAggregate = ProposalInvalidationAggregate> =
  | { readonly status: 'unavailable' }
  | { readonly status: 'missing' }
  | { readonly status: 'stale-observation'; readonly proposal: T }
  | { readonly status: 'unchanged'; readonly proposal: T }
  | {
      readonly status: 'invalidated';
      readonly proposal: T;
      readonly event: SignedProposalInvalidationEvent;
      readonly auditProjection: Exclude<AuditProjectionStatus, 'not-needed'>;
    };

export class ProposalInvalidationError extends Error {
  constructor(readonly code: 'invalid_scope' | 'invalid_key' | 'invalid_descriptor' | 'invalid_proposal' | 'invalid_signature' | 'audit_conflict' | 'state_conflict' | 'invalid_retention') {
    super('Proposal invalidation failed: ' + code);
    this.name = 'ProposalInvalidationError';
  }
}

export class ProposalInvalidationLedger {
  private readonly publicKey: KeyObject;
  private readonly scopeDigest: string;

  constructor(
    private readonly store: JsonStore,
    private readonly privateKey: KeyObject,
    scope: string,
    private readonly proposalRetentionUntil: ProposalRetentionUntil,
  ) {
    this.scopeDigest = scopeDigestFor(scope);
    if (typeof proposalRetentionUntil !== 'function') throw new ProposalInvalidationError('invalid_retention');
    assertPrivateKey(privateKey);
    this.publicKey = createPublicKey(privateKey);
  }

  /**
   * Reads an exact proposal key, verifies any embedded event, and retries its
   * idempotent append-only projection. The proposal outbox remains authoritative
   * when projection storage is temporarily unavailable.
   */
  async readProposal<T extends ProposalInvalidationAggregate = ProposalInvalidationAggregate>(
    proposalId: string,
  ): Promise<ProposalInvalidationRead<T> | undefined> {
    validateProposalId(proposalId);
    const record = await this.store.read(this.proposalKey(proposalId));
    if (!record) return undefined;
    const proposal = parseProposalAggregate(record.value, proposalId) as T;
    const event = this.eventFromAggregate(proposal);
    if (!event) return { proposal, auditProjection: 'not-needed' };
    const auditProjection = await this.project(event);
    return { proposal, event, auditProjection };
  }

  /**
   * Materializes invalidation only from a verified, definitive changed-binding
   * descriptor. An unavailable observation is a no-op. CAS on the proposal row
   * makes its signed event/outbox durable with the pending -> invalidated change.
   */
  async invalidateProposal<T extends ProposalInvalidationAggregate = ProposalInvalidationAggregate>(
    proposalId: string,
    observation: ProposalBindingObservation,
  ): Promise<ProposalInvalidationResult<T>> {
    validateProposalId(proposalId);
    const observationResult = z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unavailable') }),
      z.strictObject({ status: z.literal('changed'), descriptor: signedEventSchema }),
    ]).safeParse(observation);
    if (!observationResult.success) throw new ProposalInvalidationError('invalid_descriptor');
    const checkedObservation = observationResult.data;

    if (checkedObservation.status === 'unavailable') return { status: 'unavailable' };

    const descriptor = this.verifyChange(checkedObservation.descriptor);
    if (descriptor.event.proposalId !== digest(proposalId)) throw new ProposalInvalidationError('invalid_descriptor');

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const key = this.proposalKey(proposalId);
      const record = await this.store.read(key);
      if (!record) return { status: 'missing' };

      const proposal = parseProposalAggregate(record.value, proposalId) as T;
      const existingEvent = this.eventFromAggregate(proposal);
      if (existingEvent) {
        const auditProjection = await this.project(existingEvent);
        return { status: 'invalidated', proposal, event: existingEvent, auditProjection };
      }

      if (proposal.status !== 'pending') return { status: 'unchanged', proposal };

      this.assertDescriptorIdentity(descriptor, proposal);
      if (descriptor.event.beforeBindingDigest !== proposal.bindingDigest) {
        return { status: 'stale-observation', proposal };
      }

      const event = signEvent(this.privateKey, descriptor.event);
      const next = {
        ...proposal,
        status: 'invalidated',
        invalidation: event,
      } as T;
      const storedNext = parseProposalAggregate(next, proposalId) as T;
      const expiresAt = this.proposalExpiry(proposal);
      if (await this.store.compareAndSet(key, record.revision, storedNext, expiresAt)) {
        const auditProjection = await this.project(event);
        return { status: 'invalidated', proposal: storedNext, event, auditProjection };
      }
    }

    throw new ProposalInvalidationError('state_conflict');
  }

  private proposalExpiry(proposal: ProposalInvalidationAggregate): number {
    const now = Date.now();
    let expiresAt: number;
    try {
      expiresAt = this.proposalRetentionUntil(proposal, now);
    } catch {
      throw new ProposalInvalidationError('invalid_retention');
    }
    if (!Number.isFinite(now)
      || !Number.isFinite(expiresAt)
      || !Number.isFinite(new Date(expiresAt).getTime())
      || expiresAt <= now) {
      throw new ProposalInvalidationError('invalid_retention');
    }
    return expiresAt;
  }

  private eventFromAggregate(proposal: ProposalInvalidationAggregate): SignedProposalInvalidationEvent | undefined {
    const hasEvent = Object.hasOwn(proposal, 'invalidation');
    if (proposal.status === 'invalidated' && !hasEvent) {
      throw new ProposalInvalidationError('invalid_proposal');
    }
    if (proposal.status !== 'invalidated' && hasEvent) {
      throw new ProposalInvalidationError('invalid_proposal');
    }
    if (!hasEvent) return undefined;

    const event = this.verifyEvent(proposal.invalidation);
    this.assertDescriptorIdentity(event, proposal);
    if (event.event.beforeBindingDigest !== proposal.bindingDigest) {
      throw new ProposalInvalidationError('invalid_proposal');
    }
    return event;
  }

  private assertDescriptorIdentity(
    event: SignedProposalInvalidationEvent,
    proposal: ProposalInvalidationAggregate,
  ): void {
    if (event.event.scopeDigest !== this.scopeDigest
      || event.event.proposalId !== digest(proposal.id)
      || event.event.pluginId !== digest(proposal.pluginId)
      || event.event.subjectDigest !== digest(proposal.subject)
      || event.event.eventId !== eventIdFor(this.scopeDigest, digest(proposal.id))) {
      throw new ProposalInvalidationError('invalid_descriptor');
    }
  }

  private verifyChange(raw: unknown): SignedProposalInvalidationChange {
    const parsed = signedEventSchema.safeParse(raw);
    if (!parsed.success) throw new ProposalInvalidationError('invalid_signature');
    const envelope = parsed.data;
    this.assertSignedPayload(envelope, CHANGE_DOMAIN);
    return envelope;
  }

  private verifyEvent(raw: unknown): SignedProposalInvalidationEvent {
    const parsed = signedEventSchema.safeParse(raw);
    if (!parsed.success) throw new ProposalInvalidationError('invalid_signature');
    const envelope = parsed.data;
    this.assertSignedPayload(envelope, EVENT_DOMAIN);
    return envelope;
  }

  private assertSignedPayload(envelope: SignedProposalInvalidationChange, domain: string): void {
    if (envelope.event.scopeDigest !== this.scopeDigest
      || envelope.event.eventId !== eventIdFor(this.scopeDigest, envelope.event.proposalId)) {
      throw new ProposalInvalidationError('invalid_signature');
    }
    const signature = Buffer.from(envelope.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== envelope.signature) {
      throw new ProposalInvalidationError('invalid_signature');
    }
    const bytes = signaturePayload(domain, envelope.event.scopeDigest, envelope.event);
    if (!verify(null, bytes, this.publicKey, signature)) {
      throw new ProposalInvalidationError('invalid_signature');
    }
  }

  private async project(event: SignedProposalInvalidationEvent): Promise<Exclude<AuditProjectionStatus, 'not-needed'>> {
    const key = this.auditKey(event.event.eventId);
    // This digest-only projection is currently retained without expiry; that policy boundary still needs acceptance.
    try {
      if (await this.store.compareAndSet(key, null, event)) return 'persisted';
      const existing = await this.store.read(key);
      if (!existing) return 'pending';
      const verified = this.verifyEvent(existing.value);
      if (digest(verified) !== digest(event)) throw new ProposalInvalidationError('audit_conflict');
      return 'persisted';
    } catch (error) {
      if (error instanceof ProposalInvalidationError) throw error;
      return 'pending';
    }
  }

  private proposalKey(proposalId: string): string {
    return 'proposal:' + proposalId;
  }

  private auditKey(eventId: string): string {
    return 'proposal-invalidation-audit:v1:' + this.scopeDigest + ':' + eventId;
  }
}

function signEnvelope(
  privateKey: KeyObject,
  domain: string,
  event: ProposalInvalidationEventPayload['event'],
): SignedProposalInvalidationChange {
  const signature = sign(null, signaturePayload(domain, event.scopeDigest, event), privateKey).toString('base64url');
  return { event, signature };
}

function signEvent(privateKey: KeyObject, event: ProposalInvalidationEventPayload['event']): SignedProposalInvalidationEvent {
  return signEnvelope(privateKey, EVENT_DOMAIN, event);
}

function signaturePayload(domain: string, scopeDigest: string, payload: unknown): Buffer {
  return Buffer.from([domain, scopeDigest, digest(payload)].join(':'), 'utf8');
}

function eventIdFor(scopeDigest: string, proposalIdDigest: string): string {
  return digest({ domain: 'hasi:proposal-invalidation-event-id:v1', scopeDigest, proposalIdDigest });
}

function scopeDigestFor(scope: string): string {
  if (typeof scope !== 'string' || !scope.trim() || scope.length > MAX_SCOPE_LENGTH || scope.includes('\0')) {
    throw new ProposalInvalidationError('invalid_scope');
  }
  return digest(scope);
}

function assertPrivateKey(key: KeyObject): void {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Proposal invalidation requires a server-owned Ed25519 private key.');
  }
}

function validateProposalId(proposalId: string): void {
  if (!uuidSchema.safeParse(proposalId).success) throw new ProposalInvalidationError('invalid_key');
}

function parseProposalAggregate(
  raw: unknown,
  proposalId: string,
): ProposalInvalidationAggregate {
  let encoded: string;
  try {
    const size = measureBoundedJson(raw);
    if (size > MAX_AGGREGATE_BYTES) throw new Error('aggregate too large');
    encoded = canonicalJson(raw);
  } catch {
    throw new ProposalInvalidationError('invalid_proposal');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_AGGREGATE_BYTES) {
    throw new ProposalInvalidationError('invalid_proposal');
  }

  let clone: unknown;
  try {
    clone = JSON.parse(encoded) as unknown;
  } catch {
    throw new ProposalInvalidationError('invalid_proposal');
  }
  const parsed = proposalHeaderSchema.safeParse(clone);
  if (!parsed.success || parsed.data.id !== proposalId) {
    throw new ProposalInvalidationError('invalid_proposal');
  }
  return parsed.data;
}

/** Counts and bounds JSON before canonical serialization allocates a full copy. */
function measureBoundedJson(root: unknown): number {
  let visited = 0;

  const visit = (value: unknown, depth: number, ancestors: Set<object>): number => {
    visited += 1;
    if (visited > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('JSON limit exceeded');
    if (value === null) return 4;
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (typeof value === 'string') {
      if (value.length > MAX_AGGREGATE_BYTES) throw new Error('JSON limit exceeded');
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    if (typeof value === 'number' && Number.isFinite(value)) return Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (typeof value !== 'object') throw new Error('Not JSON');

    if (ancestors.has(value)) throw new Error('Circular JSON');
    ancestors.add(value);
    let size = 0;
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_NODES) throw new Error('Invalid array');
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key === 'symbol')
        || keys.length !== value.length + 1) throw new Error('Invalid array');
      size = 2;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid array item');
        if (index > 0) size += 1;
        size += visit(descriptor.value, depth + 1, ancestors);
        if (size > MAX_AGGREGATE_BYTES) throw new Error('JSON limit exceeded');
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Non-plain JSON object');
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key === 'symbol') || keys.length > MAX_JSON_NODES) throw new Error('Invalid object');
      size = 2;
      let first = true;
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('Invalid object key');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid object field');
        if (!first) size += 1;
        first = false;
        if (key.length > MAX_AGGREGATE_BYTES) throw new Error('JSON limit exceeded');
        size += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
        size += visit(descriptor.value, depth + 1, ancestors);
        if (size > MAX_AGGREGATE_BYTES) throw new Error('JSON limit exceeded');
      }
    }
    ancestors.delete(value);
    return size;
  };

  return visit(root, 0, new Set<object>());
}
