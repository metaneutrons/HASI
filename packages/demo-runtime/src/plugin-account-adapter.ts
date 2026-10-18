import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { digest } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { z } from 'zod';

export interface DemoPluginAccountProjection {
  permissions: string[];
  customerId?: string | undefined;
  resourceIds?: string[] | undefined;
  claims?: Record<string, string | number | boolean | null | string[]> | undefined;
}

export interface DemoPluginAccountContext {
  subject: string;
  installationId: string;
}

export interface DemoPluginAccountAdapterOptions {
  privateKey: KeyObject;
  store: JsonStore;
  scope: string;
  installationId: string;
  /** Demo adapters must never be constructed by the production runtime. */
  mode: 'development' | 'test' | 'public-demo' | 'production';
  /** A trusted, host-owned projection of the authenticated user's current rights. */
  resolveProjection: (context: DemoPluginAccountContext) => DemoPluginAccountProjection | undefined | Promise<DemoPluginAccountProjection | undefined>;
  clock?: () => number;
  grantLifetimeMs?: number;
}

interface DemoGrantState {
  schemaVersion: 1;
  scope: string;
  installationId: string;
  subjectDigest: string;
  status: 'active' | 'revoked';
  authorityRevision: number;
  expiresAt: string | null;
  updatedAt: string;
}
interface SignedDemoGrantState extends DemoGrantState { signature: string }

const installationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const grantStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: installationIdSchema,
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(['active', 'revoked']),
  authorityRevision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
const projectionSchema = z.strictObject({
  permissions: z.array(z.string().trim().min(1).max(256)).max(128),
  customerId: z.string().trim().min(1).max(256).optional(),
  resourceIds: z.array(z.string().trim().min(1).max(256)).max(256).optional(),
  claims: z.record(z.string(), z.union([
    z.string().max(1_024),
    z.number().min(-1_000_000_000_000_000).max(1_000_000_000_000_000),
    z.boolean(),
    z.null(),
    z.array(z.string().max(256)).max(256),
  ])).optional(),
}).superRefine((projection, context) => {
  if (new Set(projection.permissions).size !== projection.permissions.length) context.addIssue({ code: 'custom', path: ['permissions'], message: 'duplicate permissions' });
  if (projection.resourceIds && new Set(projection.resourceIds).size !== projection.resourceIds.length) context.addIssue({ code: 'custom', path: ['resourceIds'], message: 'duplicate resource ids' });
  if (projection.claims && Object.keys(projection.claims).length > 64) context.addIssue({ code: 'custom', path: ['claims'], message: 'too many claims' });
  for (const [name, value] of Object.entries(projection.claims ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name) || name === '__proto__' || name === 'prototype' || name === 'constructor' || Array.isArray(value) && new Set(value).size !== value.length) {
      context.addIssue({ code: 'custom', path: ['claims', name], message: 'invalid claim' });
    }
  }
});

const INACTIVE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_GRANT_LIFETIME_MS = 8 * 60 * 60 * 1000;

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(now: number): string {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) throw new RangeError('Demo account adapter clock returned an invalid timestamp');
  return value.toISOString();
}

/**
 * A durable synthetic adapter for development, tests, and the public demo.
 * It never contacts an external service and never stores credentials. Its
 * only rights source is the operator-supplied `resolveProjection` callback.
 */
export class DemoPluginAccountAdapter {
  readonly trustLevel = 'demo-only' as const;
  private readonly publicKey: KeyObject;
  private readonly clock: () => number;
  private readonly grantLifetimeMs: number;

  constructor(private readonly options: DemoPluginAccountAdapterOptions) {
    if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Demo account state requires an Ed25519 private key');
    if (options.mode === 'production') throw new TypeError('Demo-only plugin account adapters cannot run in production');
    if (!options.scope.trim() || options.scope.length > 256) throw new TypeError('Demo account scope must be a non-empty server-owned string');
    installationIdSchema.parse(options.installationId);
    this.publicKey = createPublicKey(options.privateKey);
    this.clock = options.clock ?? Date.now;
    this.grantLifetimeMs = options.grantLifetimeMs ?? DEFAULT_GRANT_LIFETIME_MS;
    if (!Number.isSafeInteger(this.grantLifetimeMs) || this.grantLifetimeMs < 60_000 || this.grantLifetimeMs > 24 * 60 * 60 * 1000) throw new TypeError('Demo account grants must last between one minute and 24 hours');
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new RangeError('Demo account adapter clock returned an invalid timestamp');
    return value;
  }

