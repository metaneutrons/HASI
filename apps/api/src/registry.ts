import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { valid, major, gt } from 'semver';
import { updateJson, type JsonStore } from '@hasi/state';
import { createInvocationToken, digest, manifestSchema, type ActorContext, type PluginManifest } from '@hasi/plugin-sdk';
import { z } from 'zod';

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface Registration {
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  allowLoopback: boolean;
  /** Operator-approved previous pins for an intentional contract migration. Never request input. */
  approvedPreviousManifestDigests?: readonly string[];
}

export interface PluginRegistryOptions {
  store?: JsonStore;
  /** Server-owned namespace for persisted plugin state. */
  scope?: string;
  fetch?: typeof fetch;
  /** Pending update candidates expire after this many milliseconds. Defaults to seven days. */
  candidateTtlMs?: number;
}

interface InstalledPlugin {
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
  const contract = (manifest: PluginManifest) => manifest.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, effect: tool.effect, requiredPermissions: [...tool.requiredPermissions].sort() })).sort((a,b) => a.name.localeCompare(b.name));
  return digest(contract(current)) === digest(contract(candidate));
}

export class PluginRegistry {
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly store: JsonStore | undefined;
  private readonly scope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly candidateTtlMs: number;
  private readonly publicKey: KeyObject;

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
    this.publicKey = createPublicKey(privateKey);
  }

  private stateKey(id: string): string {
    return `hasi:plugin-registry:v1:${digest({ scope: this.scope, pluginId: id })}`;
  }

  private endpoint(registration: Registration): URL {
    const endpoint = new URL(registration.endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/(?:plugins\/[a-z0-9-]+\/)?mcp$/.test(endpoint.pathname) || (endpoint.protocol !== 'https:' && !(registration.allowLoopback && loopback && endpoint.protocol === 'http:'))) throw new RequestError(400, 'Unzulässiger Plugin-Endpunkt.');
    return endpoint;
  }

  private async fetchManifest(registration: Registration): Promise<PluginManifest> {
    const endpoint = this.endpoint(registration);
    const response = await this.fetchImpl(new URL('./.well-known/hasi-plugin.json', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${registration.serviceToken}` } });
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
      if (digest(initialManifest) !== registration.expectedManifestDigest || initialManifest.id !== pluginId || !valid(initialManifest.version)) throw new Error('invalid initial manifest');
      if (manifest.id !== pluginId || !valid(manifest.version) || (digest(manifest) !== digest(initialManifest) && !compatibleUpdate(initialManifest, manifest))) throw new Error('invalid approved manifest chain');
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
      pluginId: initialManifest.id,
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
      pluginId: plugin.manifest.id,
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
    if (!this.store) return plugin;
    const stored = await this.store.read(this.stateKey(plugin.manifest.id));
    if (!stored) throw new RequestError(409, 'Der gespeicherte Plugin-Zustand fehlt.');
    this.applyState(plugin, this.validatePersistedState(stored.value, plugin.registration, plugin.manifest.id));
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
      this.stateKey(plugin.manifest.id),
      () => { throw new RequestError(409, 'Der gespeicherte Plugin-Zustand fehlt.'); },
      value => {
        const current = this.validatePersistedState(value, plugin.registration, plugin.manifest.id);
        const updated = update(this.unsignedState(current));
        const signed = this.signState(updated.state);
        return { value: signed, result: { state: signed, result: updated.result } };
      },
    );
    this.applyState(plugin, this.validatePersistedState(stored.state, plugin.registration, plugin.manifest.id));
    return stored.result;
  }

  async install(registration: Registration): Promise<void> {
    this.endpoint(registration);
    const liveManifest = await this.fetchManifest(registration);
    if (!valid(liveManifest.version)) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
    if (this.installed.has(liveManifest.id)) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');

    let state: PersistedPluginState;
    if (this.store) {
      if (digest(liveManifest) !== registration.expectedManifestDigest) {
        const existing = await this.store.read(this.stateKey(liveManifest.id));
        if (!existing) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
      }
      const key = this.stateKey(liveManifest.id);
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
        const verified = this.validatePersistedState(stored.value, { ...registration, expectedManifestDigest: previous.data.expectedManifestDigest }, liveManifest.id);
        // Retain the verified old slot for an operator-controlled rollback.
        await this.store.compareAndSet(`${key}:backup:${previous.data.expectedManifestDigest}`, null, verified);
        const migrated = this.seedState(registration, liveManifest);
        const signed = this.signState({ ...this.unsignedState(migrated), enabled: verified.enabled });
        await this.store.compareAndSet(key, stored.revision, signed);
        const refreshed = await this.store.read(key);
        if (!refreshed) throw new RequestError(503, 'Der Plugin-Zustand konnte nicht gespeichert werden.');
        stored = refreshed;
      }
      state = this.validatePersistedState(stored.value, registration, liveManifest.id);
    } else {
      if (digest(liveManifest) !== registration.expectedManifestDigest) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
      state = this.seedState(registration, liveManifest);
    }

    const plugin: InstalledPlugin = {
      registration,
      initialManifest: state.initialManifest,
      manifest: state.manifest,
      enabled: state.enabled,
      healthy: true,
      ...(state.candidate && state.candidateBaseDigest !== undefined && state.candidateExpiresAt !== undefined ? { candidate: state.candidate, candidateBaseDigest: state.candidateBaseDigest, candidateExpiresAt: state.candidateExpiresAt } : {}),
    };
    this.validateManifestSchemas(plugin.manifest);
    this.installed.set(plugin.manifest.id, plugin);
  }

  list() {
    return [...this.installed.values()].map(({ manifest, enabled, healthy }) => ({ ...manifest, enabled, healthy }));
  }

  version(id: string): string { return this.get(id).manifest.version; }
  modelTools(actor: ActorContext) {
    return [...this.installed.values()].filter(plugin => plugin.enabled).flatMap(plugin => plugin.manifest.tools.filter(tool => tool.effect !== 'execute' && tool.requiredPermissions.every(permission => actor.permissions.includes(permission))).map(tool => ({ pluginId: plugin.manifest.id, ...tool })));
  }
  private get(id: string): InstalledPlugin { const plugin = this.installed.get(id); if (!plugin) throw new RequestError(404, 'Plugin nicht gefunden.'); return plugin; }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.get(id);
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

  private assertInvocation(plugin: InstalledPlugin, name: string, args: Record<string, unknown>, actor: ActorContext, execution: boolean) {
    if (!plugin.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
    const tool = plugin.manifest.tools.find(candidate => candidate.name === name);
    if (!tool || (tool.effect === 'execute' && !execution)) throw new RequestError(403, 'Dieser Tool-Aufruf ist nicht freigegeben.');
    if (!tool.requiredPermissions.every(permission => actor.permissions.includes(permission))) throw new RequestError(403, 'Die Berechtigung für diese Aktion fehlt.');
    if (!validateSchema(tool.inputSchema, args)) throw new RequestError(400, 'Ungültige Tool-Argumente.');
    return tool;
  }

  async invoke(id: string, name: string, args: Record<string, unknown>, actor: ActorContext, execution = false): Promise<Record<string, unknown>> {
    const plugin = await this.refresh(this.get(id));
    this.assertInvocation(plugin, name, args, actor, execution);
    const version = plugin.manifest.version;
    const manifestDigest = digest(plugin.manifest);
    const token = await createInvocationToken({ actor, pluginId: id, pluginVersion: version, tool: name, args }, this.privateKey);
    const client = new Client({ name: 'hasi-core', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}`, 'x-hasi-invocation': token }, redirect: 'error' }, fetch: this.fetchImpl });
    try {
      await client.connect(transport);
      const current = await this.refresh(plugin);
      if (!current.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
      if (digest(current.manifest) !== manifestDigest) throw new RequestError(409, 'Die Plugin-Version wurde geändert. Bitte erneut prüfen und freigeben.');
      const currentTool = this.assertInvocation(current, name, args, actor, execution);
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
