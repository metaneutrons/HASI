import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { EXTERNAL_ARTIFACT_ENV } from '../scripts/plugin-gateway-qualification-artifacts.js';
import { createManagedReferenceManifest } from '../scripts/reference-managed-state-profile.js';
import {
  journeyArtifactEvidence,
  loadExternalJourneyArtifactPair,
  snapshotExternalJourneyArtifacts,
} from '../scripts/plugin-journey-artifacts.js';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_REPOSITORY = 'https://example.invalid/hasi-reference.git';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactPayloadDigest(entries: readonly Record<string, unknown>[]): string {
  const hasher = createHash('sha256');
  for (const entry of entries) {
    for (const value of [entry.path, entry.kind, String(entry.mode), String(entry.size), entry.sha256 ?? '', entry.target ?? '']) {
      hasher.update(String(value), 'utf8');
      hasher.update('\0', 'utf8');
    }
  }
  return hasher.digest('hex');
}

async function createPrebuiltArtifact(directory: string, version: string, managedProfile: boolean): Promise<Record<string, unknown>> {
  await mkdir(join(directory, 'src'), { recursive: true });
  const manifestInput = JSON.parse(await readFile(join(ROOT, 'examples/reference-plugin/src/manifest.json'), 'utf8')) as PluginManifestV2;
  const versioned = { ...manifestInput, version };
  const manifest = managedProfile ? createManagedReferenceManifest(versioned) : manifestSchema.parse(versioned) as PluginManifestV2;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const serverBytes = await readFile(join(ROOT, 'examples/reference-plugin/src/server.js'));
  await writeFile(join(directory, 'src/manifest.json'), manifestBytes);
  await writeFile(join(directory, 'src/server.js'), serverBytes);

  const payloadFiles: Record<string, unknown>[] = [];
  const srcMetadata = await lstat(join(directory, 'src'));
  payloadFiles.push({ path: 'src', kind: 'directory', mode: srcMetadata.mode & 0o777, size: 0 });
  for (const [path, bytes] of [['src/manifest.json', manifestBytes], ['src/server.js', serverBytes]] as const) {
    const metadata = await lstat(join(directory, path));
    payloadFiles.push({ path, kind: 'file', mode: metadata.mode & 0o777, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  payloadFiles.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const licenseInventory = [
    { name: '@hasi/plugin-sdk', version: '0.1.0', license: 'GPL-3.0-only' },
    { name: 'hasi-reference-plugin', version, license: 'GPL-3.0-only' },
  ];
  const artifactManifest = {
    schemaVersion: 1,
    pluginId: manifest.id,
    pluginVersion: version,
    manifestDigest: digest(manifest),
    manifestFileSha256: sha256(manifestBytes),
    artifactSha256: artifactPayloadDigest(payloadFiles),
    artifactDigestDefinition: 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.',
    sdkRuntime: { packageName: '@hasi/plugin-sdk', packageVersion: '0.1.0', path: 'vendor/plugin-sdk', runtimePackageCount: 1 },
    licenseInventory,
    payloadFiles,
    payloadEntryCount: payloadFiles.length,
  };
  const artifactManifestBytes = Buffer.from(`${JSON.stringify(artifactManifest, null, 2)}\n`);
  await writeFile(join(directory, 'artifact-manifest.json'), artifactManifestBytes);
  return {
    pluginId: manifest.id,
    pluginVersion: version,
    manifestDigest: digest(manifest),
    manifestFileSha256: sha256(manifestBytes),
    artifactSha256: artifactManifest.artifactSha256,
    artifactManifestSha256: sha256(artifactManifestBytes),
    payloadFileCount: payloadFiles.filter(entry => entry.kind !== 'directory').length,
    runtimePackageCount: 1,
    licenseInventory,
  };
}

async function fixture(options: { readonly secondVersion?: string; readonly managedProfile?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hasi-journey-external-artifacts-'));
  temporaryRoots.push(root);
  const workspace = join(root, 'checkout');
  const aDirectory = join(root, 'artifact-a');
  const bDirectory = join(root, 'artifact-b');
  const aEvidence = join(root, 'artifact-a-evidence.json');
  const bEvidence = join(root, 'artifact-b-evidence.json');
  await Promise.all([mkdir(workspace), mkdir(aDirectory), mkdir(bDirectory)]);
  const managedProfile = options.managedProfile ?? true;
  const a = await createPrebuiltArtifact(aDirectory, '1.0.0', managedProfile);
  const secondVersion = options.secondVersion ?? '1.0.1';
  const b = await createPrebuiltArtifact(bDirectory, secondVersion, managedProfile);
  const sidecar = (revision: string, version: string, artifactEvidence: Record<string, unknown>) => ({
    schemaVersion: 1,
    source: { repository: SOURCE_REPOSITORY, revision, tag: `v${version}` },
    artifactEvidence,
  });
  await writeFile(aEvidence, JSON.stringify(sidecar('a'.repeat(40), '1.0.0', a)));
  await writeFile(bEvidence, JSON.stringify(sidecar('b'.repeat(40), secondVersion, b)));
  const environment = {
    [EXTERNAL_ARTIFACT_ENV.aDirectory]: aDirectory,
    [EXTERNAL_ARTIFACT_ENV.aEvidence]: aEvidence,
    [EXTERNAL_ARTIFACT_ENV.bDirectory]: bDirectory,
    [EXTERNAL_ARTIFACT_ENV.bEvidence]: bEvidence,
  } as NodeJS.ProcessEnv;
  return { root, workspace, aDirectory, bDirectory, aEvidence, bEvidence, environment };
}

function admit(environment: NodeJS.ProcessEnv, workspaceRoot: string, managedMode = true) {
  return loadExternalJourneyArtifactPair({ environment, workspaceRoot, managedMode });
}

describe('managed browser journey external artifacts', () => {
  it('retains the workspace fixture path when no external inputs are supplied', async () => {
    const result = await admit({}, ROOT);
    expect(result).toBeUndefined();
  });

  it('admits the exact managed release pair and preserves operator-declared source identity in evidence', async () => {
    const input = await fixture();
    const pair = await admit(input.environment, input.workspace);
    expect(pair?.a.evidence.pluginVersion).toBe('1.0.0');
    expect(pair?.b.evidence.pluginVersion).toBe('1.0.1');
    expect(pair?.a.source).toEqual({ repository: SOURCE_REPOSITORY, revision: 'a'.repeat(40), tag: 'v1.0.0' });

    const privateDirectory = join(input.root, 'owned-journey');
    await mkdir(privateDirectory, { mode: 0o700 });
    const prepared = await snapshotExternalJourneyArtifacts(pair!, privateDirectory);
    const evidence = journeyArtifactEvidence(prepared);
    expect(prepared.manifest.managedState).toBeDefined();
    expect(prepared.releases.map(release => release.directory)).toEqual([
      join(input.root, 'owned-journey/external-reference-artifacts/reference-1.0.0'),
      join(input.root, 'owned-journey/external-reference-artifacts/reference-1.0.1'),
    ]);
    expect(evidence).toMatchObject({
      artifactInputMode: 'external-prebuilt-pair',
      independentDistributionAcceptance: false,
      sourceIdentityAssurance: 'operator-declared-metadata-only-not-verified-publisher-provenance',
      releases: [
        { sourceIdentity: { repository: SOURCE_REPOSITORY, revision: 'a'.repeat(40), tag: 'v1.0.0' } },
        { sourceIdentity: { repository: SOURCE_REPOSITORY, revision: 'b'.repeat(40), tag: 'v1.0.1' } },
      ],
    });
    expect(prepared.releases.every(release => release.directory !== input.aDirectory && release.directory !== input.bDirectory)).toBe(true);
  });

  it('rejects external artifacts in local non-managed mode', async () => {
    const input = await fixture();
    await expect(admit(input.environment, input.workspace, false)).rejects.toThrow('external_artifact_mode_requires_managed');
  });

  it('rejects versions outside the current managed runtime fixture contract', async () => {
    const input = await fixture({ secondVersion: '1.0.2' });
    await expect(admit(input.environment, input.workspace)).rejects.toThrow('external_artifact_managed_release_pair_invalid');
  });

  it('requires the prebuilt manifest to already declare the expected managed-state profile', async () => {
    const input = await fixture({ managedProfile: false });
    await expect(admit(input.environment, input.workspace)).rejects.toThrow('external_artifact_managed_state_profile_mismatch');
  });

  it('rejects incomplete paths before snapshot preparation and leaves caller inputs untouched during snapshotting', async () => {
    const input = await fixture();
    const originalManifest = await readFile(join(input.aDirectory, 'src/manifest.json'));
    const originalEvidence = await readFile(input.aEvidence);
    await expect(loadExternalJourneyArtifactPair({
      environment: { [EXTERNAL_ARTIFACT_ENV.aDirectory]: input.aDirectory },
      workspaceRoot: input.workspace,
      managedMode: true,
    })).rejects.toThrow('external_artifact_inputs_incomplete');

    const pair = await admit(input.environment, input.workspace);
    expect(pair).toBeDefined();
    const privateDirectory = join(input.root, 'owned-journey');
    await mkdir(privateDirectory, { mode: 0o700 });
    await snapshotExternalJourneyArtifacts(pair!, privateDirectory);
    expect(await readFile(join(input.aDirectory, 'src/manifest.json'))).toEqual(originalManifest);
    expect(await readFile(input.aEvidence)).toEqual(originalEvidence);
  });

  it('rechecks the accepted inventory when copying, so a post-admission source change is refused', async () => {
    const input = await fixture();
    const pair = await admit(input.environment, input.workspace);
    expect(pair).toBeDefined();
    await writeFile(join(input.aDirectory, 'src/server.js'), 'changed after admission');
    const privateDirectory = join(input.root, 'owned-journey');
    await mkdir(privateDirectory, { mode: 0o700 });
    await expect(snapshotExternalJourneyArtifacts(pair!, privateDirectory))
      .rejects.toThrow('external_artifact_payload_invalid');
  });
});