  private subjectDigest(subject: string): string {
    if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 256 || subject.includes('\0')) throw new TypeError('Demo account subject is invalid');
    return hash(`${this.options.scope}\0${subject}`);
  }

  private context(context: DemoPluginAccountContext): DemoPluginAccountContext {
    this.subjectDigest(context.subject);
    if (context.installationId !== this.options.installationId) throw new Error('Demo account installation mismatch');
    return context;
  }

  private key(subjectDigest: string): string {
    return `hasi:demo-plugin-account:v1:${digest({ scope: this.options.scope, installationId: this.options.installationId, subjectDigest })}`;
  }

  private signingContent(state: DemoGrantState): Buffer {
    return Buffer.from(`hasi-demo-plugin-account-v1\0${digest(state)}`, 'utf8');
  }

  private signed(state: DemoGrantState): SignedDemoGrantState {
    return { ...state, signature: sign(null, this.signingContent(state), this.options.privateKey).toString('base64url') };
  }

  private verified(raw: unknown, subjectDigest: string): DemoGrantState {
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid state');
      const record = raw as Record<string, unknown>;
      const signature = typeof record.signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(record.signature) ? record.signature : '';
      const state = grantStateSchema.parse(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature')));
      if (!signature || state.scope !== this.options.scope || state.installationId !== this.options.installationId || state.subjectDigest !== subjectDigest || !verify(null, this.signingContent(state), this.publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Invalid state');
      return state;
    } catch {
      throw new Error('Demo plugin account state is invalid or altered');
    }
  }

  private async read(context: DemoPluginAccountContext): Promise<{ state: DemoGrantState | undefined; revision: string | null }> {
    const normalized = this.context(context);
    const subjectDigest = this.subjectDigest(normalized.subject);
    const record = await this.options.store.read(this.key(subjectDigest));
    return { state: record ? this.verified(record.value, subjectDigest) : undefined, revision: record?.revision ?? null };
  }

  private async write(context: DemoPluginAccountContext, expectedStoreRevision: string | null, state: DemoGrantState): Promise<boolean> {
    const subjectDigest = this.subjectDigest(this.context(context).subject);
    const expiresAt = state.status === 'active' && state.expiresAt !== null
      ? Date.parse(state.expiresAt) + INACTIVE_RETENTION_MS
      : this.now() + INACTIVE_RETENTION_MS;
    return this.options.store.compareAndSet(this.key(subjectDigest), expectedStoreRevision, this.signed(state), expiresAt);
  }

  begin(input: DemoPluginAccountContext & { operation: 'consent' | 'renewal'; state: string }): Promise<{ authorizationUrl: string }> {
    this.context(input);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.state)) throw new Error('Demo account challenge is invalid');
    const query = new URLSearchParams({ state: input.state, installationId: this.options.installationId });
    return Promise.resolve({ authorizationUrl: `/account/connections/consent?${query.toString()}` });
  }

  async complete(input: DemoPluginAccountContext & {
    operation: 'consent' | 'renewal';
    state: string;
    callback: Readonly<Record<string, string>>;
    expectedAuthorityRevision: number;
    expectedAdapterRevision: number | null;
  }): Promise<{ expiresAt: string; authorityRevision: number }> {
    this.context(input);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.state) || input.callback.state !== input.state || input.callback.approved !== 'true') throw new Error('Demo account consent was not confirmed');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { state: current, revision } = await this.read(input);
      const currentAuthorityRevision = current?.authorityRevision ?? null;
      if (currentAuthorityRevision !== input.expectedAdapterRevision) throw new Error('Demo account authority changed while consent was pending');
      if (input.operation === 'consent' && current?.status === 'active' && (current.expiresAt === null || Date.parse(current.expiresAt) > this.now())) throw new Error('Demo account is already linked; use renewal');
      if (input.operation === 'renewal' && current?.status !== 'active') throw new Error('Demo account renewal is not available');
      const authorityRevision = (current?.authorityRevision ?? 0) + 1;
      const expiresAt = iso(this.now() + this.grantLifetimeMs);
      const next: DemoGrantState = {
        schemaVersion: 1,
        scope: this.options.scope,
        installationId: this.options.installationId,
        subjectDigest: this.subjectDigest(input.subject),
        status: 'active',
        authorityRevision,
        expiresAt,
        updatedAt: iso(this.now()),
      };
      if (await this.write(input, revision, next)) return { expiresAt, authorityRevision };
    }
    throw new Error('Demo account state changed concurrently');
  }

  async inspect(input: DemoPluginAccountContext): Promise<{
    status: 'active' | 'expired' | 'revoked' | 'unavailable';
    authorityRevision: number;
    expiresAt: string | null;
    projection?: DemoPluginAccountProjection | undefined;
  }> {
    const { state } = await this.read(input);
    if (!state) return { status: 'revoked', authorityRevision: 0, expiresAt: null };
    if (state.status === 'revoked') return { status: 'revoked', authorityRevision: state.authorityRevision, expiresAt: state.expiresAt };
    if (state.expiresAt !== null && Date.parse(state.expiresAt) <= this.now()) return { status: 'expired', authorityRevision: state.authorityRevision, expiresAt: state.expiresAt };
    try {
      const projection = this.options.resolveProjection(this.context(input));
      const resolved = await projection;
      if (!resolved) return { status: 'unavailable', authorityRevision: state.authorityRevision, expiresAt: state.expiresAt };
      const safeProjection = projectionSchema.parse(resolved);
      return { status: 'active', authorityRevision: state.authorityRevision, expiresAt: state.expiresAt, projection: safeProjection };
    } catch {
      return { status: 'unavailable', authorityRevision: state.authorityRevision, expiresAt: state.expiresAt };
    }
  }

  async revoke(input: DemoPluginAccountContext & { expectedAdapterRevision: number | null }): Promise<void> {
    this.context(input);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { state: current, revision } = await this.read(input);
      if (!current) return;
      if (current.status === 'revoked') return;
      if (input.expectedAdapterRevision !== current.authorityRevision) throw new Error('Demo account authority changed before revocation');
      const next: DemoGrantState = { ...current, status: 'revoked', updatedAt: iso(this.now()) };
      if (await this.write(input, revision, next)) return;
    }
    throw new Error('Demo account revocation conflicted');
  }
}
