import { randomUUID, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { digest, parseJsonRecord } from './canonical-json.js';
import { parseActorContext, type ActorContext } from './manifest.js';

const ISSUER = 'hasi-core';
const MAX_TOKEN_AGE_SECONDS = 60;

export interface CreateInvocationTokenParams {
  actor: ActorContext;
  pluginId: string;
  pluginVersion: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface InvocationBinding {
  pluginId: string;
  pluginVersion: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface VerifiedInvocation {
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
