import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JsonStore } from '@hasi/state';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { IdentityProvider, OidcIdentityMapper, Persona, VerifiedOidcIdentity } from './identity.js';

const ALLOWED_ALGORITHMS = ['RS256', 'ES256'] as const;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_TRANSACTION_LIFETIME_MS = 15 * 60 * 1000;
const MAX_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 60;
const OIDC_SCOPE = 'openid';
const STATIC_RETURN_PATHS = new Set(['/', '/admin', '/bookings']);

/** Exact same-origin routes the app shell may resume after authentication. */
export function isAllowedOidcReturnTo(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && (STATIC_RETURN_PATHS.has(value) || /^\/sources\/(?:svc|int)-[0-9]{3}$/u.test(value));
}

export interface OidcTrustedOrigins {
  authorization: string;
  token: string;
  jwks: string;
}

export interface OidcIdentityProviderOptions {
  /** HTTP endpoints are accepted only in explicit test mode and only on loopback. */
  mode: 'development' | 'test' | 'production';
  issuer: string;
  clientId: string;
  redirectUri: string;
  store: JsonStore;
  mapIdentity: OidcIdentityMapper;
  /** Production authority lookup, called for every session resolution with the stable issuer/subject key. */
  resolveAuthority?: (subject: string) => Persona | undefined | Promise<Persona | undefined>;
  /** Origins are static server configuration. Omitted values are pinned to the issuer origin. */
  trustedOrigins?: Partial<OidcTrustedOrigins>;
  /** Server-only confidential-client credential. */
  clientSecret?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  requestTimeoutMs?: number;
  transactionLifetimeMs?: number;
  sessionLifetimeMs?: number;
  maxIdTokenAgeSeconds?: number;
}

export interface AuthorizationStart {
  url: string;
  transactionId: string;
}

export interface AuthorizationCompletion {
  /** Opaque HASI session token. The upstream tokens are never returned. */
  token: string;
  user: Persona;
  /** Server-validated local application path bound to the consumed transaction. */
  returnTo: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  jwksUri: URL;
}

interface AuthorizationTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'processing';
}

interface StoredSession {
  expiresAt: number;
  user: Persona;
}

export class OidcAuthenticationError extends Error {
  constructor(message = 'Authentication could not be completed.') {
    super(message);
    this.name = 'OidcAuthenticationError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function secretEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

function parseAbsoluteUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError(`${label} is not an allowed URL.`);
  }
  return url;
}

function assertSecureUrl(url: URL, mode: OidcIdentityProviderOptions['mode'], label: string): void {
  const httpLoopback = mode === 'test' && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !httpLoopback) {
    throw new TypeError(`${label} must use HTTPS outside explicit loopback test mode.`);
  }
}

function parseOrigin(value: string, mode: OidcIdentityProviderOptions['mode'], label: string): string {
  const url = parseAbsoluteUrl(value, label);
  if (url.pathname !== '/' || url.search) throw new TypeError(`${label} must be an origin.`);
  assertSecureUrl(url, mode, label);
  return url.origin;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OidcAuthenticationError('The identity provider returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function checkPersona(value: unknown, subject: string): Persona {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OidcAuthenticationError('The configured identity mapping returned an invalid account.');
  }
  const candidate = value as Record<string, unknown>;
  const actor = candidate.actor;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 ||
      typeof candidate.displayName !== 'string' || candidate.displayName.length === 0 ||
      typeof candidate.role !== 'string' || !['student', 'employee', 'admin'].includes(candidate.role) ||
      typeof actor !== 'object' || actor === null || Array.isArray(actor)) {
    throw new OidcAuthenticationError('The configured identity mapping returned an invalid account.');
  }
  const actorCandidate = actor as Record<string, unknown>;
  if (typeof actorCandidate.subject !== 'string' || actorCandidate.subject.length === 0 ||
      (actorCandidate.customerId !== undefined && (typeof actorCandidate.customerId !== 'string' || actorCandidate.customerId.length === 0)) ||
      (actorCandidate.resourceIds !== undefined && (!Array.isArray(actorCandidate.resourceIds) || !actorCandidate.resourceIds.every(item => typeof item === 'string'))) ||
      !Array.isArray(actorCandidate.permissions) || !actorCandidate.permissions.every(item => typeof item === 'string')) {
    throw new OidcAuthenticationError('The configured identity mapping returned an invalid account.');
  }
  const persona = structuredClone(value) as Persona;
  return {
    ...persona,
    // The browser uses public IDs to scope persistent workspace data. Never let
    // a mapper's template/local ID merge separate verified upstream identities.
    id: subject,
    role: candidate.role as Persona['role'],
    actor: { ...persona.actor, subject },
  };
}

