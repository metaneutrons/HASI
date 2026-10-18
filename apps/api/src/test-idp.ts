import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const MAX_REQUEST_BYTES = 16 * 1024;
const AUTH_CODE_LIFETIME_MS = 60_000;

export interface TestIdpTokenOverrides {
  issuer?: string;
  audience?: string | string[];
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
}

export interface TestIdpOptions {
  /** Must be explicitly set to test. This server cannot be started in development or production. */
  mode: 'development' | 'test' | 'production';
  clientId: string;
  redirectUri: string;
  subject?: string;
  port?: number;
  host?: '127.0.0.1' | '::1';
  clock?: () => number;
  tokenOverrides?: TestIdpTokenOverrides;
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
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) throw new TypeError('The test IdP port is invalid.');
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new TypeError('The test identity provider must bind to loopback.');
  const callback = new URL(options.redirectUri);
  if (callback.protocol !== 'http:' || !isLoopbackHost(callback.hostname.replace(/^\[|\]$/gu, '')) || callback.username || callback.password || callback.hash) {
    throw new TypeError('The test IdP requires an HTTP loopback callback URI.');
  }

  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const keyId = randomBytes(12).toString('base64url');
  const publicJwk = await exportJWK(publicKey);
  const jwk = { ...publicJwk, kid: keyId, use: 'sig', alg: 'RS256' };
  const codes = new Map<string, AuthorizationCode>();
  const clock = options.clock ?? Date.now;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) respond(response, 400, { error: 'invalid_request' });
      else response.destroy();
    });
  });
  let issuer = '';

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requestHostAllowed(request, host)) {
      respond(response, 400, { error: 'invalid_request' });
      return;
    }
    const requestUrl = new URL(request.url ?? '/', issuer || 'http://127.0.0.1');
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
      const code = randomBytes(32).toString('base64url');
      codes.set(code, {
        clientId: options.clientId,
        redirectUri: options.redirectUri,
        challenge,
        nonce,
        subject: options.subject ?? 'test-subject-1',
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
      const idToken = await new SignJWT({ nonce: overrides.nonce ?? record.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? record.clientId)
        .setSubject(record.subject)
        .setIssuedAt(overrides.issuedAt ?? issuedAt)
        .setExpirationTime(overrides.expiresAt ?? (issuedAt + 300))
        .sign(privateKey);
      respond(response, 200, { access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
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
  issuer = `http://${advertisedHost}:${address.port.toString()}`;

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
