import { createHash } from 'node:crypto';
import { cp, lchmod, lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { valid as validSemver, gt as semverGreaterThan } from 'semver';
import { digest, manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import type { ReferencePluginArtifactEvidence } from './package-reference-plugin.js';

export const EXTERNAL_ARTIFACT_ENV = Object.freeze({
  aDirectory: 'HASI_GATEWAY_QUALIFY_ARTIFACT_A_DIR',
  aEvidence: 'HASI_GATEWAY_QUALIFY_ARTIFACT_A_EVIDENCE',
  bDirectory: 'HASI_GATEWAY_QUALIFY_ARTIFACT_B_DIR',
  bEvidence: 'HASI_GATEWAY_QUALIFY_ARTIFACT_B_EVIDENCE',
});

const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface ExternalPluginSourceIdentity {
  readonly repository: string;
  readonly revision: string;
  readonly tag: string;
}

export interface ExternalPluginArtifact<TArtifact> {
  readonly directory: string;
  readonly source: ExternalPluginSourceIdentity;
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly artifact: TArtifact;
}

export interface ExternalPluginArtifactPair<TArtifact> {
  readonly a: ExternalPluginArtifact<TArtifact>;
  readonly b: ExternalPluginArtifact<TArtifact>;
}

export class ExternalPluginArtifactInputError extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'ExternalPluginArtifactInputError';
  }
}

export interface ArtifactSnapshotInventoryEntry {
  readonly path: string;
  readonly kind: string;
  readonly mode: number;
  readonly target?: string;
}

function fail(category: string): never {
  throw new ExternalPluginArtifactInputError(category);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function parseRepositoryUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 2048) {
    fail('external_artifact_source_invalid');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('external_artifact_source_invalid'); }
  const canonicalHttps = parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.href === value;
  const canonicalFile = parsed.protocol === 'file:' && parsed.hostname === ''
    && (parsed.href === value || (value.startsWith('file://localhost/')
      && parsed.href === `file://${value.slice('file://localhost'.length)}`));
  if ((!canonicalHttps && !canonicalFile) || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.pathname.startsWith('/') || parsed.pathname === '/') {
    fail('external_artifact_source_invalid');
  }
  return value;
}

function parseSidecar(value: unknown): {
  readonly source: ExternalPluginSourceIdentity;
  readonly evidence: ReferencePluginArtifactEvidence;
} {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.source)
    || !isRecord(value.artifactEvidence)
    || Object.keys(value).sort().join(',') !== 'artifactEvidence,schemaVersion,source'
    || Object.keys(value.source).sort().join(',') !== 'repository,revision,tag') {
    return fail('external_artifact_evidence_invalid');
  }

  const source = value.source;
  const evidence = value.artifactEvidence;
  const repository = parseRepositoryUrl(source.repository);
  if (typeof source.revision !== 'string' || !GIT_REVISION.test(source.revision)
    || typeof source.tag !== 'string' || source.tag.length > 128) {
    fail('external_artifact_source_invalid');
  }

  const allowedEvidenceKeys = [
    'artifactManifestSha256', 'artifactSha256', 'licenseInventory', 'manifestDigest',
    'manifestFileSha256', 'payloadFileCount', 'pluginId', 'pluginVersion',
    'runtimePackageCount',
  ];
  if (Object.keys(evidence).sort().join(',') !== allowedEvidenceKeys.sort().join(',')) {
    fail('external_artifact_evidence_invalid');
  }
  if (evidence.pluginId !== 'hasi.reference'
    || typeof evidence.pluginVersion !== 'string' || validSemver(evidence.pluginVersion) !== evidence.pluginVersion
    || !isSha256(evidence.manifestDigest) || !isSha256(evidence.manifestFileSha256)
    || !isSha256(evidence.artifactSha256) || !isSha256(evidence.artifactManifestSha256)
    || !Number.isSafeInteger(evidence.payloadFileCount) || Number(evidence.payloadFileCount) < 1
    || Number(evidence.payloadFileCount) > 25_000
    || !Number.isSafeInteger(evidence.runtimePackageCount) || Number(evidence.runtimePackageCount) < 1
    || Number(evidence.runtimePackageCount) > 10_000
    || !Array.isArray(evidence.licenseInventory) || evidence.licenseInventory.length > 10_000) {
    fail('external_artifact_evidence_invalid');
  }
  for (const entry of evidence.licenseInventory) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'license,name,version'
      || typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 512
      || typeof entry.version !== 'string' || entry.version.length < 1 || entry.version.length > 128
      || typeof entry.license !== 'string' || entry.license.length < 1 || entry.license.length > 512) {
      fail('external_artifact_evidence_invalid');
    }
  }

  const tagVersion = source.tag.startsWith('v') ? source.tag.slice(1) : source.tag;
  if (tagVersion !== evidence.pluginVersion) fail('external_artifact_source_version_mismatch');

  return {
    source: Object.freeze({ repository, revision: source.revision, tag: source.tag }),
    evidence: evidence as unknown as ReferencePluginArtifactEvidence,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath));
}

