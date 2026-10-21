import { createPluginReleaseProvenance } from '@hasi/plugin-sdk/releases';

/** Synthetic publisher assertion for unit tests, not distribution evidence. */
export const TEST_PLUGIN_PROVENANCE = createPluginReleaseProvenance({
  source: { repository: 'https://source.example.test/plugins', commit: 'c'.repeat(40) },
  artifactDigest: 'd'.repeat(64),
  license: 'GPL-3.0-only',
  packages: [{ name: '@hasi/plugin-sdk', version: '0.1.0', license: 'GPL-3.0-only' }],
});
