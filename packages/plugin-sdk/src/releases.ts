import { z } from 'zod';
import { canonicalJson, digest } from './canonical-json.js';

const id = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
function isPlainText(value: string): boolean {
  if (value !== value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
const text = (max: number) => z.string().min(1).max(max).refine(isPlainText);
export const PLUGIN_IMAGE_PROVENANCE_LABEL = 'org.hasi.plugin.provenance.v1';
export const MAX_PLUGIN_PROVENANCE_BYTES = 256 * 1024;
export const PLUGIN_RELEASE_SIGNING_DOMAIN = 'hasi-plugin-release-v2\0';

const repository = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (url.protocol === 'file:' && !url.host && url.pathname !== '/'))
      && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
});
const dependency = z.strictObject({ name: text(200), version: text(128), license: text(128) }).readonly();

/** Publisher assertions, authenticated with the exact image; never an egress destination. */
export const pluginReleaseProvenanceSchema = z.strictObject({
  source: z.strictObject({ repository, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }).readonly(),
  artifactDigest: sha256,
  license: text(128),
  packages: z.array(dependency).min(1).max(1000).superRefine((entries, context) => {
    const identities = entries.map(item => `${item.name}\0${item.version}`);
    if (new Set(identities).size !== entries.length) context.addIssue({ code: 'custom', message: 'Duplicate dependency identity.' });
    const sorted = [...identities].sort();
    if (identities.some((item, index) => item !== sorted[index])) context.addIssue({ code: 'custom', message: 'Dependency inventory must be sorted by name and version.' });
  }).readonly(),
}).superRefine((value, context) => {
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_PLUGIN_PROVENANCE_BYTES) context.addIssue({ code: 'custom', message: 'Provenance exceeds its size limit.' });
}).readonly();

const identity = {
  pluginId: id,
  version: text(128),
  manifestDigest: sha256,
  provenance: pluginReleaseProvenanceSchema,
};

export const unsignedPluginReleaseSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ...identity,
  image: z.string().min(1).max(512),
  publisherId: id,
  configSchemaVersion: z.number().int().positive().max(2_147_483_647),
  stateMigration: z.enum(['none', 'reversible', 'irreversible']),
});
export const pluginReleaseEnvelopeSchema = unsignedPluginReleaseSchema.extend({ signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u) });
export type PluginReleaseProvenance = z.infer<typeof pluginReleaseProvenanceSchema>;
export type UnsignedPluginRelease = z.infer<typeof unsignedPluginReleaseSchema>;
export type PluginReleaseEnvelope = z.infer<typeof pluginReleaseEnvelopeSchema>;

export function createPluginReleaseProvenance(input: PluginReleaseProvenance): PluginReleaseProvenance {
  const packages = [...input.packages].sort((left, right) => {
    const a = `${left.name}\0${left.version}`;
    const b = `${right.name}\0${right.version}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return pluginReleaseProvenanceSchema.parse({ ...input, packages });
}

/** Pure publisher-side wire contract; no dependency on the host or its credentials. */
export function pluginReleaseSigningBytes(input: unknown): Buffer {
  return Buffer.from(`${PLUGIN_RELEASE_SIGNING_DOMAIN}${digest(unsignedPluginReleaseSchema.parse(input))}`, 'utf8');
}

/** Build before computing the image digest, then sign the final image reference. */
export function pluginImageProvenanceLabel(input: Pick<UnsignedPluginRelease, 'pluginId' | 'version' | 'manifestDigest' | 'provenance'>): string {
  return `sha256:${digest(z.strictObject(identity).parse({
    pluginId: input.pluginId, version: input.version, manifestDigest: input.manifestDigest, provenance: input.provenance,
  }))}`;
}

export function pluginReleaseInventoryDigest(input: PluginReleaseProvenance): string {
  return digest(pluginReleaseProvenanceSchema.parse(input));
}
