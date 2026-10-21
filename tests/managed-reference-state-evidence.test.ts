import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { digest, type ExecutionBinding, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import {
  deriveDemoPluginGrantKey,
  deriveManagedPluginAccountKey,
  deriveManagedReferenceStateKey,
  deriveManagedStateLeaseKey,
  derivePluginAccountChallengeKey,
  readManagedReferenceEvidence,
  validateManagedReferenceStateValue,
  validateManagedStateLeaseValue,
  validateOwnedDemoGrantValue,
  validateOwnedPluginAccountChallengeValue,
  validateOwnedPluginAccountValue,
  type ManagedReferenceEvidenceContext,
  type ManagedReferenceIdentityContext,
  type ManagedReferenceLeaseContext,
  type ManagedReferenceAccountContext,
} from '../scripts/managed-reference-state-evidence.js';
import { createManagedReferenceManifest } from '../scripts/reference-managed-state-profile.js';

const sourceManifestPath = new URL('../examples/reference-plugin/src/manifest.json', import.meta.url);

async function fixtureContext(overrides: Partial<Omit<ManagedReferenceEvidenceContext, 'manifest'>> = {}): Promise<ManagedReferenceEvidenceContext> {
  const source = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as PluginManifestV2;
  return {
    scope: 'managed-evidence-test-scope',
    installationId: 'reference-installation',
    subject: 'subject-a',
    account: 'account-a',
    manifest: createManagedReferenceManifest(source),
    ...overrides,
  };
}

function leaseContext(overrides: Partial<ManagedReferenceLeaseContext> = {}): ManagedReferenceLeaseContext {
  return { scope: 'scope-a', installationId: 'reference-installation', jti: '00000000-0000-4000-8000-000000000001', ...overrides };
}

function bindingFor(context: ManagedReferenceEvidenceContext, label = 'Synthetic action'): ExecutionBinding {
  return {
    subject: context.subject,
    installationId: context.installationId,
    executionId: '00000000-0000-4000-8000-000000000002',
    tool: 'execute_mark',
    argsHash: digest({ label }),
    configurationRevision: 3,
  };
}

function makeSourceState(context: ManagedReferenceEvidenceContext, binding = bindingFor(context)) {
  const identity = digest([binding.subject, binding.installationId, binding.executionId]);
  const result = { confirmed: true, actionCount: 1, label: 'Synthetic action', account: context.account };
  return {
    identity,
    result,
    value: {
      version: 1,
      actionCount: 1,
      receipts: { [identity]: { binding, account: context.account, result } },
    },
  };
}

function makeBlob(context: ManagedReferenceEvidenceContext, journalStatus: 'executing' | 'outcome_unknown' | 'confirmed' = 'executing') {
  const { identity, result, value: source } = makeSourceState(context);
  const binding = (source.receipts as Record<string, { binding: ExecutionBinding }>)[identity]?.binding;
  if (!binding) throw new Error('Source receipt fixture was not created.');
  const logicalJournalKey = `execution:v1:${digest({
    namespace: context.manifest.id,
    subject: binding.subject,
    installationId: binding.installationId,
    executionId: binding.executionId,
  })}`;
  const journal = {
    binding: digest(binding),
    status: journalStatus,
    ...(journalStatus === 'confirmed' ? { result } : {}),
  };
  return {
    identity,
    result,
    binding,
    logicalJournalKey,
    value: {
      version: 1,
      contract: digest(context.manifest.managedState),
      entries: {
        [digest(['application', 'source'])]: {
          area: 'application',
          key: 'source',
          revision: '00000000-0000-4000-8000-000000000003',
          value: source,
        },
        [digest(['journal', logicalJournalKey])]: {
          area: 'journal',
          key: logicalJournalKey,
          revision: '00000000-0000-4000-8000-000000000004',
          value: journal,
        },
      },
      nonces: {
        '00000000-0000-4000-8000-000000000005': Math.floor(Date.now() / 1000) + 600,
        '00000000-0000-4000-8000-000000000006': Math.floor(Date.now() / 1000) - 1,
      },
    },
  };
}

function signedValue(privateKey: KeyObject, domain: string, payload: Record<string, unknown>) {
  return {
    ...payload,
    signature: sign(null, Buffer.from(`${domain}${digest(payload)}`, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('managed reference host evidence', () => {
  it('derives partition, lease and account keys from trusted context', async () => {
    const context = await fixtureContext();
    const alternate = await fixtureContext({ scope: 'another-scope' });
    const id = '00000000-0000-4000-8000-000000000011';
    expect(deriveManagedReferenceStateKey(context)).toMatch(/^managed-plugin-state:v1:[a-f0-9]{64}$/u);
    expect(deriveManagedReferenceStateKey(alternate)).not.toBe(deriveManagedReferenceStateKey(context));
    expect(deriveManagedStateLeaseKey({ scope: context.scope, installationId: context.installationId, jti: id }))
      .toMatch(/^managed-plugin-state-lease:v1:[a-f0-9]{64}$/u);

    const identityContext: ManagedReferenceIdentityContext = {
      scope: context.scope,
      installationId: context.installationId,
      subject: context.subject,
    };
    expect(deriveManagedPluginAccountKey(identityContext)).toMatch(/^hasi:plugin-account:v1:[a-f0-9]{64}$/u);
    expect(deriveDemoPluginGrantKey(identityContext)).toMatch(/^hasi:demo-plugin-account:v1:[a-f0-9]{64}$/u);
    expect(derivePluginAccountChallengeKey({ ...identityContext, state: 'A'.repeat(43) }))
      .toMatch(/^hasi:plugin-account-challenge:v1:[a-f0-9]{64}$/u);
    expect(() => deriveManagedStateLeaseKey({ scope: context.scope, installationId: context.installationId, jti: 'bad' })).toThrow();
  });

  it('reads an absent partition and an initial nonce-only blob as zero effects', async () => {
    const context = await fixtureContext();
    const store = new MemoryJsonStore('managed-evidence-empty');
    expect(await readManagedReferenceEvidence(store, context)).toEqual({
      marks: 0, sourceRows: 0, journalRows: 0, confirmedJournalRows: 0, invocationRows: 0, receipts: [],
    });

    const initial = {
      version: 1,
      contract: digest(context.manifest.managedState),
      entries: {},
      nonces: { '00000000-0000-4000-8000-000000000012': Math.floor(Date.now() / 1000) + 600 },
    };
    const key = deriveManagedReferenceStateKey(context);
    expect(await store.compareAndSet(key, null, initial)).toBe(true);
    expect(await readManagedReferenceEvidence(store, context)).toMatchObject({
      marks: 0, sourceRows: 0, journalRows: 0, confirmedJournalRows: 0, invocationRows: 1, receipts: [],
    });
  });

  it('validates source receipts against an unfinished host journal after source commit', async () => {
    const context = await fixtureContext();
    const blob = makeBlob(context, 'executing');
    const evidence = validateManagedReferenceStateValue(context, blob.value);
    expect(evidence).toMatchObject({
      marks: 1,
      sourceRows: 1,
      journalRows: 1,
      confirmedJournalRows: 0,
      invocationRows: 1,
      receipts: [{ identity: blob.identity, binding: blob.binding, sourceResult: blob.result, journalStatus: 'executing' }],
    });
  });

  it('accepts outcome-unknown and confirmed receipts while enforcing confirmed output equality', async () => {
    const context = await fixtureContext();
    expect(validateManagedReferenceStateValue(context, makeBlob(context, 'outcome_unknown').value).receipts[0]?.journalStatus)
      .toBe('outcome_unknown');
    const confirmed = validateManagedReferenceStateValue(context, makeBlob(context, 'confirmed').value);
    expect(confirmed.confirmedJournalRows).toBe(1);
    expect(confirmed.receipts[0]?.journalResult).toEqual(confirmed.receipts[0]?.sourceResult);

    const invalid = structuredClone(makeBlob(context, 'confirmed').value) as Record<string, unknown>;
    const entries = invalid.entries as Record<string, { value: Record<string, unknown> }>;
    const journalEntry = Object.values(entries).find(entry => entry.value.status === 'confirmed');
    if (!journalEntry) throw new Error('Confirmed journal fixture missing.');
    journalEntry.value.result = { confirmed: false };
    expect(() => validateManagedReferenceStateValue(context, invalid)).toThrow();
  });

  it('rejects wrong contracts, malformed entry addresses, revisions, nonces and source bindings', async () => {
    const context = await fixtureContext();
    const valid = makeBlob(context).value;
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      value => { value.contract = 'f'.repeat(64); },
      value => {
        const entries = value.entries as Record<string, Record<string, unknown>>;
        const first = Object.values(entries)[0];
        if (first) first.key = 'other-address';
      },
      value => {
        const entries = value.entries as Record<string, Record<string, unknown>>;
        const first = Object.values(entries)[0];
        if (first) first.revision = 'invalid';
      },
      value => { value.nonces = { 'not-a-uuid': 123 }; },
      value => {
        const receipt = firstSourceReceipt(value);
        if (receipt) receipt.binding.subject = 'other-subject';
      },
      value => {
        const receipt = firstSourceReceipt(value);
        if (receipt) receipt.binding.argsHash = 'not-a-digest';
      },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(valid) as Record<string, unknown>;
      mutate(corrupted);
      expect(() => validateManagedReferenceStateValue(context, corrupted)).toThrow();
    }
  });

  it('rejects an unfinished journal whose execution binding cannot be reconstructed', async () => {
    const context = await fixtureContext();
    const blob = makeBlob(context).value as Record<string, unknown>;
    const entries = blob.entries as Record<string, { area: string; key: string; revision: string; value: unknown }>;
    const appAddress = digest(['application', 'source']);
    blob.entries = Object.fromEntries(Object.entries(entries).filter(([address]) => address !== appAddress));
    expect(() => validateManagedReferenceStateValue(context, blob)).toThrow();
  });

  it('validates exact lease values and signed account, demo grant and challenge records', async () => {
    const context = await fixtureContext();
    const keys = generateKeyPairSync('ed25519');
    const accountContext: ManagedReferenceAccountContext = { ...context, publicKey: keys.publicKey };
    const lease = leaseContext({ scope: context.scope, installationId: context.installationId });
    validateManagedStateLeaseValue(lease, deriveManagedStateLeaseKey(lease), { version: 1, invocation: lease.jti });
    expect(() => { validateManagedStateLeaseValue(lease, 'managed-plugin-state-lease:v1:unknown', { version: 1, invocation: lease.jti }); }).toThrow();
    expect(() => { validateManagedStateLeaseValue(lease, deriveManagedStateLeaseKey(lease), { version: 1, invocation: 'other' }); }).toThrow();

    const subjectHash = createSubjectDigest(context.scope, context.subject);
    const now = new Date().toISOString();
    const account = signedValue(keys.privateKey, 'hasi-plugin-account-state-v1\0', {
      schemaVersion: 1, scope: context.scope, installationId: context.installationId, subjectDigest: subjectHash,
      status: 'linked', authorityRevision: 1, adapterAuthorityRevision: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: now,
      revocationStatus: 'none', history: [{ operation: 'consent', at: now, authorityRevision: 1 }],
    });
    validateOwnedPluginAccountValue(accountContext, account);
    expect(() => { validateOwnedPluginAccountValue({ ...accountContext, subject: 'other-subject' }, account); }).toThrow();
    expect(() => { validateOwnedPluginAccountValue(accountContext, { ...account, signature: 'A'.repeat(86) }); }).toThrow();

    const grant = signedValue(keys.privateKey, 'hasi-demo-plugin-account-v1\0', {
      schemaVersion: 1, scope: context.scope, installationId: context.installationId, subjectDigest: subjectHash,
      status: 'active', authorityRevision: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: now,
    });
    validateOwnedDemoGrantValue(accountContext, grant);
    expect(() => { validateOwnedDemoGrantValue(accountContext, { ...grant, status: 'revoked' }); }).toThrow();

    const challengeContext = { ...accountContext, state: 'B'.repeat(43) };
    const challenge = signedValue(keys.privateKey, 'hasi-plugin-account-challenge-v1\0', {
      schemaVersion: 1, scope: context.scope, installationId: context.installationId, subjectDigest: subjectHash,
      operation: 'consent', expectedAuthorityRevision: 0, expectedAdapterRevision: null, returnTo: '/',
      issuedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), consumedAt: now,
    });
    validateOwnedPluginAccountChallengeValue(challengeContext, derivePluginAccountChallengeKey(challengeContext), challenge);
    expect(() => { validateOwnedPluginAccountChallengeValue(challengeContext, 'wrong-key', challenge); }).toThrow();
    expect(() => { validateOwnedPluginAccountChallengeValue({ ...challengeContext, subject: 'other-subject' }, derivePluginAccountChallengeKey({ ...challengeContext, subject: 'other-subject' }), challenge); }).toThrow();
  });
});

function firstSourceReceipt(value: Record<string, unknown>): { binding: ExecutionBinding } | undefined {
  if (!isRecord(value.entries)) return undefined;
  const appEntry = Object.values(value.entries).find(entry => isRecord(entry)
    && isRecord(entry.value) && Object.hasOwn(entry.value, 'receipts'));
  if (!isRecord(appEntry) || !isRecord(appEntry.value) || !isRecord(appEntry.value.receipts)) return undefined;
  const receipt = Object.values(appEntry.value.receipts)[0];
  if (!isRecord(receipt) || !isRecord(receipt.binding)) return undefined;
  return { binding: receipt.binding as unknown as ExecutionBinding };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSubjectDigest(scope: string, subject: string): string {
  return createHash('sha256').update(`${scope}\0${subject}`, 'utf8').digest('hex');
}
