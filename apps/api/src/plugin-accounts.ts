import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { digest } from '@hasi/plugin-sdk';
import type { ActorClaimValue } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';
import { z } from 'zod';

/**
 * Account history remains available while consent is active and for 180 days
 * after it ends. It is capped at 100 events. Inactive account records expire
 * after that period; active consent metadata remains until consent expires or
 * is revoked. OAuth challenges are one-use and expire after ten minutes.
 */
export const PLUGIN_ACCOUNT_RETENTION = Object.freeze({
  challengeTtlMs: 10 * 60 * 1000,
  inactiveRecordMs: 180 * 24 * 60 * 60 * 1000,
  historyRetentionMs: 180 * 24 * 60 * 60 * 1000,
  maxHistoryEvents: 100,
});

export const PLUGIN_ACCOUNT_RETURN_PATHS = ['/', '/bookings', '/admin', '/account/connections'] as const;
export type PluginAccountReturnPath = typeof PLUGIN_ACCOUNT_RETURN_PATHS[number];
export type PluginAccountOperation = 'consent' | 'renewal';
export type PluginAccountLifecycleStatus = 'unlinked' | 'linked' | 'expired' | 'revoked' | 'disconnected' | 'unavailable';
export type PluginAccountRemedy = 'connect' | 'renew' | 'retry_status' | 'retry_revocation' | 'configure_adapter';

export interface PluginAccountActorProjection {
  /** Restrict these against the host actor's current permissions before invocation. */
  permissions: string[];
  customerId?: string | undefined;
  resourceIds?: string[] | undefined;
  claims?: Record<string, ActorClaimValue> | undefined;
}

export interface PluginAccountAdapterContext {
  /** Host authenticated subject. Never read this from OAuth callback input. */
  subject: string;
  /** Host-selected installation identity. Never read this from OAuth callback input. */
  installationId: string;
}

export interface PluginAccountAdapter {
  /** Synthetic/test adapters must say demo-only; production rejects them. */
  readonly trustLevel: 'trusted' | 'demo-only';
  /** Operator-pinned HTTPS origins used by trusted authorization flows. */
  readonly authorizationOrigins?: readonly string[];
  begin(input: PluginAccountAdapterContext & {
    operation: PluginAccountOperation;
    state: string;
    signal: AbortSignal;
  }): Promise<{ authorizationUrl: string }>;
  /**
   * Exchange provider callback data and store credentials inside the adapter's
   * own custody boundary. Do not return credentials, references, or identities.
   * Implementations must compare expectedAdapterRevision atomically.
   */
  complete(input: PluginAccountAdapterContext & {
    operation: PluginAccountOperation;
    state: string;
    callback: Readonly<Record<string, string>>;
    expectedAuthorityRevision: number;
    expectedAdapterRevision: number | null;
    signal: AbortSignal;
  }): Promise<{ expiresAt: string | null; authorityRevision: number }>;
  /** Return current rights from the trusted external authority on every use. */
  inspect(input: PluginAccountAdapterContext & { signal: AbortSignal }): Promise<PluginAccountAdapterInspection>;
  /** Revoke only when expectedAdapterRevision still names the grant being removed. */
  revoke(input: PluginAccountAdapterContext & { expectedAdapterRevision: number | null; signal: AbortSignal }): Promise<void>;
}

export interface PluginAccountAdapterInspection {
  status: 'active' | 'expired' | 'revoked' | 'unavailable';
  authorityRevision: number;
  expiresAt: string | null;
  projection?: PluginAccountActorProjection | undefined;
}

export interface PluginAccountHistoryEntry {
  operation: 'consent' | 'renewal' | 'authorization_failed' | 'disconnect' | 'revocation_confirmed' | 'external_revocation' | 'expired' | 'authority_changed';
  at: string;
  authorityRevision: number;
}

export interface PluginAccountStatus {
  installationId: string;
  status: PluginAccountLifecycleStatus;
  authorityRevision: number;
  expiresAt: string | null;
  updatedAt: string;
  flow: 'idle' | 'consent_pending' | 'renewal_pending';
  adapterTrust: 'trusted' | 'demo-only' | 'missing';
  revocationStatus: 'none' | 'pending' | 'confirmed';
  remedies: PluginAccountRemedy[];
  history: PluginAccountHistoryEntry[];
  disconnectImpact: {
    pendingConfirmations: 'invalidated';
    inFlightExecutions: 'may_complete';
    completedExternalChanges: 'not_undone';
    conversationHistory: 'retained';
  };
}

export interface PluginAccountAuthority {
  installationId: string;
  authorityRevision: number;
  expiresAt: string | null;
  projection: PluginAccountActorProjection;
}

export interface PluginAccountBeginResult {
  authorizationUrl: string;
  challengeExpiresAt: string;
}

export interface PluginAccountCompleteResult {
  returnTo: PluginAccountReturnPath;
  status: 'linked';
  authorityRevision: number;
  expiresAt: string | null;
}

export interface PluginAccountRevokeResult {
  authorityRevision: number;
  status: 'disconnected';
  revocationStatus: 'pending' | 'confirmed';
}

export interface PluginAccountServiceOptions {
  privateKey: KeyObject;
  store: JsonStore;
  /** Server-owned namespace shared with the API's durable state configuration. */
  scope: string;
  /** Trusted installation identity, normally the registry instance ID. */
  installationId: string;
  mode: 'development' | 'test' | 'public-demo' | 'production';
  adapter?: PluginAccountAdapter;
  /** Deadline per provider call. Aborts the supplied signal and fails closed. */
  adapterTimeoutMs?: number;
  clock?: () => number;
  challengeTtlMs?: number;
}

export class PluginAccountError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PluginAccountError';
  }
}

