import { createHash, verify, type KeyObject } from 'node:crypto';
import {
  canonicalJson,
  digest,
  manifestSchema,
  managedStateValidator,
  type ExecutionBinding,
  type PluginManifestV2,
} from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { z } from 'zod';

const SHA256 = /^[a-f0-9]{64}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const LOGICAL_KEY = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,191}$/u;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_ENTRIES = 256;
const MAX_ACTIVE_NONCES = 128;
const MAX_ENTRY_BYTES = 60 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
type ManagedStateDeclaration = NonNullable<PluginManifestV2['managedState']>;

const executionBindingSchema = z.strictObject({
  subject: z.string().min(1).max(256).refine(value => !value.includes('\0')),
  installationId: z.string().regex(INSTALLATION_ID),
  executionId: z.uuid(),
  tool: z.string().min(1).max(256),
  argsHash: z.string().regex(SHA256),
  configurationRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
});

const sourceResultSchema = z.strictObject({
  confirmed: z.literal(true),
  actionCount: z.number().int().positive().refine(Number.isSafeInteger),
  label: z.string().min(1).max(80),
  account: z.string().min(1).max(1024),
});

const sourceReceiptSchema = z.strictObject({
  binding: executionBindingSchema,
  account: z.string().min(1).max(1024),
  result: sourceResultSchema,
});

const sourceStateSchema = z.strictObject({
  version: z.literal(1),
  actionCount: z.number().int().nonnegative().refine(Number.isSafeInteger),
  receipts: z.record(z.string().regex(SHA256), sourceReceiptSchema),
});

const journalReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ binding: z.string().regex(SHA256), status: z.literal('executing') }),
  z.strictObject({ binding: z.string().regex(SHA256), status: z.literal('outcome_unknown') }),
  z.strictObject({ binding: z.string().regex(SHA256), status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }),
]);

const stateEntrySchema = z.strictObject({
  area: z.enum(['application', 'journal']),
  key: z.string().min(1).max(192).regex(LOGICAL_KEY).refine(value => value !== 'constructor' && value !== 'prototype'),
  revision: z.uuid(),
  value: z.unknown(),
});

const stateBlobSchema = z.strictObject({
  version: z.literal(1),
  contract: z.string().regex(SHA256),
  entries: z.record(z.string().regex(SHA256), stateEntrySchema),
  nonces: z.record(z.uuid(), z.number().int().positive().refine(Number.isSafeInteger)),
});

const accountStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: z.string().regex(INSTALLATION_ID),
  subjectDigest: z.string().regex(SHA256),
  status: z.enum(['unlinked', 'linked', 'expired', 'revoked', 'disconnected']),
  authorityRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
  adapterAuthorityRevision: z.number().int().nonnegative().nullable().refine(value => value === null || Number.isSafeInteger(value)),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  pendingChallengeDigest: z.string().regex(SHA256).optional(),
  pendingOperation: z.enum(['consent', 'renewal']).optional(),
  pendingChallengeExpiresAt: z.iso.datetime({ offset: true }).optional(),
  revocationStatus: z.enum(['none', 'pending', 'confirmed']),
  history: z.array(z.strictObject({
    operation: z.enum(['consent', 'renewal', 'authorization_failed', 'disconnect', 'revocation_confirmed', 'external_revocation', 'expired', 'authority_changed']),
    at: z.iso.datetime({ offset: true }),
    authorityRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
  })).max(100),
});

const demoGrantStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: z.string().regex(INSTALLATION_ID),
  subjectDigest: z.string().regex(SHA256),
  status: z.enum(['active', 'revoked']),
  authorityRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});

const challengeStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: z.string().regex(INSTALLATION_ID),
  subjectDigest: z.string().regex(SHA256),
  operation: z.enum(['consent', 'renewal']),
  expectedAuthorityRevision: z.number().int().nonnegative().refine(Number.isSafeInteger),
  expectedAdapterRevision: z.number().int().nonnegative().nullable().refine(value => value === null || Number.isSafeInteger(value)),
  returnTo: z.enum(['/', '/bookings', '/admin', '/account/connections']),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  consumedAt: z.iso.datetime({ offset: true }).optional(),
});

export interface ManagedReferenceEvidenceContext {
  readonly scope: string;
  readonly installationId: string;
  readonly subject: string;
  readonly account: string;
  readonly manifest: PluginManifestV2;
}

export interface ManagedReferenceLeaseContext {
  readonly scope: string;
  readonly installationId: string;
  readonly jti: string;
}

