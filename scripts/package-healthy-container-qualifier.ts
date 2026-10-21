import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import {
  chmod, copyFile, lchmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageReferencePlugin, type ReferencePluginArtifactEvidence } from './package-reference-plugin.js';
import { artifactPluginProvenance, type ArtifactSourceIdentity } from './plugin-release-provenance.js';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_PLUGIN_ROOT = join(WORKSPACE_ROOT, 'examples/reference-plugin');
const NODE_BASE_IMAGE = 'docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const SOURCE_PATHS = ['package.json', 'README.md', 'src/manifest.json', 'src/server.js', 'src/state.js'] as const;
const MAX_INVENTORY_ENTRIES = 25_000;
const MAX_INVENTORY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_INVENTORY_TOTAL_BYTES = 1024 * 1024 * 1024;
const SAFE_ENVIRONMENT_NAMES = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'PNPM_HOME', 'COREPACK_HOME',
] as const;

interface BundleFile {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
}

interface EsbuildMetafile {
  readonly outputs?: Record<string, {
    readonly imports?: readonly { readonly path: string; readonly external?: boolean }[];
  }>;
}

interface PreparedEvidence {
  readonly schemaVersion: 1;
  readonly pluginSourceSha256: string;
  readonly source: ArtifactSourceIdentity;
  readonly artifactEvidence: ReferencePluginArtifactEvidence;
}

interface BundleInventoryDocument {
  readonly schemaVersion: 2;
  readonly scope: 'bundle directory contents; sibling inventory file excluded';
  readonly bundleDirectory: string;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly symlinkCount: number;
  readonly inventorySha256: string;
  readonly dockerCli:
    | { readonly status: 'empty-placeholder'; readonly path: 'docker.cli.placeholder' }
    | {
      readonly status: 'linux-elf-candidate';
      readonly path: 'docker.cli.placeholder';
      readonly sha256: string;
      readonly size: number;
      readonly mode: number;
      readonly architecture: 'x86_64' | 'aarch64';
    };
  readonly entries: readonly BundleFile[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeEnvironment(): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) safeEnvironment[name] = value;
  }
  for (const name of Object.keys(process.env)) {
    if (!SAFE_ENVIRONMENT_NAMES.includes(name as typeof SAFE_ENVIRONMENT_NAMES[number])) process.env[name] = '';
  }
  Object.assign(process.env, safeEnvironment);
  return safeEnvironment;
}

async function readRegularFile(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), 'expected_regular_source_file');
  assert(metadata.size <= MAX_INVENTORY_FILE_BYTES, 'source_file_exceeds_size_bound');
  return readFile(path);
}

async function sourceFiles(): Promise<{
  readonly files: ReadonlyMap<string, Buffer>;
  readonly sourceSha256: string;
  readonly source: ArtifactSourceIdentity;
}> {
  const gitEnvironment: NodeJS.ProcessEnv = {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const files = new Map<string, Buffer>();
  const hasher = createHash('sha256');
  const revision = execFileSync('git', ['-C', WORKSPACE_ROOT, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment,
  }).trim();
  assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision), 'plugin_source_commit_invalid');
  for (const path of SOURCE_PATHS) {
    const bytes = await readRegularFile(join(REFERENCE_PLUGIN_ROOT, path));
    const committed = execFileSync('git', ['-C', WORKSPACE_ROOT, 'show', `${revision}:examples/reference-plugin/${path}`], {
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_INVENTORY_FILE_BYTES, env: gitEnvironment,
    });
    assert(committed.equals(bytes), 'plugin_source_not_bound_to_git_commit');
    files.set(path, bytes);
    hasher.update(path, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(bytes);
    hasher.update('\0', 'utf8');
  }
  const workspacePackage = JSON.parse(await readFile(join(WORKSPACE_ROOT, 'package.json'), 'utf8')) as {
    readonly repository?: { readonly type?: unknown; readonly url?: unknown };
  };
  const repositoryValue = workspacePackage.repository?.url;
  assert(typeof repositoryValue === 'string' && repositoryValue.startsWith('git+https://'), 'plugin_source_repository_unavailable');
  const source = { repository: repositoryValue.slice('git+'.length), revision };
  assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.revision), 'plugin_source_commit_invalid');
  const parsedRepository = new URL(source.repository);
  assert(parsedRepository.protocol === 'https:' && parsedRepository.href === source.repository
    && !parsedRepository.username && !parsedRepository.password && !parsedRepository.search && !parsedRepository.hash,
  'plugin_source_repository_invalid');
  const sourceSha256 = hasher.digest('hex');
  return { files, sourceSha256, source };
}

