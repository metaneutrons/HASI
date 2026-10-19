import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryJsonStore } from '@hasi/state';
import { afterEach, describe, expect, it } from 'vitest';
import type { Persona } from '../apps/api/src/identity.js';
import { OidcIdentityProvider } from '../apps/api/src/oidc.js';
import { startTestIdp, type TestIdpServer, type TestIdpTlsOptions } from '../apps/api/src/test-idp.js';

const CLIENT_ID = 'hasi-test-idp-tls';
const HTTPS_CALLBACK = 'https://127.0.0.1:43210/api/oidc/callback';
const HTTP_CALLBACK = 'http://127.0.0.1:43210/api/oidc/callback';
const MAX_TEST_RESPONSE_BYTES = 256 * 1024;

interface CertificateFixture {
  readonly directory: string;
  readonly tls: TestIdpTlsOptions;
  readonly ca: Buffer;
  cleanup(): Promise<void>;
}

function runOpenSsl(args: readonly string[], cwd: string): void {
  try {
    execFileSync('openssl', [...args], { cwd, stdio: 'ignore', timeout: 30_000 });
  } catch {
    throw new Error('OpenSSL could not create the temporary Test IdP certificate.');
  }
}

async function createCertificateFixture(): Promise<CertificateFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-test-idp-tls-'));
  try {
    await writeFile(join(directory, 'ca.cnf'), [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_ca',
      'prompt = no',
      '[dn]',
      'CN = HASI temporary Test IdP CA',
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'));
    await writeFile(join(directory, 'server.cnf'), [
      '[req]',
      'distinguished_name = dn',
      'req_extensions = request_extensions',
      'prompt = no',
      '[dn]',
      'CN = 127.0.0.1',
      '[request_extensions]',
      'subjectAltName = IP:127.0.0.1',
      '',
    ].join('\n'));
    await writeFile(join(directory, 'server-ext.cnf'), [
      '[server_certificate]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = IP:127.0.0.1',
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid,issuer',
      '',
    ].join('\n'));

    runOpenSsl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
      '-days', '2', '-sha256', '-config', 'ca.cnf',
    ], directory);
    runOpenSsl([
      'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr',
      '-config', 'server.cnf',
    ], directory);
    runOpenSsl([
      'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.crt', '-days', '2', '-sha256', '-extfile', 'server-ext.cnf', '-extensions', 'server_certificate',
    ], directory);

    return {
      directory,
      tls: {
        key: await readFile(join(directory, 'server.key')),
        cert: await readFile(join(directory, 'server.crt')),
      },
      ca: await readFile(join(directory, 'ca.crt')),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function trustedHttpsFetch(agent: HttpsAgent, allowedOrigin: string): typeof fetch {
  return async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol !== 'https:' || url.origin !== allowedOrigin) throw new TypeError('Test fetch target is outside the trusted Test IdP origin.');
    const headers = new Headers(init.headers);
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { requestHeaders[name] = value; });
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init.body ?? (input instanceof Request ? input.body : undefined);

    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(url, { method, headers: requestHeaders, agent }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_TEST_RESPONSE_BYTES) {
            request.destroy(new Error('Test IdP response exceeded its bound.'));
            return;
          }
          chunks.push(bytes);
        });
        response.once('error', reject);
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') responseHeaders.set(name, value);
            else if (Array.isArray(value)) responseHeaders.set(name, value.join(', '));
          }
          resolve(new Response(Buffer.concat(chunks, size), {
            status: response.statusCode ?? 502,
            headers: responseHeaders,
          }));
        });
      });
      const signal = init.signal;
      const abort = () => { request.destroy(new Error('Test IdP request was aborted.')); };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () => { signal?.removeEventListener('abort', abort); });
      request.once('error', reject);
      request.setTimeout(5_000, () => { request.destroy(new Error('Test IdP request timed out.')); });
      if (body instanceof URLSearchParams) request.end(body.toString());
      else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
      else if (body === null || body === undefined) request.end();
      else {
        request.destroy(new TypeError('Unsupported test request body.'));
      }
    });
  };
}

function makePersona(subject: string): Persona {
  return {
    id: subject,
    displayName: 'TLS test user',
    role: 'student',
    actor: { subject, permissions: [] },
  };
}

async function authorize(provider: OidcIdentityProvider, fetcher: typeof fetch): Promise<{ transactionId: string; code: string; state: string }> {
  const start = await provider.beginAuthorization();
  const authorizationUrl = new URL(start.url);
  expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
  expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(HTTPS_CALLBACK);
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  const response = await fetcher(start.url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get('location') ?? '');
  return {
    transactionId: start.transactionId,
    code: callback.searchParams.get('code') ?? '',
    state: callback.searchParams.get('state') ?? '',
  };
}

