import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import Fastify from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { digest, configurationDefinitionSchema } from '@hasi/plugin-sdk';
import { managedPluginCommandSchema, managedPluginCommandResultSchema, managedPluginCatalogSchema, type ManagedPluginCommand } from '@hasi/plugin-sdk/deployment-admin';
import type { ManagedPluginAdmin } from './managed-plugin-admin.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const subject = z.string().min(1).max(256);
const draftSchema = z.strictObject({ revision: z.number().int().nonnegative(), values: z.record(z.string(), z.unknown()), disabledTools: z.array(z.string().max(256)).max(64) });
const revisionSchema = z.strictObject({ revision: z.number().int().nonnegative(), activeRevision: z.number().int().nonnegative() });
const configurationSchema = z.strictObject({
  ...revisionSchema.shape, configuration: z.record(z.string(), z.unknown()), draft: z.record(z.string(), z.unknown()),
  disabledTools: z.array(z.string().max(256)).max(64), draftDisabledTools: z.array(z.string().max(256)).max(64),
  schema: configurationDefinitionSchema.optional(),
  secrets: z.array(z.strictObject({ name: z.string().max(128), required: z.boolean(), configured: z.boolean(), revision: z.string().max(128).nullable().optional() })).max(64),
  ready: z.boolean(), audit: z.array(z.strictObject({ operation: z.enum(['draft', 'activate']), subject, at: z.iso.datetime() })).max(100),
});
const rpcSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('list'), subject }),
  z.strictObject({ method: z.literal('command'), subject, installationId: id, command: managedPluginCommandSchema }),
  z.strictObject({ method: z.literal('commandStatus'), subject, installationId: id, commandId: z.uuid() }),
  z.strictObject({ method: z.literal('configuration'), subject, installationId: id }),
  z.strictObject({ method: z.literal('draft'), subject, installationId: id, draft: draftSchema }),
  z.strictObject({ method: z.literal('activateConfiguration'), subject, installationId: id, revision: z.number().int().nonnegative() }),
]);
type Rpc = z.infer<typeof rpcSchema>;
const issuer = 'hasi-managed-plugin-api-v1';
const audience = 'hasi-managed-plugin-installer-v1';
const route = '/installer/v1/rpc';
// Includes the maximum 32-installation catalogue with configuration-toggle
// labels and approved release summaries. It never includes full tool schemas.
const MAX_RESPONSE = 16 * 1024 * 1024;

/** Separate private listener. Authentication is a short-lived host signature
 * bound to scope, actor and the entire strict RPC payload. The service also
 * resolves current admin authority from the signed institutional directory.
 */
export async function createManagedPluginRpcServer(options: { service: ManagedPluginAdmin; publicKey: KeyObject; privateKey: KeyObject; scope: string; port: number }) {
  if (options.publicKey.type !== 'public' || options.publicKey.asymmetricKeyType !== 'ed25519' || !options.scope || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new TypeError('Invalid installer RPC configuration');
  if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519'
    || !options.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(options.privateKey).export({ type: 'spki', format: 'der' }))) throw new TypeError('Installer RPC signing identity mismatch');
  const app = Fastify({ logger: false, bodyLimit: 32768 });
  app.setErrorHandler((_error, _request, reply) => reply.code(502).send({ error: 'Installer request unavailable.' }));
  app.post(route, async (request, reply) => {
    if (request.url !== route || request.headers.cookie || request.headers.origin) return reply.code(400).send({ error: 'Invalid installer request.' });
    const token = request.headers.authorization;
    if (typeof token !== 'string' || token.length > 8192 || !token.startsWith('Bearer ')) return reply.code(401).send({ error: 'Installer authentication required.' });
    const input = rpcSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid installer request.' });
    let requestId: string;
    try {
      const { payload } = await jwtVerify(token.slice(7), options.publicKey, { algorithms: ['EdDSA'], issuer, audience, maxTokenAge: '60s', requiredClaims: ['iat', 'exp', 'sub', 'jti'] });
      requestId = z.uuid().parse(payload.jti);
      if (payload.scope !== options.scope || payload.sub !== input.data.subject || payload.requestDigest !== digest(input.data)
        || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 60) throw new Error('invalid binding');
    } catch { return reply.code(401).send({ error: 'Installer authentication failed.' }); }
    try {
      const call = input.data;
      const result = call.method === 'list' ? managedPluginCatalogSchema.parse(await options.service.list(call.subject))
        : call.method === 'configuration' ? configurationSchema.parse(await options.service.describeConfiguration?.(call.installationId, call.subject))
        : call.method === 'draft' ? revisionSchema.parse(await options.service.saveConfigurationDraft?.(call.installationId, call.draft, call.subject))
        : call.method === 'activateConfiguration' ? revisionSchema.parse(await options.service.activateConfiguration?.(call.installationId, call.revision, call.subject))
        : managedPluginCommandResultSchema.parse(call.method === 'command'
          ? await options.service.command(call.installationId, call.command, call.subject)
          : await options.service.commandStatus(call.installationId, call.commandId, call.subject));
      const wire: unknown = JSON.parse(JSON.stringify(result));
      const proof = await new SignJWT({ scope: options.scope, requestId, requestDigest: digest(call), responseDigest: digest(wire) }).setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(call.subject).setIssuer(audience).setAudience(issuer).setIssuedAt().setExpirationTime('60s').sign(options.privateKey);
      return await reply.header('cache-control', 'no-store').header('x-hasi-installer-proof', proof).send(wire);
    } catch { return reply.code(409).send({ error: 'Installer state must be checked.' }); }
  });
  await app.listen({ host: '127.0.0.1', port: options.port });
  const address = app.server.address();
  if (!address || typeof address === 'string') { await app.close(); throw new Error('Installer listener unavailable'); }
  return { origin: `http://127.0.0.1:${String(address.port)}`, close: () => app.close() };
}

