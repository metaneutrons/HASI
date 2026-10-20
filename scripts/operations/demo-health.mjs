#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEALTH_URL = 'https://hasi.metaneutrons.cc/api/health';
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;

class DemoHealthProbeError extends Error {
  constructor(code) {
    super(`Demo health check failed (${code}).`);
    this.name = 'DemoHealthProbeError';
    this.code = code;
  }
}

function isTimeout(error) {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function reject(code) {
  throw new DemoHealthProbeError(code);
}

function validateOptions(options) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    reject('invalid_arguments');
  }

  const keys = Object.keys(options);
  if (keys.some((key) => key !== 'expectedRevision')) reject('invalid_arguments');

  const { expectedRevision } = options;
  if (expectedRevision !== undefined
      && (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision))) {
    reject('invalid_arguments');
  }
  return expectedRevision;
}

function parseCliArguments(args) {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== '--expected-revision'
      || !REVISION_PATTERN.test(args[1])) {
    reject('invalid_arguments');
  }
  return { expectedRevision: args[1] };
}

function discardBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Discard failures never add response or transport details to the result.
  }
}

async function readBoundedBody(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return { failure: 'invalid_response' };
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) {
      discardBody(response);
      return { failure: 'body_too_large' };
    }
  }

  if (response.body === null) return { text: '' };

  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    return { failure: 'body_read_failed' };
  }

  const chunks = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { failure: 'body_read_failed' };
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { failure: 'body_too_large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    return { failure: isTimeout(error) ? 'timeout' : 'body_read_failed' };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The body is already unusable; keep failure reporting sanitized.
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { failure: 'invalid_json' };
  }
}

function parseHealthPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    reject('invalid_json');
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    reject('invalid_response');
  }
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !Object.hasOwn(payload, 'status') || !Object.hasOwn(payload, 'revision')) {
    reject('invalid_response');
  }
  if (payload.status !== 'ready') reject('not_ready');
  if (typeof payload.revision !== 'string' || !REVISION_PATTERN.test(payload.revision)) {
    reject('invalid_response');
  }

  return { status: 'ready', revision: payload.revision };
}

/**
 * Probes only the fixed public readiness URL. The optional fetch implementation
 * is an offline-test seam; callers cannot choose a URL, headers or timeout.
 */
export async function checkDemoHealth(fetchImplementation = globalThis.fetch, options = {}) {
  const expectedRevision = validateOptions(options);
  if (typeof fetchImplementation !== 'function') reject('fetch_unavailable');

  let response;
  try {
    response = await fetchImplementation(HEALTH_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    reject(isTimeout(error) ? 'timeout' : 'network_or_redirect');
  }

  if (response.status !== 200) {
    discardBody(response);
    reject('http_status');
  }

  const body = await readBoundedBody(response);
  if ('failure' in body) reject(body.failure);
  const result = parseHealthPayload(body.text);
  if (expectedRevision !== undefined && result.revision !== expectedRevision) {
    reject('revision_mismatch');
  }
  return result;
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await checkDemoHealth(globalThis.fetch, options))}\n`);
  } catch (error) {
    const code = error instanceof DemoHealthProbeError ? error.code : 'internal_failure';
    process.stderr.write(`demo-health failed: ${code}\n`);
    process.exitCode = 1;
  }
}
