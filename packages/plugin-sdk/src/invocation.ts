import { randomUUID, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { digest, parseJsonRecord } from './canonical-json.js';
import { parseActorContext, type ActorContext } from './manifest.js';

const ISSUER = 'hasi-core';
const MAX_TOKEN_AGE_SECONDS = 60;

export interface InvocationContext { installationId: string; configurationRevision: number; configuration: Record<string, unknown> }

export interface CreateInvocationTokenParams {
  context?: InvocationContext;
  actor: ActorContext;
  pluginId: string;
  pluginVersion: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface InvocationBinding {
  installationId?: string;
  pluginId: string;
  pluginVersion: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface VerifiedInvocation {
  context?: InvocationContext;
  actor: ActorContext;
  jti: string;
  expiresAt: number;
  argsHash: string;
}

export async function createInvocationToken(
  input: CreateInvocationTokenParams,
  privateKey: KeyObject,
): Promise<string> {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Invocation tokens require an Ed25519 private key');
  }

  const actor = parseActorContext(input.actor);
  const args = parseJsonRecord(input.args, 'args');
  const issuedAt = Math.floor(Date.now() / 1_000);

  return new SignJWT({
    actor,
    ...(input.context ? { context: validateContext(input.context) } : {}),
    pluginVersion: input.pluginVersion,
    tool: input.tool,
    argsHash: digest(args),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(input.pluginId)
    .setSubject(actor.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + MAX_TOKEN_AGE_SECONDS)
    .setJti(randomUUID())
    .sign(privateKey);
}

export async function verifyInvocationTokenClaims(
  token: string,
  binding: InvocationBinding,
  publicKey: KeyObject,
): Promise<VerifiedInvocation> {
  try {
    const args = parseJsonRecord(binding.args, 'args');
    const expectedArgsHash = digest(args);
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA'],
      issuer: ISSUER,
      audience: binding.pluginId,
      maxTokenAge: `${String(MAX_TOKEN_AGE_SECONDS)}s`,
    });

    if (protectedHeader.alg !== 'EdDSA' || protectedHeader.typ !== 'JWT') {
      throw new Error('Invalid invocation token');
    }

    const expectedClaims = new Set([
      'actor',
      'context',
      'argsHash',
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'sub',
      'pluginVersion',
      'tool',
    ]);
    if (Object.keys(payload).some((claim) => !expectedClaims.has(claim))) {
      throw new Error('Invalid invocation token');
    }

    const now = Math.floor(Date.now() / 1_000);
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    const actor = parseActorContext(payload.actor);
    const context = payload.context === undefined ? undefined : validateContext(payload.context);
    if (binding.installationId !== undefined && context?.installationId !== binding.installationId) throw new Error('Invalid installation binding');
    if (
      payload.iss !== ISSUER ||
      payload.aud !== binding.pluginId ||
      payload.sub !== actor.subject ||
      payload.pluginVersion !== binding.pluginVersion ||
      payload.tool !== binding.tool ||
      payload.argsHash !== expectedArgsHash ||
      typeof payload.jti !== 'string' ||
      !isUuid(payload.jti) ||
      typeof issuedAt !== 'number' ||
      !Number.isSafeInteger(issuedAt) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      issuedAt > now ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_TOKEN_AGE_SECONDS ||
      expiresAt <= now
    ) {
      throw new Error('Invalid invocation token');
    }

    return {
      actor,
      ...(context ? { context } : {}),
      jti: payload.jti,
      expiresAt,
      argsHash: expectedArgsHash,
    };
  } catch {
    throw new Error('Invalid invocation token');
  }
}

export async function verifyInvocationToken(
  token: string,
  binding: InvocationBinding,
  publicKey: KeyObject,
): Promise<ActorContext> {
  const verified = await verifyInvocationTokenClaims(token, binding, publicKey);
  return verified.actor;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateContext(value: unknown): InvocationContext {
  const object = parseJsonRecord(value, 'invocation context');
  if (Object.keys(object).some(key => !['installationId', 'configurationRevision', 'configuration'].includes(key)) || typeof object.installationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(object.installationId) || typeof object.configurationRevision !== 'number' || !Number.isSafeInteger(object.configurationRevision) || object.configurationRevision < 0) throw new Error('Invalid invocation context');
  const configuration = parseJsonRecord(object.configuration, 'configuration');
  if (Buffer.byteLength(JSON.stringify(configuration)) > 32768) throw new Error('Configuration too large');
  return { installationId: object.installationId, configurationRevision: object.configurationRevision, configuration };
}
