import { describe, expect, it } from 'vitest';
import { artifactPluginProvenance } from '../scripts/plugin-release-provenance.js';
import type { ReferencePluginArtifactEvidence } from '../scripts/package-reference-plugin.js';

const source = { repository: 'file:///tmp/independent-source', revision: 'a'.repeat(40) };
const evidence: ReferencePluginArtifactEvidence = {
  pluginId: 'hasi.reference', pluginVersion: '1.0.0', manifestDigest: 'b'.repeat(64),
  manifestFileSha256: 'c'.repeat(64), artifactSha256: 'd'.repeat(64), artifactManifestSha256: 'e'.repeat(64),
  payloadFileCount: 2, runtimePackageCount: 1,
  licenseInventory: [
    { name: 'hasi-reference-plugin', version: '1.0.0', license: 'GPL-3.0-only' },
    { name: '@hasi/plugin-sdk', version: '0.1.0', license: 'GPL-3.0-only' },
  ],
};

describe('reference artifact publisher assertions', () => {
  it('uses the actual root license and complete payload inventory without changing source identity', () => {
    const result = artifactPluginProvenance(evidence, source);
    expect(result.source).toEqual({ repository: source.repository, commit: source.revision });
    expect(result.artifactDigest).toBe(evidence.artifactSha256);
    expect(result.license).toBe('GPL-3.0-only');
    expect(result.packages).toEqual([...evidence.licenseInventory].reverse());
    expect(artifactPluginProvenance({ ...evidence, licenseInventory: [
      { ...evidence.licenseInventory[0]!, license: 'MIT' }, evidence.licenseInventory[1]!,
    ] }, source).license).toBe('MIT');
  });

  it('rejects a missing, wrong-version or ambiguous root rather than inventing a license', () => {
    for (const licenseInventory of [
      [evidence.licenseInventory[1]!],
      [{ ...evidence.licenseInventory[0]!, version: '2.0.0' }],
      [...evidence.licenseInventory, { ...evidence.licenseInventory[0]!, license: 'MIT' }],
    ]) {
      expect(() => artifactPluginProvenance({ ...evidence, licenseInventory }, source)).toThrow(/unavailable or ambiguous/u);
    }
  });
});
