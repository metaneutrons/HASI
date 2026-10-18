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

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface Registration {
  /** Trusted installation identity; package identity remains the signed MCP audience. */
  instanceId?: string;
  /** Operator revision for secret rotation/deployment identity; never a secret-derived fingerprint. */
  credentialRevision?: string;
  /** Explicit operator-approved campus/private network exceptions. */
  allowedPrivateCidrs?: readonly string[];
  /** Logical slot readiness resolved by the operator, never request input. */
  secretReady?: (name: string) => boolean;
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  allowLoopback: boolean;
  /** Operator-approved previous pins for an intentional contract migration. Never request input. */
  approvedPreviousManifestDigests?: readonly string[];
}

export interface ApprovedPluginSource { id: string; label: string; registration: Registration }

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
  store?: JsonStore;
  /** Server-owned namespace for persisted plugin state. */
  scope?: string;
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

  constructor(private readonly privateKey: KeyObject, options: PluginRegistryOptions = {}) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('Plugin registry state requires an Ed25519 private key');
    }
    const scope = options.scope ?? DEFAULT_SCOPE;
    if (!scope.trim() || scope.length > 256) throw new TypeError('Plugin registry scope must be a non-empty server-owned string');
    const candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS;
    if (!Number.isSafeInteger(candidateTtlMs) || candidateTtlMs < 1) throw new TypeError('Candidate TTL must be a positive safe integer');
    this.store = options.store;
    this.scope = scope;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || ! /^(?:\/[A-Za-z0-9._~-]+)*\/mcp$/.test(endpoint.pathname) || (endpoint.protocol !== 'https:' && !(registration.allowLoopback && loopback && endpoint.protocol === 'http:'))) throw new RequestError(400, 'Unzulässiger Plugin-Endpunkt.');
    return endpoint;
  }

  private transport(registration: Registration): typeof fetch {
    if (this.fetchImpl !== fetch) return this.fetchImpl;
    const endpoint = this.endpoint(registration);
    const policyKey = digest({ origin: endpoint.origin, loopback: registration.allowLoopback, privateCidrs: registration.allowedPrivateCidrs ?? [] });
    let transport = this.transports.get(policyKey);
    if (!transport) {
      transport = createPluginFetch({ origins: [endpoint.origin], allowLoopback: registration.allowLoopback, ...(registration.allowedPrivateCidrs ? { allowedPrivateCidrs: registration.allowedPrivateCidrs } : {}), maxResponseBytes: 2 * 1024 * 1024 });
      this.transports.set(policyKey, transport);
    }
    return transport;
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
    if (!this.store) { plugin.settings = await this.settings.binding(plugin.instanceId, plugin.manifest, plugin.registration.secretReady); return plugin; }
    const stored = await this.store.read(this.stateKey(plugin.instanceId));
    if (!stored) throw new RequestError(409, 'Der gespeicherte Plugin-Zustand fehlt.');
    this.applyState(plugin, this.validatePersistedState(stored.value, plugin.registration, plugin.instanceId));
    plugin.settings = await this.settings.binding(plugin.instanceId, plugin.manifest, plugin.registration.secretReady);
    return plugin;
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
    this.endpoint(registration);
    const liveManifest = await this.fetchManifest(registration);
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
    plugin.settings = await this.settings.binding(instanceId, plugin.manifest, registration.secretReady);
    this.installed.set(instanceId, plugin);
  }

  list() {
    return [...this.installed.values()].map(({ instanceId, manifest, enabled, healthy, settings }) => ({ ...manifest, id: instanceId, pluginId: manifest.id, enabled, healthy, ready: settings?.ready ?? false, configurationRevision: settings?.activeRevision ?? 0 }));
  }

  version(id: string): string { return this.get(id).manifest.version; }
  modelTools(actor: ActorContext) {
    return [...this.installed.values()].filter(plugin => plugin.enabled && plugin.settings?.ready).flatMap(plugin => plugin.manifest.tools.filter(tool => tool.effect !== 'execute' && !plugin.settings?.disabledTools.includes(tool.name) && ((tool as ToolDefinitionV2).visibility ?? ['model']).includes('model') && tool.requiredPermissions.every(permission => actor.permissions.includes(permission))).map(tool => ({ pluginId: plugin.instanceId, modelName: `hasi_${createHash('sha256').update(`${plugin.instanceId}\0${tool.name}`).digest('hex').slice(0, 24)}`, ...tool })));
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
      const record = await this.store.read(this.catalogKey(source.id));
      if (record && this.connectionActive(record.value, source.id) && !this.installed.has(source.id)) await this.install(source.registration);
    }
  }
  async connectSource(id: string): Promise<void> {
    const source = this.catalogSources.get(id);
    if (!source) throw new RequestError(403, 'Diese Quelle wurde nicht von der Betreiberseite freigegeben.');
    if (this.installed.has(id)) throw new RequestError(409, 'Diese Verbindung ist bereits installiert.');
    await this.install(source.registration);
    if (this.store) {
      try { await updateJson<unknown, undefined>(this.store, this.catalogKey(id), () => this.connectionRecord(id, false), raw => { this.connectionActive(raw, id); return { value: this.connectionRecord(id, true), result: undefined }; }); }
      catch { this.installed.delete(id); throw new RequestError(503, 'Die Verbindung konnte nicht dauerhaft gespeichert werden.'); }
    }
  }
  async removeSource(id: string): Promise<void> {
    if (!this.catalogSources.has(id)) throw new RequestError(403, 'Gebündelte Dienste werden über die Betreiberkonfiguration entfernt.');
    await this.setEnabled(id, false);
    if (this.store) await updateJson<unknown, undefined>(this.store, this.catalogKey(id), () => this.connectionRecord(id, false), raw => { this.connectionActive(raw, id); return { value: this.connectionRecord(id, false), result: undefined }; });
    this.installed.delete(id);
  }

  private async sourceConnected(id: string): Promise<boolean> {
    if (!this.catalogSources.has(id) || !this.store) return true;
    const record = await this.store.read(this.catalogKey(id));
    return record !== undefined && this.connectionActive(record.value, id);
  }
  async refreshAll(): Promise<void> {
    for (const plugin of [...this.installed.values()]) {
      if (!await this.sourceConnected(plugin.instanceId)) this.installed.delete(plugin.instanceId);
      else await this.refresh(plugin);
    }
  }
  private bindingFor(plugin: InstalledPlugin): string {
    return digest({ instanceId: plugin.instanceId, manifest: digest(plugin.manifest), configuration: plugin.settings?.digest ?? null, enabled: plugin.enabled, endpoint: this.endpoint(plugin.registration).href, credentialRevision: plugin.registration.credentialRevision ?? 'legacy-v1', network: plugin.registration.allowedPrivateCidrs ?? [] });
  }
  async binding(id: string) { return this.bindingFor(await this.refresh(this.get(id))); }
  authorityBinding(id: string, actor: ActorContext) { return digest(projectActorContext(actor, this.get(id).manifest)); }
  manifest(id: string): PluginManifest { return this.get(id).manifest; }
  registration(id: string): Registration { return this.get(id).registration; }
  async configuration(id: string) { const plugin = await this.refresh(this.get(id)); return this.settings.describe(id, plugin.manifest, plugin.registration.secretReady); }
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
      return { resourceHtml: resource.text, resourceSha256: presentation.sha256, csp: presentation.csp, tools: tools.map(tool => ({ name: tool.name, effect: tool.effect, visibility: tool.visibility ?? ['model'] })) };
    } finally { await client.close(); }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = await this.refresh(this.get(id));
    await this.updateState(plugin, state => ({ state: { ...state, enabled }, result: undefined }));
  }

  async checkUpdate(id: string) {
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

  async invoke(id: string, name: string, args: Record<string, unknown>, actor: ActorContext, execution = false, source: 'model' | 'app' = 'model', expectedBinding?: string): Promise<Record<string, unknown>> {
    const plugin = await this.refresh(this.get(id));
    if (expectedBinding !== undefined && this.bindingFor(plugin) !== expectedBinding) throw new RequestError(409, 'Die bestätigte Plugin-Konfiguration ist nicht mehr aktuell.');
    this.assertInvocation(plugin, name, args, actor, execution, source);
    const version = plugin.manifest.version;
    const settingsDigest = plugin.settings?.digest;
    const manifestDigest = digest(plugin.manifest);
    const tokenActor = projectActorContext(actor, plugin.manifest);
    // The legacy knowledge adapter needs its fixture audience grants, not room claims.
    if (plugin.manifest.manifestVersion === 1 && plugin.manifest.id === 'de.hsh.hasi.knowledge') tokenActor.permissions = actor.permissions.filter(permission => permission.startsWith('knowledge:'));
    const token = await createInvocationToken({ actor: tokenActor, pluginId: plugin.manifest.id, pluginVersion: version, tool: name, args, ...(plugin.manifest.manifestVersion === 2 ? { context: { installationId: id, configurationRevision: plugin.settings?.activeRevision ?? 0, configuration: plugin.settings?.configuration ?? {} } } : {}) }, this.privateKey);
    const client = new Client({ name: 'hasi-core', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}`, 'x-hasi-invocation': token }, redirect: 'error' }, fetch: plugin.fetch });
    try {
      await client.connect(transport);
      const current = await this.refresh(plugin);
      if (expectedBinding !== undefined && this.bindingFor(current) !== expectedBinding) throw new RequestError(409, 'Die bestätigte Plugin-Konfiguration ist nicht mehr aktuell.');
      if (!current.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
      if (digest(current.manifest) !== manifestDigest || current.settings?.digest !== settingsDigest) throw new RequestError(409, 'Die Plugin-Version wurde geändert. Bitte erneut prüfen und freigeben.');
      const currentTool = this.assertInvocation(current, name, args, actor, execution, source);
      const serverVersion = client.getServerVersion();
      if (serverVersion?.version !== current.manifest.version) throw new RequestError(409, 'Die Plugin-Version hat sich geändert. Bitte zuerst prüfen und freigeben.');
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new RequestError(502, 'Die Plugin-Anfrage konnte nicht ausgeführt werden.');
      const output: unknown = result.structuredContent;
      if (!output || typeof output !== 'object' || Array.isArray(output) || !validator.validate(currentTool.outputSchema, output)) throw new RequestError(502, 'Die Plugin-Antwort entspricht nicht dem vereinbarten Vertrag.');
      if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw new RequestError(502, 'Die Plugin-Antwort ist zu groß.');
      plugin.healthy = true;
      return output as Record<string, unknown>;
    } catch (error) {
      plugin.healthy = false;
      throw error;
    } finally { await client.close(); }
  }
}
