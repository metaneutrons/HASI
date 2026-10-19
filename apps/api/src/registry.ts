import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { valid, major, gt } from 'semver';
import { MemoryJsonStore, updateJson, type JsonStore } from '@hasi/state';
import { createInvocationToken, digest, manifestSchema, projectActorContext, type ActorContext, type PluginManifest, type ToolDefinitionV2 } from '@hasi/plugin-sdk';
import { z } from 'zod';
import { PluginSettingsStore } from './plugin-settings.js';
import { createPluginFetch, type PluginFetch } from './network-policy.js';
import type { PluginSecretCustody } from './plugin-secrets.js';
import { resultEnvelope, sourcePolicySchema, type SourcePolicy, type ResultPaginationPolicy } from './result-envelope.js';
import { PluginAccountError, type PluginAccountService } from './plugin-accounts.js';
import type { PluginDeploymentBinding } from './plugin-deployment-binding.js';
import { managedPluginRuntimeContractSchema, type ManagedPluginRuntimeContract } from './managed-plugin-contract.js';

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface Registration {
  sourcePolicy?: SourcePolicy;
  pagination?: ResultPaginationPolicy;
  /** Trusted installation identity; package identity remains the signed MCP audience. */
  instanceId?: string;
  /** Operator revision for secret rotation/deployment identity; never a secret-derived fingerprint. */
  credentialRevision?: string;
  /** Explicit operator-approved campus/private network exceptions. */
  allowedPrivateCidrs?: readonly string[];
  /** Logical slot readiness resolved by the operator, never request input. */
  secretReady?: (name: string) => boolean;
  secretRevision?: (name: string) => string | null;
  secretCustody?: PluginSecretCustody;
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  allowLoopback: boolean;
  /** Operator-approved previous pins for an intentional contract migration. Never request input. */
  approvedPreviousManifestDigests?: readonly string[];
  /** Private worker control-plane fence. Never populated by browser/plugin input. */
  managedDeploymentRevision?: string;
}

export interface ApprovedPluginSource { id: string; label: string; registration: Registration }

/** A private, operator-authenticated authority, never a plugin/browser manifest. */
export interface ManagedPluginContractSource {
  initialManifest: PluginManifest;
  read(): Promise<ManagedPluginRuntimeContract | null>;
}

export interface PluginConnectionTestResult {
  instanceId: string;
  checkedAt: string;
  configured: 'ready' | 'incomplete';
  reachable: 'verified' | 'failed';
  authenticated: 'not_verified' | 'rejected';
  authorized: 'not_assessed';
  userReady: 'blocked' | 'not_assessed';
  remedies: { code: string; message: string; field?: string }[];
}

export interface PluginRegistryOptions {
  /** Current host authority; production composition must resolve this independently of caller snapshots. */
  resolveActor?: (subject: string) => Promise<ActorContext | undefined>;
  deploymentBindings?: ReadonlyMap<string, PluginDeploymentBinding>;
  managedContracts?: ReadonlyMap<string, ManagedPluginContractSource>;
  accounts?: ReadonlyMap<string, PluginAccountService>;
  /** Mandatory host provenance for production; v1 callers can retain explicit compatibility mode. */
  envelopeResults?: boolean;
  defaultSourcePolicy?: SourcePolicy;
  store?: JsonStore;
  /** Server-owned namespace for persisted plugin state. */
  scope?: string;
  /** Private production-composition pin for the exact operator deployment gateway origin. */
  operatorManagedLoopbackOrigin?: string;
  fetch?: typeof fetch;
  /** Pending update candidates expire after this many milliseconds. Defaults to seven days. */
  candidateTtlMs?: number;
  /** Separate operator code-review approval. A manifest cannot approve its own JavaScript. */
  reviewedAppDigests?: readonly string[];
}

interface InstalledPlugin {
  instanceId: string;
  fetch: typeof fetch;
  settings?: Awaited<ReturnType<PluginSettingsStore['binding']>>;
  registration: Registration;
  initialManifest: PluginManifest;
  manifest: PluginManifest;
  enabled: boolean;
  healthy: boolean;
  managedDeploymentRevision?: string;
  candidate?: PluginManifest;
  candidateBaseDigest?: string;
  candidateExpiresAt?: number;
}

interface UnsignedPluginState {
  schemaVersion: 1;
  scope: string;
  pluginId: string;
  expectedManifestDigest: string;
  initialManifest: PluginManifest;
  manifest: PluginManifest;
  enabled: boolean;
  candidate?: PluginManifest;
  candidateBaseDigest?: string;
  candidateExpiresAt?: number;
}

interface PersistedPluginState extends UnsignedPluginState {
  signature: string;
}

const validator = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(validator);

function validateSchema(schema: Record<string, unknown>, value: unknown): boolean {
  const key = `hasi:${digest(schema)}`;
  if (!validator.getSchema(key)) validator.addSchema(schema, key);
  const compiled = validator.getSchema(key);
  if (!compiled) throw new RequestError(502, 'Das Tool-Schema konnte nicht geprüft werden.');
  return Boolean(compiled(value));
}

const DEFAULT_SCOPE = 'default';
const DEFAULT_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const persistedStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(256),
  pluginId: z.string().min(1).max(256),
  expectedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  initialManifest: z.unknown(),
  manifest: z.unknown(),
  enabled: z.boolean(),
  candidate: z.unknown().optional(),
  candidateBaseDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  candidateExpiresAt: z.number().int().positive().optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export function compatibleUpdate(current: PluginManifest, candidate: PluginManifest): boolean {
  if (candidate.id !== current.id) return false;
  if (!valid(candidate.version) || !valid(current.version) || major(candidate.version) !== major(current.version) || !gt(candidate.version, current.version)) return false;
  const contract = (manifest: PluginManifest) => ({ manifestVersion: manifest.manifestVersion, apiVersion: manifest.apiVersion, tools: manifest.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, effect: tool.effect, requiredPermissions: [...tool.requiredPermissions].sort(), ...('visibility' in tool ? { visibility: tool.visibility ?? null } : {}), ...('presentationId' in tool ? { presentationId: tool.presentationId ?? null } : {}), ...('resultSemantics' in tool ? { resultSemantics: tool.resultSemantics ?? null } : {}) })).sort((a,b) => a.name.localeCompare(b.name)), ...(manifest.manifestVersion === 2 ? { configuration: manifest.configuration ?? null, secrets: manifest.secrets ?? null, identity: manifest.identity ?? null, presentations: manifest.presentations ?? null } : {}) });
  return digest(contract(current)) === digest(contract(candidate));
}