async function resolveExternalPath(path: string | undefined, workspaceRoot: string, kind: 'directory' | 'evidence'): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) {
    fail(`external_artifact_${kind}_path_invalid`);
  }
  let metadata;
  let resolvedPath: string;
  try {
    metadata = await lstat(path);
    resolvedPath = await realpath(path);
  } catch {
    fail(`external_artifact_${kind}_missing`);
  }
  if (kind === 'directory') {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('external_artifact_directory_invalid');
  } else if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EVIDENCE_BYTES) {
    fail('external_artifact_evidence_file_invalid');
  }

  let rootPath: string;
  try { rootPath = await realpath(workspaceRoot); } catch { fail('qualification_workspace_unavailable'); }
  if (isWithin(rootPath, resolvedPath)) fail('external_artifact_path_inside_workspace');
  return resolvedPath;
}

async function readSidecar(path: string): Promise<ReturnType<typeof parseSidecar>> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) fail('external_artifact_evidence_file_invalid');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')) as unknown; } catch { fail('external_artifact_evidence_invalid'); }
    return parseSidecar(value);
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) throw error;
    fail('external_artifact_evidence_read_failed');
  }
}

interface ArtifactManifestMetadata {
  readonly schemaVersion: 1;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestDigest: string;
  readonly manifestFileSha256: string;
  readonly artifactSha256: string;
  readonly artifactDigestDefinition: 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.';
  readonly payloadEntryCount: number;
  readonly payloadFiles: readonly { readonly kind: string }[];
  readonly sdkRuntime: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly path: string;
    readonly runtimePackageCount: number;
  };
  readonly licenseInventory: readonly { readonly name: string; readonly version: string; readonly license: string }[];
}

function parseArtifactManifestMetadata(value: unknown): ArtifactManifestMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.pluginId !== 'string' || typeof value.pluginVersion !== 'string'
    || !isSha256(value.manifestDigest) || !isSha256(value.manifestFileSha256) || !isSha256(value.artifactSha256)
    || value.artifactDigestDefinition !== 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.'
    || !Number.isSafeInteger(value.payloadEntryCount) || !Array.isArray(value.payloadFiles)
    || value.payloadFiles.length > 25_000 || value.payloadEntryCount !== value.payloadFiles.length
    || !isRecord(value.sdkRuntime) || typeof value.sdkRuntime.packageName !== 'string'
    || typeof value.sdkRuntime.packageVersion !== 'string' || typeof value.sdkRuntime.path !== 'string'
    || !Number.isSafeInteger(value.sdkRuntime.runtimePackageCount)
    || !Array.isArray(value.licenseInventory)) {
    return fail('external_artifact_manifest_metadata_invalid');
  }
  const payloadFiles = value.payloadFiles;
  if (!payloadFiles.every(isRecord) || !payloadFiles.every(entry => typeof entry.kind === 'string')) {
    fail('external_artifact_manifest_metadata_invalid');
  }
  const inventory = value.licenseInventory;
  if (!inventory.every(isRecord) || !inventory.every(entry => typeof entry.name === 'string'
    && typeof entry.version === 'string' && typeof entry.license === 'string')) {
    fail('external_artifact_manifest_metadata_invalid');
  }
  return value as unknown as ArtifactManifestMetadata;
}

