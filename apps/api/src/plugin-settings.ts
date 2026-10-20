import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { digest, validateConfiguration, type PluginManifest } from '@hasi/plugin-sdk';
import { updateJson, type JsonStore, type StateFence } from '@hasi/state';

const configuration = z.record(z.string(), z.unknown());
const snapshot = z.strictObject({ values: configuration, disabledTools: z.array(z.string()).max(64) });
const stateSchema = z.strictObject({
  version: z.literal(1), instanceId: z.string(), scope: z.string(), revision: z.number().int().nonnegative(),
  activeRevision: z.number().int().nonnegative(), manifestDigest: z.string(),
  active: snapshot, draft: snapshot,
  audit: z.array(z.strictObject({ operation: z.enum(['draft', 'activate']), subject: z.string().max(256), at: z.string() })).max(100),
});
type SettingsState = z.infer<typeof stateSchema>;

function configurationContract(manifest: PluginManifest): string {
  return digest({ configuration: manifest.manifestVersion === 2 ? manifest.configuration ?? null : null, secrets: manifest.manifestVersion === 2 ? manifest.secrets ?? [] : [], tools: manifest.tools.map(tool => tool.name).sort() });
}

export class PluginSettingsError extends Error {
  constructor(readonly status: number, message: string, readonly errors?: readonly { path: string; message: string }[]) { super(message); }
}

/** Public configuration only. Secret values and secret-store references never enter this record. */
export class PluginSettingsStore {
  private readonly publicKey: KeyObject;
  constructor(private readonly privateKey: KeyObject, private readonly store: JsonStore, private readonly scope: string) {
    this.publicKey = createPublicKey(privateKey);
  }

  usesStateStore(store: JsonStore): boolean { return this.store === store; }