const CLAIM_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const HISTORY_OPERATIONS = ['consent', 'renewal', 'authorization_failed', 'disconnect', 'revocation_confirmed', 'external_revocation', 'expired', 'authority_changed'] as const;
const HISTORY_RETENTION_MS = PLUGIN_ACCOUNT_RETENTION.historyRetentionMs;
const MAX_FUTURE_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 8_000;

const claimValueSchema = z.union([
  z.string().max(1_024),
  z.number().min(-1_000_000_000_000_000).max(1_000_000_000_000_000),
  z.boolean(),
  z.null(),
  z.array(z.string().max(256)).max(256),
]);
const projectionSchema = z.strictObject({
  permissions: z.array(z.string().trim().min(1).max(256)).max(128),
  customerId: z.string().trim().min(1).max(256).optional(),
  resourceIds: z.array(z.string().trim().min(1).max(256)).max(256).optional(),
  claims: z.record(z.string(), claimValueSchema).optional(),
}).superRefine((value, context) => {
  if (new Set(value.permissions).size !== value.permissions.length) context.addIssue({ code: 'custom', path: ['permissions'], message: 'duplicate account permissions' });
  if (value.resourceIds && new Set(value.resourceIds).size !== value.resourceIds.length) context.addIssue({ code: 'custom', path: ['resourceIds'], message: 'duplicate account resource ids' });
  if (value.claims && Object.keys(value.claims).length > 64) context.addIssue({ code: 'custom', path: ['claims'], message: 'too many projected claims' });
  for (const [name, claim] of Object.entries(value.claims ?? {})) {
    if (!CLAIM_NAME.test(name) || name === '__proto__' || name === 'prototype' || name === 'constructor' || Array.isArray(claim) && new Set(claim).size !== claim.length) {
      context.addIssue({ code: 'custom', path: ['claims', name], message: 'invalid projected claim' });
    }
  }
});

const accountStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: z.string().regex(INSTALLATION_ID),
  subjectDigest: z.string().regex(SHA256),
  status: z.enum(['unlinked', 'linked', 'expired', 'revoked', 'disconnected']),
  authorityRevision: z.number().int().nonnegative(),
  adapterAuthorityRevision: z.number().int().nonnegative().nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  pendingChallengeDigest: z.string().regex(SHA256).optional(),
  pendingOperation: z.enum(['consent', 'renewal']).optional(),
  pendingChallengeExpiresAt: z.iso.datetime({ offset: true }).optional(),
  revocationStatus: z.enum(['none', 'pending', 'confirmed']),
  history: z.array(z.strictObject({
    operation: z.enum(HISTORY_OPERATIONS),
    at: z.iso.datetime({ offset: true }),
    authorityRevision: z.number().int().nonnegative(),
  })).max(PLUGIN_ACCOUNT_RETENTION.maxHistoryEvents),
});
type AccountState = z.infer<typeof accountStateSchema>;
interface SignedAccountState extends AccountState { signature: string }

const challengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  installationId: z.string().regex(INSTALLATION_ID),
  subjectDigest: z.string().regex(SHA256),
  operation: z.enum(['consent', 'renewal']),
  expectedAuthorityRevision: z.number().int().nonnegative(),
  expectedAdapterRevision: z.number().int().nonnegative().nullable(),
  returnTo: z.enum(PLUGIN_ACCOUNT_RETURN_PATHS),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  consumedAt: z.iso.datetime({ offset: true }).optional(),
});
type ChallengeState = z.infer<typeof challengeSchema>;
interface SignedChallenge extends ChallengeState { signature: string }

const adapterInspectionSchema = z.strictObject({
  status: z.enum(['active', 'expired', 'revoked', 'unavailable']),
  authorityRevision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  projection: projectionSchema.optional(),
});
const adapterGrantSchema = z.strictObject({
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  authorityRevision: z.number().int().nonnegative(),
});

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
function normalizeProjection(value: unknown): PluginAccountActorProjection {
  return withoutUndefined(projectionSchema.parse(value));
}
function asIso(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Clock returned an invalid timestamp');
  return date.toISOString();
}
function expiryTime(expiresAt: string | null): number | null { return expiresAt === null ? null : Date.parse(expiresAt); }
function isAllowedReturnPath(value: unknown): value is PluginAccountReturnPath {
  return typeof value === 'string' && (PLUGIN_ACCOUNT_RETURN_PATHS as readonly string[]).includes(value);
}
function parseCallback(value: unknown, challenge: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PluginAccountError(400, 'invalid_callback', 'Die Rückmeldung des Anmeldedienstes ist ungültig.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new PluginAccountError(400, 'invalid_callback', 'Die Rückmeldung des Anmeldedienstes ist zu groß.');
  let size = 0;
  const callback: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype' || typeof raw !== 'string' || raw.length > 4_096 || raw.includes('\0')) {
      throw new PluginAccountError(400, 'invalid_callback', 'Die Rückmeldung des Anmeldedienstes ist ungültig.');
    }
    size += key.length + raw.length;
    if (size > 16_384) throw new PluginAccountError(400, 'invalid_callback', 'Die Rückmeldung des Anmeldedienstes ist zu groß.');
    callback[key] = raw;
  }
  if (callback.state !== challenge) throw new PluginAccountError(400, 'invalid_callback', 'Die Rückmeldung gehört nicht zu diesem Anmeldevorgang.');
  return callback;
}

/**
 * Durable, host-owned consent state for one trusted installation. The adapter
 * owns provider credentials and external identity; neither is stored here.
 */
export class PluginAccountService {
  private readonly publicKey: KeyObject;
  private readonly clock: () => number;
  private readonly challengeTtlMs: number;
  private readonly adapterTimeoutMs: number;