export class PluginRegistry {
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly store: JsonStore | undefined;
  private readonly scope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly candidateTtlMs: number;
  private readonly publicKey: KeyObject;
  readonly settings: PluginSettingsStore;
  private readonly catalogSources = new Map<string, ApprovedPluginSource>();
  private readonly transports = new Map<string, PluginFetch>();
  private readonly reviewedAppDigests: ReadonlySet<string>;
  private readonly envelopeResults: boolean;
  private readonly defaultSourcePolicy: SourcePolicy | undefined;
  readonly accounts: ReadonlyMap<string, PluginAccountService>;
  private readonly deploymentBindings: ReadonlyMap<string, PluginDeploymentBinding>;
  private readonly resolveActor: PluginRegistryOptions['resolveActor'];
  private readonly operatorManagedLoopbackOrigin: string | undefined;
  private readonly managedContracts: ReadonlyMap<string, ManagedPluginContractSource>;

  constructor(private readonly privateKey: KeyObject, options: PluginRegistryOptions = {}) {
    this.managedContracts = options.managedContracts ?? new Map();
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('Plugin registry state requires an Ed25519 private key');
    }
    const scope = options.scope ?? DEFAULT_SCOPE;
    if (!scope.trim() || scope.length > 256) throw new TypeError('Plugin registry scope must be a non-empty server-owned string');
    const candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS;
    if (!Number.isSafeInteger(candidateTtlMs) || candidateTtlMs < 1) throw new TypeError('Candidate TTL must be a positive safe integer');
    this.store = options.store;
    if (this.managedContracts.size && !this.store) throw new TypeError('Managed contracts require durable signed connection state');
    this.scope = scope;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.envelopeResults = options.envelopeResults ?? false;
    this.accounts = options.accounts ?? new Map();
    this.deploymentBindings = options.deploymentBindings ?? new Map();
    this.resolveActor = options.resolveActor;
    this.operatorManagedLoopbackOrigin = options.operatorManagedLoopbackOrigin;
    this.defaultSourcePolicy = options.defaultSourcePolicy ? sourcePolicySchema.parse(options.defaultSourcePolicy) : undefined;
    this.candidateTtlMs = candidateTtlMs;
    const reviewedApps = options.reviewedAppDigests ?? [];
    if (reviewedApps.length > 64 || reviewedApps.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new TypeError('Invalid reviewed App resource policy');
    this.reviewedAppDigests = new Set(reviewedApps);
    this.publicKey = createPublicKey(privateKey);
    this.settings = new PluginSettingsStore(privateKey, options.store ?? new MemoryJsonStore('registry-settings'), this.scope);
  }

  private stateKey(id: string): string {
    return `hasi:plugin-registry:v1:${digest({ scope: this.scope, pluginId: id })}`;
  }

  private endpoint(registration: Registration): URL {
    const endpoint = new URL(registration.endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    const managedGateway = endpoint.origin === this.operatorManagedLoopbackOrigin
      && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || ! /^(?:\/[A-Za-z0-9._~-]+)*\/mcp$/.test(endpoint.pathname) || (endpoint.protocol !== 'https:' && !(managedGateway || registration.allowLoopback && loopback && endpoint.protocol === 'http:'))) throw new RequestError(400, 'Unzulässiger Plugin-Endpunkt.');
    return endpoint;
  }

