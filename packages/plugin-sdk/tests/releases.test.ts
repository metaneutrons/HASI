import { describe, expect, it } from 'vitest';
import {
  createPluginReleaseProvenance,
  MAX_PLUGIN_PROVENANCE_BYTES,
  pluginImageProvenanceLabel,
  pluginReleaseInventoryDigest,
  pluginReleaseProvenanceSchema,
  pluginReleaseSigningBytes,
  type PluginReleaseProvenance,
} from '../src/releases.js';

const provenance: PluginReleaseProvenance = {
  source: { repository: 'https://source.example.test/plugin', commit: 'a'.repeat(40) },
  artifactDigest: 'b'.repeat(64),
  license: 'GPL-3.0-only',
  packages: [
    { name: '@example/plugin', version: '1.0.0', license: 'GPL-3.0-only' },
    { name: 'dependency', version: '2.0.0', license: 'MIT' },
  ],
};

describe('publisher release provenance contract', () => {
  it('normalizes publisher inventory order but rejects ambiguous or uncanonical signed inventories', () => {
    const reversed = { ...provenance, packages: [...provenance.packages].reverse() };
    expect(createPluginReleaseProvenance(reversed)).toEqual(provenance);
    expect(pluginReleaseProvenanceSchema.safeParse(reversed).success).toBe(false);
    for (const packages of [[], [...provenance.packages, provenance.packages[0]!], [
      provenance.packages[0]!, { ...provenance.packages[0]!, license: 'MIT' },
    ]]) {
      expect(() => createPluginReleaseProvenance({ ...provenance, packages })).toThrow();
    }
    expect(pluginReleaseProvenanceSchema.parse(provenance)).toEqual(provenance);
  });

  it('authenticates canonical source identities without accepting credentials or URL aliases', () => {
    for (const repository of ['https://source.example.test/plugin', 'file:///tmp/independent-plugin']) {
      expect(pluginReleaseProvenanceSchema.safeParse({ ...provenance, source: { ...provenance.source, repository } }).success).toBe(true);
    }
    for (const repository of [
      'http://source.example.test/plugin', 'https://user:password@source.example.test/plugin',
      'https://source.example.test/plugin?token=value', 'https://source.example.test/plugin#revision',
      'https://SOURCE.example.test/plugin', 'https://source.example.test:443/plugin',
      'file://server/tmp/plugin', 'file:///', '/tmp/plugin',
    ]) {
      expect(pluginReleaseProvenanceSchema.safeParse({ ...provenance, source: { ...provenance.source, repository } }).success, repository).toBe(false);
    }
    for (const commit of ['a'.repeat(40), 'b'.repeat(64)]) {
      expect(pluginReleaseProvenanceSchema.safeParse({ ...provenance, source: { ...provenance.source, commit } }).success).toBe(true);
    }
    for (const commit of ['main', 'a'.repeat(39), 'A'.repeat(40), 'tag/v1']) {
      expect(pluginReleaseProvenanceSchema.safeParse({ ...provenance, source: { ...provenance.source, commit } }).success).toBe(false);
    }
  });

  it('bounds canonical provenance bytes and keeps the image label fixed size', () => {
    const inventory = (count: number, length: number) => Array.from({ length: count }, (_, index) => ({
      name: `package-${String(index).padStart(4, '0')}`, version: '1.0.0', license: 'é'.repeat(length),
    }));
    const within = createPluginReleaseProvenance({ ...provenance, packages: inventory(1000, 1) });
    expect(Buffer.byteLength(JSON.stringify(within))).toBeLessThan(MAX_PLUGIN_PROVENANCE_BYTES);
    expect(pluginImageProvenanceLabel({ pluginId: 'example', version: '1.0.0', manifestDigest: 'c'.repeat(64), provenance: within })).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => createPluginReleaseProvenance({ ...provenance, packages: inventory(1001, 1) })).toThrow();
    expect(() => createPluginReleaseProvenance({ ...provenance, packages: inventory(1000, 128) })).toThrow(/size limit/u);
    expect(() => createPluginReleaseProvenance({ ...provenance, packages: [{ name: 'bad\nname', version: '1.0.0', license: 'MIT' }] })).toThrow();
    expect(() => createPluginReleaseProvenance({ ...provenance, license: ' MIT ' })).toThrow();
  });

  it('binds the complete inventory and source into signing bytes and the build label', () => {
    const release = {
      schemaVersion: 2 as const, pluginId: 'example', version: '1.0.0', manifestDigest: 'c'.repeat(64), provenance,
      image: `registry.example.test/plugin@sha256:${'d'.repeat(64)}`, publisherId: 'publisher',
      configSchemaVersion: 1, stateMigration: 'none' as const,
    };
    const signingBytes = pluginReleaseSigningBytes(release);
    const reordered = Object.fromEntries(Object.entries(release).reverse());
    expect(pluginReleaseSigningBytes(reordered)).toEqual(signingBytes);
    expect(signingBytes.toString('utf8')).toMatch(/^hasi-plugin-release-v2\0[a-f0-9]{64}$/u);
    const changed = { ...provenance, source: { ...provenance.source, commit: 'e'.repeat(40) } };
    expect(pluginReleaseInventoryDigest(changed)).not.toBe(pluginReleaseInventoryDigest(provenance));
    expect(pluginReleaseSigningBytes({ ...release, provenance: changed })).not.toEqual(signingBytes);
    expect(pluginImageProvenanceLabel({ ...release, provenance: changed })).not.toBe(pluginImageProvenanceLabel(release));
    // The image reference is assigned only after the immutable build label exists.
    expect(pluginImageProvenanceLabel({ ...release, image: `registry.example.test/plugin@sha256:${'f'.repeat(64)}` } as typeof release)).toBe(pluginImageProvenanceLabel(release));
    expect(pluginReleaseSigningBytes({ ...release, image: `registry.example.test/plugin@sha256:${'f'.repeat(64)}` })).not.toEqual(signingBytes);
  });
});
