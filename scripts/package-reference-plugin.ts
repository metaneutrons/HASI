import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { copyFile, lchmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_ROOT = join(WORKSPACE_ROOT, 'examples/reference-plugin');
const SDK_ROOT = join(WORKSPACE_ROOT, 'packages/plugin-sdk');
const SDK_DEPLOY_ROOT = join('vendor', 'plugin-sdk');
const EXPECTED_PLUGIN_ID = 'hasi.reference';

interface ManifestApi {
  readonly manifestSchema: { safeParse(input: unknown): { success: true; data: Record<string, unknown> } | { success: false } };
  readonly digest: (value: unknown) => string;
}

export interface ReferenceArtifactFile {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'directory';
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
}

export interface ReferencePluginArtifactEvidence {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestDigest: string;
  readonly manifestFileSha256: string;
  readonly artifactSha256: string;
  readonly artifactManifestSha256: string;
  readonly payloadFileCount: number;
  readonly runtimePackageCount: number;
  readonly licenseInventory: readonly { readonly name: string; readonly version: string; readonly license: string }[];
}

type CommandPhase = 'sdk-build' | 'dependency-preparation' | 'offline-deploy';
const failureCategories = [
  'ERR_PNPM_NO_OFFLINE_META', 'ERR_PNPM_NO_OFFLINE_TARBALL',
  'ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE', 'ERR_PNPM_OUTDATED_LOCKFILE',
  'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH', 'ERR_PNPM_TARBALL_INTEGRITY',
  'ERR_PNPM_DEPLOY_AMBIGUOUS_PEER', 'ERR_PNPM_META_FETCH_FAIL',
] as const;

/** Only fixed diagnostic categories leave the subprocess boundary, never raw output. */
export class ReferencePackagingCommandError extends Error {
  constructor(phase: CommandPhase, error: unknown) {
    const record = typeof error === 'object' && error !== null
      ? error as Record<string, unknown> : {};
    const output = [record.stdout, record.stderr].map(value =>
      typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '').join('\n');
    const category = failureCategories.find(value => output.includes(value))
      ?? (record.code === 'ETIMEDOUT' ? 'timeout' : record.code === 'ENOENT' ? 'command_unavailable' : 'unclassified');
    const status = typeof record.status === 'number' && Number.isInteger(record.status)
      && record.status >= 0 && record.status <= 255 ? String(record.status) : 'unknown';
    super(`Reference artifact command failed during ${phase} (category: ${category}; exit: ${status}).`);
    this.name = 'ReferencePackagingCommandError';
  }
}

function runLocalCommand(command: string, args: readonly string[], cwd: string, phase: CommandPhase): void {
  try {
    execFileSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new ReferencePackagingCommandError(phase, error);
  }
}

function deploySdk(outputDirectory: string, offline: boolean): void {
  runLocalCommand('pnpm', [
    ...(offline ? ['--offline'] : []),
    '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
    '--filter', '@hasi/plugin-sdk', 'deploy', '--prod', outputDirectory,
  ], WORKSPACE_ROOT, offline ? 'offline-deploy' : 'dependency-preparation');
}

/** Explicit online preparation for pnpm's dedicated deployment-lockfile metadata. */
export async function prepareReferencePluginDependencies(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'hasi-reference-dependencies-'));
  try {
    deploySdk(join(directory, 'sdk'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function loadManifestApi(): Promise<ManifestApi> {
  runLocalCommand('pnpm', ['--filter', '@hasi/plugin-sdk', 'build'], WORKSPACE_ROOT, 'sdk-build');
  const module = await import(pathToFileURL(join(SDK_ROOT, 'dist/index.js')).href) as ManifestApi;
  return module;
}

function licenseLabel(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const labels = value.map(item => licenseLabel(item)).filter(Boolean);
    return labels.length > 0 ? labels.sort().join(' OR ') : 'UNSPECIFIED';
  }
  if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && value.type.trim()) {
    return value.type.trim();
  }
  return 'UNSPECIFIED';
}

async function packageLicenses(sdkRoot: string): Promise<ReferencePluginArtifactEvidence['licenseInventory']> {
  const packages = new Map<string, { readonly name: string; readonly version: string; readonly license: string }>();
  async function addPackageManifest(path: string): Promise<void> {
    const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
      throw new Error('Reference SDK runtime package metadata is incomplete.');
    }
    const item = { name: metadata.name, version: metadata.version, license: licenseLabel(metadata.license ?? metadata.licenses) };
    packages.set(`${item.name}\0${item.version}\0${item.license}`, item);
  }

  async function packageRoots(directory: string, scoped: boolean): Promise<void> {
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const fullPath = join(directory, child.name);
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      if (!scoped && child.name.startsWith('@')) {
        await packageRoots(fullPath, true);
        continue;
      }
      try {
        await addPackageManifest(join(fullPath, 'package.json'));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  await addPackageManifest(join(sdkRoot, 'package.json'));
  const pnpmStore = join(sdkRoot, 'node_modules', '.pnpm');
  let snapshots: Dirent[];
  try {
    snapshots = await readdir(pnpmStore, { withFileTypes: true });
  } catch {
    throw new Error('Reference SDK runtime dependency store is missing.');
  }
  for (const snapshot of snapshots) {
    if (!snapshot.isDirectory()) continue;
    await packageRoots(join(pnpmStore, snapshot.name, 'node_modules'), false);
  }
  return Object.freeze([...packages.values()].sort((left, right) => left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.license.localeCompare(right.license)));
}

async function assertSelfContainedSymlinks(root: string, directory: string): Promise<void> {
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, child.name);
    if (child.isDirectory()) {
      await assertSelfContainedSymlinks(root, fullPath);
      continue;
    }
    if (!child.isSymbolicLink()) continue;
    const target = await readlink(fullPath);
    if (isAbsolute(target)) throw new Error('Reference SDK dependency tree contains an absolute symbolic link.');
    const resolvedTarget = resolve(dirname(fullPath), target);
    const fromRoot = relative(root, resolvedTarget);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Reference SDK dependency tree escapes its artifact directory.');
    }
  }
}