  private transport(registration: Registration): typeof fetch {
    const withFence = (transport: typeof fetch): typeof fetch => registration.managedDeploymentRevision ? async (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => { headers.set(name, value); });
      headers.set('x-hasi-deployment-revision', registration.managedDeploymentRevision ?? '');
      return transport(input, { ...init, headers });
    } : transport;
    if (this.fetchImpl !== fetch) return withFence(this.fetchImpl);
    const endpoint = this.endpoint(registration);
    const policyKey = digest({ origin: endpoint.origin, loopback: registration.allowLoopback, operatorManagedLoopbackOrigin: this.operatorManagedLoopbackOrigin ?? null, privateCidrs: registration.allowedPrivateCidrs ?? [] });
    let transport = this.transports.get(policyKey);
    if (!transport) {
      transport = createPluginFetch({ origins: [endpoint.origin], allowLoopback: registration.allowLoopback, ...(this.operatorManagedLoopbackOrigin ? { operatorManagedLoopbackOrigin: this.operatorManagedLoopbackOrigin } : {}), ...(registration.allowedPrivateCidrs ? { allowedPrivateCidrs: registration.allowedPrivateCidrs } : {}), maxResponseBytes: 2 * 1024 * 1024 });
      this.transports.set(policyKey, transport);
    }
    return withFence(transport);
  }

  async close(): Promise<void> { const transports = [...this.transports.values()]; this.transports.clear(); await Promise.all(transports.map(transport => transport.close())); }

  private async fetchManifest(registration: Registration): Promise<PluginManifest> {
    const endpoint = this.endpoint(registration);
    const response = await this.transport(registration)(new URL('./.well-known/hasi-plugin.json', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${registration.serviceToken}` } });
    if (response.status === 401 || response.status === 403) throw new RequestError(response.status, 'Die Dienstanmeldung wurde abgelehnt.');
    if (!response.ok) throw new RequestError(502, 'Plugin nicht erreichbar.');
    if (!response.body) throw new RequestError(502, 'Plugin-Manifest fehlt.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new RequestError(502, 'Ungültige Manifest-Daten.');
        bytes += value.byteLength;
        if (bytes > 65536) {
          await reader.cancel();
          throw new RequestError(502, 'Plugin-Manifest ist zu groß.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8');
    return manifestSchema.parse(JSON.parse(text));
  }

  private unsignedState(state: PersistedPluginState): UnsignedPluginState {
    return {
      schemaVersion: state.schemaVersion,
      scope: state.scope,
      pluginId: state.pluginId,
      expectedManifestDigest: state.expectedManifestDigest,
      initialManifest: state.initialManifest,
      manifest: state.manifest,
      enabled: state.enabled,
      ...(state.candidate && state.candidateBaseDigest !== undefined && state.candidateExpiresAt !== undefined ? {
        candidate: state.candidate,
        candidateBaseDigest: state.candidateBaseDigest,
        candidateExpiresAt: state.candidateExpiresAt,
      } : {}),
    };
  }

  private withoutCandidate(state: UnsignedPluginState): UnsignedPluginState {
    return {
      schemaVersion: state.schemaVersion,
      scope: state.scope,
      pluginId: state.pluginId,
      expectedManifestDigest: state.expectedManifestDigest,
      initialManifest: state.initialManifest,
      manifest: state.manifest,
      enabled: state.enabled,
    };
  }

  private stateSigningContent(state: UnsignedPluginState): Buffer {
    return Buffer.from(`hasi-plugin-registry-state-v1\0${digest(state)}`, 'utf8');
  }

  private signState(state: UnsignedPluginState): PersistedPluginState {
    return { ...state, signature: sign(null, this.stateSigningContent(state), this.privateKey).toString('base64url') };
  }

  private validateManifestSchemas(manifest: PluginManifest): void {
    for (const tool of manifest.tools) { validateSchema(tool.inputSchema, {}); validateSchema(tool.outputSchema, {}); }
  }

  private validatePersistedState(value: unknown, registration: Registration, pluginId: string): PersistedPluginState {
    try {
      const parsed = persistedStateSchema.parse(value);
      const initialManifest = manifestSchema.parse(parsed.initialManifest);
      const manifest = manifestSchema.parse(parsed.manifest);
      const candidate = parsed.candidate === undefined ? undefined : manifestSchema.parse(parsed.candidate);
      const state: PersistedPluginState = {
        schemaVersion: parsed.schemaVersion,
        scope: parsed.scope,
        pluginId: parsed.pluginId,
        expectedManifestDigest: parsed.expectedManifestDigest,
        initialManifest,
        manifest,
        enabled: parsed.enabled,
        ...(candidate ? { candidate } : {}),
        ...(parsed.candidateBaseDigest ? { candidateBaseDigest: parsed.candidateBaseDigest } : {}),
        ...(parsed.candidateExpiresAt !== undefined ? { candidateExpiresAt: parsed.candidateExpiresAt } : {}),
        signature: parsed.signature,
      };
      const unsigned = this.unsignedState(state);
      const signature = Buffer.from(state.signature, 'base64url');
      if (!verify(null, this.stateSigningContent(unsigned), this.publicKey, signature)) throw new Error('invalid signature');
      if (state.scope !== this.scope || state.pluginId !== pluginId || state.expectedManifestDigest !== registration.expectedManifestDigest) throw new Error('state binding mismatch');
      if (digest(initialManifest) !== registration.expectedManifestDigest || !valid(initialManifest.version)) throw new Error('invalid initial manifest');
      if (manifest.id !== initialManifest.id || !valid(manifest.version) || (digest(manifest) !== digest(initialManifest) && !compatibleUpdate(initialManifest, manifest))) throw new Error('invalid approved manifest chain');
      const hasCandidate = candidate !== undefined;
      const hasCandidateMetadata = state.candidateBaseDigest !== undefined && state.candidateExpiresAt !== undefined;
      if (hasCandidate !== hasCandidateMetadata) throw new Error('incomplete update candidate');
      if (candidate && (state.candidateBaseDigest !== digest(manifest) || !compatibleUpdate(manifest, candidate))) throw new Error('stale update candidate');
      this.validateManifestSchemas(initialManifest);
      this.validateManifestSchemas(manifest);
      if (candidate) this.validateManifestSchemas(candidate);
      return state;
    } catch {
      throw new RequestError(409, 'Der gespeicherte Plugin-Zustand ist ungültig oder wurde verändert.');
    }
  }

  private seedState(registration: Registration, initialManifest: PluginManifest): PersistedPluginState {
    const state: UnsignedPluginState = {
      schemaVersion: 1,
      scope: this.scope,
      pluginId: registration.instanceId ?? initialManifest.id,
      expectedManifestDigest: registration.expectedManifestDigest,
      initialManifest,
      manifest: initialManifest,
      enabled: true,
    };
    return this.signState(state);
  }

  private stateFromPlugin(plugin: InstalledPlugin): PersistedPluginState {
    const candidateState = plugin.candidate ? {
      candidate: plugin.candidate,
      candidateBaseDigest: plugin.candidateBaseDigest,
      candidateExpiresAt: plugin.candidateExpiresAt,
    } : undefined;
    if (candidateState && (!candidateState.candidateBaseDigest || candidateState.candidateExpiresAt === undefined)) {
      throw new RequestError(409, 'Der gespeicherte Plugin-Zustand ist ungültig oder wurde verändert.');
    }
    const state: UnsignedPluginState = {
      schemaVersion: 1,
      scope: this.scope,
      pluginId: plugin.instanceId,
      expectedManifestDigest: plugin.registration.expectedManifestDigest,
      initialManifest: plugin.initialManifest,
      manifest: plugin.manifest,
      enabled: plugin.enabled,
      ...(candidateState ? {
        candidate: candidateState.candidate,
        candidateBaseDigest: candidateState.candidateBaseDigest,
        candidateExpiresAt: candidateState.candidateExpiresAt,
      } : {}),
    };
    return this.signState(state);
  }

  private applyState(plugin: InstalledPlugin, state: PersistedPluginState): void {
    plugin.initialManifest = state.initialManifest;
    plugin.manifest = state.manifest;
    plugin.enabled = state.enabled;
    if (state.candidate) {
      plugin.candidate = state.candidate;
      if (state.candidateBaseDigest === undefined || state.candidateExpiresAt === undefined) throw new RequestError(409, 'Der gespeicherte Plugin-Zustand ist ungültig oder wurde verändert.');
      plugin.candidateBaseDigest = state.candidateBaseDigest;
      plugin.candidateExpiresAt = state.candidateExpiresAt;
    } else {
      delete plugin.candidate;
      delete plugin.candidateBaseDigest;
      delete plugin.candidateExpiresAt;
    }
  }

  private async refresh(plugin: InstalledPlugin): Promise<InstalledPlugin> {
    if (!await this.sourceConnected(plugin.instanceId)) throw new RequestError(409, 'Die Verbindung wurde entfernt. Bitte neu verbinden.');
    if (this.managedContracts.has(plugin.instanceId)) return this.refreshManaged(plugin);
    if (!this.store) { plugin.settings = await this.settings.binding(plugin.instanceId, plugin.manifest, plugin.registration.secretReady, plugin.registration.secretRevision); return plugin; }
    const stored = await this.store.read(this.stateKey(plugin.instanceId));
    if (!stored) throw new RequestError(409, 'Der gespeicherte Plugin-Zustand fehlt.');
    this.applyState(plugin, this.validatePersistedState(stored.value, plugin.registration, plugin.instanceId));
    plugin.settings = await this.settings.binding(plugin.instanceId, plugin.manifest, plugin.registration.secretReady, plugin.registration.secretRevision);
    return plugin;
  }

  private async refreshManaged(previous: InstalledPlugin, connecting = false): Promise<InstalledPlugin> {
    const authority = this.managedContracts.get(previous.instanceId);
    if (!authority) throw new RequestError(409, 'Die verwaltete Plugin-Freigabe fehlt.');
    // Keep each invocation's snapshot independent from concurrent refreshes.
    const plugin = { ...previous };
    try {
      let localRevision: string | undefined;
      let connectionRevision: string | undefined;
      if (this.store) {
        const record = await this.store.read(this.stateKey(plugin.instanceId));
        if (!record) throw new Error('Missing connection state');
        localRevision = record.revision;
        this.applyState(plugin, this.validatePersistedState(record.value, plugin.registration, plugin.instanceId));
        if (this.catalogSources.has(plugin.instanceId)) {
          const connection = await this.store.read(this.catalogKey(plugin.instanceId));
          const connected = connection ? this.connectionActive(connection.value, plugin.instanceId) : false;
          if (!connecting && !connected) throw new Error('Managed connection withdrawn');
          connectionRevision = connection?.revision;
        }
      }
      const contract = managedPluginRuntimeContractSchema.parse(await authority.read());
      if (contract.installationId !== plugin.instanceId || contract.manifest.id !== authority.initialManifest.id) throw new Error('Contract identity changed');
      this.validateManifestSchemas(contract.manifest);
      const statuses = new Map(contract.secretStatuses.map(secret => [secret.name, secret]));
      const registration = { ...plugin.registration,
        secretReady: (name: string) => statuses.get(name)?.configured ?? false,
        secretRevision: (name: string) => statuses.get(name)?.revision ?? null,
        credentialRevision: contract.transportCredentialRevision,
        managedDeploymentRevision: contract.deploymentRevision,
      };
      delete registration.secretCustody;
      const settings = await this.settings.binding(plugin.instanceId, contract.manifest, registration.secretReady, registration.secretRevision);
      if (!settings.ready || settings.activeRevision !== contract.configurationRevision) throw new Error('Configuration disagreement');
      const after = managedPluginRuntimeContractSchema.parse(await authority.read());
      if (digest(contract) !== digest(after)) throw new Error('Managed contract changed while refreshing');
      if (this.store && ((await this.store.read(this.stateKey(plugin.instanceId)))?.revision !== localRevision
        || this.catalogSources.has(plugin.instanceId) && (await this.store.read(this.catalogKey(plugin.instanceId)))?.revision !== connectionRevision)) throw new Error('Local connection authority changed');
      plugin.registration = registration;
      plugin.fetch = this.transport(registration);
      plugin.manifest = contract.manifest;
      plugin.settings = settings;
      plugin.managedDeploymentRevision = contract.deploymentRevision;
      plugin.healthy = true;
      delete plugin.candidate; delete plugin.candidateBaseDigest; delete plugin.candidateExpiresAt;
      this.installed.set(plugin.instanceId, plugin);
      return plugin;
    } catch {
      // Retain the connected record, but never advertise stale capabilities.
      const unavailable = { ...previous, healthy: false }; delete unavailable.settings;
      this.installed.set(plugin.instanceId, unavailable);
      throw new RequestError(409, 'Die aktuelle verwaltete Plugin-Freigabe ist nicht verfügbar.');
    }
  }

  private async updateState<R>(
    plugin: InstalledPlugin,
    update: (state: UnsignedPluginState) => { state: UnsignedPluginState; result: R },
  ): Promise<R> {
    if (!this.store) {
      const current = this.unsignedState(this.stateFromPlugin(plugin));
      const updated = update(current);
      this.applyState(plugin, this.signState(updated.state));
      return updated.result;
    }
    const stored = await updateJson<PersistedPluginState, { state: PersistedPluginState; result: R }>(
      this.store,
      this.stateKey(plugin.instanceId),
      () => { throw new RequestError(409, 'Der gespeicherte Plugin-Zustand fehlt.'); },
      value => {
        const current = this.validatePersistedState(value, plugin.registration, plugin.instanceId);
        const updated = update(this.unsignedState(current));
        const signed = this.signState(updated.state);
        return { value: signed, result: { state: signed, result: updated.result } };
      },
    );
    this.applyState(plugin, this.validatePersistedState(stored.state, plugin.registration, plugin.instanceId));
    return stored.result;
  }

  async install(registration: Registration): Promise<void> {
    return this.installRegistration(registration, false);
  }

  private async installRegistration(registration: Registration, connecting: boolean): Promise<void> {
    if (this.envelopeResults) sourcePolicySchema.parse(registration.sourcePolicy ?? this.defaultSourcePolicy);
    if (registration.secretCustody) {
      const custody = registration.secretCustody;
      registration = { ...registration, secretReady: name => custody.status(name).configured, secretRevision: name => custody.status(name).revision };
    }
    this.endpoint(registration);
    const managed = registration.instanceId ? this.managedContracts.get(registration.instanceId) : undefined;
    const liveManifest = managed ? manifestSchema.parse(managed.initialManifest) : await this.fetchManifest(registration);
    if (!valid(liveManifest.version)) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
    const instanceId = registration.instanceId ?? liveManifest.id;
    if (liveManifest.manifestVersion === 1 && instanceId !== liveManifest.id) throw new RequestError(409, 'Mehrere Installationen erfordern den V2-Vertrag.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceId)) throw new RequestError(400, 'Ungültige Installationskennung.');
    if (this.installed.has(instanceId)) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');

    let state: PersistedPluginState;
    if (this.store) {
      if (digest(liveManifest) !== registration.expectedManifestDigest) {
        const existing = await this.store.read(this.stateKey(instanceId));
        if (!existing) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
      }
      const key = this.stateKey(instanceId);
      let stored = await this.store.read(key);
      if (!stored) {
        if (digest(liveManifest) !== registration.expectedManifestDigest) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
        await this.store.compareAndSet(key, null, this.seedState(registration, liveManifest));
        stored = await this.store.read(key);
      }
      if (!stored) throw new RequestError(503, 'Der Plugin-Zustand konnte nicht gespeichert werden.');
      // A contract change requires an explicit server-owned old -> new pin.
      // Verify the entire previous signed state before retaining its enabled flag.
      for (let attempt = 0; attempt < 12; attempt++) {
        const previous = persistedStateSchema.safeParse(stored.value);
        if (!previous.success || previous.data.expectedManifestDigest === registration.expectedManifestDigest || !registration.approvedPreviousManifestDigests?.includes(previous.data.expectedManifestDigest)) break;
        if (digest(liveManifest) !== registration.expectedManifestDigest) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
        const verified = this.validatePersistedState(stored.value, { ...registration, expectedManifestDigest: previous.data.expectedManifestDigest }, instanceId);
        // Retain the verified old slot for an operator-controlled rollback.
        await this.store.compareAndSet(`${key}:backup:${previous.data.expectedManifestDigest}`, null, verified);
        const migrated = this.seedState(registration, liveManifest);
        const signed = this.signState({ ...this.unsignedState(migrated), enabled: verified.enabled });
        await this.store.compareAndSet(key, stored.revision, signed);
        const refreshed = await this.store.read(key);
        if (!refreshed) throw new RequestError(503, 'Der Plugin-Zustand konnte nicht gespeichert werden.');
        stored = refreshed;
      }
      state = this.validatePersistedState(stored.value, registration, instanceId);
    } else {
      if (digest(liveManifest) !== registration.expectedManifestDigest) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
      state = this.seedState(registration, liveManifest);
    }

    const plugin: InstalledPlugin = {
      instanceId, fetch: this.transport(registration), registration,
      initialManifest: state.initialManifest,
      manifest: state.manifest,
      enabled: state.enabled,
      healthy: true,
      ...(state.candidate && state.candidateBaseDigest !== undefined && state.candidateExpiresAt !== undefined ? { candidate: state.candidate, candidateBaseDigest: state.candidateBaseDigest, candidateExpiresAt: state.candidateExpiresAt } : {}),
    };
    this.validateManifestSchemas(plugin.manifest);
    this.installed.set(instanceId, plugin);
    try {
      if (managed) await this.refreshManaged(plugin, connecting);
      else plugin.settings = await this.settings.binding(instanceId, plugin.manifest, registration.secretReady, registration.secretRevision);
    } catch (error) { this.installed.delete(instanceId); throw error; }
  }

  list() {
    return [...this.installed.values()].map(({ instanceId, manifest, enabled, healthy, settings }) => ({ ...manifest, id: instanceId, pluginId: manifest.id, enabled, healthy, ready: settings?.ready ?? false, configurationRevision: settings?.activeRevision ?? 0 }));
  }

  version(id: string): string { return this.get(id).manifest.version; }
  private candidateTools(actor: ActorContext) {
    return [...this.installed.values()].filter(plugin => plugin.enabled && plugin.settings?.ready).flatMap(plugin => plugin.manifest.tools.filter(tool => tool.effect !== 'execute' && !plugin.settings?.disabledTools.includes(tool.name) && ((tool as ToolDefinitionV2).visibility ?? ['model']).includes('model') && tool.requiredPermissions.every(permission => actor.permissions.includes(permission))).map(tool => ({ pluginId: plugin.instanceId, modelName: `hasi_${createHash('sha256').update(`${plugin.instanceId}\0${tool.name}`).digest('hex').slice(0, 24)}`, ...tool })));
  }
  modelTools(actor: ActorContext) { return this.authorizedModelTools(actor); }
  async authorizedModelTools(actor: ActorContext) {
    for (const id of this.managedContracts.keys()) {
      const plugin = this.installed.get(id);
      if (plugin) {
        try { await this.refresh(plugin); }
        catch { const unavailable = { ...plugin, healthy: false }; delete unavailable.settings; this.installed.set(id, unavailable); }
      }
    }
    const tools = this.candidateTools(actor);
    const allowed: typeof tools = [];
    for (const id of new Set(tools.map(tool => tool.pluginId))) {
      try {
        const current = await this.actorFor(id, actor);
        allowed.push(...tools.filter(tool => tool.pluginId === id && tool.requiredPermissions.every(permission => current.actor.permissions.includes(permission))));
      } catch (error) { if (!(error instanceof PluginAccountError)) throw error; }
    }
    return allowed;
  }
  private async actorFor(id: string, actor: ActorContext) {
    if (this.resolveActor) {
      const current = await this.resolveActor(actor.subject);
      if (current?.subject !== actor.subject) throw new RequestError(403, 'Die aktuellen Kontorechte geben diese Aktion nicht frei.');
      actor = { ...current, permissions: actor.permissions.filter(permission => current.permissions.includes(permission)) };
    }
    const account = this.accounts.get(id);
    if (!account) return { actor, revision: undefined };
    const current = await account.resolveAuthority(actor.subject);
    const projection = current.projection;
    const projected: ActorContext = { subject: actor.subject, permissions: actor.permissions.filter(permission => projection.permissions.includes(permission)), ...(projection.customerId ? { customerId: projection.customerId } : {}), ...(projection.resourceIds ? { resourceIds: projection.resourceIds } : {}), ...(projection.claims ? { claims: projection.claims } : {}) };
    return { actor: projected, revision: current.authorityRevision };
  }
  private get(id: string): InstalledPlugin { const plugin = this.installed.get(id); if (!plugin) throw new RequestError(404, 'Plugin nicht gefunden.'); return plugin; }

  configureCatalog(sources: readonly ApprovedPluginSource[]): void {
    if (sources.length > 32) throw new RequestError(400, 'Zu viele freigegebene Quellen.');
    for (const source of sources) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.id) || this.catalogSources.has(source.id) || source.registration.instanceId !== source.id) throw new RequestError(400, 'Ungültiger freigegebener Katalog.');
      this.endpoint(source.registration);
      this.catalogSources.set(source.id, source);
    }
  }
  catalog() { return [...this.catalogSources.values()].map(source => ({ id: source.id, label: source.label, connected: this.installed.has(source.id) })); }
  private catalogKey(id: string) { return `plugin-connection:v1:${digest({ scope: this.scope, id })}`; }
  private connectionRecord(id: string, connected: boolean) {
    const value = { version: 1, scope: this.scope, id, connected };
    return { value, signature: sign(null, Buffer.from(digest(value)), this.privateKey).toString('base64url') };
  }
  private connectionActive(raw: unknown, id: string) {
    const parsed = z.strictObject({ value: z.strictObject({ version: z.literal(1), scope: z.string(), id: z.string(), connected: z.boolean() }), signature: z.string() }).parse(raw);
    if (parsed.value.scope !== this.scope || parsed.value.id !== id || !verify(null, Buffer.from(digest(parsed.value)), this.publicKey, Buffer.from(parsed.signature, 'base64url'))) throw new RequestError(409, 'Ungültige gespeicherte Verbindung.');
    return parsed.value.connected;
  }
  async restoreConnections(): Promise<void> {
    if (!this.store) return;
    for (const source of this.catalogSources.values()) {
      try {
        const record = await this.store.read(this.catalogKey(source.id));
        if (record && this.connectionActive(record.value, source.id) && !this.installed.has(source.id)) await this.install(source.registration);
      } catch (error) { if (!this.managedContracts.has(source.id)) throw error; }
    }
  }
  async connectSource(id: string): Promise<void> {
    const source = this.catalogSources.get(id);
    if (!source) throw new RequestError(403, 'Diese Quelle wurde nicht von der Betreiberseite freigegeben.');
    if (this.installed.has(id)) throw new RequestError(409, 'Diese Verbindung ist bereits installiert.');
    await this.installRegistration(source.registration, true);
    if (this.store) {
      try { await updateJson<unknown, undefined>(this.store, this.catalogKey(id), () => this.connectionRecord(id, false), raw => { this.connectionActive(raw, id); return { value: this.connectionRecord(id, true), result: undefined }; }); }
      catch { this.installed.delete(id); throw new RequestError(503, 'Die Verbindung konnte nicht dauerhaft gespeichert werden.'); }
    }
  }
  async removeSource(id: string): Promise<void> {
    if (!this.catalogSources.has(id)) throw new RequestError(403, 'Gebündelte Dienste werden über die Betreiberkonfiguration entfernt.');
    if (this.installed.has(id)) await this.setEnabled(id, false);
    if (this.store) await updateJson<unknown, undefined>(this.store, this.catalogKey(id), () => this.connectionRecord(id, false), raw => { this.connectionActive(raw, id); return { value: this.connectionRecord(id, false), result: undefined }; });
    this.installed.delete(id);
  }

  private async sourceConnected(id: string): Promise<boolean> {
    if (!this.catalogSources.has(id) || !this.store) return true;
    const record = await this.store.read(this.catalogKey(id));
    return record !== undefined && this.connectionActive(record.value, id);
  }
  async refreshAll(): Promise<void> {
    // A worker outage/withdrawn route must not prevent unrelated sources from working.
    // Connected managed sources resume only after fresh private authority succeeds.
    for (const source of this.catalogSources.values()) {
      if (this.managedContracts.has(source.id) && !this.installed.has(source.id)) {
        try { if (await this.sourceConnected(source.id)) await this.install(source.registration); } catch { /* Keep this source unavailable. */ }
      }
    }
    for (const plugin of [...this.installed.values()]) {
      try {
        if (!await this.sourceConnected(plugin.instanceId)) this.installed.delete(plugin.instanceId);
        else await this.refresh(plugin);
      } catch (error) {
        if (!this.managedContracts.has(plugin.instanceId)) throw error;
        const unavailable = { ...plugin, healthy: false }; delete unavailable.settings;
        this.installed.set(plugin.instanceId, unavailable);
      }
    }
  }
  private bindingFor(plugin: InstalledPlugin): string {
    return digest({ instanceId: plugin.instanceId, manifest: digest(plugin.manifest), configuration: plugin.settings?.digest ?? null, enabled: plugin.enabled, endpoint: this.endpoint(plugin.registration).href, credentialRevision: plugin.registration.credentialRevision ?? 'legacy-v1', network: plugin.registration.allowedPrivateCidrs ?? [], sourcePolicy: plugin.registration.sourcePolicy ?? this.defaultSourcePolicy ?? null, ...(plugin.managedDeploymentRevision ? { deployment: plugin.managedDeploymentRevision } : {}) });
  }
  async binding(id: string) { return this.bindingFor(await this.refresh(this.get(id))); }
  async authorityBinding(id: string, actor: ActorContext) {
    const current = await this.actorFor(id, actor);
    return digest({ actor: projectActorContext(current.actor, this.get(id).manifest), accountRevision: current.revision ?? null });
  }
  /** Read-only recovery can survive renewal only if the complete current account/grant projection agrees. */
  async reconciliationAuthorityBinding(id: string, actor: ActorContext) {
    return digest(projectActorContext((await this.actorFor(id, actor)).actor, this.get(id).manifest));
  }
  manifest(id: string): PluginManifest { return this.get(id).manifest; }
  validateExecutionResult(id: string, name: string, result: Record<string, unknown>) {
    const tool = this.get(id).manifest.tools.find(candidate => candidate.name === name && candidate.effect === 'execute');
    if (Object.hasOwn(result, '_hasi') || !tool || !validateSchema(tool.outputSchema, result) || Buffer.byteLength(JSON.stringify(result)) > 65536) throw new RequestError(502, 'Der Ausführungsbeleg entspricht nicht dem Vertrag.');
  }
  async projectExecutionReceipt(id: string, name: string, result: Record<string, unknown>, actor: ActorContext) {
    this.validateExecutionResult(id, name, result);
    const plugin = await this.refresh(this.get(id));
    const projected = (await this.actorFor(id, actor)).actor;
    return this.projectOutput(plugin, name, result, projectActorContext(projected, plugin.manifest));
  }
  private projectOutput(plugin: InstalledPlugin, name: string, output: Record<string, unknown>, actor: ActorContext) {
    return this.envelopeResults ? resultEnvelope({ instanceId: plugin.instanceId, manifest: plugin.manifest, configurationRevision: plugin.settings?.activeRevision ?? 0, actor, policy: sourcePolicySchema.parse(plugin.registration.sourcePolicy ?? this.defaultSourcePolicy), output, tool: name, ...(plugin.registration.pagination ? { pagination: plugin.registration.pagination } : {}) }) : output;
  }
  registration(id: string): Registration { return this.get(id).registration; }
  async configuration(id: string) { const plugin = await this.refresh(this.get(id)); return this.settings.describe(id, plugin.manifest, plugin.registration.secretReady, plugin.registration.secretRevision); }
  async configurationActivated(id: string) {
    const plugin = await this.refresh(this.get(id));
    await this.deploymentBindings.get(id)?.configurationActivated(id, plugin.settings?.activeRevision ?? 0);
  }
  /** Tests transport/contract readiness only; no business tool or credential readback. */
  async testConnection(id: string): Promise<PluginConnectionTestResult> {
    const plugin = this.get(id);
    const result: PluginConnectionTestResult = {
      instanceId: id, checkedAt: new Date().toISOString(), configured: 'incomplete',
      reachable: 'failed', authenticated: 'not_verified', authorized: 'not_assessed',
      userReady: 'blocked', remedies: [],
    };
    const client = new Client({ name: 'hasi-core-connection-test', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' }, listMaxPages: 1 });
    try {
      await this.refresh(plugin);
      result.configured = plugin.settings?.ready ? 'ready' : 'incomplete';
      for (const secret of plugin.settings?.secrets ?? []) {
        if (secret.required && !secret.configured) result.remedies.push({ code: 'secret_missing', field: secret.name, message: 'Erforderliche Zugangsdaten müssen serverseitig eingerichtet werden.' });
      }
      if (!plugin.settings?.ready && result.remedies.length === 0) result.remedies.push({ code: 'configuration_incomplete', message: 'Bitte die aktive Konfiguration prüfen und einen gültigen Entwurf aktivieren.' });
      if (!plugin.enabled) result.remedies.push({ code: 'disabled', message: 'Die Verbindung ist deaktiviert. Eine Prüfung aktiviert sie nicht.' });
      const expectedBinding = this.bindingFor(plugin);
      const liveManifest = await this.fetchManifest(plugin.registration);
      if (digest(liveManifest) !== digest(plugin.manifest)) throw new RequestError(409, 'Schnittstelle geändert.');
      const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}` }, redirect: 'error' }, fetch: plugin.fetch });
      const signal = AbortSignal.timeout(5000);
      await client.connect(transport, { signal, timeout: 5000 });
      if (client.getServerVersion()?.version !== plugin.manifest.version) throw new RequestError(409, 'Schnittstelle geändert.');
      const advertised = await client.listTools({ cursor: '' }, { signal, timeout: 5000, cacheMode: 'bypass' });
      const names = new Set(advertised.tools.map(tool => tool.name));
      if (advertised.nextCursor || names.size !== advertised.tools.length || names.size !== plugin.manifest.tools.length || plugin.manifest.tools.some(tool => !names.has(tool.name))) throw new RequestError(409, 'Schnittstelle geändert.');
      for (const tool of advertised.tools) {
        const approved = plugin.manifest.tools.find(item => item.name === tool.name);
        if (!approved || digest(tool.inputSchema) !== digest(approved.inputSchema) || digest(tool.outputSchema ?? null) !== digest(approved.outputSchema)) throw new RequestError(409, 'Schnittstelle geändert.');
      }
      const current = await this.refresh(this.get(id));
      if (this.bindingFor(current) !== expectedBinding) throw new RequestError(409, 'Schnittstelle geändert.');
      result.reachable = 'verified';
      result.userReady = current.enabled && current.settings?.ready ? 'not_assessed' : 'blocked';
      plugin.healthy = true;
    } catch (error) {
      plugin.healthy = false;
      const status = error instanceof RequestError || error instanceof SdkHttpError ? error.status : undefined;
      if (status === 401) {
        result.authenticated = 'rejected';
        result.remedies.push({ code: 'authentication_rejected', message: 'Die Dienstanmeldung wurde abgelehnt. Bitte die serverseitige Zugangsfreigabe prüfen.' });
      } else if (status === 409) result.remedies.push({ code: 'contract_changed', message: 'Die freigegebene Schnittstelle oder Konfiguration hat sich geändert. Bitte neu prüfen und freigeben.' });
      else result.remedies.push({ code: 'connection_failed', message: 'Verbindung oder Schnittstellenprüfung fehlgeschlagen. Bitte Erreichbarkeit und Betreiberfreigabe prüfen.' });
    } finally { await client.close().catch(() => undefined); }
    return result;
  }
  async readPresentation(id: string, presentationId: string, actor: ActorContext) {
    const originalActor = actor;
    const authority = await this.authorityBinding(id, actor);
    actor = (await this.actorFor(id, actor)).actor;
    const plugin = await this.refresh(this.get(id));
    if (!plugin.enabled || !plugin.settings?.ready || plugin.manifest.manifestVersion !== 2) throw new RequestError(404, 'Ansicht nicht verfügbar.');
    const approvedDigest = digest(plugin.manifest);
    const approvedSettings = plugin.settings.digest;
    const presentation = plugin.manifest.presentations?.find(item => item.id === presentationId);
    const tools = plugin.manifest.tools.filter(tool => tool.presentationId === presentationId && tool.effect === 'read' && !plugin.settings?.disabledTools.includes(tool.name) && (tool.visibility ?? ['model']).includes('app') && tool.requiredPermissions.every(permission => actor.permissions.includes(permission)));
    if (!presentation || !tools.length || !this.reviewedAppDigests.has(presentation.sha256.toLowerCase())) throw new RequestError(404, 'Ansicht nicht verfügbar.');
    const client = new Client({ name: 'hasi-core', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}` }, redirect: 'error' }, fetch: plugin.fetch });
    try {
      await client.connect(transport);
      if (client.getServerVersion()?.version !== plugin.manifest.version) throw new RequestError(409, 'Plugin-Version geändert.');
      const result = await client.readResource({ uri: presentation.resourceUri });
      const resource = result.contents[0];
      if (result.contents.length !== 1 || !resource || !('text' in resource) || typeof resource.text !== 'string' || resource.uri !== presentation.resourceUri || resource.mimeType !== presentation.mimeType || Buffer.byteLength(resource.text) > 1024 * 1024 || createHash('sha256').update(resource.text).digest('hex') !== presentation.sha256.toLowerCase()) throw new RequestError(502, 'Die Ansicht entspricht nicht der Freigabe.');
      const refreshed = await this.refresh(this.get(id));
      if (!refreshed.enabled || !refreshed.settings?.ready || digest(refreshed.manifest) !== approvedDigest || refreshed.settings.digest !== approvedSettings) throw new RequestError(409, 'Ansicht nicht mehr freigegeben.');
      if (authority !== await this.authorityBinding(id, originalActor)) throw new RequestError(409, 'Die persönliche Kontoberechtigung wurde geändert.');
      return { resourceHtml: resource.text, resourceSha256: presentation.sha256, csp: presentation.csp, tools: tools.map(tool => ({ name: tool.name, effect: tool.effect, visibility: tool.visibility ?? ['model'] })) };
    } finally { await client.close(); }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    // Withdrawal must remain possible while a managed worker is unavailable.
    const plugin = !enabled && this.managedContracts.has(id) ? this.get(id) : await this.refresh(this.get(id));
    await this.updateState(plugin, state => ({ state: { ...state, enabled }, result: undefined }));
  }

  async checkUpdate(id: string) {
    if (this.managedContracts.has(id)) throw new RequestError(409, 'Verwaltete Releases werden in der Installationsverwaltung geprüft.');
    const plugin = await this.refresh(this.get(id));
    const baseDigest = digest(plugin.manifest);
    await this.updateState(plugin, state => {
      if (digest(state.manifest) !== baseDigest) throw new RequestError(409, 'Die Plugin-Version wurde parallel geändert. Bitte erneut prüfen.');
      return { state: this.withoutCandidate(state), result: undefined };
    });

    const candidate = await this.fetchManifest(plugin.registration);
    plugin.healthy = true;
    if (digest(candidate) === baseDigest) return { status: 'current' as const, message: 'Das Plugin ist aktuell.' };
    if (!compatibleUpdate(plugin.manifest, candidate)) return { status: 'blocked' as const, message: 'Geänderte Schnittstellen oder Berechtigungen erfordern eine neue Freigabe.' };

    const candidateExpiresAt = Date.now() + this.candidateTtlMs;
    await this.updateState(plugin, state => {
      if (digest(state.manifest) !== baseDigest) throw new RequestError(409, 'Die Plugin-Version wurde parallel geändert. Bitte erneut prüfen.');
      return {
        state: { ...state, candidate, candidateBaseDigest: baseDigest, candidateExpiresAt },
        result: undefined,
      };
    });
    return { status: 'available' as const, message: `Version ${candidate.version} kann ohne Neustart von HASI aktiviert werden.` };
  }

  async activateUpdate(id: string): Promise<void> {
    if (this.managedContracts.has(id)) throw new RequestError(409, 'Verwaltete Releases werden in der Installationsverwaltung aktiviert.');
    const plugin = await this.refresh(this.get(id));
    const result = await this.updateState(plugin, state => {
      const candidate = state.candidate;
      if (!candidate) return { state, result: 'missing' as const };
      if (state.candidateBaseDigest !== digest(state.manifest) || !compatibleUpdate(state.manifest, candidate)) {
        return { state: this.withoutCandidate(state), result: 'stale' as const };
      }
      if (state.candidateExpiresAt === undefined || state.candidateExpiresAt <= Date.now()) {
        return { state: this.withoutCandidate(state), result: 'stale' as const };
      }
      return { state: { ...this.withoutCandidate(state), manifest: candidate }, result: 'activated' as const };
    });
    if (result !== 'activated') throw new RequestError(409, 'Keine kompatible Version zur Aktivierung vorhanden.');
  }

  /** Reads a signed, plugin-side execution receipt; never calls a business tool. */
  async reconcile(id: string, name: string, args: Record<string, unknown>, actor: ActorContext, executionId: string, expectedBinding: string) {
    const plugin = await this.refresh(this.get(id));
    this.assertInvocation(plugin, name, args, actor, true);
    const originalActor = actor;
    const authority = await this.authorityBinding(id, originalActor);
    actor = (await this.actorFor(id, originalActor)).actor;
    if (this.bindingFor(plugin) !== expectedBinding) throw new RequestError(409, 'Die Aktionsfreigabe hat sich geändert. Bitte den zuständigen Dienst prüfen.');
    const tool = this.assertInvocation(plugin, name, args, actor, true);
    if (tool.effect !== 'execute') throw new RequestError(403, 'Kein ausführbares Werkzeug.');
    const body = { executionId, tool: name, argsHash: digest(args) };
    const context = { installationId: id, configurationRevision: plugin.settings?.activeRevision ?? 0, configuration: plugin.settings?.configuration ?? {}, executionId };
    const token = await createInvocationToken({ actor: projectActorContext(actor, plugin.manifest), pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, tool: '__hasi.action_status', args: body, context }, this.privateKey);
    const response = await plugin.fetch(new URL('./hasi/actions/status', plugin.registration.endpoint), { method: 'POST', headers: { authorization: `Bearer ${plugin.registration.serviceToken}`, 'x-hasi-invocation': token, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { status: 'outcome_unknown' as const };
    const raw: unknown = await response.json();
    const resolution = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('confirmed'), result: z.record(z.string(), z.unknown()) }), z.strictObject({ status: z.literal('outcome_unknown') })]).parse(raw);
    if (resolution.status === 'confirmed') this.validateExecutionResult(id, name, resolution.result);
    if (this.bindingFor(await this.refresh(plugin)) !== expectedBinding) throw new RequestError(409, 'Die Aktionsfreigabe hat sich geändert.');
    if (authority !== await this.authorityBinding(id, originalActor)) throw new RequestError(409, 'Die persönliche Kontoberechtigung wurde geändert.');
    return resolution;
  }

  private assertInvocation(plugin: InstalledPlugin, name: string, args: Record<string, unknown>, actor: ActorContext, execution: boolean, source: 'model' | 'app' = 'model') {
    if (!plugin.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
    if (!plugin.settings?.ready) throw new RequestError(409, 'Das Plugin ist noch nicht vollständig konfiguriert.');
    if (plugin.settings.disabledTools.includes(name)) throw new RequestError(403, 'Dieses Tool ist deaktiviert.');
    const tool = plugin.manifest.tools.find(candidate => candidate.name === name);
    if (tool && !execution && (!( (tool as ToolDefinitionV2).visibility ?? ['model']).includes(source) || (source === 'app' && tool.effect !== 'read'))) throw new RequestError(403, 'Dieser Aufruf ist für die Oberfläche nicht freigegeben.');
    if (!tool || (tool.effect === 'execute' && !execution)) throw new RequestError(403, 'Dieser Tool-Aufruf ist nicht freigegeben.');
    if (!tool.requiredPermissions.every(permission => actor.permissions.includes(permission))) throw new RequestError(403, 'Die Berechtigung für diese Aktion fehlt.');
    if (!validateSchema(tool.inputSchema, args)) throw new RequestError(400, 'Ungültige Tool-Argumente.');
    return tool;
  }

  async invoke(id: string, name: string, args: Record<string, unknown>, actor: ActorContext, execution = false, source: 'model' | 'app' = 'model', expectedBinding?: string, executionId?: string): Promise<Record<string, unknown>> {
    const plugin = await this.refresh(this.get(id));
    this.assertInvocation(plugin, name, args, actor, execution, source);
    const originalActor = actor;
    const authority = await this.authorityBinding(id, originalActor);
    actor = (await this.actorFor(id, originalActor)).actor;
    await this.deploymentBindings.get(id)?.assertCurrent(id, plugin.settings?.activeRevision ?? 0);
    if (expectedBinding !== undefined && this.bindingFor(plugin) !== expectedBinding) throw new RequestError(409, 'Die bestätigte Plugin-Konfiguration ist nicht mehr aktuell.');
    this.assertInvocation(plugin, name, args, actor, execution, source);
    const version = plugin.manifest.version;
    const invocationBinding = this.bindingFor(plugin);
    const settingsDigest = plugin.settings?.digest;
    const manifestDigest = digest(plugin.manifest);
    const tokenActor = projectActorContext(actor, plugin.manifest);
    const token = await createInvocationToken({ actor: tokenActor, pluginId: plugin.manifest.id, pluginVersion: version, tool: name, args, ...(plugin.manifest.manifestVersion === 2 || executionId ? { context: { installationId: id, configurationRevision: plugin.settings?.activeRevision ?? 0, configuration: plugin.settings?.configuration ?? {}, ...(executionId ? { executionId } : {}) } } : {}) }, this.privateKey);
    const client = new Client({ name: 'hasi-core', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}`, 'x-hasi-invocation': token }, redirect: 'error' }, fetch: plugin.fetch });
    try {
      await client.connect(transport);
      const current = await this.refresh(plugin);
      await this.deploymentBindings.get(id)?.assertCurrent(id, current.settings?.activeRevision ?? 0);
      if (authority !== await this.authorityBinding(id, originalActor)) throw new RequestError(409, 'Die persönliche Kontoberechtigung wurde geändert.');
      if (expectedBinding !== undefined && this.bindingFor(current) !== expectedBinding) throw new RequestError(409, 'Die bestätigte Plugin-Konfiguration ist nicht mehr aktuell.');
      if (!current.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
      if (plugin.managedDeploymentRevision && this.bindingFor(current) !== invocationBinding) throw new RequestError(409, 'Die freigegebene Plugin-Installation wurde geändert.');
      if (digest(current.manifest) !== manifestDigest || current.settings?.digest !== settingsDigest) throw new RequestError(409, 'Die Plugin-Version wurde geändert. Bitte erneut prüfen und freigeben.');
      const currentTool = this.assertInvocation(current, name, args, actor, execution, source);
      const serverVersion = client.getServerVersion();
      if (serverVersion?.version !== current.manifest.version) throw new RequestError(409, 'Die Plugin-Version hat sich geändert. Bitte zuerst prüfen und freigeben.');
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new RequestError(502, 'Die Plugin-Anfrage konnte nicht ausgeführt werden.');
      const output: unknown = result.structuredContent;
      if (!output || typeof output !== 'object' || Array.isArray(output) || !validator.validate(currentTool.outputSchema, output)) throw new RequestError(502, 'Die Plugin-Antwort entspricht nicht dem vereinbarten Vertrag.');
      if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw new RequestError(502, 'Die Plugin-Antwort ist zu groß.');
      if (authority !== await this.authorityBinding(id, originalActor)) throw new RequestError(409, 'Die persönliche Kontoberechtigung wurde geändert.');
      if (plugin.managedDeploymentRevision && this.bindingFor(await this.refresh(plugin)) !== invocationBinding) throw new RequestError(409, 'Die freigegebene Plugin-Installation wurde geändert.');
      plugin.healthy = true;
      return this.projectOutput(current, name, output as Record<string, unknown>, tokenActor);
    } catch (error) {
      plugin.healthy = false;
      throw error;
    } finally { await client.close(); }
  }
}
