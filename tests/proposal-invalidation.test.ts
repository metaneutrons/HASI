import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import {
  ProposalInvalidationLedger,
  signProposalInvalidationChange,
  type ProposalInvalidationAggregate,
  type ProposalRetentionUntil,
} from '../apps/api/src/proposal-invalidation.js';

const scope = 'proposal-invalidation-test';
const beforeBindingDigest = digest('active-before');
const afterBindingDigest = digest('active-after');
const at = '2026-10-19T12:00:00.000Z';
const DAY_MS = 86_400_000;

interface TestProposal extends ProposalInvalidationAggregate {
  readonly args: Record<string, unknown>;
  readonly preview: { readonly title: string };
  readonly pluginVersion: string;
}

async function fixture(
  status = 'pending',
  options: { readonly clock?: () => number; readonly retentionUntil?: ProposalRetentionUntil } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const store = new MemoryJsonStore(
    'proposal-invalidation-' + randomUUID(),
    options.clock ? { clock: options.clock } : {},
  );
  const proposalId = randomUUID();
  const proposal: TestProposal = {
    id: proposalId,
    subject: 'synthetic-user-private-subject',
    pluginId: 'plugin.records',
    bindingDigest: beforeBindingDigest,
    status,
    ...(status === 'executing' || status === 'outcome_unknown' ? { executionId: 'durable-execution-identity' } : {}),
    pluginVersion: '1.0.0',
    args: { target: 'private-target-value' },
    preview: { title: 'Private preview' },
  };
  const key = 'proposal:' + proposalId;
  if (!await store.compareAndSet(key, null, proposal)) throw new Error('Could not seed proposal');
  const retentionUntil = options.retentionUntil ?? ((_proposal, now) => now + DAY_MS);
  const ledger = new ProposalInvalidationLedger(store, privateKey, scope, retentionUntil);
  const descriptor = signProposalInvalidationChange(privateKey, scope, {
    proposalId,
    pluginId: proposal.pluginId,
    subject: proposal.subject,
    beforeBindingDigest,
    afterBindingDigest,
    reason: 'plugin_updated',
    at,
  });
  return { store, ledger, proposal, proposalId, key, descriptor, privateKey, publicKey };
}

