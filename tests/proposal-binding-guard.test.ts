import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '../packages/state/src/index.js';
import type { ActionBindingObservation } from '../apps/api/src/registry.js';
import {
  ProposalInvalidationError,
  type ProposalInvalidationAggregate,
  type ProposalRetentionUntil,
} from '../apps/api/src/proposal-invalidation.js';
import { ProposalBindingGuard } from '../apps/api/src/proposal-binding-guard.js';

const scope = 'proposal-binding-guard-test';
const beforeBinding = digest('proposal-active-binding');
const changedBinding = digest('new-active-binding');
const dayMs = 86_400_000;

interface TestProposal extends ProposalInvalidationAggregate {
  readonly args: Record<string, unknown>;
  readonly resourceName: string;
  readonly executionId?: string;
  readonly executionStartedAt?: number;
}

async function fixture(status = 'pending') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const store = new MemoryJsonStore(`proposal-binding-guard-${randomUUID()}`);
  const proposalId = randomUUID();
  const proposal: TestProposal = {
    id: proposalId,
    subject: 'private-subject-123',
    pluginId: 'records-plugin',
    bindingDigest: beforeBinding,
    status,
    args: { providerPayload: 'never-copy-this-to-audit' },
    resourceName: 'private-resource',
    ...(status === 'executing' || status === 'outcome_unknown' ? { executionId: 'durable-execution-id', executionStartedAt: Date.now() } : {}),
  };
  const key = `proposal:${proposalId}`;
  if (!await store.compareAndSet(key, null, proposal)) throw new Error('Could not seed proposal');

  let observation: ActionBindingObservation = { status: 'current', binding: changedBinding };
  let observeCalls = 0;
  const retentionUntil: ProposalRetentionUntil = (_aggregate, now) => now + dayMs;
  const createGuard = (guardStore: JsonStore = store, retention: ProposalRetentionUntil = retentionUntil) => new ProposalBindingGuard({
    store: guardStore,
    privateKey,
    scope,
    proposalRetentionUntil: retention,
    observeActionBinding: pluginId => {
      if (pluginId !== proposal.pluginId) throw new Error('Unexpected plugin authority request');
      observeCalls += 1;
      return Promise.resolve(observation);
    },
  });
  return {
    store,
    privateKey,
    proposal,
    proposalId,
    key,
    createGuard,
    setObservation: (next: ActionBindingObservation) => { observation = next; },
    observeCalls: () => observeCalls,
  };
}

function instrumentStore(base: JsonStore, onCompareAndSet?: (key: string, value: unknown) => void): { store: JsonStore; writes: () => number } {
  let writes = 0;
  return {
    store: {
      read: key => base.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        writes += 1;
        onCompareAndSet?.(key, value);
        return base.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => base.delete(key),
    },
    writes: () => writes,
  };
}