/** Public API composition has only this client: no Docker socket or catalogue
 * with launch/secret data is needed in that process. Origin is operator-owned.
 */
export function createManagedPluginRpcClient(options: { origin: string; privateKey: KeyObject; scope: string }): ManagedPluginAdmin {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || origin.username || origin.password
    || options.privateKey.type !== 'private' || createPublicKey(options.privateKey).asymmetricKeyType !== 'ed25519' || !options.scope) throw new TypeError('Invalid installer RPC configuration');
  const call = async (input: Rpc) => {
    const payload = rpcSchema.parse(input);
    const requestId = randomUUID();
    const token = await new SignJWT({ scope: options.scope, requestDigest: digest(payload) }).setProtectedHeader({ alg: 'EdDSA' }).setJti(requestId).setSubject(payload.subject).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('60s').sign(options.privateKey);
    const response = await fetch(`${origin.origin}${route}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Installer request unavailable'); }
    if (!response.body) throw new Error('Installer response unavailable');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next: { done: boolean; value?: unknown } = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new Error('Invalid installer response');
        size += next.value.byteLength;
        if (size > MAX_RESPONSE) throw new Error('Installer response too large');
        chunks.push(next.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const proof = response.headers.get('x-hasi-installer-proof');
      if (!proof || proof.length > 8192) throw new Error('Installer response authentication failed');
      const verified = await jwtVerify(proof, createPublicKey(options.privateKey), { algorithms: ['EdDSA'], issuer: audience, audience: issuer, maxTokenAge: '60s', requiredClaims: ['iat', 'exp', 'sub'] });
      if (verified.payload.scope !== options.scope || verified.payload.sub !== payload.subject || verified.payload.requestId !== requestId || verified.payload.requestDigest !== digest(payload) || verified.payload.responseDigest !== digest(result)) throw new Error('Installer response authentication failed');
      return result;
    } finally { try { await reader.cancel(); } catch { /* The bounded read may already have closed the stream. */ } reader.releaseLock(); }
  };
  const commandResult = (raw: unknown, installationId: string, commandId: string) => {
    const result = managedPluginCommandResultSchema.parse(raw);
    if (result.commandId !== commandId || result.view.id !== installationId) throw new Error('Installer response binding invalid');
    return result;
  };
  return {
    list: async subject => managedPluginCatalogSchema.parse(await call({ method: 'list', subject })),
    command: async (installationId: string, command: ManagedPluginCommand, subject: string) => commandResult(await call({ method: 'command', installationId, command, subject }), installationId, command.commandId),
    commandStatus: async (installationId, commandId, subject) => commandResult(await call({ method: 'commandStatus', installationId, commandId, subject }), installationId, commandId),
    describeConfiguration: async (installationId, subject) => {
      const result = configurationSchema.parse(await call({ method: 'configuration', installationId, subject }));
      return { ...result, schema: result.schema, secrets: result.secrets.map(secret => ({ name: secret.name, required: secret.required, configured: secret.configured, ...(secret.revision !== undefined ? { revision: secret.revision } : {}) })) };
    },
    saveConfigurationDraft: async (installationId, draft, subject) => revisionSchema.parse(await call({ method: 'draft', installationId, draft, subject })),
    activateConfiguration: async (installationId, revision, subject) => revisionSchema.parse(await call({ method: 'activateConfiguration', installationId, revision, subject })),
  };
}
