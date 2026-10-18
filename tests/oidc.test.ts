import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import type { Persona } from '../apps/api/src/identity.js';
import { createApi } from '../apps/api/src/index.js';
import { PluginRegistry } from '../apps/api/src/registry.js';
import { isAllowedOidcReturnTo, OidcAuthenticationError, OidcIdentityProvider, type OidcIdentityProviderOptions } from '../apps/api/src/oidc.js';
import { startTestIdp, type TestIdpServer, type TestIdpTokenOverrides } from '../apps/api/src/test-idp.js';

const CLIENT_ID = 'hasi-oidc-tests';
const REDIRECT_URI = 'http://127.0.0.1:43210/api/oidc/callback';
const makePersona = (id = 'mapped-user'): Persona => ({
  id,
  displayName: 'Mapped test user',
  role: 'student',
  actor: { subject: 'discarded-upstream-field', permissions: [] },
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

interface Harness {
  idp: TestIdpServer;
  provider: OidcIdentityProvider;
  store: JsonStore;
  requests: URLSearchParams[];
  upstreamAccessTokens: string[];
}

async function createHarness(options: {
  tokenOverrides?: TestIdpTokenOverrides;
  clock?: () => number;
  store?: JsonStore;
  sessionLifetimeMs?: number;
  redirectUri?: string;
  subject?: string;
  mappedId?: string;
  port?: number;
  trustedOrigins?: OidcIdentityProviderOptions['trustedOrigins'];
} = {}): Promise<Harness> {
  const redirectUri = options.redirectUri ?? REDIRECT_URI;
  const idp = await startTestIdp({
    mode: 'test',
    clientId: CLIENT_ID,
    redirectUri,
    ...(options.subject ? { subject: options.subject } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.tokenOverrides ? { tokenOverrides: options.tokenOverrides } : {}),
  });
  const store = options.store ?? new MemoryJsonStore(`oidc-test-${randomUUID()}`);
  const requests: URLSearchParams[] = [];
  const upstreamAccessTokens: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/token' && init?.body instanceof URLSearchParams) requests.push(new URLSearchParams(init.body));
    const response = await fetch(input, init);
    if (url.pathname === '/token' && response.ok) {
      const tokenResponse = await response.clone().json() as { access_token?: unknown };
      if (typeof tokenResponse.access_token === 'string') upstreamAccessTokens.push(tokenResponse.access_token);
    }
    return response;
  };
  const provider = new OidcIdentityProvider({
    mode: 'test',
    issuer: idp.issuer,
    clientId: CLIENT_ID,
    redirectUri,
    store,
    mapIdentity: ({ subject }) => makePersona(options.mappedId ?? `mapped-${subject}`),
    fetch: fetcher,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.sessionLifetimeMs ? { sessionLifetimeMs: options.sessionLifetimeMs } : {}),
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
  });
  return { idp, provider, store, requests, upstreamAccessTokens };
}

async function authorize(provider: OidcIdentityProvider, returnTo?: string): Promise<{ transactionId: string; code: string; state: string }> {
  const start = await provider.beginAuthorization(returnTo);
  const authorizationUrl = new URL(start.url);
  expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(authorizationUrl.searchParams.get('scope')).toBe('openid');
  const response = await fetch(start.url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get('location')!);
  return {
    transactionId: start.transactionId,
    code: callback.searchParams.get('code')!,
    state: callback.searchParams.get('state')!,
  };
}

const activeIdps: TestIdpServer[] = [];
afterEach(async () => {
  await Promise.all(activeIdps.splice(0).map(idp => idp.close()));
});