export interface ManagedReferenceReceiptEvidence {
  readonly identity: string;
  readonly binding: ExecutionBinding;
  readonly sourceResult: Record<string, unknown>;
  readonly journalStatus: 'executing' | 'outcome_unknown' | 'confirmed';
  readonly journalResult?: Record<string, unknown>;
}

export interface ManagedReferenceEvidence {
  readonly marks: number;
  readonly sourceRows: number;
  readonly journalRows: number;
  readonly confirmedJournalRows: number;
  readonly invocationRows: number;
  readonly receipts: readonly ManagedReferenceReceiptEvidence[];
}

export interface ManagedReferenceIdentityContext {
  readonly scope: string;
  readonly installationId: string;
  readonly subject: string;
}

export interface ManagedReferenceAccountContext extends ManagedReferenceIdentityContext {
  readonly publicKey: KeyObject;
}

export interface ManagedReferenceChallengeIdentityContext extends ManagedReferenceIdentityContext {
  readonly state: string;
}

export interface ManagedReferenceChallengeContext extends ManagedReferenceAccountContext {
  readonly state: string;
}

function reject(): never {
  throw new Error('Managed reference state evidence is invalid.');
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) reject();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function subjectDigest(scope: string, subject: string): string {
  return sha256(`${scope}\0${subject}`);
}

function managedStateDeclaration(context: ManagedReferenceEvidenceContext): ManagedStateDeclaration {
  const input: unknown = context.manifest;
  const result = manifestSchema.safeParse(input);
  if (!result.success || result.data.manifestVersion !== 2) reject();
  const declaration = result.data.managedState;
  if (declaration === undefined) reject();
  if (declaration.accountIdentity.kind !== 'claim'
    || !result.data.identity?.claims.includes(declaration.accountIdentity.name)) reject();
  return declaration;
}

function validateContext(context: ManagedReferenceEvidenceContext): ManagedStateDeclaration {
  const scope: unknown = context.scope;
  const installationId: unknown = context.installationId;
  const subject: unknown = context.subject;
  const account: unknown = context.account;
  requireValid(typeof scope === 'string' && scope.length > 0 && scope.length <= 256 && !scope.includes('\0'));
  requireValid(typeof installationId === 'string' && INSTALLATION_ID.test(installationId));
  requireValid(typeof subject === 'string' && subject.length > 0 && subject.length <= 256 && !subject.includes('\0'));
  requireValid(typeof account === 'string' && account.length > 0 && account.length <= 1024 && !account.includes('\0'));
  return managedStateDeclaration(context);
}

function stateContractDigest(context: ManagedReferenceEvidenceContext): string {
  return digest(validateContext(context));
}

export function deriveManagedReferenceStateKey(context: ManagedReferenceEvidenceContext): string {
  validateContext(context);
  return `managed-plugin-state:v1:${digest({
    scope: context.scope,
    installation: context.installationId,
    package: context.manifest.id,
    subject: context.subject,
    account: context.account,
  })}`;
}

export function deriveManagedStateLeaseKey(context: ManagedReferenceLeaseContext): string {
  const scope: unknown = context.scope;
  const installationId: unknown = context.installationId;
  const jti: unknown = context.jti;
  requireValid(typeof scope === 'string' && scope.length > 0 && scope.length <= 256 && !scope.includes('\0'));
  requireValid(typeof installationId === 'string' && INSTALLATION_ID.test(installationId));
  requireValid(typeof jti === 'string' && z.uuid().safeParse(jti).success);
  return `managed-plugin-state-lease:v1:${digest({ scope: context.scope, installation: context.installationId, jti: context.jti })}`;
}

export function deriveManagedPluginAccountKey(context: ManagedReferenceIdentityContext): string {
  validateIdentityContext(context);
  return `hasi:plugin-account:v1:${digest({ scope: context.scope, installationId: context.installationId, subjectDigest: subjectDigest(context.scope, context.subject) })}`;
}

export function deriveDemoPluginGrantKey(context: ManagedReferenceIdentityContext): string {
  validateIdentityContext(context);
  return `hasi:demo-plugin-account:v1:${digest({ scope: context.scope, installationId: context.installationId, subjectDigest: subjectDigest(context.scope, context.subject) })}`;
}

export function derivePluginAccountChallengeKey(context: ManagedReferenceChallengeIdentityContext): string {
  validateIdentityContext(context);
  requireValid(CHALLENGE.test(context.state));
  return `hasi:plugin-account-challenge:v1:${digest({ scope: context.scope, challengeDigest: sha256(context.state) })}`;
}