describe('proposal invalidation ledger', () => {
  it('accepts the registry scope limit and rejects a larger server namespace', async () => {
    const test = await fixture();
    const input = {
      proposalId: test.proposalId, pluginId: test.proposal.pluginId, subject: test.proposal.subject,
      beforeBindingDigest, afterBindingDigest, reason: 'binding_changed' as const, at,
    };
    const longestRegistryScope = 'x'.repeat(256);
    expect(signProposalInvalidationChange(test.privateKey, longestRegistryScope, input).event.scopeDigest).toBe(digest(longestRegistryScope));
    expect(() => signProposalInvalidationChange(test.privateKey, 'x'.repeat(257), input)).toThrow('invalid_scope');
  });

  it('atomically materializes pending invalidation with a signed event and preserves the aggregate', async () => {
    const test = await fixture();
    const result = await test.ledger.invalidateProposal<TestProposal>(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    });

    expect(result.status).toBe('invalidated');
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(result.proposal).toMatchObject({
      ...test.proposal,
      status: 'invalidated',
      invalidation: result.event,
    });
    expect(result.event.event).toMatchObject({
      eventId: digest({ domain: 'hasi:proposal-invalidation-event-id:v1', scopeDigest: digest(scope), proposalIdDigest: digest(test.proposalId) }),
      scopeDigest: digest(scope),
      proposalId: digest(test.proposalId),
      pluginId: digest(test.proposal.pluginId),
      subjectDigest: digest(test.proposal.subject),
      beforeBindingDigest,
      afterBindingDigest,
      reason: 'plugin_updated',
      at,
    });
    expect(JSON.stringify(result.event)).not.toContain(test.proposal.subject);
    expect(JSON.stringify(result.event)).not.toContain(test.proposal.pluginId);
    expect(JSON.stringify(result.event)).not.toContain('private-target-value');
    expect(result.auditProjection).toBe('persisted');

    const auditKey = 'proposal-invalidation-audit:v1:' + digest(scope) + ':' + result.event.event.eventId;
    const projected = await test.store.read(auditKey);
    expect(projected?.value).toEqual(result.event);
  });

  it('expires invalidated proposal data under the explicit retention policy while retaining only the audit projection', async () => {
    let currentTime = Date.now();
    let retentionDeadline = 0;
    const test = await fixture('pending', {
      clock: () => currentTime,
      retentionUntil: (_proposal, now) => {
        retentionDeadline = now + 1_000;
        return retentionDeadline;
      },
    });
    const result = await test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    });
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(retentionDeadline).toBeGreaterThan(Date.now());

    currentTime = retentionDeadline + 1;
    expect(await test.store.read(test.key)).toBeUndefined();
    const auditKey = 'proposal-invalidation-audit:v1:' + digest(scope) + ':' + result.event.event.eventId;
    expect((await test.store.read(auditKey))?.value).toEqual(result.event);
    expect(JSON.stringify(result.event)).not.toContain(test.proposal.subject);
  });

  it.each([
    ['non-finite', (_proposal: ProposalInvalidationAggregate, _now: number) => Number.NaN],
    ['elapsed', (_proposal: ProposalInvalidationAggregate, now: number) => now],
    ['out-of-range', (_proposal: ProposalInvalidationAggregate, _now: number) => Number.MAX_VALUE],
  ])('rejects %s proposal retention deadlines without mutation', async (_label, invalidPolicy) => {
    const test = await fixture();
    const original = await test.store.read(test.key);
    let writes = 0;
    const observedStore: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        writes += 1;
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const ledger = new ProposalInvalidationLedger(observedStore, test.privateKey, scope, invalidPolicy);

    await expect(ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    })).rejects.toMatchObject({ code: 'invalid_retention' });
    expect(writes).toBe(0);
    expect((await test.store.read(test.key))?.revision).toBe(original?.revision);
  });

  it.each(['executing', 'outcome_unknown', 'confirmed', 'failed', 'expired'])(
    'leaves %s proposals and their execution identity untouched',
    async status => {
      const test = await fixture(status);
      const original = await test.store.read(test.key);
      const result = await test.ledger.invalidateProposal(test.proposalId, {
        status: 'changed',
        descriptor: test.descriptor,
      });
      const latest = await test.store.read(test.key);

      expect(result.status).toBe('unchanged');
      expect(latest?.revision).toBe(original?.revision);
      expect(latest?.value).toEqual(original?.value);
      expect(await test.store.read('proposal-invalidation-audit:v1:' + digest(scope) + ':' + test.descriptor.event.eventId)).toBeUndefined();
    },
  );

  it('treats an unavailable active binding as a no-op', async () => {
    const test = await fixture();
    const original = await test.store.read(test.key);
    let writes = 0;
    const observedStore: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        writes += 1;
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const ledger = new ProposalInvalidationLedger(observedStore, test.privateKey, scope, (_proposal, now) => now + DAY_MS);
    const result = await ledger.invalidateProposal(test.proposalId, { status: 'unavailable' });

    expect(result).toEqual({ status: 'unavailable' });
    expect(writes).toBe(0);
    expect((await test.store.read(test.key))?.revision).toBe(original?.revision);
  });

  it('does not apply a signed descriptor after the proposal binding has moved again', async () => {
    const test = await fixture();
    const current = await test.store.read(test.key);
    if (!current) throw new Error('Proposal missing');
    const changed = { ...(current.value as Record<string, unknown>), bindingDigest: digest('another-active-binding') };
    expect(await test.store.compareAndSet(test.key, current.revision, changed)).toBe(true);
    const latest = await test.store.read(test.key);

    const result = await test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    });

    expect(result.status).toBe('stale-observation');
    expect((await test.store.read(test.key))?.revision).toBe(latest?.revision);
  });

  it('uses CAS to make concurrent invalidation and projection idempotent', async () => {
    const test = await fixture();
    const observation = { status: 'changed' as const, descriptor: test.descriptor };
    const [first, second] = await Promise.all([
      test.ledger.invalidateProposal(test.proposalId, observation),
      test.ledger.invalidateProposal(test.proposalId, observation),
    ]);

    expect(first.status).toBe('invalidated');
    expect(second.status).toBe('invalidated');
    if (first.status !== 'invalidated' || second.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(first.event).toEqual(second.event);
    expect(first.proposal.invalidation).toEqual(second.proposal.invalidation);
    const auditKey = 'proposal-invalidation-audit:v1:' + digest(scope) + ':' + first.event.event.eventId;
    expect((await test.store.read(auditKey))?.value).toEqual(first.event);
  });

  it('preserves a concurrent execution claim when invalidation loses its CAS', async () => {
    const test = await fixture();
    const executionId = randomUUID();
    let claimed = false;
    let auditWrites = 0;
    const racingStore: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (key.startsWith('proposal-invalidation-audit:')) auditWrites++;
        if (key === test.key && !claimed) {
          claimed = true;
          expect(await test.store.compareAndSet(key, revision, { ...test.proposal, status: 'executing', executionId }, expiresAt)).toBe(true);
          return false;
        }
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const ledger = new ProposalInvalidationLedger(racingStore, test.privateKey, scope, (_proposal, now) => now + DAY_MS);
    const result = await ledger.invalidateProposal(test.proposalId, { status: 'changed', descriptor: test.descriptor });
    expect(result.status).toBe('unchanged');
    expect((await test.store.read(test.key))?.value).toMatchObject({ status: 'executing', executionId });
    expect(auditWrites).toBe(0);
    const repeated = await ledger.invalidateProposal(test.proposalId, { status: 'changed', descriptor: test.descriptor });
    expect(repeated.status).toBe('unchanged');
    expect((await test.store.read(test.key))?.value).not.toHaveProperty('invalidation');
  });

  it('retains the same-key outbox when projection fails and retries it on a verified read', async () => {
    const test = await fixture();
    let failProjection = true;
    const wrapped: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (key.startsWith('proposal-invalidation-audit:v1:') && failProjection) {
          throw new Error('Synthetic audit store outage');
        }
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const ledger = new ProposalInvalidationLedger(wrapped, test.privateKey, scope, (_proposal, now) => now + DAY_MS);
    const result = await ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    });
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(result.auditProjection).toBe('pending');

    const stored = await test.store.read(test.key);
    expect((stored?.value as Record<string, unknown>).status).toBe('invalidated');
    const auditKey = 'proposal-invalidation-audit:v1:' + digest(scope) + ':' + result.event.event.eventId;
    expect(await test.store.read(auditKey)).toBeUndefined();

    failProjection = false;
    const read = await ledger.readProposal<TestProposal>(test.proposalId);
    expect(read?.proposal.status).toBe('invalidated');
    expect(read?.event).toEqual(result.event);
    expect(read?.auditProjection).toBe('persisted');
    expect((await test.store.read(auditKey))?.value).toEqual(result.event);
  });

  it('rejects a tampered embedded event instead of trusting or projecting it', async () => {
    const test = await fixture();
    const result = await test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    });
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');

    const record = await test.store.read(test.key);
    if (!record) throw new Error('Proposal missing');
    const stored = record.value as Record<string, unknown>;
    const envelope = stored.invalidation as { signature: string };
    const signature = envelope.signature.startsWith('A') ? 'B' : 'A';
    const tampered = {
      ...stored,
      invalidation: { ...(stored.invalidation as Record<string, unknown>), signature: signature + envelope.signature.slice(1) },
    };
    expect(await test.store.compareAndSet(test.key, record.revision, tampered)).toBe(true);

    await expect(test.ledger.readProposal(test.proposalId)).rejects.toMatchObject({
      code: 'invalid_signature',
    });
  });

  it('rejects descriptors signed by another key and rejects undeclared descriptor fields', async () => {
    const test = await fixture();
    const other = generateKeyPairSync('ed25519');
    const forged = signProposalInvalidationChange(other.privateKey, scope, {
      proposalId: test.proposalId,
      pluginId: test.proposal.pluginId,
      subject: test.proposal.subject,
      beforeBindingDigest,
      afterBindingDigest,
      reason: 'plugin_updated',
      at,
    });
    await expect(test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: forged,
    })).rejects.toMatchObject({ code: 'invalid_signature' });

    const extendedDescriptor = { ...test.descriptor, undeclared: 'ignored input must fail' };
    await expect(test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: extendedDescriptor,
    })).rejects.toMatchObject({ code: 'invalid_descriptor' });

    expect(() => signProposalInvalidationChange(test.privateKey, scope, {
      proposalId: test.proposalId,
      pluginId: test.proposal.pluginId,
      subject: test.proposal.subject,
      beforeBindingDigest,
      afterBindingDigest,
      reason: 'plugin_updated',
      at,
      arguments: { secret: 'never-audit-this' },
    } as never)).toThrow();
    expect((await test.store.read(test.key))?.value).toEqual(test.proposal);
  });

  it('rejects malformed proposal aggregates without rewriting them', async () => {
    const test = await fixture();
    const original = await test.store.read(test.key);
    if (!original) throw new Error('Proposal missing');
    const malformed = { ...(original.value as Record<string, unknown>), status: 'pending', bindingDigest: 'not-a-digest' };
    expect(await test.store.compareAndSet(test.key, original.revision, malformed)).toBe(true);
    const malformedRecord = await test.store.read(test.key);
    await expect(test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    })).rejects.toMatchObject({ code: 'invalid_proposal' });
    expect((await test.store.read(test.key))?.revision).toBe(malformedRecord?.revision);
  });
});


describe('proposal invalidation bounded aggregate validation', () => {
  it('rejects an oversized proposal aggregate without rewriting it', async () => {
    const test = await fixture();
    const original = await test.store.read(test.key);
    if (!original) throw new Error('Proposal missing');
    const oversized = { ...(original.value as Record<string, unknown>), large: 'x'.repeat(1024 * 1024) };
    expect(await test.store.compareAndSet(test.key, original.revision, oversized)).toBe(true);
    const oversizedRecord = await test.store.read(test.key);

    await expect(test.ledger.invalidateProposal(test.proposalId, {
      status: 'changed',
      descriptor: test.descriptor,
    })).rejects.toMatchObject({ code: 'invalid_proposal' });
    expect((await test.store.read(test.key))?.revision).toBe(oversizedRecord?.revision);
  });
});