  private key(instanceId: string) { return `plugin-settings:v1:${digest({ scope: this.scope, instanceId })}`; }
  private initial(instanceId: string, manifest: PluginManifest): SettingsState {
    return { version: 1, instanceId, scope: this.scope, revision: 0, activeRevision: 0, manifestDigest: configurationContract(manifest), active: { values: {}, disabledTools: [] }, draft: { values: {}, disabledTools: [] }, audit: [] };
  }
  private signed(value: SettingsState) {
    return { value, signature: sign(null, Buffer.from(`hasi-plugin-settings-v1\0${digest(value)}`), this.privateKey).toString('base64url') };
  }
  private verified(raw: unknown, id: string): SettingsState {
    try {
      const envelope = z.strictObject({ value: stateSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).parse(raw);
      if (envelope.value.instanceId !== id || envelope.value.scope !== this.scope || !verify(null, Buffer.from(`hasi-plugin-settings-v1\0${digest(envelope.value)}`), this.publicKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error('Invalid state');
      return envelope.value;
    } catch { throw new PluginSettingsError(409, 'Die Plugin-Konfiguration ist ungültig oder wurde verändert.'); }
  }
  async read(instanceId: string, manifest: PluginManifest) {
    const record = await this.store.read(this.key(instanceId));
    return record ? this.verified(record.value, instanceId) : this.initial(instanceId, manifest);
  }
  async authoritySnapshot(instanceId: string, _manifest: PluginManifest): Promise<{ state: SettingsState; fence: StateFence }> {
    const key = this.key(instanceId);
    const record = await this.store.read(key);
    if (!record) throw new PluginSettingsError(409, 'Die Plugin-Konfiguration wurde noch nicht initialisiert.');
    return { state: this.verified(record.value, instanceId), fence: { key, revision: record.revision } };
  }
  async persistInitial(instanceId: string, manifest: PluginManifest): Promise<{ state: SettingsState; fence: StateFence }> {
    const key = this.key(instanceId);
    const current = await this.store.read(key);
    if (current) return { state: this.verified(current.value, instanceId), fence: { key, revision: current.revision } };

    await this.store.compareAndSet(key, null, this.signed(this.initial(instanceId, manifest)));
    const persisted = await this.store.read(key);
    if (!persisted) throw new PluginSettingsError(409, 'Die Plugin-Konfiguration konnte nicht initialisiert werden.');
    return { state: this.verified(persisted.value, instanceId), fence: { key, revision: persisted.revision } };
  }
  private validate(manifest: PluginManifest, values: Record<string, unknown>, disabledTools: readonly string[]) {
    const schema = manifest.manifestVersion === 2 ? manifest.configuration?.schema : undefined;
    if (!schema && Object.keys(values).length) throw new PluginSettingsError(400, 'Dieses Plugin deklariert keine Konfigurationsfelder.');
    if (schema) {
      const result = validateConfiguration(schema, values);
      if (!result.valid) throw new PluginSettingsError(400, 'Die Konfiguration entspricht nicht dem freigegebenen Schema.', result.diagnostics.slice(0, 32).map(issue => ({ path: issue.path.slice(0, 512), message: issue.message.slice(0, 256) })));
    }
    if (new Set(disabledTools).size !== disabledTools.length || disabledTools.some(name => !manifest.tools.some(tool => tool.name === name))) throw new PluginSettingsError(400, 'Unbekannte oder doppelte Tool-Auswahl.');
  }
  async describe(instanceId: string, manifest: PluginManifest, secretReady: (name: string) => boolean = () => false, secretRevision?: (name: string) => string | null) {
    const state = await this.read(instanceId, manifest);
    const secrets = manifest.manifestVersion === 2 ? (manifest.secrets ?? []).map(secret => ({ name: secret.name, required: secret.required, configured: secretReady(secret.name), ...(secretRevision ? { revision: secretRevision(secret.name) } : {}) })) : [];
    let configurationValid = state.manifestDigest === configurationContract(manifest);
    try { this.validate(manifest, state.active.values, state.active.disabledTools); } catch { configurationValid = false; }
    return {
      revision: state.revision, activeRevision: state.activeRevision,
      configuration: state.active.values, draft: state.draft.values,
      disabledTools: state.active.disabledTools, draftDisabledTools: state.draft.disabledTools,
      schema: manifest.manifestVersion === 2 ? manifest.configuration : undefined,
      secrets, ready: configurationValid && secrets.every(secret => !secret.required || secret.configured),
      audit: state.audit,
    };
  }
  async binding(instanceId: string, manifest: PluginManifest, secretReady?: (name: string) => boolean, secretRevision?: (name: string) => string | null) {
    const state = await this.describe(instanceId, manifest, secretReady, secretRevision);
    return { ...state, digest: digest({ instanceId, manifest: digest(manifest), revision: state.activeRevision, configuration: state.configuration, disabledTools: state.disabledTools, secretReadiness: state.secrets }) };
  }
  async saveDraft(instanceId: string, manifest: PluginManifest, input: { revision: number; values: Record<string, unknown>; disabledTools: string[] }, subject: string) {
    this.validate(manifest, input.values, input.disabledTools);
    return this.change(instanceId, manifest, input.revision, subject, 'draft', state => ({ ...state, draft: { values: input.values, disabledTools: input.disabledTools } }));
  }
  async activate(instanceId: string, manifest: PluginManifest, revision: number, subject: string, secretReady: (name: string) => boolean = () => false) {
    return this.change(instanceId, manifest, revision, subject, 'activate', state => {
      this.validate(manifest, state.draft.values, state.draft.disabledTools);
      if (manifest.manifestVersion === 2 && manifest.secrets?.some(secret => secret.required && !secretReady(secret.name))) throw new PluginSettingsError(409, 'Erforderliche Zugangsdaten sind noch nicht im Dienst konfiguriert.');
      return { ...state, active: state.draft, activeRevision: state.activeRevision + 1, manifestDigest: configurationContract(manifest) };
    });
  }
  private async change(id: string, manifest: PluginManifest, revision: number, subject: string, operation: 'draft' | 'activate', change: (state: SettingsState) => SettingsState) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new PluginSettingsError(400, 'Ungültige Konfigurationsversion.');
    const result = await updateJson<unknown, SettingsState>(this.store, this.key(id), () => this.signed(this.initial(id, manifest)), raw => {
      const state = this.verified(raw, id);
      if (state.revision !== revision) throw new PluginSettingsError(409, 'Die Konfiguration wurde parallel geändert. Bitte neu laden.');
      const next = { ...change(state), revision: state.revision + 1, audit: [...state.audit, { operation, subject: subject.slice(0, 256), at: new Date().toISOString() }].slice(-100) };
      return { value: this.signed(next), result: next };
    });
    return { revision: result.revision, activeRevision: result.activeRevision };
  }
}