async function readBoundedJson(response: Response, byteLimit: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > byteLimit) {
      throw new OidcAuthenticationError('The identity provider response exceeded its size limit.');
    }
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|jwk-set\+json)(?:\s*;|$)/iu.test(contentType)) {
    throw new OidcAuthenticationError('The identity provider returned an invalid response.');
  }
  if (!response.body) throw new OidcAuthenticationError('The identity provider returned an empty response.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        continue;
      }
      const chunk = result.value as Uint8Array;
      bytesRead += chunk.byteLength;
      if (bytesRead > byteLimit) {
        await reader.cancel();
        throw new OidcAuthenticationError('The identity provider response exceeded its size limit.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new OidcAuthenticationError('The identity provider returned invalid JSON.');
  }
}

export class OidcIdentityProvider implements IdentityProvider {
  private readonly issuer: string;
  private readonly issuerKey: string;
  private readonly issuerOrigin: string;
  private readonly trustedOrigins: OidcTrustedOrigins;
  private readonly redirectUri: string;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly transactionLifetimeMs: number;
  private readonly sessionLifetimeMs: number;
  private readonly maxIdTokenAgeSeconds: number;
  private discoveryPromise: Promise<DiscoveryDocument> | undefined;

  constructor(private readonly options: OidcIdentityProviderOptions) {
    if (!options.clientId || options.clientId.length > 512 || typeof options.mapIdentity !== 'function') {
      throw new TypeError('OIDC requires a client ID, durable store and operator identity mapping.');
    }
    if (options.mode === 'production' && typeof options.resolveAuthority !== 'function') {
      throw new TypeError('Production OIDC requires a current operator authority resolver.');
    }
    const issuerUrl = parseAbsoluteUrl(options.issuer, 'issuer');
    assertSecureUrl(issuerUrl, options.mode, 'issuer');
    if (issuerUrl.search || issuerUrl.pathname.endsWith('/.well-known/openid-configuration')) {
      throw new TypeError('issuer must be an OIDC issuer URL without query parameters.');
    }
    this.issuer = options.issuer;
    this.issuerOrigin = issuerUrl.origin;
    this.issuerKey = sha256(this.issuer).slice(0, 32);
    const originDefaults = this.issuerOrigin;
    this.trustedOrigins = {
      authorization: parseOrigin(options.trustedOrigins?.authorization ?? originDefaults, options.mode, 'authorization origin'),
      token: parseOrigin(options.trustedOrigins?.token ?? originDefaults, options.mode, 'token origin'),
      jwks: parseOrigin(options.trustedOrigins?.jwks ?? originDefaults, options.mode, 'JWKS origin'),
    };

    const redirect = parseAbsoluteUrl(options.redirectUri, 'redirect URI');
    assertSecureUrl(redirect, options.mode, 'redirect URI');
    if (redirect.search || redirect.pathname.length === 0) throw new TypeError('redirect URI must be fixed and must not contain a query.');
    this.redirectUri = options.redirectUri;
    this.clock = options.clock ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = this.boundedInteger(options.requestTimeoutMs ?? 5_000, 250, 30_000, 'request timeout');
    this.transactionLifetimeMs = this.boundedInteger(options.transactionLifetimeMs ?? 10 * 60_000, 30_000, MAX_TRANSACTION_LIFETIME_MS, 'transaction lifetime');
    this.sessionLifetimeMs = this.boundedInteger(options.sessionLifetimeMs ?? 8 * 60 * 60_000, 60_000, MAX_SESSION_LIFETIME_MS, 'session lifetime');
    this.maxIdTokenAgeSeconds = this.boundedInteger(options.maxIdTokenAgeSeconds ?? 600, 60, 3_600, 'ID token age');
    if (options.clientSecret !== undefined && (options.clientSecret.length === 0 || options.clientSecret.length > 4_096)) {
      throw new TypeError('clientSecret must be non-empty and bounded.');
    }
  }

