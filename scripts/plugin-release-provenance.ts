import { createPluginReleaseProvenance, type PluginReleaseProvenance } from '@hasi/plugin-sdk/releases';
import type { ReferencePluginArtifactEvidence } from './package-reference-plugin.js';

/** These source assertions must come from the actual publisher/fixture input. */
export interface ArtifactSourceIdentity {
  readonly repository: string;
  readonly revision: string;
}

export function artifactPluginProvenance(
  evidence: ReferencePluginArtifactEvidence,
  source: ArtifactSourceIdentity,
): PluginReleaseProvenance {
  const roots = evidence.licenseInventory.filter(item => item.name === 'hasi-reference-plugin' && item.version === evidence.pluginVersion);
  const root = roots[0];
  if (!root || roots.length !== 1) throw new Error('Reference artifact root license is unavailable or ambiguous.');
  return createPluginReleaseProvenance({
    source: { repository: source.repository, commit: source.revision },
    artifactDigest: evidence.artifactSha256,
    license: root.license,
    packages: evidence.licenseInventory,
  });
}