  constructor(private readonly options: PluginAccountServiceOptions) {
    if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Plugin account state requires an Ed25519 private key');
    if (!options.scope.trim() || options.scope.length > 256) throw new TypeError('Plugin account scope must be a non-empty server-owned string');
    if (!INSTALLATION_ID.test(options.installationId)) throw new TypeError('Plugin account installation identity is invalid');
    if (options.mode === 'production' && !options.adapter) throw new TypeError('Production plugin accounts require a trusted adapter');
    if (options.mode === 'production' && options.adapter?.trustLevel !== 'trusted') throw new TypeError('Production plugin accounts reject demo-only adapters');
    if (options.adapter && !(['trusted', 'demo-only'] as readonly string[]).includes(options.adapter.trustLevel)) throw new TypeError('Plugin account adapter trust level is invalid');
    if (options.adapter?.trustLevel === 'trusted') {
      const origins = options.adapter.authorizationOrigins;
      if (!origins || origins.length === 0 || origins.length > 16 || origins.some((origin) => {
        try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== ''; }
        catch { return true; }
      })) throw new TypeError('Trusted plugin account adapters require pinned HTTPS authorization origins');
    }
    this.publicKey = createPublicKey(options.privateKey);
    this.clock = options.clock ?? Date.now;
    this.challengeTtlMs = options.challengeTtlMs ?? PLUGIN_ACCOUNT_RETENTION.challengeTtlMs;
    if (!Number.isSafeInteger(this.challengeTtlMs) || this.challengeTtlMs < 1_000 || this.challengeTtlMs > PLUGIN_ACCOUNT_RETENTION.challengeTtlMs) throw new TypeError('Plugin account challenge TTL must be between one second and ten minutes');
    this.adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.adapterTimeoutMs) || this.adapterTimeoutMs < 100 || this.adapterTimeoutMs > 30_000) throw new TypeError('Plugin account adapter timeout must be between 100 milliseconds and 30 seconds');
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new RangeError('Plugin account clock returned an invalid timestamp');
    return now;
  }

  private subjectDigest(subject: string): string {
    if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 256 || subject.includes('\0')) throw new PluginAccountError(401, 'invalid_subject', 'Deine Anmeldung ist ungültig. Bitte melde dich erneut an.');
    return sha256(`${this.options.scope}\0${subject}`);
  }

  private context(subject: string): PluginAccountAdapterContext {
    this.subjectDigest(subject);
    return { subject, installationId: this.options.installationId };
  }

  private async withAdapterTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, onLateResult?: (result: T) => void | Promise<void>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.resolve().then(() => operation(controller.signal));
    if (onLateResult) void pending.then((result) => timedOut ? onLateResult(result) : undefined).catch(() => undefined);
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new PluginAccountError(504, 'adapter_timeout', 'Der Anmeldedienst antwortet nicht rechtzeitig. Bitte versuche es erneut.'));
      }, this.adapterTimeoutMs);
    });
    try { return await Promise.race([pending, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private accountKey(subjectDigest: string): string {
    return `hasi:plugin-account:v1:${digest({ scope: this.options.scope, installationId: this.options.installationId, subjectDigest })}`;
  }

  private challengeKey(challenge: string): string {
    return `hasi:plugin-account-challenge:v1:${digest({ scope: this.options.scope, challengeDigest: sha256(challenge) })}`;
  }

  private stateSigningContent(state: AccountState): Buffer { return Buffer.from(`hasi-plugin-account-state-v1\0${digest(state)}`, 'utf8'); }
  private challengeSigningContent(challenge: ChallengeState): Buffer { return Buffer.from(`hasi-plugin-account-challenge-v1\0${digest(challenge)}`, 'utf8'); }

  private signState(state: AccountState): SignedAccountState {
    return { ...state, signature: sign(null, this.stateSigningContent(state), this.options.privateKey).toString('base64url') };
  }

  private signChallenge(challenge: ChallengeState): SignedChallenge {
    return { ...challenge, signature: sign(null, this.challengeSigningContent(challenge), this.options.privateKey).toString('base64url') };
  }

  private verifyState(raw: unknown, subjectDigest: string): AccountState {
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid state');
      const record = raw as Record<string, unknown>;
      const signature = SIGNATURE.exec(typeof record.signature === 'string' ? record.signature : '')?.[0];
      const parsed = accountStateSchema.parse(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature')));
      if (!signature || parsed.scope !== this.options.scope || parsed.installationId !== this.options.installationId || parsed.subjectDigest !== subjectDigest || !verify(null, this.stateSigningContent(parsed), this.publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Invalid state');
      return parsed;
    } catch {
      throw new PluginAccountError(409, 'account_state_invalid', 'Der Kontostatus ist ungültig oder wurde verändert. Bitte wende dich an den Support.');
    }
  }

  private verifyChallenge(raw: unknown, challenge: string): SignedChallenge {
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid challenge');
      const record = raw as Record<string, unknown>;
      const signature = SIGNATURE.exec(typeof record.signature === 'string' ? record.signature : '')?.[0];
      const parsed = challengeSchema.parse(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'signature')));
    if (!CHALLENGE.test(challenge) || !signature || parsed.scope !== this.options.scope || parsed.installationId !== this.options.installationId || !verify(null, this.challengeSigningContent(parsed), this.publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Invalid challenge');
      return { ...parsed, signature };
    } catch {
      throw new PluginAccountError(400, 'challenge_invalid', 'Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte starte ihn erneut.');
    }
  }

  private initialState(subjectDigest: string): AccountState {
    return {
      schemaVersion: 1,
      scope: this.options.scope,
      installationId: this.options.installationId,
      subjectDigest,
      status: 'unlinked',
      authorityRevision: 0,
      adapterAuthorityRevision: null,
      expiresAt: null,
      updatedAt: asIso(this.now()),
      revocationStatus: 'none',
      history: [],
    };
  }

  private async readState(subjectDigest: string): Promise<AccountState> {
    const record = await this.options.store.read(this.accountKey(subjectDigest));
    return record ? this.verifyState(record.value, subjectDigest) : this.initialState(subjectDigest);
  }

  private storageExpiry(state: AccountState): number | undefined {
    if (state.status === 'linked') {
      const grantExpiry = expiryTime(state.expiresAt);
      return grantExpiry === null ? undefined : grantExpiry + PLUGIN_ACCOUNT_RETENTION.inactiveRecordMs;
    }
    return Date.parse(state.updatedAt) + PLUGIN_ACCOUNT_RETENTION.inactiveRecordMs;
  }

  private appendHistory(state: AccountState, operation: PluginAccountHistoryEntry['operation'], at: string, authorityRevision = state.authorityRevision): AccountState {
    const cutoff = Date.parse(at) - HISTORY_RETENTION_MS;
    const history = [...state.history.filter((entry) => Date.parse(entry.at) >= cutoff), { operation, at, authorityRevision }]
      .slice(-PLUGIN_ACCOUNT_RETENTION.maxHistoryEvents);
    return { ...state, history };
  }

  private async mutateState(subjectDigest: string, change: (state: AccountState) => AccountState): Promise<AccountState> {
    const key = this.accountKey(subjectDigest);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const stored = await this.options.store.read(key);
      const current = stored ? this.verifyState(stored.value, subjectDigest) : this.initialState(subjectDigest);
      const next = withoutUndefined(accountStateSchema.parse(change(current)));
      const signed = this.signState(next);
      if (await this.options.store.compareAndSet(key, stored?.revision ?? null, signed, this.storageExpiry(next))) return next;
    }
    throw new PluginAccountError(409, 'account_conflict', 'Der Kontostatus wurde parallel geändert. Bitte lade ihn neu und versuche es erneut.');
  }

  private adapterRequired(): PluginAccountAdapter {
    const adapter = this.options.adapter;
    if (!adapter) throw new PluginAccountError(503, 'adapter_missing', 'Für diesen Dienst ist keine persönliche Kontoverbindung eingerichtet.');
    if (this.options.mode === 'production' && adapter.trustLevel !== 'trusted') throw new PluginAccountError(503, 'adapter_untrusted', 'Die persönliche Kontoverbindung ist in dieser Umgebung nicht freigegeben.');
    return adapter;
  }

  private validateAuthorizationUrl(value: unknown, adapter: PluginAccountAdapter, challenge: string): string {
    if (typeof value !== 'string' || value.length > 2_048) throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat keine gültige Anmeldeseite bereitgestellt.');
    if (value.startsWith('/') && !value.startsWith('//')) {
      let local: URL;
      try { local = new URL(value, 'https://hasi.invalid'); } catch { throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat keine gültige Anmeldeseite bereitgestellt.'); }
      const queryKeys = [...local.searchParams.keys()];
      if (adapter.trustLevel !== 'demo-only' || local.pathname !== '/account/connections/consent' || local.hash || local.searchParams.getAll('state').length !== 1 || local.searchParams.get('state') !== challenge || local.searchParams.getAll('installationId').length !== 1 || local.searchParams.get('installationId') !== this.options.installationId || queryKeys.length !== 2 || queryKeys.some((key) => key !== 'state' && key !== 'installationId')) throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat eine unzulässige lokale Anmeldeseite bereitgestellt.');
      return `${local.pathname}${local.search}`;
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat keine gültige Anmeldeseite bereitgestellt.'); }
    if (adapter.trustLevel !== 'trusted' || url.protocol !== 'https:' || url.username || url.password || url.hash || !adapter.authorizationOrigins?.includes(url.origin) || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== challenge) throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat eine unzulässige Anmeldeseite bereitgestellt.');
    return url.toString();
  }

  private normalizeExpiry(expiresAt: unknown): string | null {
    if (expiresAt === null) return null;
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat eine ungültige Gültigkeitsdauer zurückgegeben.');
    const timestamp = Date.parse(expiresAt);
    if (timestamp <= this.now() || timestamp > this.now() + MAX_FUTURE_EXPIRY_MS) throw new PluginAccountError(502, 'adapter_response_invalid', 'Der Anmeldedienst hat eine unzulässige Gültigkeitsdauer zurückgegeben.');
    return new Date(timestamp).toISOString();
  }

  private normalizeInspection(value: unknown): PluginAccountAdapterInspection {
    try {
      const parsed = adapterInspectionSchema.parse(value);
      const inspection = withoutUndefined({
        ...parsed,
        ...(parsed.projection ? { projection: normalizeProjection(parsed.projection) } : {}),
      });
      if (inspection.status === 'active') {
        if (!inspection.projection) throw new Error('Missing projection');
        if (inspection.expiresAt !== null && Date.parse(inspection.expiresAt) <= this.now()) throw new Error('Expired active projection');
      }
      return inspection;
    } catch {
      throw new PluginAccountError(503, 'adapter_response_invalid', 'Der Kontostatus des Anmeldedienstes konnte nicht sicher geprüft werden.');
    }
  }

  private flowFor(state: AccountState, now: number): PluginAccountStatus['flow'] {
    if (!state.pendingChallengeDigest || !state.pendingOperation || !state.pendingChallengeExpiresAt || Date.parse(state.pendingChallengeExpiresAt) <= now) return 'idle';
    return state.pendingOperation === 'renewal' ? 'renewal_pending' : 'consent_pending';
  }

  private publicStatus(state: AccountState, overrides: { status?: PluginAccountLifecycleStatus; adapterUnavailable?: boolean } = {}): PluginAccountStatus {
    const now = this.now();
    const flow = this.flowFor(state, now);
    const status = overrides.status ?? state.status;
    const adapterTrust = this.options.adapter?.trustLevel ?? 'missing';
    const remedies: PluginAccountRemedy[] = [];
    if (!this.options.adapter) remedies.push('configure_adapter');
    else if (overrides.adapterUnavailable) remedies.push('retry_status');
    if (status === 'unlinked' || status === 'revoked' || status === 'disconnected') remedies.push('connect');
    if (status === 'linked' || status === 'expired') remedies.push('renew');
    if (state.revocationStatus === 'pending') remedies.push('retry_revocation');
    return {
      installationId: this.options.installationId,
      status,
      authorityRevision: state.authorityRevision,
      expiresAt: state.expiresAt,
      updatedAt: state.updatedAt,
      flow,
      adapterTrust,
      revocationStatus: state.revocationStatus,
      remedies: [...new Set(remedies)],
      history: state.history.filter((entry) => Date.parse(entry.at) >= now - HISTORY_RETENTION_MS),
      disconnectImpact: {
        pendingConfirmations: 'invalidated',
        inFlightExecutions: 'may_complete',
        completedExternalChanges: 'not_undone',
        conversationHistory: 'retained',
      },
    };
  }

  /** Read the current account state and reconcile it with the external authority. */
  async status(subject: string): Promise<PluginAccountStatus> {
    const subjectDigest = this.subjectDigest(subject);
    let state = await this.readState(subjectDigest);
    const now = this.now();
    if (state.pendingChallengeDigest && state.pendingChallengeExpiresAt && Date.parse(state.pendingChallengeExpiresAt) <= now) {
        state = await this.mutateState(subjectDigest, (current) => current.pendingChallengeDigest === state.pendingChallengeDigest
        ? { ...current, updatedAt: asIso(now), pendingChallengeDigest: undefined, pendingOperation: undefined, pendingChallengeExpiresAt: undefined }
        : current);
    }
    if (state.status !== 'linked') return this.publicStatus(state);
    const adapter = this.options.adapter;
    if (!adapter) return this.publicStatus(state, { status: 'unavailable', adapterUnavailable: true });

    let inspection: PluginAccountAdapterInspection;
    try { inspection = this.normalizeInspection(await this.withAdapterTimeout((signal) => adapter.inspect({ ...this.context(subject), signal }))); }
    catch { return this.publicStatus(state, { status: 'unavailable', adapterUnavailable: true }); }
    if (inspection.status === 'unavailable') return this.publicStatus(state, { status: 'unavailable', adapterUnavailable: true });

    if (inspection.status === 'revoked' || inspection.status === 'expired') {
      const nextStatus = inspection.status;
      const eventAt = asIso(this.now());
      const event = nextStatus === 'revoked' ? 'external_revocation' : 'expired';
      state = await this.mutateState(subjectDigest, (current) => {
        const lastEvent = current.history.at(-1);
        // Another replica may have reconciled exactly this provider transition
        // after our inspection. Return that result without a second revision or
        // history event. A newer consent/disconnect/pending flow still conflicts.
        const alreadyReconciled = current.status === nextStatus
          && current.authorityRevision === state.authorityRevision + 1
          && current.adapterAuthorityRevision === inspection.authorityRevision
          && current.expiresAt === inspection.expiresAt
          && current.revocationStatus === (nextStatus === 'revoked' ? 'confirmed' : 'none')
          && current.pendingChallengeDigest === undefined && current.pendingOperation === undefined
          && current.pendingChallengeExpiresAt === undefined
          && lastEvent?.operation === event && lastEvent.authorityRevision === current.authorityRevision;
        if (alreadyReconciled) return current;
        if (current.status !== 'linked' || current.authorityRevision !== state.authorityRevision) throw new PluginAccountError(409, 'account_changed', 'Die Kontoberechtigung wurde parallel geändert. Bitte lade den Status neu.');
        const revision = current.authorityRevision + 1;
        return this.appendHistory({ ...current, status: nextStatus, authorityRevision: revision, adapterAuthorityRevision: inspection.authorityRevision, expiresAt: inspection.expiresAt, updatedAt: eventAt, pendingChallengeDigest: undefined, pendingOperation: undefined, pendingChallengeExpiresAt: undefined, revocationStatus: nextStatus === 'revoked' ? 'confirmed' : 'none' }, event, eventAt, revision);
      });
      return this.publicStatus(state);
    }

    if (!inspection.projection) return this.publicStatus(state, { status: 'unavailable', adapterUnavailable: true });
    const normalizedExpiry = inspection.expiresAt === null ? null : this.normalizeExpiry(inspection.expiresAt);
    const currentStateAfterInspect = await this.readState(subjectDigest);
    if (currentStateAfterInspect.status !== 'linked' || currentStateAfterInspect.authorityRevision !== state.authorityRevision) {
      throw new PluginAccountError(409, 'account_changed', 'Die Kontoberechtigung wurde während der Prüfung geändert. Bitte lade den Status neu.');
    }
    const sourceChanged = currentStateAfterInspect.adapterAuthorityRevision !== inspection.authorityRevision || currentStateAfterInspect.expiresAt !== normalizedExpiry;
    if (sourceChanged) {
      const eventAt = asIso(this.now());
      state = await this.mutateState(subjectDigest, (current) => {
        if (current.status !== 'linked' || current.authorityRevision !== currentStateAfterInspect.authorityRevision) throw new PluginAccountError(409, 'account_changed', 'Die Kontoberechtigung wurde während der Prüfung geändert. Bitte lade den Status neu.');
        const revision = current.authorityRevision + 1;
        return this.appendHistory({ ...current, authorityRevision: revision, adapterAuthorityRevision: inspection.authorityRevision, expiresAt: normalizedExpiry, updatedAt: eventAt }, 'authority_changed', eventAt, revision);
      });
    }
    const finalState = await this.readState(subjectDigest);
    if (finalState.status !== 'linked' || finalState.authorityRevision !== state.authorityRevision) throw new PluginAccountError(409, 'account_changed', 'Die Kontoberechtigung wurde während der Prüfung geändert. Bitte lade den Status neu.');
    return this.publicStatus(finalState);
  }

  /**
   * Start consent or renewal. `returnTo` is an exact allow-listed local path;
   * arbitrary URLs and browser-selected provider endpoints are rejected.
   */
  async begin(subject: string, input: { operation: PluginAccountOperation; returnTo: string }): Promise<PluginAccountBeginResult> {
    const subjectDigest = this.subjectDigest(subject);
    if (!isAllowedReturnPath(input.returnTo)) throw new PluginAccountError(400, 'invalid_return_path', 'Die Rückkehradresse ist nicht freigegeben.');
    const adapter = this.adapterRequired();
    let current = await this.readState(subjectDigest);
    if (current.status === 'linked') {
      const refreshed = await this.status(subject);
      current = await this.readState(subjectDigest);
      if (refreshed.status === 'unavailable') throw new PluginAccountError(503, 'account_authority_unavailable', 'Der aktuelle Kontostatus kann nicht geprüft werden. Bitte versuche es erneut.');
    }
    if (current.revocationStatus === 'pending') throw new PluginAccountError(409, 'revocation_pending', 'Die vorherige Kontoverbindung muss erst beim Anmeldedienst widerrufen werden.');
    if (input.operation === 'consent' && current.status === 'linked') throw new PluginAccountError(409, 'renewal_required', 'Für dieses Konto ist bereits eine Verbindung aktiv. Bitte starte eine Erneuerung.');
    if (input.operation === 'renewal' && current.status !== 'linked' && current.status !== 'expired') throw new PluginAccountError(409, 'account_not_linked', 'Dieses Konto kann derzeit nicht erneuert werden.');

    const state = randomBytes(32).toString('base64url');
    const stateDigest = sha256(state);
    const issuedAt = asIso(this.now());
    const expiresAt = asIso(this.now() + this.challengeTtlMs);
    const challenge: ChallengeState = {
      schemaVersion: 1,
      scope: this.options.scope,
      installationId: this.options.installationId,
      subjectDigest,
      operation: input.operation,
      expectedAuthorityRevision: current.authorityRevision,
      expectedAdapterRevision: current.adapterAuthorityRevision,
      returnTo: input.returnTo,
      issuedAt,
      expiresAt,
    };
    const challengeKey = this.challengeKey(state);
    if (!await this.options.store.compareAndSet(challengeKey, null, this.signChallenge(challenge), Date.parse(expiresAt))) throw new PluginAccountError(503, 'challenge_unavailable', 'Der Anmeldevorgang konnte nicht vorbereitet werden. Bitte versuche es erneut.');

    try {
      await this.mutateState(subjectDigest, (latest) => {
        if (latest.authorityRevision !== current.authorityRevision || latest.status !== current.status) throw new PluginAccountError(409, 'account_changed', 'Der Kontostatus wurde parallel geändert. Bitte lade ihn neu.');
        if (input.operation === 'consent' && latest.status === 'linked') throw new PluginAccountError(409, 'renewal_required', 'Für dieses Konto ist bereits eine Verbindung aktiv. Bitte starte eine Erneuerung.');
        if (input.operation === 'renewal' && latest.status !== 'linked' && latest.status !== 'expired') throw new PluginAccountError(409, 'account_not_linked', 'Dieses Konto kann derzeit nicht erneuert werden.');
        return { ...latest, updatedAt: issuedAt, pendingChallengeDigest: stateDigest, pendingOperation: input.operation, pendingChallengeExpiresAt: expiresAt };
      });
      const preparedUrl = z.strictObject({ authorizationUrl: z.string().max(2_048) }).parse(await this.withAdapterTimeout((signal) => adapter.begin({ ...this.context(subject), operation: input.operation, state, signal })));
      return { authorizationUrl: this.validateAuthorizationUrl(preparedUrl.authorizationUrl, adapter, state), challengeExpiresAt: expiresAt };
    } catch (cause) {
      await this.options.store.delete(challengeKey);
      await this.mutateState(subjectDigest, (latest) => latest.pendingChallengeDigest === stateDigest
        ? { ...latest, updatedAt: asIso(this.now()), pendingChallengeDigest: undefined, pendingOperation: undefined, pendingChallengeExpiresAt: undefined }
        : latest).catch(() => undefined);
      if (cause instanceof PluginAccountError) throw cause;
      throw new PluginAccountError(503, 'authorization_start_failed', 'Der Anmeldevorgang konnte nicht gestartet werden. Bitte versuche es erneut.');
    }
  }

  private async consumeChallenge(subjectDigest: string, challenge: string): Promise<ChallengeState> {
    if (!CHALLENGE.test(challenge)) throw new PluginAccountError(400, 'challenge_invalid', 'Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte starte ihn erneut.');
    const key = this.challengeKey(challenge);
    const stored = await this.options.store.read(key);
    if (!stored) throw new PluginAccountError(400, 'challenge_expired', 'Der Anmeldevorgang ist abgelaufen. Bitte starte ihn erneut.');
    const signed = this.verifyChallenge(stored.value, challenge);
    const challengeState = challengeSchema.parse(Object.fromEntries(Object.entries(signed).filter(([key]) => key !== 'signature')));
    if (challengeState.subjectDigest !== subjectDigest || challengeState.scope !== this.options.scope || challengeState.installationId !== this.options.installationId) throw new PluginAccountError(403, 'challenge_subject_mismatch', 'Der Anmeldevorgang gehört nicht zu deinem aktuellen Konto.');
    if (Date.parse(challengeState.expiresAt) <= this.now()) throw new PluginAccountError(400, 'challenge_expired', 'Der Anmeldevorgang ist abgelaufen. Bitte starte ihn erneut.');
    if (challengeState.consumedAt) throw new PluginAccountError(409, 'challenge_replayed', 'Dieser Anmeldevorgang wurde bereits verwendet. Bitte starte ihn erneut.');
    const consumedAt = asIso(this.now());
    const consumed: ChallengeState = { ...challengeState, consumedAt };
    if (!await this.options.store.compareAndSet(key, stored.revision, this.signChallenge(consumed), Date.parse(challengeState.expiresAt))) throw new PluginAccountError(409, 'challenge_replayed', 'Dieser Anmeldevorgang wurde bereits verwendet. Bitte starte ihn erneut.');
    return challengeState;
  }

  /** Complete only for the same authenticated subject and trusted installation that began the flow. */
  async complete(subject: string, challenge: string, callbackInput: unknown): Promise<PluginAccountCompleteResult> {
    const context = this.context(subject);
    const subjectDigest = this.subjectDigest(subject);
    const callback = parseCallback(callbackInput, challenge);
    const challengeState = await this.consumeChallenge(subjectDigest, challenge);
    const stateDigest = sha256(challenge);
    let current = await this.readState(subjectDigest);
    if (current.pendingChallengeDigest !== stateDigest || current.authorityRevision !== challengeState.expectedAuthorityRevision || current.pendingOperation !== challengeState.operation) {
      throw new PluginAccountError(409, 'challenge_superseded', 'Der Anmeldevorgang wurde ersetzt oder der Kontostatus hat sich geändert. Bitte starte ihn erneut.');
    }
    const adapter = this.adapterRequired();
    let completedGrant: { expiresAt: string | null; authorityRevision: number } | undefined;
    try {
      const grant = adapterGrantSchema.parse(await this.withAdapterTimeout((signal) => adapter.complete({
        ...context,
        operation: challengeState.operation,
        state: challenge,
        callback,
        expectedAuthorityRevision: challengeState.expectedAuthorityRevision,
        expectedAdapterRevision: challengeState.expectedAdapterRevision,
        signal,
      }), (lateGrant) => {
        const late = adapterGrantSchema.safeParse(lateGrant);
        return late.success ? this.withAdapterTimeout((signal) => adapter.revoke({ ...context, expectedAdapterRevision: late.data.authorityRevision, signal })) : undefined;
      }));
      completedGrant = grant;
      const normalizedExpiry = this.normalizeExpiry(grant.expiresAt);
      const eventAt = asIso(this.now());
      const next = await this.mutateState(subjectDigest, (latest) => {
        if (latest.pendingChallengeDigest !== stateDigest || latest.authorityRevision !== challengeState.expectedAuthorityRevision || latest.pendingOperation !== challengeState.operation) throw new PluginAccountError(409, 'challenge_superseded', 'Der Anmeldevorgang wurde während der Bestätigung ersetzt.');
        const revision = latest.authorityRevision + 1;
        return this.appendHistory({
          ...latest,
          status: 'linked',
          authorityRevision: revision,
          adapterAuthorityRevision: grant.authorityRevision,
          expiresAt: normalizedExpiry,
          updatedAt: eventAt,
          pendingChallengeDigest: undefined,
          pendingOperation: undefined,
          pendingChallengeExpiresAt: undefined,
          revocationStatus: 'none',
        }, challengeState.operation, eventAt, revision);
      });
      return { returnTo: challengeState.returnTo, status: 'linked', authorityRevision: next.authorityRevision, expiresAt: next.expiresAt };
    } catch (cause) {
      const grantToRevoke = completedGrant;
      if (grantToRevoke) await this.withAdapterTimeout((signal) => adapter.revoke({ ...context, expectedAdapterRevision: grantToRevoke.authorityRevision, signal })).catch(() => undefined);
      if (!(cause instanceof PluginAccountError && cause.code === 'challenge_superseded')) {
        const eventAt = asIso(this.now());
        current = await this.mutateState(subjectDigest, (latest) => latest.pendingChallengeDigest === stateDigest
          ? this.appendHistory({ ...latest, updatedAt: eventAt, pendingChallengeDigest: undefined, pendingOperation: undefined, pendingChallengeExpiresAt: undefined }, 'authorization_failed', eventAt)
          : latest).catch(() => current);
      }
      if (cause instanceof PluginAccountError) throw cause;
      throw new PluginAccountError(502, 'authorization_failed', 'Der Anmeldedienst konnte die Kontoverbindung nicht bestätigen. Bitte starte den Vorgang erneut.');
    }
  }

  /** Resolve fresh account rights. Any adapter outage or race denies access. */
  async resolveAuthority(subject: string): Promise<PluginAccountAuthority> {
    const status = await this.status(subject);
    if (status.status === 'unavailable') throw new PluginAccountError(503, 'account_authority_unavailable', 'Die persönliche Kontoberechtigung kann aktuell nicht geprüft werden.');
    if (status.status !== 'linked') throw new PluginAccountError(403, 'account_not_linked', 'Für diesen Dienst ist kein aktives persönliches Konto verbunden.');
    const adapter = this.adapterRequired();
    let inspection: PluginAccountAdapterInspection;
    try { inspection = this.normalizeInspection(await this.withAdapterTimeout((signal) => adapter.inspect({ ...this.context(subject), signal }))); }
    catch { throw new PluginAccountError(503, 'account_authority_unavailable', 'Die persönliche Kontoberechtigung kann aktuell nicht geprüft werden.'); }
    if (inspection.status !== 'active' || !inspection.projection) {
      await this.status(subject);
      throw new PluginAccountError(403, 'account_authority_changed', 'Die persönliche Kontoberechtigung ist abgelaufen oder wurde widerrufen.');
    }
    const normalizedExpiry = this.normalizeExpiry(inspection.expiresAt);
    const latest = await this.readState(this.subjectDigest(subject));
    if (latest.status !== 'linked' || latest.authorityRevision !== status.authorityRevision || latest.adapterAuthorityRevision !== inspection.authorityRevision || latest.expiresAt !== normalizedExpiry) {
      throw new PluginAccountError(409, 'account_authority_changed', 'Die persönliche Kontoberechtigung wurde parallel geändert. Bitte lade den Status neu.');
    }
    return {
      installationId: this.options.installationId,
      authorityRevision: latest.authorityRevision,
      expiresAt: latest.expiresAt,
      projection: normalizeProjection(inspection.projection),
    };
  }

  /** Re-resolve authority immediately before a sensitive invocation. */
  async assertCurrent(subject: string, expectedAuthorityRevision: number): Promise<PluginAccountAuthority> {
    if (!Number.isSafeInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 0) throw new PluginAccountError(400, 'invalid_revision', 'Ungültige Version der Kontoberechtigung.');
    const current = await this.resolveAuthority(subject);
    if (current.authorityRevision !== expectedAuthorityRevision) throw new PluginAccountError(409, 'account_authority_changed', 'Die persönliche Kontoberechtigung hat sich geändert. Bitte wiederhole die Aktion nach erneuter Prüfung.');
    return current;
  }

  /** Invalidate host authority by CAS before trying provider-side revocation. */
  async disconnect(subject: string, expectedAuthorityRevision: number): Promise<PluginAccountRevokeResult> {
    const subjectDigest = this.subjectDigest(subject);
    if (!Number.isSafeInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 0) throw new PluginAccountError(400, 'invalid_revision', 'Ungültige Version der Kontoberechtigung.');
    const current = await this.readState(subjectDigest);
    if (current.authorityRevision !== expectedAuthorityRevision) throw new PluginAccountError(409, 'account_changed', 'Der Kontostatus wurde geändert. Bitte lade ihn neu, bevor du die Verbindung trennst.');
    if (current.status !== 'linked' && current.status !== 'expired') throw new PluginAccountError(409, 'account_not_linked', 'Es ist keine aktive Kontoverbindung vorhanden.');
    const revokedAt = asIso(this.now());
    const disconnected = await this.mutateState(subjectDigest, (latest) => {
      if (latest.authorityRevision !== expectedAuthorityRevision || latest.status !== current.status) throw new PluginAccountError(409, 'account_changed', 'Der Kontostatus wurde parallel geändert. Bitte lade ihn neu.');
      const revision = latest.authorityRevision + 1;
      return this.appendHistory({
        ...latest,
        status: 'disconnected',
        authorityRevision: revision,
        updatedAt: revokedAt,
        pendingChallengeDigest: undefined,
        pendingOperation: undefined,
        pendingChallengeExpiresAt: undefined,
        revocationStatus: this.options.adapter || latest.adapterAuthorityRevision !== null ? 'pending' : 'confirmed',
      }, 'disconnect', revokedAt, revision);
    });
    const adapter = this.options.adapter;
    if (!adapter) return { authorityRevision: disconnected.authorityRevision, status: 'disconnected', revocationStatus: disconnected.revocationStatus === 'pending' ? 'pending' : 'confirmed' };

    try {
      await this.withAdapterTimeout((signal) => adapter.revoke({ ...this.context(subject), expectedAdapterRevision: disconnected.adapterAuthorityRevision, signal }));
      const confirmedAt = asIso(this.now());
      const finalState = await this.mutateState(subjectDigest, (latest) => latest.status === 'disconnected' && latest.authorityRevision === disconnected.authorityRevision
        ? this.appendHistory({ ...latest, revocationStatus: 'confirmed', updatedAt: confirmedAt }, 'revocation_confirmed', confirmedAt)
        : latest);
      return { authorityRevision: finalState.authorityRevision, status: 'disconnected', revocationStatus: finalState.revocationStatus === 'pending' ? 'pending' : 'confirmed' };
    } catch {
      return { authorityRevision: disconnected.authorityRevision, status: 'disconnected', revocationStatus: 'pending' };
    }
  }

  /** Retry external cleanup without restoring local authority. */
  async retryRevocation(subject: string, expectedAuthorityRevision: number): Promise<PluginAccountRevokeResult> {
    const subjectDigest = this.subjectDigest(subject);
    if (!Number.isSafeInteger(expectedAuthorityRevision) || expectedAuthorityRevision < 0) throw new PluginAccountError(400, 'invalid_revision', 'Ungültige Version der Kontoberechtigung.');
    const state = await this.readState(subjectDigest);
    if (state.authorityRevision !== expectedAuthorityRevision) throw new PluginAccountError(409, 'account_changed', 'Der Kontostatus wurde geändert. Bitte lade ihn neu.');
    if (state.status !== 'disconnected' || state.revocationStatus !== 'pending') throw new PluginAccountError(409, 'revocation_not_pending', 'Für dieses Konto ist kein ausstehender Widerruf vorhanden.');
    const adapter = this.adapterRequired();
    try {
      await this.withAdapterTimeout((signal) => adapter.revoke({ ...this.context(subject), expectedAdapterRevision: state.adapterAuthorityRevision, signal }));
      const at = asIso(this.now());
      const finalState = await this.mutateState(subjectDigest, (latest) => latest.status === 'disconnected' && latest.authorityRevision === expectedAuthorityRevision
        ? this.appendHistory({ ...latest, revocationStatus: 'confirmed', updatedAt: at }, 'revocation_confirmed', at)
        : latest);
      return { authorityRevision: finalState.authorityRevision, status: 'disconnected', revocationStatus: finalState.revocationStatus === 'pending' ? 'pending' : 'confirmed' };
    } catch {
      return { authorityRevision: state.authorityRevision, status: 'disconnected', revocationStatus: 'pending' };
    }
  }
}