async function verifyManifestMetadata(
  directory: string,
  expected: ReferencePluginArtifactEvidence,
): Promise<PluginManifestV2> {
  let bytes: Buffer;
  try {
    const metadata = await lstat(resolve(directory, 'artifact-manifest.json'));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ARTIFACT_MANIFEST_BYTES) {
      fail('external_artifact_manifest_file_invalid');
    }
    bytes = await readFile(resolve(directory, 'artifact-manifest.json'));
    if (bytes.byteLength > MAX_ARTIFACT_MANIFEST_BYTES) fail('external_artifact_manifest_file_invalid');
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) throw error;
    fail('external_artifact_manifest_read_failed');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected.artifactManifestSha256) {
    fail('external_artifact_manifest_hash_mismatch');
  }
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { fail('external_artifact_manifest_invalid'); }
  const artifact = parseArtifactManifestMetadata(raw);
  const payloadFileCount = artifact.payloadFiles.filter(file => file.kind !== 'directory').length;
  if (artifact.pluginId !== expected.pluginId || artifact.pluginVersion !== expected.pluginVersion
    || artifact.manifestDigest !== expected.manifestDigest || artifact.manifestFileSha256 !== expected.manifestFileSha256
    || artifact.artifactSha256 !== expected.artifactSha256 || payloadFileCount !== expected.payloadFileCount
    || artifact.sdkRuntime.runtimePackageCount !== expected.runtimePackageCount
    || JSON.stringify(artifact.licenseInventory) !== JSON.stringify(expected.licenseInventory)) {
    fail('external_artifact_manifest_evidence_mismatch');
  }

  let manifestBytes: Buffer;
  try {
    const manifestPath = resolve(directory, 'src/manifest.json');
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ARTIFACT_MANIFEST_BYTES) {
      fail('external_artifact_plugin_manifest_invalid');
    }
    manifestBytes = await readFile(manifestPath);
    if (manifestBytes.byteLength > MAX_ARTIFACT_MANIFEST_BYTES) fail('external_artifact_plugin_manifest_invalid');
  } catch (error) {
    if (error instanceof ExternalPluginArtifactInputError) throw error;
    fail('external_artifact_plugin_manifest_read_failed');
  }
  if (createHash('sha256').update(manifestBytes).digest('hex') !== expected.manifestFileSha256) {
    fail('external_artifact_plugin_manifest_hash_mismatch');
  }
  let input: unknown;
  try { input = JSON.parse(manifestBytes.toString('utf8')) as unknown; } catch { fail('external_artifact_plugin_manifest_invalid'); }
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success || parsed.data.manifestVersion !== 2 || parsed.data.id !== 'hasi.reference'
    || parsed.data.version !== expected.pluginVersion || digest(parsed.data) !== expected.manifestDigest) {
    fail('external_artifact_plugin_manifest_incompatible');
  }
  const statusTool = parsed.data.tools.find(tool => tool.name === 'read_status');
  const inputSchema = statusTool && isRecord(statusTool.inputSchema) ? statusTool.inputSchema : undefined;
  const inputProperties = inputSchema && isRecord(inputSchema.properties) ? inputSchema.properties : undefined;
  if (statusTool?.effect !== 'read' || !statusTool.requiredPermissions.includes('reference:read')
    || inputSchema?.type !== 'object' || inputSchema.additionalProperties !== false
    || !inputProperties || Object.keys(inputProperties).length !== 0) {
    fail('external_artifact_reference_contract_invalid');
  }
  const identityClaims: unknown = parsed.data.identity?.claims;
  const configurationSchema = isRecord(parsed.data.configuration?.schema) ? parsed.data.configuration.schema : undefined;
  const configurationProperties = configurationSchema && isRecord(configurationSchema.properties)
    ? configurationSchema.properties : undefined;
  const outputSchema = isRecord(statusTool.outputSchema) ? statusTool.outputSchema : undefined;
  const outputProperties = outputSchema && isRecord(outputSchema.properties) ? outputSchema.properties : undefined;
  const outputRequired: unknown = outputSchema?.required;
  const requiredOutput = ['account', 'actionCount', 'label', 'version'];
  if (!isStringArray(identityClaims) || !identityClaims.includes('reference.account')
    || !configurationSchema || !configurationProperties || configurationSchema.additionalProperties !== false
    || !isStringArray(configurationSchema.required) || !configurationSchema.required.includes('label')
    || !isRecord(configurationProperties.label) || configurationProperties.label.type !== 'string'
    || !outputSchema || !outputProperties || outputSchema.additionalProperties !== false
    || !isStringArray(outputRequired) || !requiredOutput.every(name => outputRequired.includes(name))
    || !isRecord(outputProperties.label) || outputProperties.label.type !== 'string'
    || !isRecord(outputProperties.account) || outputProperties.account.type !== 'string'
    || !isRecord(outputProperties.version) || outputProperties.version.type !== 'string'
    || !isRecord(outputProperties.actionCount) || outputProperties.actionCount.type !== 'integer') {
    fail('external_artifact_reference_contract_invalid');
  }
  return parsed.data;
}

