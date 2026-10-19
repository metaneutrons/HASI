import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDemoHealth } from './demo-health.mjs';

const FIXED_URL = 'https://hasi.metaneutrons.cc/api/health';
const READY_BODY = JSON.stringify({ status: 'ready', revision: 'a'.repeat(40) });

test('the actual CLI exits nonzero with a sanitized synthetic failure', () => {
  const preload = 'globalThis.fetch = async () => new Response("private fixture body", { status: 503 });';
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('./demo-health.mjs', import.meta.url)),
  ], { encoding: 'utf8', env: {}, timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'demo-health failed: http_status\n');
});

function assertSafeRequest(url, options) {
  assert.equal(url, FIXED_URL);
  assert.equal(options.method, 'GET');
  assert.deepEqual(options.headers, { accept: 'application/json' });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(options, 'body'), false);
}

async function expectFailure(code, fetchImplementation) {
  await assert.rejects(checkDemoHealth(fetchImplementation), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, `Demo health check failed (${code}).`);
    return true;
  });
}

test('accepts only the fixed public ready contract and returns minimal status', async () => {
  let calls = 0;
  const result = await checkDemoHealth(async (url, options) => {
    calls += 1;
    assertSafeRequest(url, options);
    return new Response(READY_BODY, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 'ready', revision: 'a'.repeat(40) });
});

test('accepts an exact 8 KiB JSON body', async () => {
  const body = READY_BODY + ' '.repeat(8 * 1024 - Buffer.byteLength(READY_BODY));
  assert.equal(Buffer.byteLength(body), 8 * 1024);

  const result = await checkDemoHealth(async (url, options) => {
    assertSafeRequest(url, options);
    return new Response(body, { status: 200 });
  });

  assert.deepEqual(result, { status: 'ready', revision: 'a'.repeat(40) });
});

test('sanitizes a timeout and makes no retry', async () => {
  let calls = 0;
  await expectFailure('timeout', async (url, options) => {
    calls += 1;
    assertSafeRequest(url, options);
    throw new DOMException('private timeout detail', 'TimeoutError');
  });
  assert.equal(calls, 1);
});

test('rejects redirects through fetch policy and hides the failing URL', async () => {
  await expectFailure('network_or_redirect', async (url, options) => {
    assertSafeRequest(url, options);
    throw new TypeError('redirect to https://private.invalid/path?token=hidden');
  });
});

test('sanitizes network failures without exposing exception details', async () => {
  await expectFailure('network_or_redirect', async (url, options) => {
    assertSafeRequest(url, options);
    throw new Error('https://private.invalid/?credential=hidden');
  });
});

test('rejects a non-200 status without reading or exposing its body', async () => {
  await expectFailure('http_status', async (url, options) => {
    assertSafeRequest(url, options);
    return new Response('private database error details', { status: 503 });
  });
});

test('rejects a response larger than 8 KiB', async () => {
  await expectFailure('body_too_large', async (url, options) => {
    assertSafeRequest(url, options);
    return new Response('x'.repeat(8 * 1024 + 1), { status: 200 });
  });
});

test('rejects invalid JSON', async () => {
  await expectFailure('invalid_json', async (url, options) => {
    assertSafeRequest(url, options);
    return new Response('{invalid json', { status: 200 });
  });
});

test('rejects invalid revisions and extra response fields', async (t) => {
  await t.test('invalid revision', async () => {
    await expectFailure('invalid_response', async (url, options) => {
      assertSafeRequest(url, options);
      return new Response(JSON.stringify({ status: 'ready', revision: 'unknown' }), { status: 200 });
    });
  });

  await t.test('extra field', async () => {
    await expectFailure('invalid_response', async (url, options) => {
      assertSafeRequest(url, options);
      return new Response(JSON.stringify({ status: 'ready', revision: 'b'.repeat(40), extra: true }), { status: 200 });
    });
  });
});

test('reports an unavailable health payload as not ready', async () => {
  await expectFailure('not_ready', async (url, options) => {
    assertSafeRequest(url, options);
    return new Response(JSON.stringify({ status: 'unavailable', revision: 'c'.repeat(40) }), { status: 200 });
  });
});
