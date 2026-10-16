import type { KeyObject } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { valid, major, gt } from 'semver';
import { createInvocationToken, digest, manifestSchema, type ActorContext, type PluginManifest } from '@hasi/plugin-sdk';

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export interface Registration {
  endpoint: string;
  serviceToken: string;
  expectedManifestDigest: string;
  allowLoopback: boolean;
}

interface InstalledPlugin {
  registration: Registration;
  manifest: PluginManifest;
  enabled: boolean;
  healthy: boolean;
  candidate?: PluginManifest;
}

const validator = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(validator);

export function compatibleUpdate(current: PluginManifest, candidate: PluginManifest): boolean {
  if (candidate.id !== current.id) return false;
  if (!valid(candidate.version) || !valid(current.version) || major(candidate.version) !== major(current.version) || !gt(candidate.version, current.version)) return false;
  const contract = (manifest: PluginManifest) => manifest.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, effect: tool.effect, requiredPermissions: [...tool.requiredPermissions].sort() })).sort((a,b) => a.name.localeCompare(b.name));
  return digest(contract(current)) === digest(contract(candidate));
}

export class PluginRegistry {
  private readonly installed = new Map<string, InstalledPlugin>();
  constructor(private readonly privateKey: KeyObject) {}

  private async fetchManifest(registration: Registration): Promise<PluginManifest> {
    const endpoint = new URL(registration.endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp' || (endpoint.protocol !== 'https:' && !(registration.allowLoopback && loopback && endpoint.protocol === 'http:'))) throw new RequestError(400, 'Unzulässiger Plugin-Endpunkt.');
    const response = await fetch(new URL('/.well-known/hasi-plugin.json', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${registration.serviceToken}` } });
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

  async install(registration: Registration): Promise<void> {
    const manifest = await this.fetchManifest(registration);
    if (digest(manifest) !== registration.expectedManifestDigest || !valid(manifest.version) || this.installed.has(manifest.id)) throw new RequestError(409, 'Plugin-Freigabe oder Version stimmt nicht überein.');
    for (const tool of manifest.tools) { validator.compile(tool.inputSchema); validator.compile(tool.outputSchema); }
    this.installed.set(manifest.id, { registration, manifest, enabled: true, healthy: true });
  }

  list() {
    return [...this.installed.values()].map(({ manifest, enabled, healthy }) => ({ ...manifest, enabled, healthy }));
  }

  version(id: string): string { return this.get(id).manifest.version; }
  modelTools(actor: ActorContext) {
    return [...this.installed.values()].filter(plugin => plugin.enabled).flatMap(plugin => plugin.manifest.tools.filter(tool => tool.effect !== 'execute' && tool.requiredPermissions.every(permission => actor.permissions.includes(permission))).map(tool => ({ pluginId: plugin.manifest.id, ...tool })));
  }
  private get(id: string): InstalledPlugin { const plugin = this.installed.get(id); if (!plugin) throw new RequestError(404, 'Plugin nicht gefunden.'); return plugin; }
  setEnabled(id: string, enabled: boolean): void { this.get(id).enabled = enabled; }

  async checkUpdate(id: string) {
    const plugin = this.get(id);
    delete plugin.candidate;
    const candidate = await this.fetchManifest(plugin.registration);
    plugin.healthy = true;
    if (digest(candidate) === digest(plugin.manifest)) return { status: 'current' as const, message: 'Das Plugin ist aktuell.' };
    if (!compatibleUpdate(plugin.manifest, candidate)) return { status: 'blocked' as const, message: 'Geänderte Schnittstellen oder Berechtigungen erfordern eine neue Freigabe.' };
    plugin.candidate = candidate;
    return { status: 'available' as const, message: `Version ${candidate.version} kann ohne Neustart von HASI aktiviert werden.` };
  }

  activateUpdate(id: string): void {
    const plugin = this.get(id);
    if (!plugin.candidate || !compatibleUpdate(plugin.manifest, plugin.candidate)) throw new RequestError(409, 'Keine kompatible Version zur Aktivierung vorhanden.');
    plugin.manifest = plugin.candidate;
    delete plugin.candidate;
  }

  async invoke(id: string, name: string, args: Record<string, unknown>, actor: ActorContext, execution = false): Promise<Record<string, unknown>> {
    const plugin = this.get(id);
    if (!plugin.enabled) throw new RequestError(409, 'Das Plugin ist deaktiviert.');
    const tool = plugin.manifest.tools.find(candidate => candidate.name === name);
    if (!tool || (tool.effect === 'execute' && !execution)) throw new RequestError(403, 'Dieser Tool-Aufruf ist nicht freigegeben.');
    if (!tool.requiredPermissions.every(permission => actor.permissions.includes(permission))) throw new RequestError(403, 'Die Berechtigung für diese Aktion fehlt.');
    if (!validator.validate(tool.inputSchema, args)) throw new RequestError(400, 'Ungültige Tool-Argumente.');
    const token = await createInvocationToken({ actor, pluginId: id, pluginVersion: plugin.manifest.version, tool: name, args }, this.privateKey);
    const client = new Client({ name: 'hasi-core', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(plugin.registration.endpoint), { requestInit: { headers: { authorization: `Bearer ${plugin.registration.serviceToken}`, 'x-hasi-invocation': token }, redirect: 'error' } });
    try {
      await client.connect(transport);
      const serverVersion = client.getServerVersion();
      if (serverVersion?.version !== plugin.manifest.version) throw new RequestError(409, 'Die Plugin-Version hat sich geändert. Bitte zuerst prüfen und freigeben.');
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new RequestError(502, 'Die Plugin-Anfrage konnte nicht ausgeführt werden.');
      const output: unknown = result.structuredContent;
      if (!output || typeof output !== 'object' || Array.isArray(output) || !validator.validate(tool.outputSchema, output)) throw new RequestError(502, 'Die Plugin-Antwort entspricht nicht dem vereinbarten Vertrag.');
      if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw new RequestError(502, 'Die Plugin-Antwort ist zu groß.');
      plugin.healthy = true;
      return output as Record<string, unknown>;
    } catch (error) {
      plugin.healthy = false;
      throw error;
    } finally { await client.close(); }
  }
}