export async function createVerifiedArtifactSnapshot<TArtifact>(input: {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly inventory: readonly ArtifactSnapshotInventoryEntry[];
  readonly readArtifactManifest: (directory: string, evidence: ReferencePluginArtifactEvidence) => Promise<TArtifact>;
}): Promise<{ readonly directory: string; readonly artifact: TArtifact }> {
  if (!isAbsolute(input.sourceDirectory) || !isAbsolute(input.destinationDirectory)) {
    fail('external_artifact_snapshot_path_invalid');
  }
  const sourceDirectory = resolve(input.sourceDirectory);
  const destinationDirectory = resolve(input.destinationDirectory);
  if (isWithin(sourceDirectory, destinationDirectory) || isWithin(destinationDirectory, sourceDirectory)) {
    fail('external_artifact_snapshot_paths_overlap');
  }
  validateSnapshotInventory(input.inventory);
  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  });
  await normalizeSnapshotSymlinkModes(destinationDirectory, input.inventory);
  const artifact = await input.readArtifactManifest(destinationDirectory, input.evidence);
  await verifyManifestMetadata(destinationDirectory, input.evidence);
  return Object.freeze({ directory: destinationDirectory, artifact });
}

function validateSnapshotInventory(inventory: readonly ArtifactSnapshotInventoryEntry[]): void {
  if (!Array.isArray(inventory) || inventory.length > 25_000) fail('external_artifact_snapshot_inventory_invalid');
  const paths = new Set<string>();
  for (const entry of inventory) {
    const candidate: unknown = entry;
    if (!isRecord(candidate)) fail('external_artifact_snapshot_inventory_invalid');
    const path = candidate.path;
    const kind = candidate.kind;
    const mode = candidate.mode;
    const target = candidate.target;
    if (typeof path !== 'string' || path.length < 1 || path.length > 4096
      || path.includes('\0') || path.includes('\\') || path.startsWith('/')
      || /^[a-zA-Z]:/u.test(path) || path === 'artifact-manifest.json'
      || path.split('/').some(component => component.length === 0 || component === '.' || component === '..')
      || typeof kind !== 'string' || !['file', 'directory', 'symlink'].includes(kind)
      || !Number.isSafeInteger(mode) || typeof mode !== 'number' || mode < 0 || mode > 0o777
      || paths.has(path)) {
      fail('external_artifact_snapshot_inventory_invalid');
    }
    if (kind === 'symlink') {
      if (typeof target !== 'string' || target.length < 1 || target.length > 4096
        || target.includes('\0') || isAbsolute(target) || /^[a-zA-Z]:[\\/]/u.test(target)) {
        fail('external_artifact_snapshot_inventory_invalid');
      }
    } else if (target !== undefined) {
      fail('external_artifact_snapshot_inventory_invalid');
    }
    paths.add(path);
  }
}