const activeIdps: TestIdpServer[] = [];
afterEach(async () => {
  await Promise.all(activeIdps.splice(0).map(idp => idp.close()));
});

describe('Test IdP TLS fixture', () => {
  it('serves trusted HTTPS discovery and completes authorization with PKCE', async () => {
    const certificate = await createCertificateFixture();
    const agent = new HttpsAgent({ ca: certificate.ca });
    let idp: TestIdpServer | undefined;
    try {
      idp = await startTestIdp({
        mode: 'test',
        clientId: CLIENT_ID,
        redirectUri: HTTPS_CALLBACK,
        tls: certificate.tls,
      });
      activeIdps.push(idp);
      const origin = new URL(idp.issuer).origin;
      const fetcher = trustedHttpsFetch(agent, origin);
      const mappedSubjects: string[] = [];

      await expect(fetch(`${idp.issuer}/.well-known/openid-configuration`)).rejects.toThrow();
      expect(idp.issuer).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u);
      const discoveryResponse = await fetcher(`${idp.issuer}/.well-known/openid-configuration`);
      expect(discoveryResponse.status).toBe(200);
      expect(await discoveryResponse.json()).toMatchObject({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
      });

      const provider = new OidcIdentityProvider({
        mode: 'test',
        issuer: idp.issuer,
        clientId: CLIENT_ID,
        redirectUri: HTTPS_CALLBACK,
        store: new MemoryJsonStore('test-idp-https-authorization'),
        mapIdentity: ({ subject }) => {
          mappedSubjects.push(subject);
          return makePersona(subject);
        },
        fetch: fetcher,
      });
      const callback = await authorize(provider, fetcher);
      const result = await provider.completeAuthorization(callback);
      expect(mappedSubjects).toEqual(['test-subject-1']);
      expect(result.user.actor.subject).toMatch(/^oidc:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u);
      expect(await provider.resolve(result.token)).toEqual(result.user);
    } finally {
      agent.destroy();
      if (idp) await idp.close();
      const activeIndex = idp ? activeIdps.indexOf(idp) : -1;
      if (activeIndex >= 0) activeIdps.splice(activeIndex, 1);
      await certificate.cleanup();
    }
  }, 45_000);

  it('keeps the existing HTTP loopback test flow working without TLS options', async () => {
    const idp = await startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: HTTP_CALLBACK });
    activeIdps.push(idp);
    const mappedSubjects: string[] = [];
    expect(idp.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const provider = new OidcIdentityProvider({
      mode: 'test',
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      redirectUri: HTTP_CALLBACK,
      store: new MemoryJsonStore('test-idp-http-compatibility'),
      mapIdentity: ({ subject }) => {
        mappedSubjects.push(subject);
        return makePersona(subject);
      },
    });
    const start = await provider.beginAuthorization();
    const authorizationResponse = await fetch(start.url, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackUrl = new URL(authorizationResponse.headers.get('location') ?? '');
    const result = await provider.completeAuthorization({
      transactionId: start.transactionId,
      code: callbackUrl.searchParams.get('code') ?? '',
      state: callbackUrl.searchParams.get('state') ?? '',
    });
    expect(mappedSubjects).toEqual(['test-subject-1']);
    expect(result.user.actor.subject).toMatch(/^oidc:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u);
  });

  it.each([
    ['remote HTTPS callback', 'https://example.test/api/oidc/callback'],
    ['HTTPS callback with user information', 'https://user@127.0.0.1/api/oidc/callback'],
    ['HTTPS callback with a fragment', 'https://127.0.0.1/api/oidc/callback#fragment'],
    ['remote HTTP callback', 'http://example.test/api/oidc/callback'],
  ])('rejects a %s', async (_label, redirectUri) => {
    await expect(startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri })).rejects.toThrow(TypeError);
  });

  it.each(['development', 'production'] as const)('rejects TLS fixture startup in %s mode', async mode => {
    await expect(startTestIdp({
      mode,
      clientId: CLIENT_ID,
      redirectUri: HTTPS_CALLBACK,
      tls: { key: 'test-only-key', cert: 'test-only-cert' },
    })).rejects.toThrow(/explicit test mode/u);
  });

  it('bounds TLS constructor inputs', async () => {
    await expect(startTestIdp({
      mode: 'test',
      clientId: CLIENT_ID,
      redirectUri: HTTPS_CALLBACK,
      tls: { key: 'k'.repeat(64 * 1024 + 1), cert: 'certificate' },
    })).rejects.toThrow(TypeError);
  });
});
