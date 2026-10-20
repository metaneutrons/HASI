import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TLS_KEY_BYTES = 64 * 1024;
const MAX_TLS_CERT_BYTES = 256 * 1024;
const AUTH_CODE_LIFETIME_MS = 60_000;
const MAX_TEST_SUBJECT_CHOICES = 4;
const MAX_TEST_SUBJECT_ID_LENGTH = 128;
const MAX_TEST_SUBJECT_LABEL_BYTES = 256;

export interface TestIdpTokenOverrides {
  issuer?: string;
  audience?: string | string[];
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
}

export type TestIdpRequiredClaim = 'iss' | 'sub' | 'aud' | 'exp' | 'iat' | 'nonce';

export interface TestIdpTlsOptions {
  readonly key: Buffer | string;
  readonly cert: Buffer | string;
}

export interface TestIdpOptions {
  /** Must be explicitly set to test. This server cannot be started in development or production. */
  mode: 'development' | 'test' | 'production';
  clientId: string;
  redirectUri: string;
  subject?: string;
  subjects?: readonly { readonly subject: string; readonly label: string }[];
  port?: number;
  host?: '127.0.0.1' | '::1';
  clock?: () => number;
  tokenOverrides?: TestIdpTokenOverrides;
  /** Test-only server fixture control for signing an ID token without one required claim. */
  omitClaim?: TestIdpRequiredClaim;
  /** Constructor-only TLS material for trusted local HTTPS qualification. */
  tls?: TestIdpTlsOptions;
}

export interface TestIdpServer {
  issuer: string;
  clientId: string;
  redirectUri: string;
  close(): Promise<void>;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  subject: string;
  expiresAt: number;
  used: boolean;
}

function respond(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(serialized), ...headers });
  response.end(serialized);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1';
}

function copyTestSubjects(options: TestIdpOptions): readonly { readonly subject: string; readonly label: string }[] | undefined {
  const configuredSubjects: unknown = options.subjects;
  if (configuredSubjects === undefined) return undefined;
  if (options.subject !== undefined) throw new TypeError('Fixed and selectable test identities cannot be configured together.');
  if (!Array.isArray(configuredSubjects) || configuredSubjects.length === 0 || configuredSubjects.length > MAX_TEST_SUBJECT_CHOICES) {
    throw new TypeError(`Test identity choices must contain between one and ${MAX_TEST_SUBJECT_CHOICES.toString()} entries.`);
  }

  const seenSubjects = new Set<string>();
  const copiedSubjects = configuredSubjects.map((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Each test identity choice must contain only a subject and label.');
    }
    const choice = value as Record<string, unknown>;
    const keys = Object.keys(choice);
    if (keys.length !== 2 || !Object.hasOwn(choice, 'subject') || !Object.hasOwn(choice, 'label')) {
      throw new TypeError('Each test identity choice must contain only a subject and label.');
    }

    const { subject, label } = choice;
    if (typeof subject !== 'string' || subject.length > MAX_TEST_SUBJECT_ID_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(subject)) {
      throw new TypeError('A test identity subject is invalid.');
    }
    if (seenSubjects.has(subject)) throw new TypeError('Test identity subjects must be distinct.');
    const hasControlCharacter = typeof label === 'string' && Array.from(label).some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159));
    });
    if (typeof label !== 'string' || label.trim().length === 0 || Buffer.byteLength(label, 'utf8') > MAX_TEST_SUBJECT_LABEL_BYTES || hasControlCharacter) {
      throw new TypeError('A test identity label is invalid.');
    }
    seenSubjects.add(subject);
    return Object.freeze({ subject, label });
  });

  return Object.freeze(copiedSubjects);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function renderTestIdentityChoicePage(
  response: ServerResponse,
  params: URLSearchParams,
  subjects: readonly { readonly subject: string; readonly label: string }[],
  callbackOrigin: string,
): void {
  const validatedParameters: readonly [string, string][] = [
    ['response_type', 'code'],
    ['client_id', params.get('client_id') ?? ''],
    ['redirect_uri', params.get('redirect_uri') ?? ''],
    ['scope', params.get('scope') ?? ''],
    ['code_challenge_method', 'S256'],
    ['code_challenge', params.get('code_challenge') ?? ''],
    ['state', params.get('state') ?? ''],
    ['nonce', params.get('nonce') ?? ''],
  ];
  const hiddenFields = validatedParameters
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  const buttons = subjects
    .map(({ subject, label }) => `<button type="submit" name="test_subject" value="${escapeHtml(subject)}">${escapeHtml(label)}</button>`)
    .join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Choose a test identity</title></head><body><main><h1>Choose a synthetic test identity</h1><form method="get" action="/authorize">${hiddenFields}<fieldset><legend>Synthetic identities</legend>${buttons}</fieldset></form></main></body></html>`;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; base-uri 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'`,
    'content-length': Buffer.byteLength(html),
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}