async function createSourceLayout(outputRoot: string, files: ReadonlyMap<string, Buffer>): Promise<string> {
  const exampleRoot = join(outputRoot, 'examples/reference-plugin');
  await mkdir(join(exampleRoot, 'src'), { recursive: true, mode: 0o700 });
  for (const [path, bytes] of files) {
    const destination = join(exampleRoot, path);
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  }
  return exampleRoot;
}

async function createPackagingSource(
  outputRoot: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<string> {
  const sourceRoot = join(outputRoot, '.packaging-source');
  await mkdir(join(sourceRoot, 'src'), { recursive: true, mode: 0o700 });
  for (const [path, bytes] of files) {
    await writeFile(join(sourceRoot, path), bytes, { mode: 0o600, flag: 'wx' });
  }
  return sourceRoot;
}

function esbuildApiPath(): string {
  const workspaceRequire = createRequire(import.meta.url);
  const tsxEntry = workspaceRequire.resolve('tsx');
  const tsxRequire = createRequire(tsxEntry);
  return tsxRequire.resolve('esbuild');
}

async function bundleQualifier(outputRoot: string, safeEnvironment: NodeJS.ProcessEnv): Promise<void> {
  const scriptDirectory = join(outputRoot, 'scripts');
  await mkdir(scriptDirectory, { recursive: true, mode: 0o700 });
  const bundlePath = join(scriptDirectory, 'qualify-healthy-plugin-container.mjs');
  const metadataPath = join(outputRoot, '.esbuild-meta.json');
  const banner = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';
  // pnpm may replace esbuild's CLI shim with a native executable. Its public JS
  // API handles both layouts without asking Node to parse a native binary.
  const buildSource = [
    'import { createRequire } from "node:module";',
    'import { writeFileSync } from "node:fs";',
    'const require = createRequire(import.meta.url);',
    `const { buildSync } = require(${JSON.stringify(esbuildApiPath())});`,
    `const result = buildSync(${JSON.stringify({
      entryPoints: [join(WORKSPACE_ROOT, 'scripts/qualify-healthy-plugin-container.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      outfile: bundlePath, metafile: true, banner: { js: banner },
    })});`,
    `writeFileSync(${JSON.stringify(metadataPath)}, JSON.stringify(result.metafile));`,
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', buildSource], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: safeEnvironment,
  });
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as EsbuildMetafile;
  await rm(metadataPath, { force: true });
  const imports = Object.values(metadata.outputs ?? {}).flatMap(output => output.imports ?? []);
  const builtinRuntimeImports = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  assert(imports.every(item => item.external === true && builtinRuntimeImports.has(item.path)),
    'bundle_has_non_builtin_runtime_import');
  execFileSync(process.execPath, ['--check', bundlePath], {
    cwd: outputRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    env: safeEnvironment,
  });
  await chmod(bundlePath, 0o600);
}

function verifyOptInGuard(outputRoot: string, safeEnvironment: NodeJS.ProcessEnv): void {
  const bundlePath = join(outputRoot, 'scripts/qualify-healthy-plugin-container.mjs');
  const expected = '{"qualified":false,"blocker":"explicit_opt_in_required"}\n';
  try {
    execFileSync(process.execPath, [bundlePath], {
      cwd: outputRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...safeEnvironment, PATH: '/nonexistent' },
    });
  } catch (error) {
    const details = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const stderr = typeof details.stderr === 'string' ? details.stderr
      : Buffer.isBuffer(details.stderr) ? details.stderr.toString('utf8') : '';
    const stdout = typeof details.stdout === 'string' ? details.stdout
      : Buffer.isBuffer(details.stdout) ? details.stdout.toString('utf8') : '';
    assert(details.status === 1 && stderr === expected && stdout === '', 'bundle_opt_in_guard_output_mismatch');
    return;
  }
  throw new Error('bundle_opt_in_guard_did_not_reject');
}

