import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestIdp, type TestIdpOptions, type TestIdpServer } from '../apps/api/src/test-idp.js';

const CLIENT_ID = 'hasi-test-idp-subject-choice';
const REDIRECT_URI = 'http://127.0.0.1:43210/api/oidc/callback?fixed=one&other=two';

const activeIdps: TestIdpServer[] = [];
afterEach(async () => {
  await Promise.all(activeIdps.splice(0).map(idp => idp.close()));
});

function authorizationRequest(redirectUri = REDIRECT_URI): { params: URLSearchParams; verifier: string } {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
  });
  return { params, verifier };
}

function authorizeUrl(idp: TestIdpServer, params: URLSearchParams): URL {
  const url = new URL('/authorize', idp.issuer);
  url.search = params.toString();
  return url;
}

function decodeHtmlAttribute(value: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  return value.replace(/&(?:amp|lt|gt|quot|#39);/gu, entity => entities[entity] ?? entity);
}

async function tokenClaims(idp: TestIdpServer, code: string, verifier: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/token', idp.issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { id_token?: unknown };
  expect(typeof body.id_token).toBe('string');
  if (typeof body.id_token !== 'string') throw new Error('The test IdP did not return an ID token.');
  return decodeJwt(body.id_token);
}

describe('test IdP selectable synthetic identities', () => {
  it('shows an escaped, accessible GET choice form and exchanges the selected subject with PKCE', async () => {
    const choices = [
      { subject: 'student-one', label: 'Student one' },
      { subject: 'student-two', label: 'A <Admin> & "guest"\'s' },
    ];
    const idp = await startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, subjects: choices });
    activeIdps.push(idp);

    const { params, verifier } = authorizationRequest();
    params.set('unvalidated', 'must-not-be-forwarded');
    const choiceResponse = await fetch(authorizeUrl(idp, params), { redirect: 'manual' });
    expect(choiceResponse.status).toBe(200);
    expect(choiceResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(choiceResponse.headers.get('cache-control')).toBe('no-store');
    expect(choiceResponse.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:43210;");
    expect(choiceResponse.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await choiceResponse.text();
    expect(html).toContain('<form method="get" action="/authorize">');
    expect(html).toContain('<fieldset><legend>Synthetic identities</legend>');
    expect(html).toContain('value="student-two">A &lt;Admin&gt; &amp; &quot;guest&quot;&#39;s</button>');
    expect(html).not.toContain('<Admin>');
    expect(html).not.toContain('must-not-be-forwarded');
    expect(html).not.toMatch(/<script\b|<link\b|<img\b/iu);

    const hiddenFields = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)]
      .map(([, name, value]): [string, string] => {
        if (name === undefined || value === undefined) throw new Error('Malformed identity choice input');
        return [name, decodeHtmlAttribute(value)];
      });
    expect(hiddenFields.map(([name]) => name)).toEqual([
      'response_type', 'client_id', 'redirect_uri', 'scope', 'code_challenge_method', 'code_challenge', 'state', 'nonce',
    ]);
    const submittedParams = new URLSearchParams(hiddenFields);
    expect(submittedParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(submittedParams.get('scope')).toBe('openid profile');
    expect(submittedParams.has('unvalidated')).toBe(false);
    submittedParams.append('test_subject', 'student-two');

    const selectedResponse = await fetch(authorizeUrl(idp, submittedParams), { redirect: 'manual' });
    expect(selectedResponse.status).toBe(302);
    const callback = new URL(selectedResponse.headers.get('location') ?? '');
    expect(callback.searchParams.get('state')).toBe(params.get('state'));
    const code = callback.searchParams.get('code');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (code === null) throw new Error('The test IdP did not return an authorization code.');

    const rejectedVerifier = await fetch(new URL('/token', idp.issuer), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code,
        code_verifier: randomBytes(32).toString('base64url'),
      }),
    });
    expect(rejectedVerifier.status).toBe(400);
    const claims = await tokenClaims(idp, code, verifier);
    expect(claims.sub).toBe('student-two');
    expect(claims.nonce).toBe(params.get('nonce'));
  });

  it('rejects malformed choice configuration and snapshots a valid list at construction', async () => {
    const validChoice = { subject: 'student-one', label: 'Student one' };
    const invalidConfigurations: [string, Partial<TestIdpOptions>][] = [
      ['empty list', { subjects: [] }],
      ['too many choices', { subjects: Array.from({ length: 5 }, (_, index) => ({ subject: `student-${index.toString()}`, label: `Student ${index.toString()}` })) }],
      ['empty subject', { subjects: [{ subject: '', label: 'No subject' }] }],
      ['unsafe subject', { subjects: [{ subject: 'student one', label: 'Unsafe subject' }] }],
      ['oversized subject', { subjects: [{ subject: 's'.repeat(129), label: 'Long subject' }] }],
      ['empty label', { subjects: [{ subject: 'student-one', label: '  ' }] }],
      ['oversized label', { subjects: [{ subject: 'student-one', label: 'x'.repeat(257) }] }],
      ['control in label', { subjects: [{ subject: 'student-one', label: 'Bad\nlabel' }] }],
      ['duplicate subjects', { subjects: [validChoice, { subject: 'student-one', label: 'Duplicate' }] }],
      ['fixed and selectable identities', { subject: 'fixed-subject', subjects: [validChoice] }],
    ];

    for (const [name, options] of invalidConfigurations) {
      await expect(startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, ...options }), name).rejects.toThrow(TypeError);
    }

    const mutableChoices = [validChoice];
    const idpPromise = startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, subjects: mutableChoices });
    mutableChoices[0]!.subject = 'changed-after-construction';
    const idp = await idpPromise;
    activeIdps.push(idp);
    const { params } = authorizationRequest();
    const response = await fetch(authorizeUrl(idp, params), { redirect: 'manual' });
    const html = await response.text();
    expect(html).toContain('value="student-one">Student one</button>');
    expect(html).not.toContain('changed-after-construction');
  });

  it('rejects duplicate, empty and undeclared selections and any selection in fixed/default mode', async () => {
    const selectableIdp = await startTestIdp({
      mode: 'test',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      subjects: [{ subject: 'student-one', label: 'Student one' }],
    });
    activeIdps.push(selectableIdp);

    for (const values of [['student-one', 'student-one'], [''], ['unknown-subject']]) {
      const { params } = authorizationRequest();
      for (const value of values) params.append('test_subject', value);
      const response = await fetch(authorizeUrl(selectableIdp, params), { redirect: 'manual' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }

    const normalIdp = await startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
    activeIdps.push(normalIdp);
    for (const [subject, expected] of [['student-one', 'test-subject-1'], ['fixed-subject', 'fixed-subject']] as const) {
      const idp = subject === 'student-one'
        ? normalIdp
        : await startTestIdp({ mode: 'test', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, subject });
      if (idp !== normalIdp) activeIdps.push(idp);
      const { params, verifier } = authorizationRequest();
      params.append('test_subject', subject);
      const denied = await fetch(authorizeUrl(idp, params), { redirect: 'manual' });
      expect(denied.status).toBe(400);

      params.delete('test_subject');
      const response = await fetch(authorizeUrl(idp, params), { redirect: 'manual' });
      expect(response.status).toBe(302);
      const callback = new URL(response.headers.get('location') ?? '');
      const code = callback.searchParams.get('code');
      if (code === null) throw new Error('The test IdP did not return an authorization code.');
      expect((await tokenClaims(idp, code, verifier)).sub).toBe(expected);
    }
  });

  it('keeps the constructor test-mode guard in force', async () => {
    for (const mode of ['development', 'production'] as const) {
      await expect(startTestIdp({
        mode,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        subjects: [{ subject: 'student-one', label: 'Student one' }],
      })).rejects.toThrow('explicit test mode');
    }
  });
});
