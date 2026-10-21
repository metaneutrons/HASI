import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import type { ReferencePluginArtifactEvidence } from '../scripts/package-reference-plugin.js';

const packageReferencePluginMock = vi.hoisted(() => vi.fn());

vi.mock('../scripts/package-reference-plugin.js', async importOriginal => {
  const original = await importOriginal<typeof import('../scripts/package-reference-plugin.js')>();
  return { ...original, packageReferencePlugin: packageReferencePluginMock };
});

import { artifacts } from '../scripts/serve-plugin-journey.js';

type PackageReferencePlugin = (input: {
  readonly outputDirectory: string;
  readonly sourceDirectory?: string;
}) => Promise<ReferencePluginArtifactEvidence>;

interface PackageObservation {
  manifest: PluginManifestV2;
  committedManifest: PluginManifestV2;
}

const packageMock = packageReferencePluginMock as unknown as Mock<PackageReferencePlugin>;
const observations: PackageObservation[] = [];

describe('journey artifact source profiles', () => {
  beforeEach(() => {
    observations.splice(0);
    packageMock.mockReset();
    packageMock.mockImplementation(async input => {
      if (!input.sourceDirectory) throw new Error('The independent source directory is required.');
      const manifestPath = join(input.sourceDirectory, 'src/manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifestV2;
      const committed = execFileSync('git', ['show', 'HEAD:src/manifest.json'], {
        cwd: input.sourceDirectory,
        encoding: 'utf8',
        // Git hooks export GIT_DIR/GIT_WORK_TREE for the caller repository.
        // Read this independently committed fixture, not the hook's checkout.
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      observations.push({ manifest, committedManifest: JSON.parse(committed) as PluginManifestV2 });
      return {
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        manifestDigest: 'a'.repeat(64),
        manifestFileSha256: 'b'.repeat(64),
        artifactSha256: 'c'.repeat(64),
        artifactManifestSha256: 'd'.repeat(64),
        payloadFileCount: 1,
        runtimePackageCount: 1,
        licenseInventory: [],
      };
    });
  });

  it.each([false, true])('commits the selected profile before packaging (inherited Git context: %s)', async inheritedGitContext => {
    const managedDirectory = await mkdtemp(join(tmpdir(), 'hasi-managed-journey-artifacts-'));
    const directDirectory = await mkdtemp(join(tmpdir(), 'hasi-direct-journey-artifacts-'));
    try {
      if (inheritedGitContext) {
        vi.stubEnv('GIT_DIR', join(managedDirectory, 'unrelated-parent.git'));
        vi.stubEnv('GIT_WORK_TREE', directDirectory);
      }
      const original = JSON.parse(await readFile(new URL('../examples/reference-plugin/src/manifest.json', import.meta.url), 'utf8')) as PluginManifestV2;
      const managed = await artifacts(managedDirectory, true);
      expect(manifestSchema.safeParse(managed.manifest).success).toBe(true);
      expect(managed.manifest.mcpVersion).toBe('2025-11-25');
      expect(managed.manifest.managedState).toMatchObject({
        schemaVersion: 1,
        accountIdentity: { kind: 'claim', name: 'reference.account' },
      });
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        expect(manifestSchema.safeParse(observation.manifest).success).toBe(true);
        expect(observation.manifest.mcpVersion).toBe('2025-11-25');
        expect(observation.manifest.managedState).toEqual(managed.manifest.managedState);
        expect(observation.committedManifest).toEqual(observation.manifest);
      }

      observations.splice(0);
      packageMock.mockClear();
      const direct = await artifacts(directDirectory, false);
      expect(direct.manifest).toEqual(original);
      expect(direct.manifest.mcpVersion).toBe(original.mcpVersion);
      expect(direct.manifest.managedState).toBeUndefined();
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        expect(observation.manifest.mcpVersion).toBe(original.mcpVersion);
        expect(observation.manifest.managedState).toBeUndefined();
        expect(observation.committedManifest).toEqual(observation.manifest);
      }
    } finally {
      vi.unstubAllEnvs();
      await Promise.all([
        rm(managedDirectory, { recursive: true, force: true }),
        rm(directDirectory, { recursive: true, force: true }),
      ]);
    }
  });
});