function operatorDockerfile(): string {
  return [
    '# Replace docker.cli.placeholder with the reviewed Linux Docker CLI before building this operator image.',
    '# Run only after review, with host networking and /var/run/docker.sock mounted for the trusted operator.',
    `FROM ${NODE_BASE_IMAGE}`,
    'WORKDIR /opt/hasi',
    'COPY --chown=0:0 scripts/qualify-healthy-plugin-container.mjs /opt/hasi/scripts/qualify-healthy-plugin-container.mjs',
    'COPY --chown=0:0 examples/reference-plugin/ /opt/hasi/examples/reference-plugin/',
    'COPY --chown=0:0 prebuilt/ /opt/hasi/prebuilt/',
    'COPY --chown=0:0 docker.cli.placeholder /usr/local/bin/docker',
    'RUN chmod 0555 /usr/local/bin/docker && chmod 0444 /opt/hasi/scripts/qualify-healthy-plugin-container.mjs',
    'ENV DOCKER_HOST=unix:///var/run/docker.sock',
    'ENV HASI_PREBUILT_QUALIFICATION_ARTIFACT=/opt/hasi/prebuilt/artifact',
    'ENTRYPOINT ["node", "/opt/hasi/scripts/qualify-healthy-plugin-container.mjs"]',
    '',
  ].join('\n');
}

async function writeOperatorInputs(outputRoot: string): Promise<void> {
  const dockerfile = operatorDockerfile();
  assert(dockerfile.includes(`FROM ${NODE_BASE_IMAGE}`), 'operator_dockerfile_base_image_mismatch');
  await writeFile(join(outputRoot, 'Dockerfile.operator'), dockerfile, { mode: 0o600, flag: 'wx' });
  await writeFile(join(outputRoot, 'docker.cli.placeholder'), '', { mode: 0o600, flag: 'wx' });
}