  /** Starts an authorization-code flow and persists all PKCE/state material server-side. */
  async beginAuthorization(returnTo = '/'): Promise<AuthorizationStart> {
    if (!isAllowedOidcReturnTo(returnTo)) throw new OidcAuthenticationError('The requested return path is not allowed.');
    const discovery = await this.getDiscovery();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const transactionId = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const createdAt = this.now();
      const expiresAt = createdAt + this.transactionLifetimeMs;
      const transaction: AuthorizationTransaction = { state, nonce, verifier, returnTo, createdAt, expiresAt, status: 'pending' };
      if (!await this.options.store.compareAndSet(this.transactionKey(transactionId), null, transaction, expiresAt)) continue;

      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(discovery.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', this.options.clientId);
      url.searchParams.set('redirect_uri', this.redirectUri);
      url.searchParams.set('scope', OIDC_SCOPE);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { url: url.href, transactionId };
    }
    throw new OidcAuthenticationError('An authorization transaction could not be saved.');
  }

  /** Validates and consumes the browser transaction before exchanging the authorization code. */
  async completeAuthorization(input: { code: string; state: string; transactionId: string } | null | undefined): Promise<AuthorizationCompletion> {
    if (input === null || input === undefined || typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 4_096 ||
        typeof input.state !== 'string' || input.state.length === 0 || input.state.length > 256 ||
        typeof input.transactionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.transactionId)) {
      throw new OidcAuthenticationError('The authorization response is invalid.');
    }

    const key = this.transactionKey(input.transactionId);
    const current = await this.options.store.read(key);
    if (current === undefined) throw new OidcAuthenticationError('The authorization response is invalid or expired.');
    const transactionValue = current.value;
    if (typeof transactionValue !== 'object' || transactionValue === null || Array.isArray(transactionValue)) {
      throw new OidcAuthenticationError('The authorization response is invalid or expired.');
    }
    const transaction = transactionValue as Partial<AuthorizationTransaction>;
    const now = this.now();
    // Existing in-flight transactions from before return-path persistence resume
    // at `/`; new transactions always store an explicit allowlisted path.
    const returnTo = transaction.returnTo ?? '/';
    if (transaction.status !== 'pending' ||
        typeof transaction.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(transaction.state) ||
        typeof transaction.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(transaction.nonce) ||
        typeof transaction.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(transaction.verifier) ||
        typeof transaction.createdAt !== 'number' || !Number.isFinite(transaction.createdAt) || transaction.createdAt > now + CLOCK_TOLERANCE_SECONDS * 1_000 ||
        typeof transaction.expiresAt !== 'number' || !Number.isFinite(transaction.expiresAt) || transaction.expiresAt <= now ||
        transaction.expiresAt > transaction.createdAt + MAX_TRANSACTION_LIFETIME_MS ||
        !isAllowedOidcReturnTo(returnTo) ||
        !secretEquals(input.state, transaction.state)) {
      throw new OidcAuthenticationError('The authorization response is invalid or expired.');
    }
    const claimed: AuthorizationTransaction = { ...transaction, returnTo, status: 'processing' } as AuthorizationTransaction;
    if (!await this.options.store.compareAndSet(key, current.revision, claimed, transaction.expiresAt)) {
      throw new OidcAuthenticationError('The authorization response has already been used.');
    }

