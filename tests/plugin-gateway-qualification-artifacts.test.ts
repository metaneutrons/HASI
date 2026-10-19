import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest, manifestSchema } from '@hasi/plugin-sdk';
import { qualificationFixtures } from '../scripts/healthy-plugin-qualification.js';
import {
  createVerifiedArtifactSnapshot, EXTERNAL_ARTIFACT_ENV, loadExternalPluginArtifactPair,
} from '../scripts/plugin-gateway-qualification-artifacts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots: string[] = [];
const sourceRepository = 'https://example.invalid/qualification-plugin.git';

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

interface ArtifactInputFixture {
  readonly workspace: string;
  readonly outside: string;
  readonly aDirectory: string;
  readonly aEvidence: string;
  readonly bDirectory: string;
  readonly bEvidence: string;
  readonly env: NodeJS.ProcessEnv;
}

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

async function createArtifact(
  directory: string,
  version: string,
  mutateManifest?: (manifest: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  await mkdir(join(directory, 'src'), { recursive: true });
  const manifestInput = JSON.parse(await readFile(join(ROOT, 'examples/reference-plugin/src/manifest.json'), 'utf8')) as Record<string, unknown>;
  manifestInput.version = version;
  mutateManifest?.(manifestInput);
  const parsedManifest = manifestSchema.parse(manifestInput);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifestInput, null, 2)}\n`);
  const serverBytes = await readFile(join(ROOT, 'examples/reference-plugin/src/server.js'));
  await writeFile(join(directory, 'src/manifest.json'), manifestBytes);
  await writeFile(join(directory, 'src/server.js'), serverBytes);
  await symlink('server.js', join(directory, 'src/server-link.js'));

  const payloadFiles = [];
  const srcStats = await lstat(join(directory, 'src'));
  payloadFiles.push({ path: 'src', kind: 'directory', mode: srcStats.mode & 0o777, size: 0 });
  for (const [name, bytes] of [['src/manifest.json', manifestBytes], ['src/server.js', serverBytes]] as const) {
    const metadata = await lstat(join(directory, name));
    payloadFiles.push({ path: name, kind: 'file', mode: metadata.mode & 0o777, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  const linkMetadata = await lstat(join(directory, 'src/server-link.js'));
  payloadFiles.push({ path: 'src/server-link.js', kind: 'symlink', mode: linkMetadata.mode & 0o777,
    size: Buffer.byteLength('server.js', 'utf8'), target: 'server.js' });
  payloadFiles.sort((left, right) => left.path.localeCompare(right.path));
  const licenseInventory = [
    { name: '@hasi/plugin-sdk', version: '0.1.0', license: 'GPL-3.0-only' },
    { name: 'hasi-reference-plugin', version, license: 'GPL-3.0-only' },
  ];
  const artifact = {
    schemaVersion: 1,
    pluginId: parsedManifest.id,
    pluginVersion: version,
    manifestDigest: digest(parsedManifest),
    manifestFileSha256: sha256(manifestBytes),
    artifactSha256: artifactPayloadDigest(payloadFiles),
    artifactDigestDefinition: 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.',
    sdkRuntime: { packageName: '@hasi/plugin-sdk', packageVersion: '0.1.0', path: 'vendor/plugin-sdk', runtimePackageCount: 1 },
    licenseInventory,
    payloadFiles,
    payloadEntryCount: payloadFiles.length,
  };
  const artifactManifestBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(join(directory, 'artifact-manifest.json'), artifactManifestBytes);
  return {
    pluginId: parsedManifest.id,
    pluginVersion: version,
    manifestDigest: artifact.manifestDigest,
    manifestFileSha256: artifact.manifestFileSha256,
    artifactSha256: artifact.artifactSha256,
    artifactManifestSha256: sha256(artifactManifestBytes),
    payloadFileCount: payloadFiles.filter(entry => entry.kind !== 'directory').length,
    runtimePackageCount: 1,
    licenseInventory,
  };
}

async function fixture(options: {
  readonly mutateBManifest?: (manifest: Record<string, unknown>) => void;
} = {}): Promise<ArtifactInputFixture> {
  const outside = await mkdtemp(join(tmpdir(), 'hasi-gateway-external-artifacts-'));
  temporaryRoots.push(outside);
  const workspace = join(outside, 'checkout');
  await mkdir(workspace);
  const aDirectory = join(outside, 'artifact-a');
  const bDirectory = join(outside, 'artifact-b');
  await mkdir(aDirectory);
  await mkdir(bDirectory);
  const aEvidence = join(outside, 'artifact-a-evidence.json');
  const bEvidence = join(outside, 'artifact-b-evidence.json');
  const artifactEvidenceA = await createArtifact(aDirectory, '1.0.0');
  const artifactEvidenceB = await createArtifact(bDirectory, '1.1.0', options.mutateBManifest);
  const makeSidecar = (revision: string, tag: string, artifactEvidence: Record<string, unknown>) => ({
    schemaVersion: 1,
    source: { repository: sourceRepository, revision, tag },
    artifactEvidence,
  });
  await writeFile(aEvidence, JSON.stringify(makeSidecar('a'.repeat(40), 'v1.0.0', artifactEvidenceA)));
  await writeFile(bEvidence, JSON.stringify(makeSidecar('b'.repeat(40), 'v1.1.0', artifactEvidenceB)));
  const env = {
    [EXTERNAL_ARTIFACT_ENV.aDirectory]: aDirectory,
    [EXTERNAL_ARTIFACT_ENV.aEvidence]: aEvidence,
    [EXTERNAL_ARTIFACT_ENV.bDirectory]: bDirectory,
    [EXTERNAL_ARTIFACT_ENV.bEvidence]: bEvidence,
  } as NodeJS.ProcessEnv;
  return { workspace, outside, aDirectory, aEvidence, bDirectory, bEvidence, env };
}

function loader(input: ArtifactInputFixture, readArtifactManifest = qualificationFixtures.readArtifactManifest) {
  return loadExternalPluginArtifactPair({
    env: input.env,
    workspaceRoot: input.workspace,
    readArtifactManifest,
  });
}

describe('external gateway qualification artifacts', () => {
  it('keeps the default workspace fixture mode when no external inputs are set', async () => {
    const reader = vi.fn(qualificationFixtures.readArtifactManifest);
    const result = await loadExternalPluginArtifactPair({ env: {}, workspaceRoot: ROOT, readArtifactManifest: reader });
    expect(result).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('admits two complete external artifacts and verifies their inventories before returning', async () => {
    const input = await fixture();
    const result = await loader(input);
    expect(result?.a.source).toEqual({ repository: sourceRepository, revision: 'a'.repeat(40), tag: 'v1.0.0' });
    expect(result?.a.artifact.pluginVersion).toBe('1.0.0');
    expect(result?.b.source.revision).toBe('b'.repeat(40));
    expect(result?.b.artifact.pluginVersion).toBe('1.1.0');
  });

  it('rejects partial input before invoking artifact verification', async () => {
    const reader = vi.fn(qualificationFixtures.readArtifactManifest);
    await expect(loadExternalPluginArtifactPair({
      env: { [EXTERNAL_ARTIFACT_ENV.aDirectory]: '/tmp/external-a' },
      workspaceRoot: ROOT,
      readArtifactManifest: reader,
    })).rejects.toThrow('external_artifact_inputs_incomplete');
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects credential-bearing repository URLs and noncanonical source identities', async () => {
    const input = await fixture();
    const sidecar = JSON.parse(await readFile(input.aEvidence, 'utf8')) as Record<string, unknown>;
    (sidecar.source as Record<string, unknown>).repository = 'https://user:secret@example.invalid/qualification-plugin.git';
    await writeFile(input.aEvidence, JSON.stringify(sidecar));
    await expect(loader(input)).rejects.toThrow('external_artifact_source_invalid');
  });

  it('accepts absolute local file repository identities as metadata without fetching them', async () => {
    const input = await fixture();
    const localRepository = pathToFileURL(input.outside).href;
    for (const evidencePath of [input.aEvidence, input.bEvidence]) {
      const sidecar = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      (sidecar.source as Record<string, unknown>).repository = localRepository;
      await writeFile(evidencePath, JSON.stringify(sidecar));
    }
    const result = await loader(input);
    expect(result?.a.source.repository).toBe(localRepository);

    const localhostInput = await fixture();
    const localhostRepository = `file://localhost${localhostInput.outside}`;
    for (const evidencePath of [localhostInput.aEvidence, localhostInput.bEvidence]) {
      const sidecar = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
      (sidecar.source as Record<string, unknown>).repository = localhostRepository;
      await writeFile(evidencePath, JSON.stringify(sidecar));
    }
    const localhostResult = await loader(localhostInput);
    expect(localhostResult?.a.source.repository).toBe(localhostRepository);
  });

  it('rejects artifact paths inside the HASI checkout before reading evidence', async () => {
    const input = await fixture();
    const inside = join(input.workspace, 'artifact-a');
    await mkdir(inside);
    const env = { ...input.env, [EXTERNAL_ARTIFACT_ENV.aDirectory]: inside };
    await expect(loadExternalPluginArtifactPair({ env, workspaceRoot: input.workspace, readArtifactManifest: qualificationFixtures.readArtifactManifest }))
      .rejects.toThrow('external_artifact_path_inside_workspace');
  });

  it('rejects sidecar symlinks and path overlap', async () => {
    const input = await fixture();
    const target = `${input.aEvidence}.target`;
    await writeFile(target, await readFile(input.aEvidence));
    await rm(input.aEvidence);
    await symlink(target, input.aEvidence);
    await expect(loader(input)).rejects.toThrow('external_artifact_evidence_file_invalid');

    const second = await fixture();
    const env = { ...second.env, [EXTERNAL_ARTIFACT_ENV.aEvidence]: join(second.aDirectory, 'artifact-manifest.json') };
    await expect(loadExternalPluginArtifactPair({ env, workspaceRoot: second.workspace, readArtifactManifest: qualificationFixtures.readArtifactManifest }))
      .rejects.toThrow('external_artifact_paths_overlap');
  });

  it('rejects duplicated revisions or a nonincreasing update', async () => {
    const input = await fixture();
    const sidecar = JSON.parse(await readFile(input.bEvidence, 'utf8')) as Record<string, unknown>;
    (sidecar.source as Record<string, unknown>).revision = 'a'.repeat(40);
    await writeFile(input.bEvidence, JSON.stringify(sidecar));
    await expect(loader(input)).rejects.toThrow('external_artifact_pair_invalid');
  });

  it('rejects evidence metadata that disagrees with the immutable artifact manifest', async () => {
    const input = await fixture();
    const sidecar = JSON.parse(await readFile(input.aEvidence, 'utf8')) as Record<string, unknown>;
    (sidecar.artifactEvidence as Record<string, unknown>).runtimePackageCount = 2;
    await writeFile(input.aEvidence, JSON.stringify(sidecar));
    await expect(loader(input)).rejects.toThrow('external_artifact_manifest_evidence_mismatch');
  });

  it('rejects payload corruption through the complete inventory verifier', async () => {
    const input = await fixture();
    await writeFile(join(input.aDirectory, 'src/server.js'), 'tampered');
    await expect(loader(input)).rejects.toThrow('artifact_payload_entry_mismatch');
  });

  it('checks the complete inventory before reading a child manifest through a symlinked ancestor', async () => {
    const input = await fixture();
    const escapedSource = join(input.outside, 'escaped-src');
    await rename(join(input.aDirectory, 'src'), escapedSource);
    await symlink(escapedSource, join(input.aDirectory, 'src'));
    await expect(loader(input)).rejects.toThrow('artifact_symlink_escapes_root');
  });

  it('copies external artifacts into an owned snapshot and rejects source changes after admission', async () => {
    const input = await fixture();
    const admitted = await loader(input);
    expect(admitted).toBeDefined();
    if (!admitted) throw new Error('external artifact pair was not admitted');
    const snapshotDirectory = join(input.workspace, 'owned-snapshot-a');
    const sourceSymlinkMode = (await lstat(join(input.aDirectory, 'src/server-link.js'))).mode & 0o777;
    const snapshot = await createVerifiedArtifactSnapshot({
      sourceDirectory: admitted.a.directory,
      destinationDirectory: snapshotDirectory,
      evidence: admitted.a.evidence,
      inventory: admitted.a.artifact.payloadFiles,
      readArtifactManifest: qualificationFixtures.readArtifactManifest,
    });
    expect(snapshot.artifact.pluginVersion).toBe('1.0.0');
    expect(await readFile(join(snapshot.directory, 'src/server.js')))
      .toEqual(await readFile(join(input.aDirectory, 'src/server.js')));
    expect((await lstat(join(snapshot.directory, 'src/server-link.js'))).mode & 0o777)
      .toBe(admitted.a.artifact.payloadFiles.find(entry => entry.path === 'src/server-link.js')?.mode);
    expect((await lstat(join(input.aDirectory, 'src/server-link.js'))).mode & 0o777).toBe(sourceSymlinkMode);

    await writeFile(join(input.aDirectory, 'src/server.js'), 'changed after admission');
    await expect(createVerifiedArtifactSnapshot({
      sourceDirectory: admitted.a.directory,
      destinationDirectory: join(input.workspace, 'changed-snapshot-a'),
      evidence: admitted.a.evidence,
      inventory: admitted.a.artifact.payloadFiles,
      readArtifactManifest: qualificationFixtures.readArtifactManifest,
    })).rejects.toThrow('artifact_payload_entry_mismatch');
  });

  it('rejects unsafe snapshot inventory paths before copying', async () => {
    const input = await fixture();
    const admitted = await loader(input);
    expect(admitted).toBeDefined();
    if (!admitted) throw new Error('external artifact pair was not admitted');
    const inventory = admitted.a.artifact.payloadFiles.map(entry => ({ ...entry }));
    inventory[0] = { ...inventory[0]!, path: '../outside' };
    await expect(createVerifiedArtifactSnapshot({
      sourceDirectory: admitted.a.directory,
      destinationDirectory: join(input.workspace, 'unsafe-snapshot-a'),
      evidence: admitted.a.evidence,
      inventory,
      readArtifactManifest: qualificationFixtures.readArtifactManifest,
    })).rejects.toThrow('external_artifact_snapshot_inventory_invalid');
  });

  it('rejects a symlinked ancestor before normalizing a copied symlink mode', async () => {
    const input = await fixture();
    const admitted = await loader(input);
    expect(admitted).toBeDefined();
    if (!admitted) throw new Error('external artifact pair was not admitted');
    const escapedSource = join(input.outside, 'escaped-snapshot-src');
    await rename(join(input.aDirectory, 'src'), escapedSource);
    await symlink(escapedSource, join(input.aDirectory, 'src'));
    await expect(createVerifiedArtifactSnapshot({
      sourceDirectory: admitted.a.directory,
      destinationDirectory: join(input.workspace, 'symlink-ancestor-snapshot-a'),
      evidence: admitted.a.evidence,
      inventory: admitted.a.artifact.payloadFiles,
      readArtifactManifest: qualificationFixtures.readArtifactManifest,
    })).rejects.toThrow('external_artifact_snapshot_symlink_ancestor_invalid');
  });

  it('rejects an update whose reference manifest contract changed after inventory verification', async () => {
    const input = await fixture({
      mutateBManifest: manifest => {
        const tools = manifest.tools as Record<string, unknown>[];
        const status = tools.find(tool => tool.name === 'read_status');
        const output = status?.outputSchema as Record<string, unknown>;
        const properties = output.properties as Record<string, Record<string, unknown>>;
        const label = properties.label;
        if (!label) throw new Error('reference fixture label schema is missing');
        label.type = 'integer';
      },
    });
    const reader = vi.fn(qualificationFixtures.readArtifactManifest);
    await expect(loader(input, reader)).rejects.toThrow('external_artifact_reference_contract_invalid');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('rejects different otherwise-valid contracts after inventory verification', async () => {
    const input = await fixture({ mutateBManifest: manifest => { manifest.description = 'Different contract revision'; } });
    const reader = vi.fn(qualificationFixtures.readArtifactManifest);
    await expect(loader(input, reader)).rejects.toThrow('external_artifact_reference_contract_mismatch');
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
