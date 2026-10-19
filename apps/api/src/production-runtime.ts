import { createHash, createPublicKey, sign, verify, timingSafeEqual, type KeyObject } from 'node:crypto';
import { actorContextSchema, digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { z } from 'zod';
import { createRegistryKnowledgeContexts } from './knowledge-context-runtime.js';
import { createApi, type ApiOptions } from './index.js';
import { OidcIdentityProvider, type OidcIdentityProviderOptions } from './oidc.js';
import { PluginRegistry, type ApprovedPluginSource } from './registry.js';
import type { Persona } from './identity.js';
import type { PluginAccountService } from './plugin-accounts.js';
import type { PluginDeploymentBinding } from './plugin-deployment-binding.js';
import { createPluginDeploymentGateway } from './plugin-deployment-proxy.js';
import type { DockerPluginActiveEndpointResolver } from './docker-plugin-driver.js';
import { createConsoleOperationalEventSink, type OperationalEventSink } from './operational-events.js';

/** Same stable key as the verified OIDC provider; e-mail is never an account authority. */
export function stableOidcSubject(issuer: string, subject: string) {
  const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
  return `oidc:${hash(issuer)}:${hash(subject)}`;
}
const authoritySchema = z.strictObject({
  id: z.string().min(1).max(256), displayName: z.string().min(1).max(256),
  role: z.enum(['student', 'employee', 'admin']), actor: actorContextSchema,
});

/** Operator-only directory. No HTTP route can write grants or select another subject. */
export class ProductionAuthorityDirectory {
  private readonly publicKey: KeyObject;
  constructor(private readonly store: JsonStore, private readonly privateKey: KeyObject, private readonly scope: string) { this.publicKey = createPublicKey(privateKey); }
  private key(subject: string) { return `authority:v1:${createHash('sha256').update(subject).digest('hex')}`; }
  async resolve(subject: string): Promise<Persona | undefined> {
    const record = await this.store.read(this.key(subject));
    if (!record) return undefined;
    const envelope = z.strictObject({ authority: authoritySchema.nullable(), signature: z.string().max(128) }).parse(record.value);
    if (!verify(null, Buffer.from(digest({ subject, scope: this.scope, authority: envelope.authority })), this.publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error('Invalid authority record signature');
    if (!envelope.authority) return undefined;
    const value = envelope.authority;
    if (value.id !== subject || value.actor.subject !== subject) throw new Error('Invalid authority binding');
    return value;
  }
  async replace(subject: string, revision: string | null, authority: Persona | null) {
    if (authority && (authority.id !== subject || authority.actor.subject !== subject)) throw new Error('Invalid authority binding');
    // Revocation is a tombstone rather than delete/CAS-null, preserving concurrency fencing.
    const value = authority ? authoritySchema.parse(authority) : null;
    const signature = sign(null, Buffer.from(digest({ subject, scope: this.scope, authority: value })), this.privateKey).toString('base64url');
    return this.store.compareAndSet(this.key(subject), revision, { authority: value, signature });
  }
}

export interface ProductionRuntimeOptions {
  privateKey: KeyObject;
  store: JsonStore;
  scope: string;
  webOrigin: string;
  apiHostname: string;
  plugins: readonly ApprovedPluginSource[];
  identity: Omit<OidcIdentityProviderOptions, 'mode' | 'store' | 'mapIdentity' | 'resolveAuthority' | 'redirectUri'>;
  actionPolicies?: ApiOptions['actionPolicies'];
  operationalEventSink?: OperationalEventSink;
  accounts?: ReadonlyMap<string, PluginAccountService>;
  deploymentBindings?: ReadonlyMap<string, PluginDeploymentBinding>;
  /** Embedded operator compositions only; prefer a separate worker process in institutional hosting. */
  managedGateway?: { endpointResolver: DockerPluginActiveEndpointResolver; port: number; installationIds: readonly string[] };
}

/** Separate long-lived API/worker topology; the public Coolify fixture stack is not used. */
export async function createProductionRuntime(options: ProductionRuntimeOptions) {
  const origin = new URL(options.webOrigin);
  if (origin.origin !== options.webOrigin || origin.protocol !== 'https:' || origin.username || origin.password || options.store instanceof MemoryJsonStore || !options.apiHostname || !options.scope) throw new TypeError('Production requires HTTPS and durable operator-owned state');
  const directory = new ProductionAuthorityDirectory(options.store, options.privateKey, options.scope);
  const identity = new OidcIdentityProvider({ ...options.identity, mode: 'production', store: options.store, redirectUri: `${origin.origin}/api/auth/callback`, mapIdentity: async verified => {
    const user = await directory.resolve(stableOidcSubject(verified.issuer, verified.subject));
    if (!user) throw new Error('Institutional account not authorized');
    return user;
  }, resolveAuthority: subject => directory.resolve(subject) });
  const managed = new Set(options.managedGateway?.installationIds ?? []);
  if ([...managed].some(id => !options.plugins.some(plugin => plugin.id === id) || !options.deploymentBindings?.has(id))) throw new TypeError('Managed plugins require an approved source and current configuration/route binding');
  const gateway = options.managedGateway ? await createPluginDeploymentGateway({ ...options.managedGateway, authorize: ({ installationId, authorization }) => {
    const plugin = options.plugins.find(source => source.id === installationId && managed.has(installationId));
    if (!plugin || !authorization) return false;
    const actual = Buffer.from(authorization); const expected = Buffer.from(`Bearer ${plugin.registration.serviceToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } }) : undefined;
  let registry: PluginRegistry | undefined;
  try {
    registry = new PluginRegistry(options.privateKey, {
      store: options.store,
      scope: options.scope,
      envelopeResults: true,
      resolveActor: async subject => (await directory.resolve(subject))?.actor,
      ...(gateway ? { operatorManagedLoopbackOrigin: gateway.origin } : {}),
      ...(options.accounts ? { accounts: options.accounts } : {}),
      ...(options.deploymentBindings ? { deploymentBindings: options.deploymentBindings } : {}),
    });
    const plugins = options.plugins.map(source => gateway && managed.has(source.id) ? {
      ...source,
      registration: {
        ...source.registration,
        endpoint: `${gateway.origin}/api/plugin-deployments/${source.id}/mcp`,
        allowLoopback: false,
      },
    } : source);
    // Catalogue entries are approvals to connect, not an instruction to reinstall removed sources.
    // createApi restores only durable connected records; a fresh installation is explicit admin work.
    const knowledgeContexts = createRegistryKnowledgeContexts({ registry, store: options.store, privateKey: options.privateKey, scope: options.scope, resolveActor: async subject => (await directory.resolve(subject))?.actor });
    const app = await createApi({ mode: 'production', knowledgeContexts, registry, identity, store: options.store, origin: origin.origin, allowedHosts: [options.apiHostname], secureCookies: true, sessionCookieName: '__Host-hasi-session', pluginCatalog: plugins, operationalEventSink: options.operationalEventSink ?? createConsoleOperationalEventSink(), ...(options.actionPolicies ? { actionPolicies: options.actionPolicies } : {}) });
    if (gateway) app.addHook('onClose', () => gateway.close());
    app.get('/health', () => ({ status: 'ok' }));
    return { app, registry, directory };
  } catch {
    await gateway?.close();
    await registry?.close();
    throw new Error('Production runtime startup failed');
  }
}