function copyTlsMaterial(value: unknown): HttpsServerOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Test IdP TLS configuration must contain only a key and certificate.');
  }
  const input = value as TestIdpTlsOptions;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('key') || !keys.includes('cert')) {
    throw new TypeError('Test IdP TLS configuration must contain only a key and certificate.');
  }
  const copyField = (value: unknown, maxBytes: number, label: string): Buffer | string => {
    if (typeof value === 'string') {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes === 0 || bytes > maxBytes) throw new TypeError(`Test IdP TLS ${label} is invalid.`);
      return value;
    }
    if (!Buffer.isBuffer(value) || value.byteLength === 0 || value.byteLength > maxBytes) {
      throw new TypeError(`Test IdP TLS ${label} is invalid.`);
    }
    return Buffer.from(value);
  };
  return {
    key: copyField(input.key, MAX_TLS_KEY_BYTES, 'key'),
    cert: copyField(input.cert, MAX_TLS_CERT_BYTES, 'certificate'),
  };
}

function requestHostAllowed(request: IncomingMessage, bindHost: string): boolean {
  const header = request.headers.host;
  if (!header) return false;
  try {
    const parsed = new URL(`http://${header}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    return isLoopbackHost(hostname) && (hostname === bindHost || (bindHost === '127.0.0.1' && hostname === 'localhost'));
  } catch {
    return false;
  }
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new Error('bad_request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error('bad_request');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Starts a synthetic HTTP OIDC provider on loopback for protocol and boundary tests. */
export async function startTestIdp(options: TestIdpOptions): Promise<TestIdpServer> {
  if (options.mode !== 'test') throw new Error('The local test identity provider is available only in explicit test mode.');
  if (!options.clientId || options.clientId.length > 512 || !options.redirectUri) throw new TypeError('A client ID and redirect URI are required.');
  const testSubjects = copyTestSubjects(options);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) throw new TypeError('The test IdP port is invalid.');
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new TypeError('The test identity provider must bind to loopback.');
  const callback = new URL(options.redirectUri);
  if (!['http:', 'https:'].includes(callback.protocol) || !isLoopbackHost(callback.hostname.replace(/^\[|\]$/gu, '')) || callback.username || callback.password || callback.hash) {
    throw new TypeError('The test IdP requires an HTTP or HTTPS loopback callback URI.');
  }
  const tls = options.tls === undefined ? undefined : copyTlsMaterial(options.tls);

  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const keyId = randomBytes(12).toString('base64url');
  const publicJwk = await exportJWK(publicKey);
  const jwk = { ...publicJwk, kid: keyId, use: 'sig', alg: 'RS256' };
  const codes = new Map<string, AuthorizationCode>();
  const clock = options.clock ?? Date.now;
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) respond(response, 400, { error: 'invalid_request' });
      else response.destroy();
    });
  };
  let server: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>;
  try {
    server = tls ? createHttpsServer(tls, handle) : createServer(handle);
  } catch {
    throw new TypeError('The test IdP TLS configuration is invalid.');
  }
  let issuer = '';

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requestHostAllowed(request, host)) {
      respond(response, 400, { error: 'invalid_request' });
      return;
    }
    const requestUrl = new URL(request.url ?? '/', issuer || `${tls ? 'https' : 'http'}://127.0.0.1`);
    if (requestUrl.pathname === '/.well-known/openid-configuration' && request.method === 'GET') {
      respond(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (requestUrl.pathname === '/jwks' && request.method === 'GET') {
      respond(response, 200, { keys: [jwk] }, { 'content-type': 'application/jwk-set+json; charset=utf-8' });
      return;
    }
    if (requestUrl.pathname === '/authorize' && request.method === 'GET') {
      const params = requestUrl.searchParams;
      const state = params.get('state');
      const nonce = params.get('nonce');
      const challenge = params.get('code_challenge');
      if (params.get('response_type') !== 'code' || params.get('client_id') !== options.clientId ||
          params.get('redirect_uri') !== options.redirectUri || !params.get('scope')?.split(/\s+/u).includes('openid') ||
          params.get('code_challenge_method') !== 'S256' || challenge === null || !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
          state === null || !/^[A-Za-z0-9_-]{43}$/u.test(state) || nonce === null || !/^[A-Za-z0-9_-]{43}$/u.test(nonce)) {
        respond(response, 400, { error: 'invalid_request' });
        return;
      }
      const requestedSubjects = params.getAll('test_subject');
      if (testSubjects === undefined) {
        if (requestedSubjects.length > 0) {
          respond(response, 400, { error: 'invalid_request' });
          return;
        }
      } else if (requestedSubjects.length === 0) {
        renderTestIdentityChoicePage(response, params, testSubjects, callback.origin);
        return;
      } else if (requestedSubjects.length !== 1 || !testSubjects.some(choice => choice.subject === requestedSubjects[0])) {
        respond(response, 400, { error: 'invalid_request' });
        return;
      }
      const code = randomBytes(32).toString('base64url');
      codes.set(code, {
        clientId: options.clientId,
        redirectUri: options.redirectUri,
        challenge,
        nonce,
        subject: requestedSubjects[0] ?? options.subject ?? 'test-subject-1',
        expiresAt: clock() + AUTH_CODE_LIFETIME_MS,
        used: false,
      });
      const destination = new URL(options.redirectUri);
      destination.searchParams.set('code', code);
      destination.searchParams.set('state', state);
      response.writeHead(302, { location: destination.href, 'cache-control': 'no-store', 'content-length': '0' });
      response.end();
      return;
    }
    if (requestUrl.pathname === '/token' && request.method === 'POST') {
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
        respond(response, 400, { error: 'invalid_request' });
        return;
      }
      let params: URLSearchParams;
      try {
        params = await readForm(request);
      } catch {
        respond(response, 400, { error: 'invalid_request' });
        return;
      }
      const code = params.get('code') ?? '';
      const record = codes.get(code);
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (params.get('grant_type') !== 'authorization_code' || !record || record.used || record.expiresAt <= clock() ||
          params.get('client_id') !== record.clientId || params.get('redirect_uri') !== record.redirectUri ||
          !record.clientId || challenge !== record.challenge || params.has('client_secret')) {
        respond(response, 400, { error: 'invalid_grant' });
        return;
      }
      record.used = true;
      const issuedAt = Math.floor(clock() / 1000);
      const overrides = options.tokenOverrides ?? {};
      const omittedClaim = options.omitClaim;
      let idToken = new SignJWT(omittedClaim === 'nonce' ? {} : { nonce: overrides.nonce ?? record.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' });
      if (omittedClaim !== 'iss') idToken = idToken.setIssuer(overrides.issuer ?? issuer);
      if (omittedClaim !== 'aud') idToken = idToken.setAudience(overrides.audience ?? record.clientId);
      if (omittedClaim !== 'sub') idToken = idToken.setSubject(record.subject);
      if (omittedClaim !== 'iat') idToken = idToken.setIssuedAt(overrides.issuedAt ?? issuedAt);
      if (omittedClaim !== 'exp') idToken = idToken.setExpirationTime(overrides.expiresAt ?? (issuedAt + 300));
      const signedIdToken = await idToken.sign(privateKey);
      respond(response, 200, { access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: signedIdToken });
      return;
    }
    respond(response, 404, { error: 'not_found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    throw new Error('The local test identity provider could not bind a loopback address.');
  }
  const advertisedHost = host === '::1' ? '[::1]' : host;
  issuer = `${tls ? 'https' : 'http'}://${advertisedHost}:${address.port.toString()}`;

  return {
    issuer,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