async function artifactFiles(root: string): Promise<ReferenceArtifactFile[]> {
  const files: ReferenceArtifactFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, child.name);
      const path = relative(root, fullPath).split(sep).join('/');
      if (child.isDirectory()) {
        const stats = await lstat(fullPath);
        files.push({ path, kind: 'directory', mode: stats.mode & 0o777, size: 0 });
        await visit(fullPath);
      } else if (child.isSymbolicLink()) {
        let stats = await lstat(fullPath);
        if ((stats.mode & 0o777) !== 0o777 && process.platform === 'darwin') {
          // Linux archives expose symlink mode 0777; normalize macOS's 0755 before recording this mode-bound digest.
          // lchmod changes the link itself; chmod would follow it and mutate target permissions.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required to normalize symlink mode on macOS.
          await lchmod(fullPath, 0o777);
        }
        stats = await lstat(fullPath);
        if ((stats.mode & 0o777) !== 0o777) {
          throw new Error('Reference artifact symbolic link permissions could not be normalized.');
        }
        const target = await readlink(fullPath);
        files.push({ path, kind: 'symlink', mode: stats.mode & 0o777, size: Buffer.byteLength(target, 'utf8'), target });
      } else if (child.isFile()) {
        const stats = await lstat(fullPath);
        const bytes = await readFile(fullPath);
        files.push({ path, kind: 'file', mode: stats.mode & 0o777, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function artifactDigest(files: readonly ReferenceArtifactFile[]): string {
  const hasher = createHash('sha256');
  for (const file of files) {
    hasher.update(file.path, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(file.kind, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(String(file.mode), 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(String(file.size), 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(file.sha256 ?? '', 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(file.target ?? '', 'utf8');
    hasher.update('\0', 'utf8');
  }
  return hasher.digest('hex');
}

async function assertNoMachineSpecificDeploymentMetadata(sdkRoot: string): Promise<void> {
  await rm(join(sdkRoot, 'node_modules', '.modules.yaml'), { force: true });
  await rm(join(sdkRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true });
}

/**
 * Packages the reviewed local reference plugin with the SDK production runtime
 * closure. pnpm is offline and lifecycle scripts are disabled for the deploy.
 */
export async function packageReferencePlugin(input: {
  readonly outputDirectory: string;
  readonly sourceDirectory?: string;
}): Promise<ReferencePluginArtifactEvidence> {
  const outputDirectory = resolve(input.outputDirectory);
  const sourceDirectory = resolve(input.sourceDirectory ?? EXAMPLE_ROOT);
  const parentDirectory = dirname(outputDirectory);
  const packageMetadata = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8')) as Record<string, unknown>;
  const manifestBytes = await readFile(join(sourceDirectory, 'src', 'manifest.json'));
  const manifestInput = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  const sdk = await loadManifestApi();
  const parsedManifest = sdk.manifestSchema.safeParse(manifestInput);
  if (!parsedManifest.success || parsedManifest.data.id !== EXPECTED_PLUGIN_ID
    || typeof parsedManifest.data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsedManifest.data.version)) {
    throw new Error('The reference plugin manifest identity or version is invalid.');
  }
  if (packageMetadata.name !== 'hasi-reference-plugin' || packageMetadata.license !== 'GPL-3.0-only') {
    throw new Error('The reference plugin package metadata is invalid.');
  }

  await mkdir(parentDirectory, { recursive: true });
  try {
    await lstat(outputDirectory);
    throw new Error('Reference artifact output directory already exists.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Reference artifact output directory already exists.') throw error;
  }

  let createdOutput = false;
  try {
    await mkdir(outputDirectory);
    createdOutput = true;
    const sdkDeployDirectory = join(outputDirectory, SDK_DEPLOY_ROOT);
    await mkdir(dirname(sdkDeployDirectory), { recursive: true });
    deploySdk(sdkDeployDirectory, true);
    await assertNoMachineSpecificDeploymentMetadata(sdkDeployDirectory);
    await assertSelfContainedSymlinks(sdkDeployDirectory, sdkDeployDirectory);

    await mkdir(join(outputDirectory, 'src'), { recursive: true });
    await copyFile(join(sourceDirectory, 'README.md'), join(outputDirectory, 'README.md'));
    await copyFile(join(WORKSPACE_ROOT, 'LICENSE'), join(outputDirectory, 'LICENSE'));
    await copyFile(join(sourceDirectory, 'src', 'server.js'), join(outputDirectory, 'src', 'server.js'));
    await copyFile(join(sourceDirectory, 'src', 'manifest.json'), join(outputDirectory, 'src', 'manifest.json'));
    const packagedMetadata = {
      name: packageMetadata.name,
      version: parsedManifest.data.version,
      private: true,
      type: 'module',
      license: packageMetadata.license,
      scripts: { start: 'node src/server.js' },
    };
    await writeFile(join(outputDirectory, 'package.json'), `${JSON.stringify(packagedMetadata, null, 2)}\n`, 'utf8');

    const files = await artifactFiles(outputDirectory);
    const sdkPackages = await packageLicenses(sdkDeployDirectory);
    const licenses = Object.freeze([...sdkPackages, {
      name: 'hasi-reference-plugin',
      version: parsedManifest.data.version,
      license: licenseLabel(packageMetadata.license),
    }].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.license.localeCompare(right.license)));
    const manifestDigest = sdk.digest(parsedManifest.data);
    const manifestFileSha256 = createHash('sha256').update(manifestBytes).digest('hex');
    const artifactSha256 = artifactDigest(files);
    const sdkPackage = JSON.parse(await readFile(join(sdkDeployDirectory, 'package.json'), 'utf8')) as Record<string, unknown>;
    const artifactManifest = {
      schemaVersion: 1,
      pluginId: EXPECTED_PLUGIN_ID,
      pluginVersion: parsedManifest.data.version,
      manifestDigest,
      manifestFileSha256,
      artifactSha256,
      artifactDigestDefinition: 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.',
      sdkRuntime: {
        packageName: sdkPackage.name,
        packageVersion: sdkPackage.version,
        path: SDK_DEPLOY_ROOT.split(sep).join('/'),
        runtimePackageCount: sdkPackages.length,
      },
      licenseInventory: licenses,
      payloadFiles: files,
      payloadEntryCount: files.length,
    };
    await writeFile(join(outputDirectory, 'artifact-manifest.json'), `${JSON.stringify(artifactManifest, null, 2)}\n`, 'utf8');
    const artifactManifestSha256 = createHash('sha256').update(await readFile(join(outputDirectory, 'artifact-manifest.json'))).digest('hex');
    return Object.freeze({
      pluginId: EXPECTED_PLUGIN_ID,
      pluginVersion: parsedManifest.data.version,
      manifestDigest,
      manifestFileSha256,
      artifactSha256,
      artifactManifestSha256,
      payloadFileCount: files.filter(file => file.kind !== 'directory').length,
      runtimePackageCount: sdkPackages.length,
      licenseInventory: licenses,
    });
  } catch (error) {
    if (createdOutput) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

const scriptPath = process.argv[1];
if (scriptPath && resolve(scriptPath) === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory || process.argv.length !== 3) {
    process.stderr.write('Usage: pnpm exec tsx scripts/package-reference-plugin.ts <new-output-directory>|--prepare\n');
    process.exitCode = 2;
  } else {
    try {
      if (outputDirectory === '--prepare') {
        await prepareReferencePluginDependencies();
        process.stdout.write('Reference SDK dependencies prepared; artifact packaging remains offline.\n');
      } else {
        const evidence = await packageReferencePlugin({ outputDirectory });
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      }
    } catch (error) {
      process.stderr.write(error instanceof ReferencePackagingCommandError ? `${error.message}\n` : 'Reference plugin packaging failed.\n');
      process.exitCode = 1;
    }
  }
}