function validateIdentityContext(context: ManagedReferenceIdentityContext): void {
  const scope: unknown = context.scope;
  const installationId: unknown = context.installationId;
  const subject: unknown = context.subject;
  requireValid(typeof scope === 'string' && scope.length > 0 && scope.length <= 256 && !scope.includes('\0'));
  requireValid(typeof installationId === 'string' && INSTALLATION_ID.test(installationId));
  requireValid(typeof subject === 'string' && subject.length > 0 && subject.length <= 256 && !subject.includes('\0'));
}

function validateSigningContext(context: ManagedReferenceAccountContext): void {
  validateIdentityContext(context);
  requireValid(context.publicKey.type === 'public' && context.publicKey.asymmetricKeyType === 'ed25519');
}

export function validateManagedStateLeaseValue(context: ManagedReferenceLeaseContext, key: string, value: unknown): void {
  const expectedKey = deriveManagedStateLeaseKey(context);
  requireValid(key === expectedKey && isRecord(value));
  requireValid(Object.keys(value).length === 2 && Object.hasOwn(value, 'version') && Object.hasOwn(value, 'invocation'));
  requireValid(value.version === 1 && value.invocation === context.jti);
}

export function validateOwnedPluginAccountValue(context: ManagedReferenceAccountContext, value: unknown): void {
  validateSigningContext(context);
  const signed = validateSignedRecord(value);
  const parsed = accountStateSchema.parse(signed.payload);
  requireValid(parsed.scope === context.scope && parsed.installationId === context.installationId
    && parsed.subjectDigest === subjectDigest(context.scope, context.subject));
  verifySignedPayload(context.publicKey, 'hasi-plugin-account-state-v1\0', parsed, signed.signature);
}

export function validateOwnedDemoGrantValue(context: ManagedReferenceAccountContext, value: unknown): void {
  validateSigningContext(context);
  const signed = validateSignedRecord(value);
  const parsed = demoGrantStateSchema.parse(signed.payload);
  requireValid(parsed.scope === context.scope && parsed.installationId === context.installationId
    && parsed.subjectDigest === subjectDigest(context.scope, context.subject));
  verifySignedPayload(context.publicKey, 'hasi-demo-plugin-account-v1\0', parsed, signed.signature);
}

export function validateOwnedPluginAccountChallengeValue(context: ManagedReferenceChallengeContext, key: string, value: unknown): void {
  const expectedKey = derivePluginAccountChallengeKey(context);
  validateSigningContext(context);
  requireValid(key === expectedKey);
  const signed = validateSignedRecord(value);
  const parsed = challengeStateSchema.parse(signed.payload);
  requireValid(parsed.scope === context.scope && parsed.installationId === context.installationId
    && parsed.subjectDigest === subjectDigest(context.scope, context.subject));
  verifySignedPayload(context.publicKey, 'hasi-plugin-account-challenge-v1\0', parsed, signed.signature);
}

function validateSignedRecord(value: unknown): { payload: Record<string, unknown>; signature: string } {
  requireValid(isRecord(value));
  const signature = value.signature;
  requireValid(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(signature));
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signature'));
  requireValid(Object.keys(payload).length + 1 === Object.keys(value).length);
  return { payload, signature };
}

function verifySignedPayload(publicKey: KeyObject, domain: string, payload: unknown, signature: string): void {
  const message = Buffer.from(`${domain}${digest(payload)}`, 'utf8');
  requireValid(verify(null, message, publicKey, Buffer.from(signature, 'base64url')));
}

function executionJournalKey(manifest: PluginManifestV2, binding: ExecutionBinding): string {
  return `execution:v1:${digest({ namespace: manifest.id, subject: binding.subject, installationId: binding.installationId, executionId: binding.executionId })}`;
}