async function inventoryBundle(outputRoot: string): Promise<{
  readonly entryCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly symlinkCount: number;
  readonly inventorySha256: string;
  readonly inventory: readonly BundleFile[];
}> {
  const entries: BundleFile[] = [];
  let totalBytes = 0;
  let symlinkCount = 0;
  async function visit(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = relative(outputRoot, join(directory, child.name)).split(sep).join('/');
      const fullPath = join(directory, child.name);
      const metadata = await lstat(fullPath);
      if (metadata.isDirectory()) {
        entries.push({ path, kind: 'directory', mode: metadata.mode & 0o777, size: 0 });
        await visit(fullPath);
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const packageRoot = join(outputRoot, 'prebuilt/artifact');
        const resolvedTarget = resolve(dirname(fullPath), target);
        const fromPackageRoot = relative(packageRoot, resolvedTarget);
        assert(path.startsWith('prebuilt/artifact/') && !isAbsolute(target)
          && fromPackageRoot !== '..' && !fromPackageRoot.startsWith(`..${sep}`) && !isAbsolute(fromPackageRoot),
        'bundle_symlink_escapes_prebuilt_artifact');
        const size = Buffer.byteLength(target, 'utf8');
        totalBytes += size;
        symlinkCount += 1;
        entries.push({ path, kind: 'symlink', mode: metadata.mode & 0o777, size, target, sha256: sha256(target) });
      } else if (metadata.isFile()) {
        assert(metadata.size <= MAX_INVENTORY_FILE_BYTES, 'bundle_file_exceeds_size_bound');
        totalBytes += metadata.size;
        const bytes = await readFile(fullPath);
        entries.push({ path, kind: 'file', mode: metadata.mode & 0o777, size: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error('bundle_contains_special_file');
      }
      assert(entries.length <= MAX_INVENTORY_ENTRIES && totalBytes <= MAX_INVENTORY_TOTAL_BYTES,
        'bundle_inventory_exceeds_size_bound');
    }
  }
  await visit(outputRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const inventorySha256 = sha256(JSON.stringify(entries));
  return {
    entryCount: entries.length,
    fileCount: entries.filter(entry => entry.kind === 'file').length,
    totalBytes,
    symlinkCount,
    inventorySha256,
    inventory: entries,
  };
}

function assertSafeBundleInventory(inventory: Awaited<ReturnType<typeof inventoryBundle>>): void {
  assert(inventory.inventory.every(entry => entry.kind !== 'symlink' || entry.path.startsWith('prebuilt/artifact/')),
    'prepared_bundle_contains_unexpected_symlink');
  assert(inventory.inventory.every(entry => !/(?:^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.pnpmfile\.cjs|fnox|config\.toml)(?:\/|$)/iu.test(entry.path)),
    'prepared_bundle_contains_private_configuration');
}

function inventoryDocument(
  outputRoot: string,
  inventory: Awaited<ReturnType<typeof inventoryBundle>>,
  dockerCli: BundleInventoryDocument['dockerCli'],
): BundleInventoryDocument {
  return {
    schemaVersion: 2,
    scope: 'bundle directory contents; sibling inventory file excluded',
    bundleDirectory: outputRoot,
    entryCount: inventory.entryCount,
    fileCount: inventory.fileCount,
    totalBytes: inventory.totalBytes,
    symlinkCount: inventory.symlinkCount,
    inventorySha256: inventory.inventorySha256,
    dockerCli,
    entries: inventory.inventory,
  };
}

async function writeInventoryFile(
  inventoryPath: string,
  document: BundleInventoryDocument,
  replace: boolean,
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  assert(bytes.byteLength <= MAX_INVENTORY_FILE_BYTES, 'bundle_inventory_file_exceeds_size_bound');
  if (!replace) {
    await writeFile(inventoryPath, bytes, { mode: 0o600, flag: 'wx' });
  } else {
    const temporaryPath = `${inventoryPath}.new-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, inventoryPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  return { bytes, sha256: sha256(bytes) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBundleFileRecord(value: unknown): value is BundleFile {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path.length === 0
    || value.path.length > 4096 || value.path.includes('\0') || value.path.includes('\\')
    || value.path.startsWith('/') || value.path.split('/').some(part => part === '' || part === '.' || part === '..')
    || !['file', 'directory', 'symlink'].includes(String(value.kind))
    || !Number.isSafeInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o777
    || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > MAX_INVENTORY_FILE_BYTES) {
    return false;
  }
  if (value.kind === 'directory') return value.size === 0 && value.sha256 === undefined && value.target === undefined;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) return false;
  if (value.kind === 'file') return value.target === undefined;
  return typeof value.target === 'string' && value.target.length > 0 && !isAbsolute(value.target)
    && Buffer.byteLength(value.target, 'utf8') === value.size
    && sha256(value.target) === value.sha256;
}

async function inspectDockerCliCandidate(bundleDirectory: string): Promise<{
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly architecture: 'x86_64' | 'aarch64';
}> {
  const cliPath = join(bundleDirectory, 'docker.cli.placeholder');
  const metadata = await lstat(cliPath);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 20
    && metadata.size <= MAX_INVENTORY_FILE_BYTES && (metadata.mode & 0o111) !== 0,
  'docker_cli_transfer_file_invalid');
  const bytes = await readFile(cliPath);
  assert(bytes.byteLength === metadata.size && bytes[0] === 0x7f
    && bytes.toString('ascii', 1, 4) === 'ELF' && bytes[4] === 2
    && (bytes[5] === 1 || bytes[5] === 2), 'docker_cli_linux_elf_invalid');
  const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  const architecture = machine === 62 ? 'x86_64' : machine === 183 ? 'aarch64' : undefined;
  assert(architecture !== undefined, 'docker_cli_linux_architecture_unsupported');
  return { sha256: sha256(bytes), size: bytes.byteLength, mode: metadata.mode & 0o777, architecture };
}

async function copyArtifactTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  async function visit(sourceDirectory: string, destinationDirectory: string): Promise<void> {
    for (const child of await readdir(sourceDirectory, { withFileTypes: true })) {
      const source = join(sourceDirectory, child.name);
      const destination = join(destinationDirectory, child.name);
      const metadata = await lstat(source);
      if (metadata.isDirectory()) {
        await mkdir(destination, { mode: 0o700 });
        await visit(source, destination);
        await chmod(destination, metadata.mode & 0o777);
      } else if (metadata.isSymbolicLink()) {
        await symlink(await readlink(source), destination);
        if (process.platform === 'darwin') {
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- Preserve link metadata without changing its target.
          await lchmod(destination, metadata.mode & 0o777);
        }
      } else if (metadata.isFile()) {
        await copyFile(source, destination);
        await chmod(destination, metadata.mode & 0o777);
      } else {
        throw new Error('countertest_artifact_special_file_invalid');
      }
    }
  }
  await visit(sourceRoot, destinationRoot);
}

function expectBundleBlocker(
  bundleScript: string,
  environment: NodeJS.ProcessEnv,
  expectedBlocker: string,
  category: string,
): void {
  try {
    execFileSync(process.execPath, [bundleScript], {
      cwd: dirname(dirname(bundleScript)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: environment,
    });
  } catch (error) {
    const details = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const stderr = typeof details.stderr === 'string' ? details.stderr
      : Buffer.isBuffer(details.stderr) ? details.stderr.toString('utf8') : '';
    const stdout = typeof details.stdout === 'string' ? details.stdout
      : Buffer.isBuffer(details.stdout) ? details.stdout.toString('utf8') : '';
    assert(details.status === 1 && stderr === `{"qualified":false,"blocker":"${expectedBlocker}"}\n`
      && stdout === '', category);
    return;
  }
  throw new Error(`${category}_did_not_fail`);
}

async function verifyPreparedArtifactCounterchecks(
  outputRoot: string,
  safeEnvironment: NodeJS.ProcessEnv,
): Promise<{
  readonly validPrebuilt: 'accepted_before_missing_docker_executable';
  readonly copiedPrebuilt: 'accepted_before_missing_docker_executable';
  readonly mismatchedContext: 'rejected_before_docker_executable_lookup';
  readonly corruptedSource: 'rejected_before_docker_executable_lookup';
  readonly corruptedPayload: 'rejected_before_docker_executable_lookup';
}> {
  const bundleScript = join(outputRoot, 'scripts/qualify-healthy-plugin-container.mjs');
  const preparedArtifact = join(outputRoot, 'prebuilt/artifact');
  const preflightEnvironment = {
    ...safeEnvironment,
    PATH: '/nonexistent',
    HASI_DOCKER_QUALIFY: '1',
    HASI_PREBUILT_QUALIFICATION_ARTIFACT: preparedArtifact,
    DOCKER_HOST: 'unix:///tmp/hasi-qualification-no-daemon.sock',
  };
  expectBundleBlocker(bundleScript, preflightEnvironment, 'approved_node_base_not_local',
    'prebuilt_artifact_positive_countercheck_failed');
  expectBundleBlocker(bundleScript, {
    ...preflightEnvironment,
    DOCKER_CONTEXT: 'hasi-qualification-mismatched-context',
  }, 'docker_context_override_not_supported', 'docker_context_override_countercheck_failed');

  const countertestRoot = await mkdtemp(join(tmpdir(), 'hasi-prebuilt-artifact-countercheck-'));
  try {
    const countertestArtifact = join(countertestRoot, 'artifact');
    await copyArtifactTree(preparedArtifact, countertestArtifact);
    await copyFile(join(outputRoot, 'prebuilt/artifact-evidence.json'), join(countertestRoot, 'artifact-evidence.json'));
    expectBundleBlocker(bundleScript, {
      ...preflightEnvironment,
      HASI_PREBUILT_QUALIFICATION_ARTIFACT: countertestArtifact,
    }, 'approved_node_base_not_local', 'copied_prebuilt_artifact_positive_countercheck_failed');
    const tamperedFile = join(countertestArtifact, 'src/server.js');
    const tamperedMetadata = await lstat(tamperedFile);
    assert(tamperedMetadata.isFile(), 'countertest_server_source_invalid');
    const originalBytes = await readFile(tamperedFile);
    await unlink(tamperedFile);
    await writeFile(tamperedFile, Buffer.concat([originalBytes, Buffer.from('\n')]), { mode: tamperedMetadata.mode & 0o777 });
    await chmod(tamperedFile, tamperedMetadata.mode & 0o777);
    expectBundleBlocker(bundleScript, {
      ...preflightEnvironment,
      HASI_PREBUILT_QUALIFICATION_ARTIFACT: countertestArtifact,
    }, 'prebuilt_artifact_source_binding_invalid', 'prebuilt_source_corruption_countercheck_failed');
    await writeFile(tamperedFile, originalBytes);
    const payloadFile = join(countertestArtifact, 'LICENSE');
    const payloadMetadata = await lstat(payloadFile);
    assert(payloadMetadata.isFile() && !payloadMetadata.isSymbolicLink(), 'countertest_license_payload_invalid');
    const payloadBytes = await readFile(payloadFile);
    await unlink(payloadFile);
    await writeFile(payloadFile, Buffer.concat([payloadBytes, Buffer.from('\n')]), { mode: payloadMetadata.mode & 0o777 });
    expectBundleBlocker(bundleScript, {
      ...preflightEnvironment,
      HASI_PREBUILT_QUALIFICATION_ARTIFACT: countertestArtifact,
    }, 'artifact_payload_entry_mismatch', 'prebuilt_artifact_corruption_countercheck_failed');
  } finally {
    await rm(countertestRoot, { recursive: true, force: true });
  }
  return {
    validPrebuilt: 'accepted_before_missing_docker_executable',
    copiedPrebuilt: 'accepted_before_missing_docker_executable',
    mismatchedContext: 'rejected_before_docker_executable_lookup',
    corruptedSource: 'rejected_before_docker_executable_lookup',
    corruptedPayload: 'rejected_before_docker_executable_lookup',
  };
}

async function refreshTransferInventory(
  bundleArgument: string,
  expectedInventorySha256: string,
  expectedSidecarSha256: string,
): Promise<void> {
  sanitizeEnvironment();
  assert(isAbsolute(bundleArgument) && /^[a-f0-9]{64}$/u.test(expectedInventorySha256)
    && /^[a-f0-9]{64}$/u.test(expectedSidecarSha256),
    'transfer_inventory_arguments_invalid');
  const bundleDirectory = resolve(bundleArgument);
  const bundleMetadata = await lstat(bundleDirectory);
  assert(bundleMetadata.isDirectory() && !bundleMetadata.isSymbolicLink(), 'transfer_bundle_directory_invalid');
  const inventoryPath = `${bundleDirectory}.inventory.json`;
  const inventoryMetadata = await lstat(inventoryPath);
  assert(inventoryMetadata.isFile() && !inventoryMetadata.isSymbolicLink()
    && inventoryMetadata.size <= MAX_INVENTORY_FILE_BYTES, 'original_bundle_inventory_invalid');
  const originalBytes = await readFile(inventoryPath);
  assert(sha256(originalBytes) === expectedSidecarSha256, 'original_bundle_inventory_file_hash_mismatch');
  let parsedOriginal: unknown;
  try { parsedOriginal = JSON.parse(originalBytes.toString('utf8')) as unknown; } catch { throw new Error('original_bundle_inventory_invalid'); }
  assert(isRecord(parsedOriginal) && parsedOriginal.schemaVersion === 2
    && parsedOriginal.scope === 'bundle directory contents; sibling inventory file excluded'
    && parsedOriginal.inventorySha256 === expectedInventorySha256
    && Array.isArray(parsedOriginal.entries)
    && parsedOriginal.entries.every(isBundleFileRecord)
    && sha256(JSON.stringify(parsedOriginal.entries)) === expectedInventorySha256
    && isRecord(parsedOriginal.dockerCli) && parsedOriginal.dockerCli.status === 'empty-placeholder'
    && parsedOriginal.dockerCli.path === 'docker.cli.placeholder', 'original_bundle_inventory_mismatch');
  const originalEntries = parsedOriginal.entries;
  const originalCliEntry = originalEntries.find(entry => entry.path === 'docker.cli.placeholder');
  assert(originalCliEntry?.kind === 'file' && originalCliEntry.size === 0
    && originalCliEntry.sha256 === sha256(Buffer.alloc(0)), 'original_docker_cli_placeholder_mismatch');
  assert(parsedOriginal.entryCount === originalEntries.length
    && parsedOriginal.fileCount === originalEntries.filter(entry => entry.kind === 'file').length
    && parsedOriginal.totalBytes === originalEntries.reduce((sum, entry) => sum + entry.size, 0)
    && parsedOriginal.symlinkCount === originalEntries.filter(entry => entry.kind === 'symlink').length,
  'original_bundle_inventory_counts_mismatch');

  const dockerCli = await inspectDockerCliCandidate(bundleDirectory);
  const inventory = await inventoryBundle(bundleDirectory);
  assertSafeBundleInventory(inventory);
  const refreshedCliEntry = inventory.inventory.find(entry => entry.path === 'docker.cli.placeholder');
  assert(refreshedCliEntry?.kind === 'file' && refreshedCliEntry.sha256 === dockerCli.sha256
    && refreshedCliEntry.size === dockerCli.size && refreshedCliEntry.mode === dockerCli.mode,
  'docker_cli_inventory_entry_mismatch');
  const originalByPath = new Map(originalEntries.map(entry => [entry.path, entry]));
  const refreshedByPath = new Map(inventory.inventory.map(entry => [entry.path, entry]));
  assert(originalByPath.size === refreshedByPath.size, 'transfer_bundle_unexpected_entry_count_change');
  for (const [path, original] of originalByPath) {
    const refreshed = refreshedByPath.get(path);
    assert(refreshed !== undefined, 'transfer_bundle_entry_missing');
    if (path !== 'docker.cli.placeholder') {
      assert(JSON.stringify(refreshed) === JSON.stringify(original), 'transfer_bundle_changed_outside_docker_cli');
    }
  }

  const document = inventoryDocument(bundleDirectory, inventory, {
    status: 'linux-elf-candidate',
    path: 'docker.cli.placeholder',
    ...dockerCli,
  });
  const refreshedSidecar = await writeInventoryFile(inventoryPath, document, true);
  process.stdout.write(`${JSON.stringify({
    bundleDirectory,
    bundleInventory: inventoryPath,
    bundleInventorySha256: refreshedSidecar.sha256,
    initialInventorySha256: expectedInventorySha256,
    transferInventorySha256: inventory.inventorySha256,
    inventoryEntryCount: inventory.entryCount,
    inventoryFileCount: inventory.fileCount,
    inventoryTotalBytes: inventory.totalBytes,
    inventorySymlinkCount: inventory.symlinkCount,
    dockerCli,
    dockerCliValidationLimit: 'ELF header, machine, executable mode, size, and SHA-256 only; binary was not run or identified as Docker CLI',
  }, null, 2)}\n`);
}

async function makeBundle(): Promise<void> {
  assert(process.argv.length === 2, 'usage: pnpm exec tsx scripts/package-healthy-container-qualifier.ts');
  const safeEnvironment = sanitizeEnvironment();
  const outputRoot = await mkdtemp(join(tmpdir(), 'hasi-healthy-plugin-operator-'));
  const inventoryPath = `${outputRoot}.inventory.json`;
  await chmod(outputRoot, 0o700);
  let succeeded = false;
  try {
    const source = await sourceFiles();
    const prebuiltRoot = join(outputRoot, 'prebuilt');
    await mkdir(prebuiltRoot, { mode: 0o700 });
    await createSourceLayout(outputRoot, source.files);
    const packagingSource = await createPackagingSource(outputRoot, source.files);
    const artifactEvidence = await packageReferencePlugin({
      outputDirectory: join(prebuiltRoot, 'artifact'),
      sourceDirectory: packagingSource,
    });
    artifactPluginProvenance(artifactEvidence, source.source);
    await rm(packagingSource, { recursive: true, force: true });
    const evidence: PreparedEvidence = {
      schemaVersion: 1,
      pluginSourceSha256: source.sourceSha256,
      source: { repository: source.source.repository, revision: source.source.revision },
      artifactEvidence,
    };
    await writeFile(join(prebuiltRoot, 'artifact-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await bundleQualifier(outputRoot, safeEnvironment);
    verifyOptInGuard(outputRoot, safeEnvironment);
    await writeOperatorInputs(outputRoot);
    const counterchecks = await verifyPreparedArtifactCounterchecks(outputRoot, safeEnvironment);
    const inventory = await inventoryBundle(outputRoot);
    assertSafeBundleInventory(inventory);
    const dockerPlaceholder = inventory.inventory.find(entry => entry.path === 'docker.cli.placeholder');
    assert(dockerPlaceholder?.kind === 'file' && dockerPlaceholder.size === 0, 'docker_cli_placeholder_invalid');
    const dockerCli = { status: 'empty-placeholder', path: 'docker.cli.placeholder' } as const;
    const inventoryFile = await writeInventoryFile(inventoryPath, inventoryDocument(outputRoot, inventory, dockerCli), false);
    const output = {
      bundleDirectory: outputRoot,
      bundleDirectoryMode: '0700',
      bundleInventory: inventoryPath,
      bundleInventorySha256: inventoryFile.sha256,
      operatorDockerfile: join(outputRoot, 'Dockerfile.operator'),
      operatorDockerfileSha256: sha256(await readFile(join(outputRoot, 'Dockerfile.operator'))),
      bundledScript: join(outputRoot, 'scripts/qualify-healthy-plugin-container.mjs'),
      bundledScriptSha256: sha256(await readFile(join(outputRoot, 'scripts/qualify-healthy-plugin-container.mjs'))),
      pluginSourceSha256: source.sourceSha256,
      artifactSha256: artifactEvidence.artifactSha256,
      artifactManifestSha256: artifactEvidence.artifactManifestSha256,
      manifestDigest: artifactEvidence.manifestDigest,
      payloadFileCount: artifactEvidence.payloadFileCount,
      runtimePackageCount: artifactEvidence.runtimePackageCount,
      inventoryEntryCount: inventory.entryCount,
      inventoryFileCount: inventory.fileCount,
      inventoryTotalBytes: inventory.totalBytes,
      inventorySymlinkCount: inventory.symlinkCount,
      inventorySha256: inventory.inventorySha256,
      refreshInventoryUsage: 'pnpm exec tsx scripts/package-healthy-container-qualifier.ts --refresh-inventory <absolute-bundle-directory> <initial-inventory-sha256> <initial-inventory-file-sha256>',
      optInGuard: 'explicit_opt_in_required',
      counterchecks,
      dockerCli,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    succeeded = true;
  } finally {
    if (!succeeded) {
      await rm(outputRoot, { recursive: true, force: true });
      await rm(inventoryPath, { force: true });
    }
  }
}

try {
  if (process.argv.length === 2) {
    await makeBundle();
  } else if (process.argv.length === 6 && process.argv[2] === '--refresh-inventory') {
    await refreshTransferInventory(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '');
  } else {
    throw new Error('usage: pnpm exec tsx scripts/package-healthy-container-qualifier.ts [--refresh-inventory <absolute-bundle-directory> <initial-inventory-sha256> <initial-inventory-file-sha256>]');
  }
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 400) : 'unknown_error';
  process.stderr.write(`Healthy plugin operator bundle preparation failed: ${message}\n`);
  process.exitCode = 1;
}