describe('proposal binding guard', () => {
  it('returns missing for a foreign owner before calling the registry observer', async () => {
    const test = await fixture();
    const counted = instrumentStore(test.store);
    const guard = test.createGuard(counted.store);

    await expect(guard.observeOwnedProposal(test.proposalId, 'another-subject')).resolves.toEqual({ status: 'missing' });
    expect(test.observeCalls()).toBe(0);
    expect(counted.writes()).toBe(0);
  });

  it('does not project a foreign invalidated proposal with a pending audit outbox', async () => {
    const test = await fixture();
    const unavailableProjection: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (key.startsWith('proposal-invalidation-audit:v1:')) throw new Error('temporary audit store outage');
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const ownerGuard = test.createGuard(unavailableProjection);
    const invalidated = await ownerGuard.observeOwnedProposal(test.proposalId, test.proposal.subject);
    if (invalidated.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(invalidated.auditProjection).toBe('pending');
    const auditKey = `proposal-invalidation-audit:v1:${digest(scope)}:${invalidated.event.event.eventId}`;
    expect(await test.store.read(auditKey)).toBeUndefined();

    const counted = instrumentStore(test.store);
    const foreignGuard = test.createGuard(counted.store);
    const priorObserverCalls = test.observeCalls();
    await expect(foreignGuard.observeOwnedProposal(test.proposalId, 'another-subject')).resolves.toEqual({ status: 'missing' });
    expect(test.observeCalls()).toBe(priorObserverCalls);
    expect(counted.writes()).toBe(0);
    expect(await test.store.read(auditKey)).toBeUndefined();
  });

  it('returns a fixed missing result for an unvalidated owner header', async () => {
    const test = await fixture();
    const stored = await test.store.read(test.key);
    if (!stored) throw new Error('Expected seeded proposal');
    expect(await test.store.compareAndSet(test.key, stored.revision, {
      ...(stored.value as TestProposal),
      subject: { privateValue: 'must-not-be-returned' },
    })).toBe(true);
    const counted = instrumentStore(test.store);
    const guard = test.createGuard(counted.store);

    await expect(guard.observeOwnedProposal(test.proposalId, test.proposal.subject)).resolves.toEqual({ status: 'missing' });
    expect(test.observeCalls()).toBe(0);
    expect(counted.writes()).toBe(0);
  });

  it('leaves pending proposals untouched when binding authority is unavailable', async () => {
    const test = await fixture();
    test.setObservation({ status: 'unavailable' });
    const counted = instrumentStore(test.store);
    const guard = test.createGuard(counted.store);
    const before = await test.store.read(test.key);

    await expect(guard.observeOwnedProposal(test.proposalId, test.proposal.subject)).resolves.toEqual({ status: 'unavailable' });
    expect(counted.writes()).toBe(0);
    expect((await test.store.read(test.key))?.revision).toBe(before?.revision);
  });

  it('does not write or sign an event when the trusted current binding is unchanged', async () => {
    const test = await fixture();
    test.setObservation({ status: 'current', binding: beforeBinding });
    const counted = instrumentStore(test.store);
    const guard = test.createGuard(counted.store);

    const result = await guard.observeOwnedProposal<TestProposal>(test.proposalId, test.proposal.subject);
    expect(result).toEqual({ status: 'unchanged', proposal: test.proposal });
    expect(counted.writes()).toBe(0);
  });

  it.each(['executing', 'outcome_unknown', 'confirmed', 'failed', 'expired'])(
    'leaves %s proposals unchanged without consulting the registry',
    async status => {
      const test = await fixture(status);
      const counted = instrumentStore(test.store);
      const guard = test.createGuard(counted.store);
      const before = await test.store.read(test.key);

      const result = await guard.observeOwnedProposal<TestProposal>(test.proposalId, test.proposal.subject);
      expect(result).toEqual({ status: 'unchanged', proposal: before?.value });
      expect(test.observeCalls()).toBe(0);
      expect(counted.writes()).toBe(0);
      expect((await test.store.read(test.key))?.value).toEqual(before?.value);
    },
  );

  it('invalidates changed current bindings with a bounded signed digest-only audit event', async () => {
    let retentionDeadline = 0;
    const test = await fixture();
    const guard = test.createGuard(test.store, (_aggregate, now) => {
      retentionDeadline = now + dayMs;
      return retentionDeadline;
    });

    const result = await guard.observeOwnedProposal<TestProposal>(test.proposalId, test.proposal.subject);
    expect(result.status).toBe('invalidated');
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(result.proposal).toMatchObject({ ...test.proposal, status: 'invalidated', invalidation: result.event });
    expect(result.event.event.reason).toBe('binding_changed');
    expect(result.event.event.beforeBindingDigest).toBe(beforeBinding);
    expect(result.event.event.afterBindingDigest).toBe(changedBinding);
    expect(JSON.stringify(result.event)).not.toContain(test.proposal.subject);
    expect(JSON.stringify(result.event)).not.toContain(test.proposal.pluginId);
    expect(JSON.stringify(result.event)).not.toContain('never-copy-this-to-audit');
    expect(retentionDeadline).toBeGreaterThan(Date.now());
  });

  it.each([
    ['plugin_disabled', 'plugin_disabled'],
    ['plugin_removed', 'plugin_removed'],
  ] as const)('preserves the definitive %s withdrawal reason', async (reason, expectedReason) => {
    const test = await fixture();
    test.setObservation({ status: 'withdrawn', binding: changedBinding, reason });
    const guard = test.createGuard();

    const result = await guard.observeOwnedProposal(test.proposalId, test.proposal.subject);
    expect(result.status).toBe('invalidated');
    if (result.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(result.event.event.reason).toBe(expectedReason);
  });

  it('treats malformed trusted observations as unavailable without mutation', async () => {
    const test = await fixture();
    test.setObservation({ status: 'current', binding: 'not-a-binding-digest' });
    const counted = instrumentStore(test.store);
    const guard = test.createGuard(counted.store);
    const before = await test.store.read(test.key);

    await expect(guard.observeOwnedProposal(test.proposalId, test.proposal.subject)).resolves.toEqual({ status: 'unavailable' });
    expect(counted.writes()).toBe(0);
    expect((await test.store.read(test.key))?.revision).toBe(before?.revision);
  });

  it('does not overwrite a concurrent execution claim or its execution identity', async () => {
    const test = await fixture();
    let executionClaimed = false;
    const racingStore: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (!executionClaimed && key === test.key && (value as TestProposal).status === 'invalidated') {
          executionClaimed = true;
          const current = await test.store.read(key);
          if (!current) throw new Error('Proposal vanished before competing execution claim');
          const executing = { ...(current.value as TestProposal), status: 'executing', executionId: 'execution-won-race', executionStartedAt: Date.now() };
          if (!await test.store.compareAndSet(key, current.revision, executing)) throw new Error('Could not install competing execution claim');
          return false;
        }
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const guard = test.createGuard(racingStore);

    const result = await guard.observeOwnedProposal<TestProposal>(test.proposalId, test.proposal.subject);
    expect(result).toMatchObject({ status: 'unchanged', proposal: { status: 'executing', executionId: 'execution-won-race' } });
    expect((await test.store.read(test.key))?.value).toMatchObject({ status: 'executing', executionId: 'execution-won-race' });
  });

  it('verifies an existing invalidation and retries its signed audit projection without re-observing', async () => {
    const test = await fixture();
    let failProjectionOnce = true;
    const projectionRetryStore: JsonStore = {
      read: key => test.store.read(key),
      compareAndSet: async (key, revision, value, expiresAt) => {
        if (failProjectionOnce && key.startsWith('proposal-invalidation-audit:v1:')) {
          failProjectionOnce = false;
          throw new Error('temporary audit store outage');
        }
        return test.store.compareAndSet(key, revision, value, expiresAt);
      },
      delete: key => test.store.delete(key),
    };
    const guard = test.createGuard(projectionRetryStore);

    const first = await guard.observeOwnedProposal(test.proposalId, test.proposal.subject);
    expect(first.status).toBe('invalidated');
    if (first.status !== 'invalidated') throw new Error('Expected invalidation');
    expect(first.auditProjection).toBe('pending');
    expect(test.observeCalls()).toBe(1);

    const second = await guard.observeOwnedProposal(test.proposalId, test.proposal.subject);
    expect(second.status).toBe('invalidated');
    if (second.status !== 'invalidated') throw new Error('Expected verified existing invalidation');
    expect(second.auditProjection).toBe('persisted');
    expect(second.event).toEqual(first.event);
    expect(test.observeCalls()).toBe(1);
  });

  it('rejects a tampered prior invalidation before observing current binding', async () => {
    const test = await fixture();
    const guard = test.createGuard();
    const invalidated = await guard.observeOwnedProposal(test.proposalId, test.proposal.subject);
    if (invalidated.status !== 'invalidated') throw new Error('Expected invalidation');
    const stored = await test.store.read(test.key);
    if (!stored) throw new Error('Expected persisted proposal');
    const proposal = stored.value as TestProposal & { invalidation: { signature: string } };
    expect(await test.store.compareAndSet(test.key, stored.revision, {
      ...proposal,
      invalidation: { ...proposal.invalidation, signature: 'A'.repeat(86) },
    })).toBe(true);

    await expect(guard.observeOwnedProposal(test.proposalId, test.proposal.subject)).rejects.toMatchObject({ code: 'invalid_signature' } satisfies Partial<ProposalInvalidationError>);
    expect(test.observeCalls()).toBe(1);
  });
});