describe('OIDC authorization-code identity boundary', () => {
  it('allows only fixed local return paths and the bounded source route form', () => {
    for (const path of ['/', '/admin', '/bookings', '/sources/svc-123', '/sources/int-007']) {
      expect(isAllowedOidcReturnTo(path)).toBe(true);
    }
    for (const path of ['//evil.invalid', 'https://evil.invalid/path', '/%2F%2Fevil.invalid', '/unknown', '/admin?next=/']) {
      expect(isAllowedOidcReturnTo(path)).toBe(false);
    }
  });

  it('runs discovery, authorization-code + PKCE, verified projection and persistent sessions', async () => {
    const harness = await createHarness();
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    const result = await harness.provider.completeAuthorization(callback);

    expect(result.user.id).toBe(result.user.actor.subject);
    expect(result.user.id).toMatch(/^oidc:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u);
    expect(result.user.actor.customerId).toBeUndefined();
    expect(result.user.actor.resourceIds).toBeUndefined();
    expect(result.user.actor.permissions).toEqual([]);
    expect(result.user.actor.subject).toMatch(/^oidc:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u);
    expect(result.token).not.toBe(harness.upstreamAccessTokens[0]);
    expect(await harness.provider.resolve(result.token)).toEqual(result.user);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(harness.requests[0]?.get('client_secret')).toBeNull();

    const capturedRequest = harness.requests[0];
    if (capturedRequest === undefined) throw new Error('The token request was not captured.');
    const replay = await fetch(new URL('/token', harness.idp.issuer), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: capturedRequest,
    });
    expect(replay.status).toBe(400);
    expect(await harness.provider.resolve(result.token)).toEqual(result.user);
    await harness.provider.logout(result.token);
    expect(await harness.provider.resolve(result.token)).toBeUndefined();
    expect(() => harness.provider.login('admin')).toThrow(OidcAuthenticationError);
  });

  it('rejects forged state before exchange and consumes a valid state only once', async () => {
    const harness = await createHarness();
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    const forgedState = `${callback.state.startsWith('A') ? 'B' : 'A'}${callback.state.slice(1)}`;
    await expect(harness.provider.completeAuthorization({ ...callback, state: forgedState })).rejects.toThrow(OidcAuthenticationError);
    expect(harness.requests).toHaveLength(0);

    const result = await harness.provider.completeAuthorization(callback);
    expect(await harness.provider.resolve(result.token)).toBeDefined();
    await expect(harness.provider.completeAuthorization(callback)).rejects.toThrow(OidcAuthenticationError);
    expect(harness.requests).toHaveLength(1);
  });

  it('binds an approved return path to the consumed server-side OIDC transaction', async () => {
    const harness = await createHarness();
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider, '/admin');
    const result = await harness.provider.completeAuthorization(callback);
    expect(result.returnTo).toBe('/admin');

    const defaultCallback = await authorize(harness.provider);
    const defaultResult = await harness.provider.completeAuthorization(defaultCallback);
    expect(defaultResult.returnTo).toBe('/');
  });

  it('isolates public IDs by verified issuer and subject when a mapper reuses a template ID', async () => {
    const store = new MemoryJsonStore(`oidc-public-id-${randomUUID()}`);
    const loginWithSubject = async (subject: string, port?: number) => {
      const harness = await createHarness({ subject, mappedId: 'employee-template', store, ...(port !== undefined ? { port } : {}) });
      try {
        const callback = await authorize(harness.provider);
        const result = await harness.provider.completeAuthorization(callback);
        return { issuer: harness.idp.issuer, user: result.user };
      } finally {
        await harness.idp.close();
      }
    };

    const firstLogin = await loginWithSubject('upstream-employee-a');
    const issuerPort = Number(new URL(firstLogin.issuer).port);
    const secondLogin = await loginWithSubject('upstream-employee-b', issuerPort);
    const repeatLogin = await loginWithSubject('upstream-employee-a', issuerPort);

    expect(secondLogin.issuer).toBe(firstLogin.issuer);
    expect(repeatLogin.issuer).toBe(firstLogin.issuer);
    expect(firstLogin.user.id).not.toBe('employee-template');
    expect(secondLogin.user.id).not.toBe('employee-template');
    expect(firstLogin.user.id).not.toBe(secondLogin.user.id);
    expect(repeatLogin.user.id).toBe(firstLogin.user.id);
    expect(firstLogin.user.id).toBe(firstLogin.user.actor.subject);
    expect(secondLogin.user.id).toBe(secondLogin.user.actor.subject);
  });

  it.each(['//evil.invalid', 'https://evil.invalid/path', '/%2F%2Fevil.invalid', '/unknown'])('rejects unsafe login return paths at the API boundary: %s', async returnTo => {
    const harness = await createHarness({ redirectUri: 'http://127.0.0.1:43210/api/auth/callback' });
    activeIdps.push(harness.idp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const api = await createApi({
      mode: 'test',
      registry: new PluginRegistry(privateKey),
      identity: harness.provider,
      store: harness.store,
      origin: 'http://127.0.0.1:3000',
      allowedHosts: ['127.0.0.1'],
    });
    try {
      const query = new URLSearchParams({ returnTo });
      const response = await api.inject({ method: 'GET', url: `/api/auth/login?${query.toString()}`, headers: { host: '127.0.0.1' } });
      expect(response.statusCode).toBe(400);
    } finally {
      await api.close();
    }
  });

  it('returns to /admin after the full browser-style login callback flow', async () => {
    const harness = await createHarness({ redirectUri: 'http://127.0.0.1:43210/api/auth/callback' });
    activeIdps.push(harness.idp);
    const { privateKey } = generateKeyPairSync('ed25519');
    const api = await createApi({
      mode: 'test',
      registry: new PluginRegistry(privateKey),
      identity: harness.provider,
      store: harness.store,
      origin: 'http://127.0.0.1:3000',
      allowedHosts: ['127.0.0.1'],
    });
    try {
      const login = await api.inject({
        method: 'GET',
        url: '/api/auth/login?returnTo=%2Fadmin',
        headers: { host: '127.0.0.1' },
      });
      expect(login.statusCode).toBe(302);
      const authorizationUrl = login.headers.location;
      if (typeof authorizationUrl !== 'string') throw new Error('The login route did not return an authorization URL.');
      const transactionCookie = login.headers['set-cookie'];
      const cookieHeader = Array.isArray(transactionCookie) ? transactionCookie.join(';') : transactionCookie;
      const transactionId = cookieHeader?.match(/(?:^|[,; ])hasi-oidc-transaction=([^;,]+)/u)?.[1];
      if (transactionId === undefined) throw new Error('The login route did not set an OIDC transaction cookie.');

      const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
      expect(authorizationResponse.status).toBe(302);
      const callbackUrl = new URL(authorizationResponse.headers.get('location')!);
      const callback = await api.inject({
        method: 'GET',
        url: `${callbackUrl.pathname}${callbackUrl.search}`,
        headers: { host: '127.0.0.1', cookie: `hasi-oidc-transaction=${transactionId}` },
      });

      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('http://127.0.0.1:3000/admin');
      const sessionCookies = callback.headers['set-cookie'];
      const sessionCookieHeaders = Array.isArray(sessionCookies) ? sessionCookies : [sessionCookies ?? ''];
      expect(sessionCookieHeaders.some(cookie => cookie.startsWith('hasi-session='))).toBe(true);
    } finally {
      await api.close();
    }
  });

  it('consumes a transaction before exchange and rejects a forged authorization code', async () => {
    const harness = await createHarness();
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    const forgedCode = `${callback.code.startsWith('A') ? 'B' : 'A'}${callback.code.slice(1)}`;
    await expect(harness.provider.completeAuthorization({ ...callback, code: forgedCode })).rejects.toThrow(OidcAuthenticationError);
    expect(harness.requests).toHaveLength(1);
    expect(await harness.provider.resolve(undefined)).toBeUndefined();
    await expect(harness.provider.completeAuthorization(callback)).rejects.toThrow(OidcAuthenticationError);
    expect(harness.requests).toHaveLength(1);
  });

  const invalidClaimCases: [string, TestIdpTokenOverrides][] = [
    ['nonce', { nonce: 'forged-nonce-value-000000000000000000000000000' }],
    ['issuer', { issuer: 'http://127.0.0.1:9' }],
    ['audience', { audience: 'another-client' }],
    ['ambiguous audience without azp', { audience: [CLIENT_ID, 'another-client'] }],
  ];
  it.each(invalidClaimCases)('rejects a signed ID token with invalid %s claims', async (_label, tokenOverrides) => {
    const harness = await createHarness({ tokenOverrides });
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    await expect(harness.provider.completeAuthorization(callback)).rejects.toThrow(OidcAuthenticationError);
  });

  const invalidTimeCases: [string, TestIdpTokenOverrides][] = [
    ['expired', { issuedAt: Math.floor(Date.now() / 1000) - 3_000, expiresAt: Math.floor(Date.now() / 1000) - 2_900 }],
    ['future issued', { issuedAt: Math.floor(Date.now() / 1000) + 120, expiresAt: Math.floor(Date.now() / 1000) + 300 }],
    ['long-lived', { issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 3_601 }],
  ];
  it.each(invalidTimeCases)('rejects an ID token with unsafe %s timestamps', async (_label, tokenOverrides) => {
    const harness = await createHarness({ tokenOverrides });
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    await expect(harness.provider.completeAuthorization(callback)).rejects.toThrow(OidcAuthenticationError);
  });

  it('supports transactions across provider instances using the shared durable store and expires sessions', async () => {
    let now = Date.now();
    const store = new MemoryJsonStore(`oidc-test-${randomUUID()}`, { clock: () => now });
    const harness = await createHarness({ clock: () => now, store, sessionLifetimeMs: 60_000 });
    activeIdps.push(harness.idp);
    const secondProvider = new OidcIdentityProvider({
      mode: 'test', issuer: harness.idp.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      store, clock: () => now, sessionLifetimeMs: 60_000,
      mapIdentity: ({ subject }) => makePersona(`mapped-${subject}`),
    });
    const callback = await authorize(harness.provider);
    const result = await secondProvider.completeAuthorization(callback);
    expect(await harness.provider.resolve(result.token)).toEqual(result.user);
    now += 60_001;
    expect(await harness.provider.resolve(result.token)).toBeUndefined();
  });

  it('requires production authority resolution and applies role and permission revocation on every session resolve', async () => {
    const issuer = 'https://idp.example.test';
    const store = new MemoryJsonStore(`oidc-authority-${randomUUID()}`);
    const productionOptions: OidcIdentityProviderOptions = {
      mode: 'production',
      issuer,
      clientId: CLIENT_ID,
      redirectUri: 'https://hasi.example.test/api/oidc/callback',
      store,
      mapIdentity: ({ subject }) => makePersona(subject),
    };
    expect(() => new OidcIdentityProvider(productionOptions)).toThrow(TypeError);

    const upstreamSubject = 'institution-account-42';
    const stableSubject = `oidc:${sha256(issuer)}:${sha256(upstreamSubject)}`;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 60 * 60_000;
    const issuerKey = sha256(issuer).slice(0, 32);
    const sessionKey = `oidc:${issuerKey}:session:${sha256(token)}`;
    const savedPersona = makePersona('login-snapshot');
    savedPersona.actor.subject = stableSubject;
    expect(await store.compareAndSet(sessionKey, null, { expiresAt, user: savedPersona }, expiresAt)).toBe(true);

    let authority: Persona | undefined = {
      id: 'current-user',
      displayName: 'Current user',
      role: 'admin',
      actor: { subject: 'ignored-callback-subject', permissions: ['rooms:execute', 'plugins:manage'] },
    };
    let authorityResolver: (subject: string) => Persona | undefined | Promise<Persona | undefined> = () => authority;
    const resolvedSubjects: string[] = [];
    const provider = new OidcIdentityProvider({
      ...productionOptions,
      requestTimeoutMs: 250,
      resolveAuthority: subject => {
        resolvedSubjects.push(subject);
        return authorityResolver(subject);
      },
    });

    expect(await provider.resolve(token)).toMatchObject({
      id: stableSubject,
      role: 'admin',
      actor: { subject: stableSubject, permissions: ['rooms:execute', 'plugins:manage'] },
    });
    authority = {
      id: 'downgraded-user',
      displayName: 'Downgraded user',
      role: 'student',
      actor: { subject: 'ignored-callback-subject', permissions: ['knowledge:read'] },
    };
    expect(await provider.resolve(token)).toMatchObject({
      id: stableSubject,
      role: 'student',
      actor: { subject: stableSubject, permissions: ['knowledge:read'] },
    });
    expect(resolvedSubjects).toEqual([stableSubject, stableSubject]);

    authority = undefined;
    expect(await provider.resolve(token)).toBeUndefined();
    authorityResolver = () => Promise.reject(new Error('authority store unavailable'));
    expect(await provider.resolve(token)).toBeUndefined();
    authorityResolver = () => new Promise<Persona | undefined>(() => undefined);
    expect(await provider.resolve(token)).toBeUndefined();
  });

  it('rejects expired state before contacting the token endpoint', async () => {
    let now = Date.now();
    const harness = await createHarness({ clock: () => now });
    activeIdps.push(harness.idp);
    const callback = await authorize(harness.provider);
    now += 10 * 60_000 + 1;
    await expect(harness.provider.completeAuthorization(callback)).rejects.toThrow(OidcAuthenticationError);
    expect(harness.requests).toHaveLength(0);
  });

  it('rejects unpinned discovery endpoints and insecure non-test origins', async () => {
    const idp = await startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
    activeIdps.push(idp);
    const unpinned = new OidcIdentityProvider({
      mode: 'test', issuer: idp.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      store: new MemoryJsonStore(`oidc-test-${randomUUID()}`), mapIdentity: () => makePersona(),
      trustedOrigins: { jwks: 'http://127.0.0.1:9' },
    });
    await expect(unpinned.beginAuthorization()).rejects.toThrow(OidcAuthenticationError);
    expect(() => new OidcIdentityProvider({
      mode: 'development', issuer: idp.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
      store: new MemoryJsonStore(`oidc-test-${randomUUID()}`), mapIdentity: () => makePersona(),
    })).toThrow(TypeError);
    await expect(startTestIdp({ mode: 'production', clientId: CLIENT_ID, redirectUri: REDIRECT_URI })).rejects.toThrow();
    await expect(startTestIdp({ mode: 'development', clientId: CLIENT_ID, redirectUri: REDIRECT_URI })).rejects.toThrow();
  });

  it('bounds discovery responses and timeouts while hiding upstream error details', async () => {
    const base = {
      mode: 'test' as const,
      issuer: 'https://idp.example.test',
      clientId: CLIENT_ID,
      redirectUri: 'https://hasi.example.test/api/oidc/callback',
      store: new MemoryJsonStore(`oidc-test-${randomUUID()}`),
      mapIdentity: () => makePersona(),
    };
    const oversized = new OidcIdentityProvider({
      ...base,
      fetch: () => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(70 * 1_024) } })),
    });
    await expect(oversized.beginAuthorization()).rejects.toThrow('size limit');

    const secretMarker = 'upstream-private-detail';
    const errorResponse = new OidcIdentityProvider({
      ...base,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ error: secretMarker }), { status: 502, headers: { 'content-type': 'application/json' } })),
    });
    const upstreamError = await errorResponse.beginAuthorization().catch((error: unknown) => error instanceof Error ? error : new Error('unexpected'));
    expect(upstreamError).toBeInstanceOf(OidcAuthenticationError);
    if (!(upstreamError instanceof Error)) throw new Error('Expected an authentication error');
    expect(upstreamError.message).not.toContain(secretMarker);

    const timeout = new OidcIdentityProvider({
      ...base,
      requestTimeoutMs: 250,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new Error(secretMarker));
        else signal?.addEventListener('abort', () => { reject(new Error(secretMarker)); }, { once: true });
      }),
    });
    const timeoutError = await timeout.beginAuthorization().catch((error: unknown) => error instanceof Error ? error : new Error('unexpected'));
    expect(timeoutError).toBeInstanceOf(OidcAuthenticationError);
    if (!(timeoutError instanceof Error)) throw new Error('Expected a timeout error');
    expect(timeoutError.message).not.toContain(secretMarker);
  });
});