    const discovery = await this.getDiscovery();
    const tokenResponse = await this.requestJson(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: this.tokenRequestBody(input.code, transaction.verifier),
    }, MAX_TOKEN_RESPONSE_BYTES);
    const tokenDocument = asRecord(tokenResponse);
    if (typeof tokenDocument.id_token !== 'string' || tokenDocument.id_token.length === 0 || tokenDocument.id_token.length > 24 * 1024) {
      throw new OidcAuthenticationError('The identity provider did not return a valid ID token.');
    }

    const verified = await this.verifyIdToken(tokenDocument.id_token, transaction.nonce, discovery);
    let mapped: Persona;
    try {
      mapped = checkPersona(await this.options.mapIdentity(verified), this.stableSubject(verified.issuer, verified.subject));
    } catch (error) {
      if (error instanceof OidcAuthenticationError) throw error;
      throw new OidcAuthenticationError('The configured identity mapping could not create an account.');
    }
    const token = await this.createSession(mapped);
    return { token, user: structuredClone(mapped), returnTo };
  }

  /** Persona-ID login belongs to the explicit mock provider, never an OIDC session. */
  login(_id: string): never {
    throw new OidcAuthenticationError('Persona login is unavailable for OIDC identities.');
  }

  async resolve(token: string | undefined): Promise<Persona | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const record = await this.options.store.read(this.sessionKey(token));
    if (!record) return undefined;
    const session = record.value as Partial<StoredSession> | undefined;
    if (!session || typeof session.expiresAt !== 'number' || session.expiresAt <= this.now() || !session.user) {
      await this.options.store.delete(this.sessionKey(token));
      return undefined;
    }
    let sessionUser: Persona;
    try {
      sessionUser = checkPersona(session.user, this.stableSubjectFromActor(session.user));
    } catch {
      await this.options.store.delete(this.sessionKey(token));
      return undefined;
    }
    if (this.options.mode !== 'production') return sessionUser;
    return this.resolveCurrentAuthority(sessionUser.actor.subject);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token && /^[A-Za-z0-9_-]{43}$/u.test(token)) await this.options.store.delete(this.sessionKey(token));
  }

  private boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is outside its allowed bounds.`);
    return value;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) throw new OidcAuthenticationError('The server clock is unavailable.');
    return now;
  }

  private transactionKey(transactionId: string): string {
    return `oidc:${this.issuerKey}:transaction:${sha256(transactionId)}`;
  }

  private sessionKey(token: string): string {
    return `oidc:${this.issuerKey}:session:${sha256(token)}`;
  }

  private stableSubject(issuer: string, subject: string): string {
    return `oidc:${sha256(issuer)}:${sha256(subject)}`;
  }

  private stableSubjectFromActor(user: Persona): string {
    return user.actor.subject;
  }

  private async resolveCurrentAuthority(subject: string): Promise<Persona | undefined> {
    const resolver = this.options.resolveAuthority;
    if (typeof resolver !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => { resolve(undefined); }, this.requestTimeoutMs);
      });
      const current = await Promise.race([Promise.resolve().then(() => resolver(subject)), timeout]);
      return current === undefined ? undefined : checkPersona(current, subject);
    } catch {
      // A current-authority lookup error is an authorization denial for this request.
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private tokenRequestBody(code: string, verifier: string): URLSearchParams {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.options.clientId,
      code_verifier: verifier,
    });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    return body;
  }

  private async getDiscovery(): Promise<DiscoveryDocument> {
    this.discoveryPromise ??= this.loadDiscovery();
    try {
      return await this.discoveryPromise;
    } catch (error) {
      this.discoveryPromise = undefined;
      throw error;
    }
  }

  private async loadDiscovery(): Promise<DiscoveryDocument> {
    const discoveryUrl = `${this.issuer.replace(/\/+$/u, '')}/.well-known/openid-configuration`;
    const document = asRecord(await this.requestJson(new URL(discoveryUrl), { method: 'GET', headers: { accept: 'application/json' } }, MAX_JSON_BYTES));
    if (document.issuer !== this.issuer) throw new OidcAuthenticationError('The identity provider issuer does not match the configured issuer.');
    const authorizationEndpoint = this.pinnedEndpoint(document.authorization_endpoint, this.trustedOrigins.authorization, 'authorization endpoint');
    const tokenEndpoint = this.pinnedEndpoint(document.token_endpoint, this.trustedOrigins.token, 'token endpoint');
    const jwksUri = this.pinnedEndpoint(document.jwks_uri, this.trustedOrigins.jwks, 'JWKS URI');
    return { issuer: this.issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  }

  private pinnedEndpoint(value: unknown, pinnedOrigin: string, label: string): URL {
    if (typeof value !== 'string') throw new OidcAuthenticationError(`The identity provider ${label} is invalid.`);
    const url = parseAbsoluteUrl(value, label);
    assertSecureUrl(url, this.options.mode, label);
    if (url.origin !== pinnedOrigin) throw new OidcAuthenticationError(`The identity provider ${label} is outside the configured origin pin.`);
    return url;
  }

  private async requestJson(url: URL, init: RequestInit, maxBytes: number): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OidcAuthenticationError('The identity provider request timed out.'));
      }, this.requestTimeoutMs);
    });
    const operation = (async () => {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new OidcAuthenticationError('The identity provider request failed.');
      }
      return readBoundedJson(response, maxBytes);
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      controller.abort();
      if (error instanceof OidcAuthenticationError) throw error;
      throw new OidcAuthenticationError('The identity provider request failed.');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async verifyIdToken(rawToken: string, expectedNonce: string, discovery: DiscoveryDocument): Promise<VerifiedOidcIdentity> {
    const jwksDocument = asRecord(await this.requestJson(discovery.jwksUri, { method: 'GET', headers: { accept: 'application/jwk-set+json, application/json' } }, MAX_JSON_BYTES));
    if (!Array.isArray(jwksDocument.keys) || jwksDocument.keys.length === 0 || jwksDocument.keys.length > 32) {
      throw new OidcAuthenticationError('The identity provider signing keys are invalid.');
    }
    try {
      const localJwks = createLocalJWKSet(jwksDocument as unknown as Parameters<typeof createLocalJWKSet>[0]);
      const result = await jwtVerify(rawToken, localJwks, {
        algorithms: [...ALLOWED_ALGORITHMS],
        issuer: this.issuer,
        audience: this.options.clientId,
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'],
        maxTokenAge: `${this.maxIdTokenAgeSeconds.toString()}s`,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.now()),
      });
      const payload = result.payload;
      const nowSeconds = Math.floor(this.now() / 1000);
      const issuedAt = payload.iat;
      const expiresAt = payload.exp;
      const audience = payload.aud;
      if (result.protectedHeader.alg !== 'RS256' && result.protectedHeader.alg !== 'ES256') {
        throw new OidcAuthenticationError('The identity provider used an unsupported signing algorithm.');
      }
      if (typeof payload.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/u.test(payload.sub) ||
          typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
          typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= nowSeconds - CLOCK_TOLERANCE_SECONDS ||
          expiresAt <= issuedAt || expiresAt - issuedAt > 3_600 ||
          (Array.isArray(audience) && audience.length > 1 && payload.azp !== this.options.clientId) ||
          (payload.azp !== undefined && payload.azp !== this.options.clientId)) {
        throw new OidcAuthenticationError('The identity provider returned unsafe ID token claims.');
      }
      if (typeof payload.nonce !== 'string' || !secretEquals(payload.nonce, expectedNonce)) {
        throw new OidcAuthenticationError('The ID token nonce does not match the authorization request.');
      }
      if (payload.iss !== discovery.issuer) throw new OidcAuthenticationError('The ID token issuer is invalid.');
      return { issuer: discovery.issuer, subject: payload.sub, claims: payload };
    } catch (error) {
      if (error instanceof OidcAuthenticationError) throw error;
      throw new OidcAuthenticationError('The ID token could not be verified.');
    }
  }

  private async createSession(user: Persona): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = this.now() + this.sessionLifetimeMs;
      const session: StoredSession = { expiresAt, user };
      if (await this.options.store.compareAndSet(this.sessionKey(token), null, session, expiresAt)) return token;
    }
    throw new OidcAuthenticationError('A HASI session could not be created.');
  }
}