async function normalizeSnapshotSymlinkModes(
  destinationDirectory: string,
  inventory: readonly ArtifactSnapshotInventoryEntry[],
): Promise<void> {
  let rootMetadata;
  try { rootMetadata = await lstat(destinationDirectory); } catch { fail('external_artifact_snapshot_directory_invalid'); }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('external_artifact_snapshot_directory_invalid');

  for (const entry of inventory) {
    if (entry.kind !== 'symlink') continue;
    const components = entry.path.split('/');
    let copiedPath = destinationDirectory;
    try {
      for (const component of components.slice(0, -1)) {
        copiedPath = join(copiedPath, component);
        const ancestor = await lstat(copiedPath);
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
          fail('external_artifact_snapshot_symlink_ancestor_invalid');
        }
      }
      copiedPath = join(copiedPath, components.at(-1) ?? '');
      const metadata = await lstat(copiedPath);
      if (!metadata.isSymbolicLink()) fail('external_artifact_snapshot_symlink_entry_invalid');
      if ((metadata.mode & 0o777) === entry.mode) continue;
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Detect unavailable symlink-mode support and fail closed.
      if (process.platform !== 'darwin' || typeof lchmod !== 'function') {
        fail('external_artifact_snapshot_symlink_mode_mismatch');
      }
      if (await readlink(copiedPath) !== entry.target) fail('external_artifact_snapshot_symlink_target_mismatch');
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Preserve the Linux-normalized symlink mode in the owned snapshot.
      await lchmod(copiedPath, entry.mode);
      const normalized = await lstat(copiedPath);
      if (!normalized.isSymbolicLink() || (normalized.mode & 0o777) !== entry.mode
        || await readlink(copiedPath) !== entry.target) {
        fail('external_artifact_snapshot_symlink_mode_normalization_failed');
      }
    } catch (error) {
      if (error instanceof ExternalPluginArtifactInputError) throw error;
      fail('external_artifact_snapshot_symlink_mode_normalization_failed');
    }
  }
}

function referenceContractDigest(manifest: PluginManifestV2): string {
  return digest({ ...manifest, version: '<qualification-version>' });
}

export async function loadExternalPluginArtifactPair<TArtifact>(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly readArtifactManifest: (directory: string, evidence: ReferencePluginArtifactEvidence) => Promise<TArtifact>;
}): Promise<ExternalPluginArtifactPair<TArtifact> | undefined> {
  const values = Object.values(EXTERNAL_ARTIFACT_ENV).map(name => input.env[name]);
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => value === undefined)) fail('external_artifact_inputs_incomplete');

  const [aDirectory, aEvidencePath, bDirectory, bEvidencePath] = await Promise.all([
    resolveExternalPath(input.env[EXTERNAL_ARTIFACT_ENV.aDirectory], input.workspaceRoot, 'directory'),
    resolveExternalPath(input.env[EXTERNAL_ARTIFACT_ENV.aEvidence], input.workspaceRoot, 'evidence'),
    resolveExternalPath(input.env[EXTERNAL_ARTIFACT_ENV.bDirectory], input.workspaceRoot, 'directory'),
    resolveExternalPath(input.env[EXTERNAL_ARTIFACT_ENV.bEvidence], input.workspaceRoot, 'evidence'),
  ]);

  const allPaths = [aDirectory, aEvidencePath, bDirectory, bEvidencePath];
  if (new Set(allPaths).size !== allPaths.length
    || isWithin(aDirectory, bDirectory) || isWithin(bDirectory, aDirectory)
    || isWithin(aDirectory, aEvidencePath) || isWithin(bDirectory, aEvidencePath)
    || isWithin(aDirectory, bEvidencePath) || isWithin(bDirectory, bEvidencePath)) {
    fail('external_artifact_paths_overlap');
  }

  const [aSidecar, bSidecar] = await Promise.all([readSidecar(aEvidencePath), readSidecar(bEvidencePath)]);
  if (aSidecar.source.repository !== bSidecar.source.repository
    || aSidecar.source.revision === bSidecar.source.revision
    || aSidecar.source.tag === bSidecar.source.tag
    || !semverGreaterThan(bSidecar.evidence.pluginVersion, aSidecar.evidence.pluginVersion)) {
    fail('external_artifact_pair_invalid');
  }

  const [aArtifact, bArtifact] = await Promise.all([
    input.readArtifactManifest(aDirectory, aSidecar.evidence),
    input.readArtifactManifest(bDirectory, bSidecar.evidence),
  ]);
  const [aManifest, bManifest] = await Promise.all([
    verifyManifestMetadata(aDirectory, aSidecar.evidence),
    verifyManifestMetadata(bDirectory, bSidecar.evidence),
  ]);
  if (referenceContractDigest(aManifest) !== referenceContractDigest(bManifest)) {
    fail('external_artifact_reference_contract_mismatch');
  }
  return Object.freeze({
    a: Object.freeze({ directory: aDirectory, source: aSidecar.source, evidence: aSidecar.evidence, artifact: aArtifact }),
    b: Object.freeze({ directory: bDirectory, source: bSidecar.source, evidence: bSidecar.evidence, artifact: bArtifact }),
  });
}
