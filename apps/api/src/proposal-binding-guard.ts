import type { KeyObject } from 'node:crypto';
import type { JsonStore } from '@hasi/state';
import { z } from 'zod';
import type { ActionBindingObservation } from './registry.js';
import {
  ProposalInvalidationLedger,
  signProposalInvalidationChange,
  type ProposalInvalidationAggregate,
  type ProposalInvalidationResult,
  type ProposalRetentionUntil,
} from './proposal-invalidation.js';

const bindingDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const proposalIdSchema = z.uuid();
const subjectSchema = z.string().min(1).max(256);
const observationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('current'), binding: bindingDigestSchema }),
  z.strictObject({ status: z.literal('withdrawn'), binding: bindingDigestSchema, reason: z.enum(['plugin_disabled', 'plugin_removed']) }),
]);

export interface ProposalBindingGuardOptions {
  /** Server-owned durable store shared with proposal creation and confirmation. */
  readonly store: JsonStore;
  /** Server-owned Ed25519 key used by the proposal invalidation ledger. */
  readonly privateKey: KeyObject;
  /** Explicit server-owned namespace; never selected by request or plugin input. */
  readonly scope: string;
  /** Explicit retention policy for pending-to-invalidated proposal CAS. */
  readonly proposalRetentionUntil: ProposalRetentionUntil;
  /** Trusted server registry observation; unavailable is always a no-op. */
  readonly observeActionBinding: (pluginId: string) => Promise<ActionBindingObservation>;
}

/**
 * Revalidates a proposal owner and its trusted plugin binding before asking the
 * ledger to perform a pending-only signed invalidation CAS.
 */
export class ProposalBindingGuard {
  private readonly ledger: ProposalInvalidationLedger;
  private readonly store: JsonStore;
  private readonly observeActionBinding: ProposalBindingGuardOptions['observeActionBinding'];
  private readonly privateKey: KeyObject;
  private readonly scope: string;

  constructor(options: ProposalBindingGuardOptions) {
    this.store = options.store;
    this.observeActionBinding = options.observeActionBinding;
    this.privateKey = options.privateKey;
    this.scope = options.scope;
    this.ledger = new ProposalInvalidationLedger(
      options.store,
      options.privateKey,
      options.scope,
      options.proposalRetentionUntil,
    );
  }

  async observeOwnedProposal<T extends ProposalInvalidationAggregate = ProposalInvalidationAggregate>(
    proposalId: string,
    subject: string,
  ): Promise<ProposalInvalidationResult<T>> {
    if (!proposalIdSchema.safeParse(proposalId).success || !subjectSchema.safeParse(subject).success) return { status: 'missing' };
    let header: Awaited<ReturnType<JsonStore['read']>>;
    try {
      header = await this.store.read(`proposal:${proposalId}`);
    } catch {
      return { status: 'unavailable' };
    }
    if (!header || !ownedHeaderMatches(header.value, proposalId, subject)) return { status: 'missing' };

    // Proposal ownership is immutable in the application lifecycle. Recheck
    // after the ledger read, whose invalidation projection is idempotent but may write.
    const read = await this.ledger.readProposal<T>(proposalId);
    if (read?.proposal.subject !== subject) return { status: 'missing' };

    if (read.event) {
      if (read.auditProjection === 'not-needed') return { status: 'unchanged', proposal: read.proposal };
      return {
        status: 'invalidated',
        proposal: read.proposal,
        event: read.event,
        auditProjection: read.auditProjection,
      };
    }
    if (read.proposal.status !== 'pending') return { status: 'unchanged', proposal: read.proposal };

    let observed: ReturnType<typeof observationSchema.safeParse>;
    try {
      observed = observationSchema.safeParse(await this.observeActionBinding(read.proposal.pluginId));
    } catch {
      return { status: 'unavailable' };
    }
    if (!observed.success || observed.data.status === 'unavailable') return { status: 'unavailable' };

    const afterBindingDigest = observed.data.binding;
    if (afterBindingDigest === read.proposal.bindingDigest) {
      return observed.data.status === 'current'
        ? { status: 'unchanged', proposal: read.proposal }
        : { status: 'unavailable' };
    }

    const descriptor = signProposalInvalidationChange(this.privateKey, this.scope, {
      proposalId: read.proposal.id,
      pluginId: read.proposal.pluginId,
      subject: read.proposal.subject,
      beforeBindingDigest: read.proposal.bindingDigest,
      afterBindingDigest,
      reason: observed.data.status === 'current' ? 'binding_changed' : observed.data.reason,
      at: new Date().toISOString(),
    });
    return this.ledger.invalidateProposal<T>(proposalId, { status: 'changed', descriptor });
  }
}

function ownedHeaderMatches(raw: unknown, proposalId: string, subject: string): boolean {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const id = Object.getOwnPropertyDescriptor(raw, 'id');
    const owner = Object.getOwnPropertyDescriptor(raw, 'subject');
    return Boolean(id && 'value' in id && id.value === proposalId
      && owner && 'value' in owner && subjectSchema.safeParse(owner.value).success && owner.value === subject);
  } catch {
    return false;
  }
}