function validateSourceState(context: ManagedReferenceEvidenceContext, value: unknown): z.infer<typeof sourceStateSchema> {
  requireValid(isRecord(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_ENTRY_BYTES);
  requireValid(managedStateValidator(validateContext(context).applicationSchema)(value));
  const source = sourceStateSchema.parse(value);
  requireValid(Object.keys(source.receipts).length === source.actionCount);

  const actionCounts = new Set<number>();
  for (const [identity, receipt] of Object.entries(source.receipts)) {
    requireValid(identity === digest([receipt.binding.subject, receipt.binding.installationId, receipt.binding.executionId]));
    requireValid(receipt.binding.subject === context.subject && receipt.binding.installationId === context.installationId
      && receipt.binding.tool === 'execute_mark' && receipt.binding.argsHash === digest({ label: receipt.result.label })
      && receipt.binding.configurationRevision >= 0 && receipt.account === context.account);
    requireValid(receipt.result.account === context.account && receipt.result.actionCount <= source.actionCount
      && !actionCounts.has(receipt.result.actionCount));
    actionCounts.add(receipt.result.actionCount);
  }
  for (let count = 1; count <= source.actionCount; count += 1) requireValid(actionCounts.has(count));
  return source;
}

function emptyEvidence(): ManagedReferenceEvidence {
  return { marks: 0, sourceRows: 0, journalRows: 0, confirmedJournalRows: 0, invocationRows: 0, receipts: [] };
}

export function validateManagedReferenceStateValue(context: ManagedReferenceEvidenceContext, value: unknown): ManagedReferenceEvidence {
  const contract = stateContractDigest(context);
  requireValid(isRecord(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_TOTAL_BYTES);
  const blob = stateBlobSchema.parse(value);
  requireValid(blob.contract === contract && Object.keys(blob.entries).length <= MAX_ENTRIES
    && Object.keys(blob.nonces).length <= MAX_ACTIVE_NONCES);
  for (const expiry of Object.values(blob.nonces)) requireValid(Number.isSafeInteger(expiry) && expiry > 0);
  for (const [address, entry] of Object.entries(blob.entries)) {
    requireValid(address === digest([entry.area, entry.key])
      && Buffer.byteLength(JSON.stringify(entry.value), 'utf8') <= MAX_ENTRY_BYTES);
  }

  const sourceAddress = digest(['application', 'source']);
  const sourceEntry = blob.entries[sourceAddress];
  let source: z.infer<typeof sourceStateSchema> | undefined;
  if (sourceEntry) {
    requireValid(sourceEntry.area === 'application' && sourceEntry.key === 'source');
    source = validateSourceState(context, sourceEntry.value);
  }

  const bindings = new Map<string, { identity: string; binding: ExecutionBinding; sourceResult: Record<string, unknown> }>();
  for (const [identity, receipt] of Object.entries(source?.receipts ?? {})) {
    const binding = executionBindingSchema.parse(receipt.binding);
    const key = executionJournalKey(context.manifest, binding);
    requireValid(!bindings.has(key));
    bindings.set(key, { identity, binding, sourceResult: receipt.result });
  }

  const journals = new Map<string, z.infer<typeof journalReceiptSchema>>();
  for (const entry of Object.values(blob.entries)) {
    if (entry.area === 'application') {
      requireValid(entry.key === 'source');
      continue;
    }
    const known = bindings.get(entry.key);
    // The logical execution key is a digest. Without a source receipt there is
    // no trusted execution ID from which to reconstruct and verify that key.
    requireValid(known !== undefined && entry.key.startsWith('execution:v1:'));
    const journal = journalReceiptSchema.parse(entry.value);
    requireValid(journal.binding === digest(known.binding));
    if (journal.status === 'confirmed') {
      const executeTool = context.manifest.tools.find(tool => tool.name === 'execute_mark');
      requireValid(executeTool !== undefined && managedStateValidator(executeTool.outputSchema)(journal.result));
      requireValid(canonicalJson(journal.result) === canonicalJson(known.sourceResult));
    }
    requireValid(!journals.has(entry.key));
    journals.set(entry.key, journal);
  }

  requireValid(journals.size === bindings.size);
  for (const key of bindings.keys()) requireValid(journals.has(key));

  const receipts: ManagedReferenceReceiptEvidence[] = [...bindings.entries()].map(([key, known]) => {
    const journal = journals.get(key);
    requireValid(journal !== undefined);
    return {
      identity: known.identity,
      binding: known.binding,
      sourceResult: known.sourceResult,
      journalStatus: journal.status,
      ...(journal.status === 'confirmed' ? { journalResult: journal.result } : {}),
    };
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const invocationRows = Object.values(blob.nonces).filter(expiry => expiry > nowSeconds).length;
  return {
    marks: source?.actionCount ?? 0,
    sourceRows: Object.keys(source?.receipts ?? {}).length,
    journalRows: journals.size,
    confirmedJournalRows: [...journals.values()].filter(receipt => receipt.status === 'confirmed').length,
    invocationRows,
    receipts,
  };
}

export async function readManagedReferenceEvidence(
  store: JsonStore,
  context: ManagedReferenceEvidenceContext,
): Promise<ManagedReferenceEvidence> {
  const row = await store.read(deriveManagedReferenceStateKey(context));
  if (!row) return emptyEvidence();
  requireValid(z.uuid().safeParse(row.revision).success);
  return validateManagedReferenceStateValue(context, row.value);
}
