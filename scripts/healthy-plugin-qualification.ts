import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInvocationToken, digest, manifestSchema, type ActorContext, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { PLUGIN_IMAGE_PROVENANCE_LABEL, pluginImageProvenanceLabel, type PluginReleaseProvenance } from '@hasi/plugin-sdk/releases';
import type { ReferencePluginArtifactEvidence } from './package-reference-plugin.js';
import { artifactPluginProvenance, type ArtifactSourceIdentity } from './plugin-release-provenance.js';
import {
  buildPluginContainerLaunchPolicy,
  DeploymentDriverError,
  pluginReleaseSigningBytes,
  PluginArtifactError,
  verifyPluginRelease,
  type PluginContainerLaunchPolicy,
  type PluginReleaseEnvelope,
  type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import {
  createDockerPluginDriver,
  DockerPluginDriverError,
  type DockerPluginDriverOptions,
} from '../apps/api/src/docker-plugin-driver.js';
import { DOCKER_PLUGIN_MANAGED_VALUE, dockerPluginContainerName, PLUGIN_RELAY_IMAGE, PLUGIN_RELAY_RESOURCES } from '../apps/api/src/docker-plugin-relay.js';
import { PLUGIN_RELAY_PROGRAM } from '../apps/api/src/plugin-relay-program.js';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_PLUGIN_ROOT = join(WORKSPACE_ROOT, 'examples/reference-plugin');
const NODE_BASE_IMAGE = 'docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const IMAGE_REPOSITORY = 'localhost/hasi-reference-qualification';
const OWNER_LABEL = 'com.hasi.qualification.owner';
const SECRET_TOKEN_NAME = 'SERVICE_TOKEN';
const SECRET_PUBLIC_KEY_NAME = 'PUBLIC_KEY';
const SECRET_TOKEN_REF = 'local-qualification-service-token';
const SECRET_PUBLIC_KEY_REF = 'local-qualification-public-key';
const CPU_MILLICORES = 500;
const MEMORY_BYTES = 256 * 1024 * 1024;
const PID_LIMIT = 64;
const PLUGIN_LABEL = 'Synthetic healthy plugin qualification';
const ACCOUNT_CLAIM = 'qualification-account';
const MAX_ARTIFACT_PAYLOAD_ENTRIES = 25_000;
const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 1024 * 1024 * 1024;

const SAFE_CHILD_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
  'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'PNPM_HOME',
] as const;

let dockerEndpoint: string | undefined;

class QualificationFailure extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'QualificationFailure';
  }
}

interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestDigest: string;
  readonly artifactSha256: string;
  readonly manifestFileSha256: string;
  readonly payloadEntryCount: number;
  readonly artifactDigestDefinition: string;
  readonly payloadFiles: readonly ArtifactPayloadEntry[];
}

interface ArtifactPayloadEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
}

interface PreparedArtifact {
  readonly directory: string;
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly manifest: ArtifactManifest;
  readonly source: ArtifactSourceIdentity;
}

interface NativeMcpResult {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function fail(category: string): never {
  throw new QualificationFailure(category);
}

function assert(condition: unknown, category: string): asserts condition {
  if (!condition) fail(category);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_CHILD_ENV) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  if (dockerEndpoint !== undefined) result.DOCKER_HOST = dockerEndpoint;
  return result;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function packageReferencePluginWithAllowlistedEnvironment(outputDirectory: string, sourceDirectory?: string): ReferencePluginArtifactEvidence {
  const packageModuleUrl = pathToFileURL(join(WORKSPACE_ROOT, 'scripts/package-reference-plugin.ts')).href;
  const source = [
    `const { packageReferencePlugin } = await import(${JSON.stringify(packageModuleUrl)});`,
    `const evidence = await packageReferencePlugin(${JSON.stringify({ outputDirectory, ...(sourceDirectory ? { sourceDirectory } : {}) })});`,
    'process.stdout.write(JSON.stringify(evidence));',
  ].join('\n');
  let output: string;
  try {
    output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnvironment(),
    }).trim();
  } catch {
    fail('reference_plugin_offline_packaging_failed');
  }
  let evidence: unknown;
  try { evidence = JSON.parse(output) as unknown; } catch { fail('reference_plugin_artifact_evidence_invalid'); }
  assert(typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence), 'reference_plugin_artifact_evidence_invalid');
  return evidence as ReferencePluginArtifactEvidence;
}

function requireOptIn(): void {
  if (process.env.HASI_DOCKER_QUALIFY !== '1') fail('explicit_opt_in_required');
  if (process.env.VERCEL || process.env.HASI_DEMO_MODE === '1') fail('local_operator_mode_required');
}

function runDocker(args: readonly string[], category: string, timeoutMs = 10_000): string {
  if (dockerEndpoint === undefined) fail('docker_endpoint_not_resolved');
  try {
    return execFileSync('docker', ['--host', dockerEndpoint, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: childEnvironment(),
    }).trim();
  } catch {
    fail(category);
  }
}

function dockerSocketPath(): string {
  if (process.env.DOCKER_CONTEXT !== undefined) fail('docker_context_override_not_supported');
  let host = process.env.DOCKER_HOST;
  if (!host) {
    try {
      host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: childEnvironment(),
      }).trim();
    } catch {
      fail('docker_context_inspection_failed');
    }
  }
  if (!host.startsWith('unix:///')) fail('local_unix_docker_required');
  if (host.length > 4096 || /[\s#?\\]/u.test(host) || containsControlCharacter(host)) {
    fail('docker_socket_path_invalid');
  }
  let socketPath: string;
  try { socketPath = decodeURIComponent(host.slice('unix://'.length)); } catch { fail('docker_socket_path_invalid'); }
  if (!isAbsolute(socketPath) || socketPath.includes('\0')) fail('docker_socket_path_invalid');
  dockerEndpoint = host;
  return socketPath;
}

function assertLocalNodeImage(): void {
  const output = runDocker([
    'image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}', NODE_BASE_IMAGE,
  ], 'approved_node_base_not_local');
  const [imageId, os, architecture, repoDigestJson] = output.split('|');
  assert(/^sha256:[a-f0-9]{64}$/u.test(imageId ?? ''), 'approved_node_base_identity_invalid');
  assert(os === 'linux' && ['amd64', 'arm64'].includes(architecture ?? ''), 'approved_node_base_platform_invalid');
  let repoDigests: unknown;
  try { repoDigests = JSON.parse(repoDigestJson ?? '') as unknown; } catch { fail('approved_node_base_metadata_invalid'); }
  const digest = NODE_BASE_IMAGE.slice(NODE_BASE_IMAGE.lastIndexOf('@') + 1);
  assert(Array.isArray(repoDigests) && repoDigests.filter(value => typeof value === 'string' && value.endsWith(`@${digest}`)).length === 1,
    'approved_node_base_digest_not_unique');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function pluginSourceSha256(sourceDirectory = REFERENCE_PLUGIN_ROOT): Promise<string> {
  const sourcePaths = ['package.json', 'README.md', 'src/manifest.json', 'src/server.js', 'src/state.js'] as const;
  const hash = createHash('sha256');
  for (const path of sourcePaths) {
    hash.update(path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(await readFile(join(sourceDirectory, path)));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function workspacePluginSourceIdentity(): Promise<ArtifactSourceIdentity> {
  const packageMetadata = JSON.parse(await readFile(join(WORKSPACE_ROOT, 'package.json'), 'utf8')) as {
    readonly repository?: { readonly type?: unknown; readonly url?: unknown };
  };
  const repositoryValue = packageMetadata.repository?.url;
  assert(typeof repositoryValue === 'string' && repositoryValue.startsWith('git+https://'),
    'prebuilt_artifact_source_binding_invalid');
  const repository = repositoryValue.slice('git+'.length);
  const gitEnvironment = {
    ...childEnvironment(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const revision = execFileSync('git', ['-C', WORKSPACE_ROOT, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment,
  }).trim();
  assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision), 'prebuilt_artifact_source_binding_invalid');
  const parsedRepository = new URL(repository);
  assert(parsedRepository.protocol === 'https:' && parsedRepository.href === repository
    && !parsedRepository.username && !parsedRepository.password && !parsedRepository.search && !parsedRepository.hash,
  'prebuilt_artifact_source_binding_invalid');
  for (const path of ['package.json', 'README.md', 'src/manifest.json', 'src/server.js', 'src/state.js']) {
    const working = await readFile(join(REFERENCE_PLUGIN_ROOT, path));
    const committed = execFileSync('git', ['-C', WORKSPACE_ROOT, 'show', `${revision}:examples/reference-plugin/${path}`], {
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_ARTIFACT_FILE_BYTES, env: gitEnvironment,
    });
    assert(working.equals(committed), 'prebuilt_artifact_source_binding_invalid');
  }
  return { repository, revision };
}

function assertArtifactBinding(
  identity: Pick<UnsignedPluginRelease, 'pluginId' | 'version' | 'manifestDigest'>,
  artifact: ArtifactManifest,
): void {
  if (identity.pluginId !== artifact.pluginId
    || identity.version !== artifact.pluginVersion
    || identity.manifestDigest !== artifact.manifestDigest) {
    throw new PluginArtifactError('Release does not identify the packaged reference plugin.');
  }
}

function expectPluginArtifactDenial(operation: () => unknown, category: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof PluginArtifactError) return;
    fail(category);
  }
  fail(category);
}

function createSignedRelease(unsigned: UnsignedPluginRelease, privateKey: KeyObject): PluginReleaseEnvelope {
  return {
    ...unsigned,
    signature: sign(null, pluginReleaseSigningBytes(unsigned), privateKey).toString('base64url'),
  };
}

function createAndVerifySyntheticRelease(input: {
  readonly artifact: ArtifactManifest;
  readonly image: string;
  readonly provenance: PluginReleaseProvenance;
}) {
  const keyPair = generateKeyPairSync('ed25519');
  const unsigned: UnsignedPluginRelease = {
    schemaVersion: 2,
    pluginId: input.artifact.pluginId,
    version: input.artifact.pluginVersion,
    manifestDigest: input.artifact.manifestDigest,
    provenance: input.provenance,
    image: input.image,
    publisherId: 'local-qualifier',
    configSchemaVersion: 1,
    stateMigration: 'none',
  };
  assertArtifactBinding(unsigned, input.artifact);
  const envelope = createSignedRelease(unsigned, keyPair.privateKey);
  const approval: PublisherApproval = {
    publisherId: unsigned.publisherId,
    publicKey: keyPair.publicKey,
    sourceRegistryPrefix: IMAGE_REPOSITORY,
    allowedPluginIds: [input.artifact.pluginId],
  };
  const resolvePublisher = (publisherId: string) => publisherId === approval.publisherId ? approval : undefined;
  const release = verifyPluginRelease(envelope, resolvePublisher);

  const changedCommit = `${input.provenance.source.commit.startsWith('0') ? '1' : '0'}${input.provenance.source.commit.slice(1)}`;
  const signedSourceIdentityCounterprobe = verifyPluginRelease(createSignedRelease({
    ...unsigned,
    provenance: {
      ...input.provenance,
      source: { ...input.provenance.source, commit: changedCommit },
    },
  }, keyPair.privateKey), resolvePublisher);

  const differentSignatureBytes = Buffer.from(envelope.signature, 'base64url');
  assert(differentSignatureBytes.byteLength === 64, 'synthetic_release_signature_fixture_invalid');
  differentSignatureBytes[0] = (differentSignatureBytes[0] ?? 0) ^ 1;
  const differentSignature = differentSignatureBytes.toString('base64url');
  expectPluginArtifactDenial(
    () => verifyPluginRelease({ ...envelope, signature: differentSignature }, resolvePublisher),
    'invalid_signature_counterprobe_failed',
  );
  const unapprovedRelease = createSignedRelease({ ...unsigned, pluginId: 'hasi.unapproved' }, keyPair.privateKey);
  expectPluginArtifactDenial(
    () => verifyPluginRelease(unapprovedRelease, resolvePublisher),
    'unapproved_release_counterprobe_failed',
  );
  const wrongManifestDigest = unsigned.manifestDigest.startsWith('0')
    ? `1${unsigned.manifestDigest.slice(1)}` : `0${unsigned.manifestDigest.slice(1)}`;
  expectPluginArtifactDenial(
    () => { assertArtifactBinding({ ...unsigned, manifestDigest: wrongManifestDigest }, input.artifact); },
    'manifest_identity_counterprobe_failed',
  );
  expectPluginArtifactDenial(
    () => { assertArtifactBinding({ ...unsigned, version: '1.0.1' }, input.artifact); },
    'plugin_version_counterprobe_failed',
  );

  return { release, signedSourceIdentityCounterprobe };
}

async function ephemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('loopback_port_allocation_failed');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => { if (error) reject(error); else resolveClose(); });
  });
  return port;
}

function launchPolicy(release: ReturnType<typeof verifyPluginRelease>, networkName: string, hostPort: number): PluginContainerLaunchPolicy {
  return buildPluginContainerLaunchPolicy(release, {
    network: { mode: 'internal', name: networkName },
    hostPort,
    containerPort: 3000,
    cpuMillicores: CPU_MILLICORES,
    memoryBytes: MEMORY_BYTES,
    pidsLimit: PID_LIMIT,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 1_000,
  });
}

async function expectDriverDenial(
  operation: () => Promise<unknown>,
  category: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DeploymentDriverError && error.outcome === 'failed') return;
    fail(category);
  }
  fail(category);
}

function networkDetails(name: string): { readonly name: string; readonly internal: boolean; readonly labels: Record<string, string> } {
  const output = runDocker([
    'network', 'inspect', '--format', '{{.Name}}|{{.Internal}}|{{json .Labels}}', name,
  ], 'qualification_network_inspection_failed');
  const [actualName, internal, labelsJson] = output.split('|');
  let labels: unknown;
  try { labels = JSON.parse(labelsJson ?? '') as unknown; } catch { fail('qualification_network_metadata_invalid'); }
  assert(typeof labels === 'object' && labels !== null && !Array.isArray(labels), 'qualification_network_metadata_invalid');
  return { name: actualName ?? '', internal: internal === 'true', labels: labels as Record<string, string> };
}

function createQualificationNetwork(name: string, ownerId: string, internal: boolean): void {
  runDocker([
    'network', 'create', ...(internal ? ['--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'] : []),
    '--label', `hasi.managed-by=${DOCKER_PLUGIN_MANAGED_VALUE}`, '--label', `hasi.owner=${ownerId}`,
    '--label', `${OWNER_LABEL}=${ownerId}`, name,
  ], 'qualification_network_creation_failed');
  const details = networkDetails(name);
  assert(details.name === name && details.internal === internal && details.labels[OWNER_LABEL] === ownerId,
    'qualification_network_identity_mismatch');
}

function parseDockerLabels(value: string | undefined): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value ?? '') as unknown; } catch { fail('docker_container_metadata_invalid'); }
  assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), 'docker_container_metadata_invalid');
  return parsed as Record<string, string>;
}

function assertControlContainerPolicy(containerId: string, networkName: string, ownerId: string): void {
  const format = '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.Privileged}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{json .Config.Labels}}';
  const fields = runDocker(['container', 'inspect', '--format', format, containerId], 'control_container_inspection_failed').split('|');
  assert(fields.length === 13, 'control_container_metadata_invalid');
  assert(fields[0] === '65532:65532' && fields[1] === 'true', 'control_container_identity_or_rootfs_policy_failed');
  assert(fields[2] === '["ALL"]' && (fields[3] === '[]' || fields[3] === 'null'), 'control_container_capability_policy_failed');
  const securityOptions = JSON.parse(fields[4] ?? 'null') as unknown;
  assert(Array.isArray(securityOptions) && securityOptions.includes('no-new-privileges:true'), 'control_container_privilege_policy_failed');
  assert(fields[5] === 'false' && fields[6] === '500000000', 'control_container_cpu_or_privilege_policy_failed');
  assert(fields[7] === String(MEMORY_BYTES) && fields[8] === String(MEMORY_BYTES) && fields[9] === String(PID_LIMIT),
    'control_container_resource_policy_failed');
  assert(fields[10] === networkName, 'control_container_network_policy_failed');
  assert(fields[11] === 'null' || fields[11] === '{}', 'control_container_port_policy_failed');
  assert(parseDockerLabels(fields[12])[OWNER_LABEL] === ownerId, 'control_container_owner_missing');
}

function createControlContainer(input: {
  readonly image: string;
  readonly networkName: string;
  readonly ownerId: string;
  readonly name: string;
  readonly probeSource: string;
}): string {
  const id = runDocker([
    'container', 'create', '--pull=never', '--name', input.name,
    '--label', `${OWNER_LABEL}=${input.ownerId}`,
    '--network', input.networkName,
    '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--cpus', String(CPU_MILLICORES / 1_000), '--memory', String(MEMORY_BYTES), '--memory-swap', String(MEMORY_BYTES),
    '--pids-limit', String(PID_LIMIT), '--entrypoint', 'node', input.image, '-e', input.probeSource,
  ], 'control_container_creation_failed');
  assert(/^[a-f0-9]{12,64}$/u.test(id), 'control_container_identity_invalid');
  const details = runDocker([
    'container', 'inspect', '--format', `{{.Name}}|{{json .Config.Labels}}`, id,
  ], 'control_container_inspection_failed').split('|');
  assert(details[0] === `/${input.name}` && parseDockerLabels(details[1])[OWNER_LABEL] === input.ownerId,
    'control_container_owner_mismatch');
  assertControlContainerPolicy(id, input.networkName, input.ownerId);
  return id;
}

const HEALTH_PROBE_SOURCE = [
  "const https = require('node:https');",
  'let done = false;',
  'let responseStatus = null;',
  'let responseComplete = false;',
  'const finish = () => { if (done) return; done = true; clearTimeout(deadline); process.stdout.write(JSON.stringify({ status: responseStatus, complete: responseComplete }) + "\\n"); };',
  'const deadline = setTimeout(() => { request.destroy(); finish(); }, 4500);',
  "const request = https.get({ hostname: 'hasi.metaneutrons.cc', path: '/api/health', method: 'GET', headers: { accept: 'application/json' }, maxHeaderSize: 8192 }, response => {",
  '  responseStatus = response.statusCode ?? null;',
  '  let bodyBytes = 0;',
  '  response.on("data", chunk => { bodyBytes += chunk.length; if (bodyBytes > 16384) request.destroy(); });',
  '  response.on("end", () => { responseComplete = bodyBytes <= 16384; finish(); });',
  '  response.on("error", () => finish());',
  '});',
  'request.on("error", () => finish());',
].join('\n');

function parseProbeResult(output: string, category: string): { readonly status: number | null; readonly complete: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch { fail(category); }
  assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), category);
  const result = parsed as Record<string, unknown>;
  assert((result.status === null || (typeof result.status === 'number' && Number.isInteger(result.status)))
    && typeof result.complete === 'boolean', category);
  return { status: result.status, complete: result.complete };
}

function pluginLauncherDockerfile(): string {
  const launcher = [
    "if (!process.env.HASI_SECRET_SERVICE_TOKEN || !process.env.HASI_SECRET_PUBLIC_KEY) throw new Error('Assigned fixture slots are required');",
    "process.env.HASI_REFERENCE_PLUGIN_TEST_MODE = '1';",
    'process.env.HASI_REFERENCE_PLUGIN_TOKEN = process.env.HASI_SECRET_SERVICE_TOKEN;',
    'process.env.HASI_REFERENCE_PLUGIN_PUBLIC_KEY = process.env.HASI_SECRET_PUBLIC_KEY;',
    "process.env.HASI_REFERENCE_PLUGIN_HOST = '0.0.0.0';",
    "process.env.HASI_REFERENCE_PLUGIN_PORT = '3000';",
    "await import('./src/server.js');",
  ].join(' ');
  return [
    `FROM ${NODE_BASE_IMAGE}`,
    'WORKDIR /opt/hasi/reference-plugin',
    'COPY --chown=0:0 . /opt/hasi/reference-plugin/',
    'RUN chown -R 0:0 /opt/hasi/reference-plugin \\\n&& find /opt/hasi/reference-plugin -type d -exec chmod 0555 {} + \\\n&& find /opt/hasi/reference-plugin -type f -exec chmod 0444 {} +',
    `ENTRYPOINT ["node", "--input-type=module", "-e", ${JSON.stringify(launcher)}]`,
    '',
  ].join('\n');
}

async function readArtifactManifest(
  artifactDirectory: string,
  evidence: ReferencePluginArtifactEvidence,
): Promise<ArtifactManifest> {
  let artifactBytes: Buffer;
  try {
    const metadata = await lstat(join(artifactDirectory, 'artifact-manifest.json'));
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= MAX_ARTIFACT_FILE_BYTES,
      'artifact_manifest_file_invalid');
    artifactBytes = await readFile(join(artifactDirectory, 'artifact-manifest.json'));
  } catch {
    fail('artifact_manifest_read_failed');
  }
  let parsedArtifact: unknown;
  try { parsedArtifact = JSON.parse(artifactBytes.toString('utf8')) as unknown; } catch { fail('artifact_manifest_read_failed'); }
  assert(isRecord(parsedArtifact) && parsedArtifact.schemaVersion === 1
    && parsedArtifact.pluginId === evidence.pluginId
    && parsedArtifact.pluginVersion === evidence.pluginVersion
    && parsedArtifact.manifestDigest === evidence.manifestDigest
    && parsedArtifact.artifactSha256 === evidence.artifactSha256
    && parsedArtifact.manifestFileSha256 === evidence.manifestFileSha256
    && parsedArtifact.artifactDigestDefinition === 'SHA-256 over sorted payload file records; artifact-manifest.json is excluded.'
    && Number.isSafeInteger(parsedArtifact.payloadEntryCount)
    && Array.isArray(parsedArtifact.payloadFiles)
    && parsedArtifact.payloadFiles.length <= MAX_ARTIFACT_PAYLOAD_ENTRIES
    && parsedArtifact.payloadEntryCount === parsedArtifact.payloadFiles.length,
  'artifact_manifest_invalid');
  const payloadFiles = parsedArtifact.payloadFiles.map(parseArtifactPayloadEntry);
  assert(new Set(payloadFiles.map(entry => entry.path)).size === payloadFiles.length, 'artifact_manifest_duplicate_payload_path');
  const artifact = parsedArtifact as unknown as ArtifactManifest;
  assert(sha256(artifactBytes) === evidence.artifactManifestSha256,
    'artifact_manifest_hash_mismatch');
  const fileCount = payloadFiles.filter(entry => entry.kind !== 'directory').length;
  assert(fileCount === evidence.payloadFileCount, 'artifact_evidence_payload_count_mismatch');
  const actualPayloadFiles = await collectArtifactPayloadFiles(artifactDirectory);
  assert(actualPayloadFiles.length === payloadFiles.length, 'artifact_payload_tree_mismatch');
  const actualByPath = new Map(actualPayloadFiles.map(entry => [entry.path, entry]));
  const actualInManifestOrder: ArtifactPayloadEntry[] = [];
  for (const expected of payloadFiles) {
    const actual = actualByPath.get(expected.path);
    if (actual?.kind !== expected.kind) fail('artifact_payload_entry_mismatch');
    assert(actual.mode === expected.mode && actual.size === expected.size
      && actual.sha256 === expected.sha256 && actual.target === expected.target, 'artifact_payload_entry_mismatch');
    actualInManifestOrder.push(actual);
  }
  const actualDigest = artifactPayloadDigest(actualInManifestOrder);
  assert(actualDigest === artifact.artifactSha256 && actualDigest === evidence.artifactSha256,
    'artifact_payload_digest_mismatch');
  const manifestPath = join(artifactDirectory, 'src', 'manifest.json');
  const manifestMetadata = await lstat(manifestPath);
  assert(manifestMetadata.isFile() && !manifestMetadata.isSymbolicLink()
    && manifestMetadata.size <= MAX_ARTIFACT_FILE_BYTES, 'packaged_manifest_file_invalid');
  const manifestBytes = await readFile(manifestPath);
  assert(sha256(manifestBytes) === evidence.manifestFileSha256, 'packaged_manifest_hash_mismatch');
  return { ...artifact, payloadFiles };
}

function parseArtifactPayloadEntry(value: unknown): ArtifactPayloadEntry {
  assert(isRecord(value) && typeof value.path === 'string' && isSafeArtifactPath(value.path)
    && ['file', 'directory', 'symlink'].includes(String(value.kind))
    && Number.isSafeInteger(value.mode) && Number(value.mode) >= 0 && Number(value.mode) <= 0o777
    && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= MAX_ARTIFACT_FILE_BYTES,
  'artifact_manifest_payload_entry_invalid');
  const kind = value.kind as ArtifactPayloadEntry['kind'];
  if (kind === 'file') {
    assert(isSha256(value.sha256) && value.target === undefined, 'artifact_manifest_payload_entry_invalid');
  } else if (kind === 'directory') {
    assert(value.size === 0 && value.sha256 === undefined && value.target === undefined,
      'artifact_manifest_payload_entry_invalid');
  } else {
    assert(typeof value.target === 'string' && value.target.length > 0 && value.target.length <= 4096
      && !value.target.includes('\0') && !isAbsolute(value.target)
      && value.sha256 === undefined && Buffer.byteLength(value.target, 'utf8') === value.size,
    'artifact_manifest_payload_entry_invalid');
  }
  return value as unknown as ArtifactPayloadEntry;
}

function isSafeArtifactPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes('\0') && !path.includes('\\')
    && !path.startsWith('/') && path !== 'artifact-manifest.json'
    && path.split('/').every(component => component.length > 0 && component !== '.' && component !== '..');
}

function artifactPayloadDigest(entries: readonly ArtifactPayloadEntry[]): string {
  const hasher = createHash('sha256');
  for (const entry of entries) {
    hasher.update(entry.path, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(entry.kind, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(String(entry.mode), 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(String(entry.size), 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(entry.sha256 ?? '', 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(entry.target ?? '', 'utf8');
    hasher.update('\0', 'utf8');
  }
  return hasher.digest('hex');
}

async function collectArtifactPayloadFiles(artifactDirectory: string): Promise<ArtifactPayloadEntry[]> {
  const root = resolve(artifactDirectory);
  const rootMetadata = await lstat(root);
  assert(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), 'artifact_root_directory_invalid');
  const entries: ArtifactPayloadEntry[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, child.name);
      const path = relative(root, fullPath).split(sep).join('/');
      if (path === 'artifact-manifest.json') continue;
      assert(isSafeArtifactPath(path), 'artifact_payload_path_invalid');
      const metadata = await lstat(fullPath);
      let entry: ArtifactPayloadEntry;
      if (metadata.isDirectory()) {
        entry = { path, kind: 'directory', mode: metadata.mode & 0o777, size: 0 };
        await visit(fullPath);
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolvedTarget = resolve(dirname(fullPath), target);
        const fromRoot = relative(root, resolvedTarget);
        assert(!isAbsolute(target) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
          'artifact_symlink_escapes_root');
        try { await lstat(resolvedTarget); } catch { fail('artifact_symlink_target_missing'); }
        entry = {
          path,
          kind: 'symlink',
          mode: metadata.mode & 0o777,
          size: Buffer.byteLength(target, 'utf8'),
          target,
        };
        totalBytes += entry.size;
      } else if (metadata.isFile()) {
        assert(metadata.size <= MAX_ARTIFACT_FILE_BYTES, 'artifact_file_exceeds_size_bound');
        const bytes = await readFile(fullPath);
        entry = {
          path,
          kind: 'file',
          mode: metadata.mode & 0o777,
          size: bytes.byteLength,
          sha256: sha256(bytes),
        };
        totalBytes += entry.size;
      } else {
        fail('artifact_payload_special_file_invalid');
      }
      entries.push(entry);
      assert(entries.length <= MAX_ARTIFACT_PAYLOAD_ENTRIES && totalBytes <= MAX_ARTIFACT_TOTAL_BYTES,
        'artifact_payload_exceeds_size_bound');
    }
  }
  await visit(root);
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function parsePreparedArtifactEvidence(value: unknown, sourceSha256: string): {
  readonly evidence: ReferencePluginArtifactEvidence;
  readonly source: ArtifactSourceIdentity;
} {
  assert(isRecord(value) && value.schemaVersion === 1 && value.pluginSourceSha256 === sourceSha256
    && isRecord(value.source) && Object.keys(value).sort().join(',') === 'artifactEvidence,pluginSourceSha256,schemaVersion,source'
    && Object.keys(value.source).sort().join(',') === 'repository,revision'
    && typeof value.source.repository === 'string' && typeof value.source.revision === 'string',
    'prebuilt_artifact_source_binding_invalid');
  const source = { repository: value.source.repository, revision: value.source.revision };
  const rawEvidence = value.artifactEvidence;
  assert(isRecord(rawEvidence)
    && rawEvidence.pluginId === 'hasi.reference'
    && typeof rawEvidence.pluginVersion === 'string' && /^\d+\.\d+\.\d+$/u.test(rawEvidence.pluginVersion)
    && isSha256(rawEvidence.manifestDigest)
    && isSha256(rawEvidence.manifestFileSha256)
    && isSha256(rawEvidence.artifactSha256)
    && isSha256(rawEvidence.artifactManifestSha256)
    && Number.isSafeInteger(rawEvidence.payloadFileCount) && Number(rawEvidence.payloadFileCount) > 0
    && Number(rawEvidence.payloadFileCount) <= 100_000
    && Number.isSafeInteger(rawEvidence.runtimePackageCount) && Number(rawEvidence.runtimePackageCount) > 0
    && Number(rawEvidence.runtimePackageCount) <= 10_000
    && Array.isArray(rawEvidence.licenseInventory) && rawEvidence.licenseInventory.length <= 10_000,
  'prebuilt_artifact_evidence_invalid');
  for (const license of rawEvidence.licenseInventory) {
    assert(isRecord(license)
      && typeof license.name === 'string' && license.name.length > 0 && license.name.length <= 512
      && typeof license.version === 'string' && license.version.length > 0 && license.version.length <= 128
      && typeof license.license === 'string' && license.license.length > 0 && license.license.length <= 512,
    'prebuilt_artifact_evidence_invalid');
  }
  const evidence = rawEvidence as unknown as ReferencePluginArtifactEvidence;
  try { artifactPluginProvenance(evidence, source); } catch { fail('prebuilt_artifact_source_binding_invalid'); }
  return { evidence, source };
}

async function loadPreparedArtifact(path: string, sourceSha256: string): Promise<PreparedArtifact> {
  assert(isAbsolute(path), 'prebuilt_artifact_path_must_be_absolute');
  const directory = resolve(path);
  let artifactMetadata: Stats;
  let evidenceMetadata: Stats;
  try {
    artifactMetadata = await lstat(directory);
    evidenceMetadata = await lstat(join(dirname(directory), 'artifact-evidence.json'));
  } catch {
    fail('prebuilt_artifact_or_evidence_missing');
  }
  assert(artifactMetadata.isDirectory() && !artifactMetadata.isSymbolicLink(), 'prebuilt_artifact_directory_invalid');
  assert(evidenceMetadata.isFile() && !evidenceMetadata.isSymbolicLink() && evidenceMetadata.size <= 64 * 1024,
    'prebuilt_artifact_evidence_file_invalid');
  let parsedEvidence: unknown;
  try {
    parsedEvidence = JSON.parse(await readFile(join(dirname(directory), 'artifact-evidence.json'), 'utf8')) as unknown;
  } catch {
    fail('prebuilt_artifact_evidence_invalid');
  }
  const { evidence, source } = parsePreparedArtifactEvidence(parsedEvidence, sourceSha256);
  assert(await pluginSourceSha256(directory) === sourceSha256, 'prebuilt_artifact_source_binding_invalid');
  const manifest = await readArtifactManifest(directory, evidence);
  return { directory, evidence, manifest, source };
}

function dockerImageIdentity(tag: string, ownerId: string, expectedProvenanceLabel: string): { readonly id: string; readonly repoDigest: string } {
  const output = runDocker(['image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}|{{index .Config.Labels "' + OWNER_LABEL + '"}}|{{index .Config.Labels "' + PLUGIN_IMAGE_PROVENANCE_LABEL + '"}}', tag],
    'built_image_inspection_failed');
  const [id, repoDigestsJson, ownerLabel, provenanceLabel] = output.split('|');
  assert(typeof id === 'string' && /^sha256:[a-f0-9]{64}$/u.test(id) && ownerLabel === ownerId
    && provenanceLabel === expectedProvenanceLabel, 'built_image_metadata_invalid');
  let repoDigests: unknown;
  try { repoDigests = JSON.parse(repoDigestsJson ?? '') as unknown; } catch { fail('built_image_repo_digests_invalid'); }
  assert(Array.isArray(repoDigests) && repoDigests.every((value: unknown) => typeof value === 'string'), 'built_image_repo_digests_missing');
  const candidates = repoDigests.filter(value => value.startsWith(`${IMAGE_REPOSITORY}@sha256:`));
  const repoDigest = candidates[0];
  assert(candidates.length === 1 && typeof repoDigest === 'string'
    && /^localhost\/hasi-reference-qualification@sha256:[a-f0-9]{64}$/u.test(repoDigest),
    'built_image_repo_digest_not_unique');
  return { id, repoDigest };
}

function containerSecuritySnapshot(containerId: string, networkName: string): void {
  const user = runDocker(['container', 'inspect', '--format', '{{.Config.User}}', containerId],
    'plugin_container_identity_inspection_failed');
  const hostConfig = parseJsonObject(runDocker(['container', 'inspect', '--format', '{{json .HostConfig}}', containerId],
    'plugin_container_policy_inspection_failed'), 'plugin_container_policy_metadata_invalid');
  const networkOutput = runDocker(['container', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId],
    'plugin_container_network_inspection_failed');
  assert(user === '65532:65532', 'runtime_non_root_policy_failed');
  assert(hostConfig.ReadonlyRootfs === true, 'runtime_read_only_rootfs_policy_failed');
  assert(Array.isArray(hostConfig.CapDrop) && hostConfig.CapDrop.length === 1 && hostConfig.CapDrop[0] === 'ALL'
    && (hostConfig.CapAdd === null || hostConfig.CapAdd === undefined || (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length === 0)),
  'runtime_capability_policy_failed');
  const securityOptions = hostConfig.SecurityOpt;
  assert(Array.isArray(securityOptions) && securityOptions.includes('no-new-privileges:true'), 'runtime_no_new_privileges_policy_failed');
  assert(hostConfig.Privileged === false, 'runtime_privileged_policy_failed');
  assert(hostConfig.NanoCpus === 500_000_000 && hostConfig.Memory === MEMORY_BYTES
    && hostConfig.MemorySwap === MEMORY_BYTES && hostConfig.PidsLimit === PID_LIMIT, 'runtime_resource_policy_failed');
  const bindings = hostConfig.PortBindings;
  assert(bindings === undefined || bindings === null || (isRecord(bindings) && Object.keys(bindings).length === 0),
    'plugin_has_requested_publication');
  const actualPorts = parseJsonObject(runDocker(['container', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', containerId],
    'plugin_publication_inspection_failed'), 'plugin_publication_metadata_invalid');
  assert(Object.values(actualPorts).every(value => value === null), 'plugin_has_effective_publication');
  assert(hostConfig.NetworkMode === networkName, 'runtime_internal_network_policy_failed');
  for (const field of [hostConfig.Binds, hostConfig.Mounts, hostConfig.Devices, hostConfig.DeviceRequests, hostConfig.Tmpfs]) {
    assert(field === undefined || field === null || (Array.isArray(field) && field.length === 0)
      || (typeof field === 'object' && !Array.isArray(field) && Object.keys(field).length === 0),
    'runtime_mount_or_device_policy_failed');
  }
  let networks: unknown;
  try { networks = JSON.parse(networkOutput) as unknown; } catch { fail('runtime_network_metadata_invalid'); }
  assert(typeof networks === 'object' && networks !== null && !Array.isArray(networks)
    && Object.keys(networks).length === 1 && Object.hasOwn(networks, networkName), 'runtime_network_attachment_failed');
}

function relaySecuritySnapshot(ownerId: string, installationId: string, operationId: string, internalNetwork: string, relayNetwork: string, hostPort: number): string {
  const name = `${dockerPluginContainerName(ownerId, installationId, operationId)}-relay`;
  const body = parseJsonObject(runDocker(['container', 'inspect', '--format', '{{json .}}', name],
    'relay_security_inspection_failed'), 'relay_security_metadata_invalid');
  assert(typeof body.Id === 'string' && /^[a-f0-9]{64}$/u.test(body.Id), 'relay_identity_invalid');
  assert(isRecord(body.Config) && isRecord(body.HostConfig) && isRecord(body.NetworkSettings), 'relay_security_metadata_invalid');
  const config = body.Config;
  const host = body.HostConfig;
  const settings = body.NetworkSettings;
  assert(config.Image === PLUGIN_RELAY_IMAGE && config.User === '65532:65532'
    && JSON.stringify(config.Entrypoint) === JSON.stringify(['node', '--input-type=module', '-e', PLUGIN_RELAY_PROGRAM]),
  'relay_image_or_program_mismatch');
  assert(host.ReadonlyRootfs === true && host.Privileged === false
    && JSON.stringify(host.CapDrop) === '["ALL"]' && JSON.stringify(host.SecurityOpt) === '["no-new-privileges:true"]'
    && host.NanoCpus === PLUGIN_RELAY_RESOURCES.cpuMillicores * 1_000_000
    && host.Memory === PLUGIN_RELAY_RESOURCES.memoryBytes && host.MemorySwap === PLUGIN_RELAY_RESOURCES.memoryBytes
    && host.PidsLimit === PLUGIN_RELAY_RESOURCES.pidsLimit, 'relay_resource_or_privilege_mismatch');
  assert(isRecord(settings.Networks) && Object.keys(settings.Networks).length === 2
    && Object.hasOwn(settings.Networks, internalNetwork) && Object.hasOwn(settings.Networks, relayNetwork), 'relay_network_membership_mismatch');
  for (const bindings of [host.PortBindings, settings.Ports]) {
    assert(isRecord(bindings) && Object.keys(bindings).length === 1 && Array.isArray(bindings['8080/tcp']), 'relay_publication_missing');
    const ports = bindings['8080/tcp'] as unknown[];
    assert(ports.length === 1 && isRecord(ports[0]) && ports[0].HostIp === '127.0.0.1'
      && ports[0].HostPort === String(hostPort), 'relay_publication_not_loopback');
  }
  assert(Array.isArray(config.Env) && config.Env.every(value => typeof value === 'string'
    && ['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HASI_RELAY_TARGET_ADDRESS', 'HASI_RELAY_TARGET_PORT', 'HASI_RELAY_LISTEN_PORT'].includes(value.slice(0, value.indexOf('=')))),
  'relay_received_unassigned_environment');
  for (const value of [host.Binds, host.Mounts, body.Mounts, host.Devices, host.DeviceRequests]) {
    assert(value === undefined || value === null || (Array.isArray(value) && value.length === 0), 'relay_mount_or_device_present');
  }
  return body.Id;
}

function loopbackHealthStatus(hostPort: number): Promise<number | null> {
  return new Promise(resolveStatus => {
    let done = false;
    const finish = (status: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveStatus(status);
    };
    const timer = setTimeout(() => { request.destroy(); finish(null); }, 2_000);
    const request = httpRequest({ host: '127.0.0.1', port: hostPort, path: '/healthz', agent: false }, response => {
      finish(response.statusCode ?? null);
      response.destroy();
    });
    request.on('error', () => { finish(null); });
    request.end();
  });
}

function runContainerNode(containerId: string, source: string, category: string, timeoutMs = 7_000): string {
  return runDocker(['exec', containerId, 'node', '-e', source], category, timeoutMs);
}

function pluginBehaviorProbes(containerId: string, nonce: string): {
  readonly rootfsWriteDenied: boolean;
  readonly rootfsWriteFailureCode: string;
  readonly assignedSecretSlotsPresent: boolean;
  readonly foreignSecretSlotsAbsent: boolean;
  readonly pidsLimit: string;
  readonly memoryLimit: string;
  readonly cpuLimit: string;
} {
  const filesystemProbe = [
    "const fs = require('node:fs');",
    "const root = '/opt/hasi/reference-plugin';",
    'let safe = true;',
    'function checkPath(path) { const st = fs.lstatSync(path); if (st.uid !== 0 || st.gid !== 0 || (!st.isSymbolicLink() && (st.mode & 0o222) !== 0)) safe = false; if (st.isSymbolicLink()) { const target = fs.realpathSync(path); if (!target.startsWith(root + "/") || target === root) safe = false; const targetStat = fs.statSync(path); if (targetStat.uid !== 0 || targetStat.gid !== 0 || (targetStat.mode & 0o222) !== 0) safe = false; } if (st.isDirectory()) for (const entry of fs.readdirSync(path)) checkPath(path + "/" + entry); }',
    'checkPath(root);',
    `const target = '/tmp/hasi-qualification-write-${nonce}';`,
    'const tmp = fs.statSync("/tmp");',
    'let writeFailureCode = null;',
    'try { fs.writeFileSync(target, "fixture", { flag: "wx" }); fs.rmSync(target, { force: true }); } catch (error) { writeFailureCode = error.code ?? null; }',
    'const assigned = Boolean(process.env.HASI_SECRET_SERVICE_TOKEN) && Boolean(process.env.HASI_SECRET_PUBLIC_KEY);',
    'const allowedNames = new Set(["PATH", "NODE_VERSION", "YARN_VERSION", "HOME", "HOSTNAME", "HASI_PLUGIN_INSTALLATION_ID", "HASI_SECRET_SERVICE_TOKEN", "HASI_SECRET_PUBLIC_KEY"]);',
    'const environmentAllowed = value => Object.keys(value).every(name => allowedNames.has(name));',
    'const foreignAbsent = environmentAllowed(process.env);',
    'const unexpectedSlotRejected = !environmentAllowed({ ...process.env, HASI_SECRET_UNEXPECTED_QUALIFICATION: "synthetic" });',
    'const unexpectedProviderRejected = !environmentAllowed({ ...process.env, CUSTOM_API_KEY: "synthetic" });',
    'process.stdout.write(JSON.stringify({ uid: process.getuid(), packageFilesRootOwnedReadOnly: safe, tmpWorldWritable: (tmp.mode & 0o002) !== 0, writeFailureCode, assigned, foreignAbsent, unexpectedSlotRejected, unexpectedProviderRejected }) + "\\n");',
  ].join('\n');
  const filesystemResult = parseJsonObject(runContainerNode(containerId, filesystemProbe, 'plugin_filesystem_probe_failed'), 'plugin_filesystem_probe_invalid');
  assert(filesystemResult.uid === 65_532 && filesystemResult.packageFilesRootOwnedReadOnly === true, 'plugin_package_file_policy_failed');
  assert(filesystemResult.tmpWorldWritable === true, 'plugin_tmp_directory_not_world_writable');
  assert(filesystemResult.writeFailureCode === 'EROFS', 'plugin_rootfs_write_was_not_denied_by_readonly_mount');
  assert(filesystemResult.assigned === true && filesystemResult.foreignAbsent === true
    && filesystemResult.unexpectedSlotRejected === true && filesystemResult.unexpectedProviderRejected === true, 'plugin_secret_slot_boundary_failed');

  const cgroupProbe = [
    "const fs = require('node:fs');",
    'const result = { pids: fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(), memory: fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), cpu: fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim() };',
    'process.stdout.write(JSON.stringify(result) + "\\n");',
  ].join('\n');
  const cgroupResult = parseJsonObject(runContainerNode(containerId, cgroupProbe, 'plugin_cgroup_probe_failed'), 'plugin_cgroup_probe_invalid');
  const cpuValues = typeof cgroupResult.cpu === 'string' ? cgroupResult.cpu.split(/\s+/u) : [];
  assert(cgroupResult.pids === String(PID_LIMIT), 'runtime_pids_cgroup_limit_failed');
  assert(cgroupResult.memory === String(MEMORY_BYTES), 'runtime_memory_cgroup_limit_failed');
  assert(typeof cgroupResult.cpu === 'string'
    && cpuValues.length === 2 && cpuValues[0] === '50000' && cpuValues[1] === '100000', 'runtime_cpu_cgroup_limit_failed');
  return {
    rootfsWriteDenied: true,
    rootfsWriteFailureCode: 'EROFS',
    assignedSecretSlotsPresent: true,
    foreignSecretSlotsAbsent: true,
    pidsLimit: cgroupResult.pids,
    memoryLimit: cgroupResult.memory,
    cpuLimit: cgroupResult.cpu,
  };
}

function parseJsonObject(output: string, category: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch { fail(category); }
  assert(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), category);
  return parsed as Record<string, unknown>;
}

async function verifyPinnedManifestAndRead(input: {
  readonly hostPort?: number;
  readonly baseUrl?: string;
  readonly installationId?: string;
  readonly configurationRevision?: number;
  readonly artifact: ArtifactManifest;
  readonly releaseManifestDigest: string;
  readonly privateKey: KeyObject;
  readonly serviceToken: string;
  readonly nonce: string;
}): Promise<void> {
  const baseUrl = new URL(input.baseUrl ?? `http://127.0.0.1:${String(input.hostPort)}/`);
  assert(baseUrl.protocol === 'http:' && baseUrl.hostname === '127.0.0.1' && baseUrl.port !== ''
    && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash
    && (baseUrl.pathname === '/' || /^\/api\/plugin-deployments\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/$/u.test(baseUrl.pathname)),
  'native_mcp_endpoint_not_operator_loopback');
  let manifestResponse: Response;
  try {
    manifestResponse = await fetch(new URL('.well-known/hasi-plugin.json', baseUrl), { headers: { authorization: `Bearer ${input.serviceToken}` }, signal: AbortSignal.timeout(5_000) });
  } catch {
    fail('pinned_manifest_fetch_failed');
  }
  assert(manifestResponse.status === 200, 'pinned_manifest_fetch_failed');
  let manifestInput: unknown;
  try { manifestInput = await manifestResponse.json(); } catch { fail('pinned_manifest_json_invalid'); }
  const parsedManifest = manifestSchema.safeParse(manifestInput);
  assert(parsedManifest.success && parsedManifest.data.manifestVersion === 2, 'pinned_manifest_invalid');
  const manifest: PluginManifestV2 = parsedManifest.data;
  const actualDigest = digest(manifest);
  assert(manifest.id === input.artifact.pluginId
    && manifest.version === input.artifact.pluginVersion
    && actualDigest === input.artifact.manifestDigest
    && actualDigest === input.releaseManifestDigest,
  'running_manifest_digest_mismatch');

  const actor: ActorContext = {
    subject: `healthy-qualification-${input.nonce}`,
    permissions: ['reference:read'],
    claims: { 'reference.account': ACCOUNT_CLAIM },
  };
  const args: Record<string, never> = {};
  const invocation = await createInvocationToken({
    actor,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    tool: 'read_status',
    args,
    context: {
      installationId: input.installationId ?? manifest.id,
      configurationRevision: input.configurationRevision ?? 1,
      configuration: { label: PLUGIN_LABEL },
    },
  }, input.privateKey);
  let response: Response;
  try {
    response = await fetch(new URL('mcp', baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.serviceToken}`,
        'x-hasi-invocation': invocation,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_status', arguments: args } }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    fail('native_mcp_read_failed');
  }
  assert(response.status === 200, `native_mcp_read_http_${String(response.status)}`);
  let responseText = '';
  try { responseText = await response.text(); } catch { fail('native_mcp_response_unreadable'); }
  assert(Buffer.byteLength(responseText, 'utf8') <= 65_536, 'native_mcp_response_too_large');
  const dataLine = responseText.split(/\r?\n/u).find(line => line.startsWith('data: '));
  let wire: NativeMcpResult;
  try { wire = JSON.parse(dataLine ? dataLine.slice('data: '.length) : responseText) as NativeMcpResult; } catch { fail('native_mcp_response_invalid'); }
  assert(wire.jsonrpc === '2.0' && wire.id === 1 && wire.error === undefined, 'native_mcp_protocol_response_invalid');
  const result = wire.result;
  assert(typeof result === 'object' && result !== null && !Array.isArray(result), 'native_mcp_result_invalid');
  assert((result as Record<string, unknown>).isError === undefined || (result as Record<string, unknown>).isError === false, 'native_mcp_tool_reported_error');
  const structuredContent = (result as Record<string, unknown>).structuredContent;
  assert(typeof structuredContent === 'object' && structuredContent !== null && !Array.isArray(structuredContent), 'native_mcp_structured_content_missing');
  const value = structuredContent as Record<string, unknown>;
  assert(value.label === PLUGIN_LABEL
    && value.account === ACCOUNT_CLAIM
    && value.version === manifest.version
    && value.actionCount === 0,
  'native_mcp_read_output_mismatch');

  // A valid signature must not authorize a different installation of this plugin.
  const foreignInvocation = await createInvocationToken({
    actor, pluginId: manifest.id, pluginVersion: manifest.version, tool: 'read_status', args,
    context: { installationId: `foreign-${input.nonce}`, configurationRevision: input.configurationRevision ?? 1,
      configuration: { label: PLUGIN_LABEL } },
  }, input.privateKey);
  let foreignResponse: Response;
  try {
    foreignResponse = await fetch(new URL('mcp', baseUrl), {
      method: 'POST', headers: { authorization: `Bearer ${input.serviceToken}`, 'x-hasi-invocation': foreignInvocation,
        accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_status', arguments: args } }),
      signal: AbortSignal.timeout(5_000),
    });
    await foreignResponse.body?.cancel();
  } catch { fail('native_mcp_foreign_installation_probe_failed'); }
  assert(foreignResponse.status === 401, 'native_mcp_foreign_installation_accepted');
}

function exactContainerList(): Set<string> {
  const output = runDocker(['container', 'ls', '--all', '--quiet'], 'container_inventory_failed');
  return new Set(output.split('\n').filter(Boolean));
}

function containerIdForExactName(name: string): string | undefined {
  const output = runDocker(['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}|{{.Names}}'], 'container_inventory_failed');
  const matches = output.split('\n').map(line => line.split('|')).filter(fields => fields[1] === name);
  if (matches.length > 1) fail('qualification_container_name_ambiguous');
  const id = matches[0]?.[0];
  return id && /^[a-f0-9]{64}$/u.test(id) ? id : undefined;
}

function removeOwnedNetwork(name: string | undefined, ownerId: string): boolean {
  if (!name) return true;
  const names = runDocker(['network', 'ls', '--no-trunc', '--format', '{{.Name}}'], 'network_inventory_failed');
  if (!names.split('\n').includes(name)) return true;
  const details = networkDetails(name);
  if (details.labels[OWNER_LABEL] !== ownerId || details.name !== name) return false;
  runDocker(['network', 'rm', name], 'qualification_network_cleanup_failed');
  const after = runDocker(['network', 'ls', '--no-trunc', '--format', '{{.Name}}'], 'network_cleanup_verification_failed');
  return !after.split('\n').includes(name);
}

function removeOwnedImage(tag: string | undefined, expectedId: string | undefined, ownerId: string): boolean {
  if (!tag) return true;
  const tags = runDocker(['image', 'ls', '--quiet', tag], 'image_inventory_failed');
  if (!tags) return true;
  const output = runDocker([
    'image', 'inspect', '--format', '{{.Id}}|{{index .Config.Labels "' + OWNER_LABEL + '"}}', tag,
  ], 'built_image_cleanup_inspection_failed');
  const [id, label] = output.split('|');
  if ((expectedId !== undefined && id !== expectedId) || label !== ownerId) return false;
  runDocker(['image', 'rm', tag], 'built_image_cleanup_failed');
  return runDocker(['image', 'ls', '--quiet', tag], 'image_cleanup_verification_failed').length === 0;
}

function removeOwnedControlContainer(name: string | undefined, id: string | undefined, ownerId: string): boolean {
  if (!name) return true;
  const foundId = id ?? containerIdForExactName(name);
  if (!foundId) return true;
  const output = runDocker([
    'container', 'inspect', '--format', '{{.Id}}|{{.Name}}|{{json .Config.Labels}}', foundId,
  ], 'control_container_cleanup_inspection_failed').split('|');
  const labels = parseDockerLabels(output[2]);
  if (output[0] !== foundId || output[1] !== `/${name}` || labels[OWNER_LABEL] !== ownerId) return false;
  runDocker(['container', 'rm', '--force', foundId], 'control_container_cleanup_failed');
  return containerIdForExactName(name) === undefined;
}

export async function runHealthyPluginContainerQualification(): Promise<Record<string, unknown>> {
  requireOptIn();
  const sourceSha256 = await pluginSourceSha256();
  const preparedArtifactPath = process.env.HASI_PREBUILT_QUALIFICATION_ARTIFACT;
  const preparedArtifact = preparedArtifactPath === undefined
    ? undefined
    : await loadPreparedArtifact(preparedArtifactPath, sourceSha256);
  const socketPath = dockerSocketPath();
  assertLocalNodeImage();

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const shortNonce = nonce.toLowerCase();
  const ownerId = `local-qualifier-${shortNonce}`;
  const installationId = `healthy-plugin-${shortNonce}`;
  const operationId = `stage-${randomUUID()}`;
  const internalNetwork = `hasi-plugin-qual-${shortNonce}`;
  const externalNetwork = `hasi-plugin-egress-${shortNonce}`;
  const imageTag = `${IMAGE_REPOSITORY}:${shortNonce}`;
  const controlContainerName = `hasi-qual-control-${shortNonce}`;
  const baselineContainers = exactContainerList();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hasi-healthy-plugin-qualification-'));
  const artifactDirectory = preparedArtifact?.directory ?? join(tempRoot, 'artifact');
  const dockerfilePath = join(tempRoot, 'Dockerfile');
  let baselineContainersRestored = false;
  let internalNetworkAttempted = false;
  let externalNetworkAttempted = false;
  let imageBuildAttempted = false;
  let controlContainerAttempted = false;
  let imageId: string | undefined;
  let controlContainerId: string | undefined;
  let stagedDeploymentId: string | undefined;
  let driver: ReturnType<typeof createDockerPluginDriver> | undefined;
  let cleanupFailed = false;
  let summary: Record<string, unknown> | undefined;
  let primaryFailure: unknown;

  const routeOperations = new Map<string, 'committed' | 'not-committed' | 'pending' | 'unknown'>();
  let activeDeploymentId: string | null = null;
  const routing: DockerPluginDriverOptions['routing'] = {
    activate: input => {
      routeOperations.set(input.operationId, 'pending');
      if (activeDeploymentId !== input.previousDeploymentId) {
        routeOperations.set(input.operationId, 'not-committed');
        throw new QualificationFailure('local_route_activation_base_changed');
      }
      activeDeploymentId = input.candidateDeploymentId;
      routeOperations.set(input.operationId, 'committed');
      return Promise.resolve();
    },
    rollback: input => {
      routeOperations.set(input.operationId, 'pending');
      if (activeDeploymentId !== input.currentDeploymentId) {
        routeOperations.set(input.operationId, 'not-committed');
        throw new QualificationFailure('local_route_rollback_base_changed');
      }
      activeDeploymentId = input.previousDeploymentId;
      routeOperations.set(input.operationId, 'committed');
      return Promise.resolve();
    },
    readActiveDeploymentId: () => Promise.resolve(activeDeploymentId),
    readOperationStatus: input => Promise.resolve(routeOperations.get(input.operationId) ?? 'unknown'),
  };

  try {
    const artifactEvidence = preparedArtifact?.evidence
      ?? packageReferencePluginWithAllowlistedEnvironment(artifactDirectory);
    const artifact = preparedArtifact?.manifest ?? await readArtifactManifest(artifactDirectory, artifactEvidence);
    assert(await pluginSourceSha256(artifactDirectory) === sourceSha256, 'prebuilt_artifact_source_binding_invalid');
    const sourceIdentity = preparedArtifact?.source ?? await workspacePluginSourceIdentity();
    let provenance: PluginReleaseProvenance;
    try { provenance = artifactPluginProvenance(artifactEvidence, sourceIdentity); }
    catch { fail('prebuilt_artifact_source_binding_invalid'); }
    const provenanceLabel = pluginImageProvenanceLabel({
      pluginId: artifact.pluginId,
      version: artifact.pluginVersion,
      manifestDigest: artifact.manifestDigest,
      provenance,
    });
    const dockerfile = pluginLauncherDockerfile();
    const dockerfileSha256 = sha256(dockerfile);
    await writeFile(dockerfilePath, dockerfile, 'utf8');
    const configurationSha256 = sha256([
      dockerfile,
      HEALTH_PROBE_SOURCE,
      JSON.stringify({ cpuMillicores: CPU_MILLICORES, memoryBytes: MEMORY_BYTES, pidsLimit: PID_LIMIT, containerPort: 3000 }),
    ].join('\0'));

    const existingTag = runDocker(['image', 'ls', '--quiet', imageTag], 'image_tag_collision_check_failed');
    assert(existingTag.length === 0, 'qualification_image_tag_already_exists');
    internalNetworkAttempted = true;
    createQualificationNetwork(internalNetwork, ownerId, true);
    externalNetworkAttempted = true;
    createQualificationNetwork(externalNetwork, ownerId, false);

    imageBuildAttempted = true;
    runDocker([
      'build', '--network=none', '--pull=false', '--label', `${OWNER_LABEL}=${ownerId}`,
      '--label', `${PLUGIN_IMAGE_PROVENANCE_LABEL}=${provenanceLabel}`,
      '--tag', imageTag, '--file', dockerfilePath, artifactDirectory,
    ], 'offline_image_build_failed', 180_000);
    const identity = dockerImageIdentity(imageTag, ownerId, provenanceLabel);
    imageId = identity.id;
    const releaseFixtures = createAndVerifySyntheticRelease({ artifact, image: identity.repoDigest, provenance });
    const syntheticRelease = releaseFixtures.release;
    assert(syntheticRelease.imageDigest === identity.repoDigest.slice(identity.repoDigest.lastIndexOf('@sha256:') + 8),
      'built_image_digest_binding_failed');

    const hostPort = await ephemeralLoopbackPort();
    const runtimeKeys = generateKeyPairSync('ed25519');
    const publicKeyPem = runtimeKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const syntheticToken = randomBytes(32).toString('base64url');
    const secretByName = new Map([
      [SECRET_TOKEN_NAME, syntheticToken],
      [SECRET_PUBLIC_KEY_NAME, publicKeyPem],
    ]);
    const secretAssignments = [
      { name: SECRET_TOKEN_NAME, secretRef: `${SECRET_TOKEN_REF}-${shortNonce}` },
      { name: SECRET_PUBLIC_KEY_NAME, secretRef: `${SECRET_PUBLIC_KEY_REF}-${shortNonce}` },
    ] as const;
    let secretResolutions = 0;
    driver = createDockerPluginDriver({
      enabled: true,
      deploymentTarget: 'operator-local',
      socketPath,
      ownerId,
      allowedInternalNetworks: [internalNetwork],
      relayNetwork: externalNetwork,
      routing,
      resolveSecret: input => {
        secretResolutions += 1;
        assert(input.ownerId === ownerId && input.installationId === installationId
          && input.pluginId === artifact.pluginId, 'synthetic_secret_scope_mismatch');
        const expectedRef = input.secretName === SECRET_TOKEN_NAME
          ? `${SECRET_TOKEN_REF}-${shortNonce}`
          : input.secretName === SECRET_PUBLIC_KEY_NAME ? `${SECRET_PUBLIC_KEY_REF}-${shortNonce}` : undefined;
        assert(expectedRef !== undefined && input.secretRef === expectedRef, 'unassigned_synthetic_secret_requested');
        return secretByName.get(input.secretName);
      },
      healthPath: '/healthz',
      requestTimeoutMs: 5_000,
    });
    const policy = launchPolicy(syntheticRelease, internalNetwork, hostPort);
    const baseInput = {
      installationId,
      operationId,
      baseCurrentDigest: null,
      configurationRevision: 'healthy-qualification-v1',
      release: syntheticRelease,
      policy,
      secretAssignments,
    } as const;
    const activeDriver = driver;

    const sourceIdentityCounterprobe = releaseFixtures.signedSourceIdentityCounterprobe;
    assert(sourceIdentityCounterprobe.image === syntheticRelease.image
      && sourceIdentityCounterprobe.provenance.source.commit !== syntheticRelease.provenance.source.commit,
    'signed_source_identity_counterprobe_invalid');
    const provenanceCounterprobeInput = {
      ...baseInput,
      release: sourceIdentityCounterprobe,
      policy: launchPolicy(sourceIdentityCounterprobe, internalNetwork, hostPort),
    } as const;
    const containersBeforeProvenanceCounterprobe = exactContainerList();
    const secretResolutionsBeforeProvenanceCounterprobe = secretResolutions;
    try {
      const unexpected = await activeDriver.stage(provenanceCounterprobeInput);
      stagedDeploymentId = unexpected.deploymentId;
      fail('signed_source_identity_image_label_counterprobe_failed');
    } catch (error) {
      if (error instanceof QualificationFailure) throw error;
      if (!(error instanceof DockerPluginDriverError) || error.outcome !== 'failed' || error.reason !== 'image_provenance_mismatch') {
        fail('signed_source_identity_image_label_counterprobe_failed');
      }
    }
    const containersAfterProvenanceCounterprobe = exactContainerList();
    assert([...containersAfterProvenanceCounterprobe].every(id => containersBeforeProvenanceCounterprobe.has(id))
      && [...containersBeforeProvenanceCounterprobe].every(id => containersAfterProvenanceCounterprobe.has(id)),
    'signed_source_identity_counterprobe_changed_container_inventory');
    assert(secretResolutions === secretResolutionsBeforeProvenanceCounterprobe,
      'signed_source_identity_counterprobe_resolved_secrets');

    const denials: readonly [string, PluginContainerLaunchPolicy][] = [
      ['read-only root filesystem', { ...policy, readOnlyRootFilesystem: false } as unknown as PluginContainerLaunchPolicy],
      ['non-root UID/GID', { ...policy, user: { uid: 0, gid: 0 } } as unknown as PluginContainerLaunchPolicy],
      ['capability drop', { ...policy, capDrop: [] } as unknown as PluginContainerLaunchPolicy],
      ['resource limits', { ...policy, memoryBytes: 0 }],
    ];
    for (const [description, deniedPolicy] of denials) {
      await expectDriverDenial(() => activeDriver.stage({ ...baseInput, policy: deniedPolicy }),
        `static_${description.replaceAll(' ', '_')}_denial_failed`);
    }
    await expectDriverDenial(
      () => activeDriver.stage({ ...baseInput, policy: launchPolicy(syntheticRelease, externalNetwork, hostPort) }),
      'static_external_network_denial_failed',
    );
    const afterDenials = exactContainerList();
    assert([...afterDenials].every(id => baselineContainers.has(id))
      && [...baselineContainers].every(id => afterDenials.has(id)), 'static_denials_changed_container_inventory');

    const externalNetworkDetails = networkDetails(externalNetwork);
    assert(!externalNetworkDetails.internal && externalNetworkDetails.labels[OWNER_LABEL] === ownerId,
      'external_control_network_invalid');
    controlContainerAttempted = true;
    controlContainerId = createControlContainer({
      image: identity.repoDigest,
      networkName: externalNetwork,
      ownerId,
      name: controlContainerName,
      probeSource: HEALTH_PROBE_SOURCE,
    });
    const controlOutput = runDocker(['container', 'start', '--attach', controlContainerId], 'external_egress_control_unavailable', 7_000);
    const controlProbe = parseProbeResult(controlOutput, 'external_egress_control_unavailable');
    assert(controlProbe.status === 200 && controlProbe.complete, 'external_egress_control_unavailable');
    assert(removeOwnedControlContainer(controlContainerName, controlContainerId, ownerId), 'external_control_cleanup_failed');
    controlContainerAttempted = false;
    controlContainerId = undefined;

    const staged = await driver.stage(baseInput);
    stagedDeploymentId = staged.deploymentId;
    containerSecuritySnapshot(staged.deploymentId, internalNetwork);
    const relayId = relaySecuritySnapshot(ownerId, installationId, operationId, internalNetwork, externalNetwork, hostPort);
    assert(secretResolutions === 2, 'synthetic_secret_resolution_count_invalid');
    const reconciled = await driver.reconcile({ installationId, operationId });
    assert(reconciled.activeDeploymentId === null && reconciled.stagedDeploymentId === staged.deploymentId,
      'staged_deployment_reconciliation_failed');

    const healthy = await driver.check({
      installationId,
      deploymentId: staged.deploymentId,
      releaseDigest: syntheticRelease.releaseDigest,
    });
    if (!healthy) {
      const state = parseJsonObject(runDocker(['container', 'inspect', '--format', '{{json .State}}', staged.deploymentId],
        'plugin_process_state_inspection_failed'), 'plugin_process_state_metadata_invalid');
      const pluginProcessRunning = state.Running === true;
      let pluginInternalHealthStatus: number | null = null;
      let hostStatus: number | null = null;
      let healthBlocker: string;
      if (!pluginProcessRunning) {
        healthBlocker = state.OOMKilled === true ? 'plugin_process_oom_killed' : 'plugin_process_exited_before_health_check';
      } else {
        const internalHealthProbe = [
          'fetch("http://127.0.0.1:3000/healthz", { signal: AbortSignal.timeout(2000) })',
          '.then(async response => { const status = response.status; await response.body?.cancel(); process.stdout.write(JSON.stringify({ status }) + "\\n"); })',
          '.catch(() => process.stdout.write(JSON.stringify({ status: null }) + "\\n"));',
        ].join('');
        const internalHealth = parseJsonObject(runContainerNode(staged.deploymentId, internalHealthProbe,
          'plugin_internal_health_probe_failed', 5_000), 'plugin_internal_health_probe_invalid');
        pluginInternalHealthStatus = typeof internalHealth.status === 'number' ? internalHealth.status : null;
        if (pluginInternalHealthStatus !== 200) {
          healthBlocker = 'plugin_server_health_endpoint_unavailable';
        } else {
          hostStatus = await loopbackHealthStatus(hostPort);
          healthBlocker = hostStatus !== 200
            ? 'host_loopback_health_path_unavailable' : 'docker_driver_health_probe_disagreed_with_direct_probe';
        }
      }
      summary = {
        qualification: 'local-synthetic-reference-plugin-container-behavior',
        qualified: false,
        blocker: healthBlocker,
        externalSourceIndependentlyReviewed: false,
        fullDistributionAcceptance: false,
        fullP5P6Acceptance: false,
        baseImage: NODE_BASE_IMAGE,
        image: identity.repoDigest,
        imageDigest: syntheticRelease.imageDigest,
        manifestDigest: artifact.manifestDigest,
        artifactSha256: artifactEvidence.artifactSha256,
        artifactManifestSha256: artifactEvidence.artifactManifestSha256,
        pluginSourceSha256: sourceSha256,
        sourceIdentity,
        sourceIdentityAssurance: preparedArtifact ? 'prepared-sidecar-assertion-bound-to-source-files' : 'workspace-commit-matched-to-source-files',
        dockerfileSha256,
        configurationSha256,
        payloadFileCount: artifactEvidence.payloadFileCount,
        runtimePackageCount: artifactEvidence.runtimePackageCount,
        cleanupVerified: false,
        qualificationCounts: {
          releaseCounterprobes: 5,
          imageProvenanceLabelCounterprobes: 1,
          preflightSecretResolutionCounterprobes: 1,
          staticPolicyDenials: denials.length + 1,
          assignedSecretResolutions: secretResolutions,
          nativeReadStatusCalls: 0,
          rootfsWriteProbes: 0,
          credentialBoundaryProbes: 0,
          internalEgressProbes: 0,
        },
        probes: {
          syntheticPublisherSignatureVerified: true,
          signedChangedSourceCommitRejectedBeforeContainerOrSecret: true,
          packagedManifestIdentityMatched: true,
          runningManifestDigestMatched: false,
          nativeMcpReadMatchedSyntheticContext: false,
          driverHealthCheck: false,
          pluginProcessRunning,
          pluginInternalHealthStatus,
          hostLoopbackHealthStatus: hostStatus,
          stagedContainerPolicyInspected: true,
          nonRootRuntime: true,
          readOnlyRootfs: true,
          capabilitiesDropped: true,
          noNewPrivileges: true,
          builtinSeccompVerifiedByDriver: true,
          pluginUnpublished: true,
          relayLoopbackOnlyPublishedPort: true,
          externalControlStatus: controlProbe.status,
          targetEgressDeniedOnInternalNetwork: false,
        },
      };
      fail(healthBlocker);
    }
    const pluginProbes = pluginBehaviorProbes(staged.deploymentId, shortNonce);
    const pluginEgressOutput = runContainerNode(staged.deploymentId, HEALTH_PROBE_SOURCE, 'plugin_egress_probe_failed', 7_000);
    const pluginEgress = parseProbeResult(pluginEgressOutput, 'plugin_egress_probe_invalid');
    assert(pluginEgress.status === null, 'plugin_reached_public_health_endpoint_on_internal_network');

    await verifyPinnedManifestAndRead({
      hostPort,
      installationId,
      artifact,
      releaseManifestDigest: syntheticRelease.manifestDigest,
      privateKey: runtimeKeys.privateKey,
      serviceToken: syntheticToken,
      nonce: shortNonce,
    });

    summary = {
      qualification: 'local-synthetic-reference-plugin-container-behavior',
      qualified: true,
      externalSourceIndependentlyReviewed: false,
      fullDistributionAcceptance: false,
      fullP5P6Acceptance: false,
      baseImage: NODE_BASE_IMAGE,
      image: identity.repoDigest,
      imageDigest: syntheticRelease.imageDigest,
      manifestDigest: artifact.manifestDigest,
      artifactSha256: artifactEvidence.artifactSha256,
      artifactManifestSha256: artifactEvidence.artifactManifestSha256,
      pluginSourceSha256: sourceSha256,
      sourceIdentity,
      sourceIdentityAssurance: preparedArtifact ? 'prepared-sidecar-assertion-bound-to-source-files' : 'workspace-commit-matched-to-source-files',
      dockerfileSha256,
      configurationSha256,
      payloadFileCount: artifactEvidence.payloadFileCount,
      runtimePackageCount: artifactEvidence.runtimePackageCount,
      qualificationCounts: {
        releaseCounterprobes: 5,
        imageProvenanceLabelCounterprobes: 1,
        preflightSecretResolutionCounterprobes: 1,
        staticPolicyDenials: denials.length + 1,
        assignedSecretResolutions: secretResolutions,
        nativeReadStatusCalls: 1,
      },
      probes: {
        syntheticPublisherSignatureVerified: true,
        signedChangedSourceCommitRejectedBeforeContainerOrSecret: true,
        packagedManifestIdentityMatched: true,
        runningManifestDigestMatched: true,
        nativeMcpReadMatchedSyntheticContext: true,
        validSignedForeignInstallationDenied: true,
        driverHealthCheck: healthy,
        nonRootRuntime: true,
        readOnlyRootfs: true,
        rootfsWriteDenied: pluginProbes.rootfsWriteDenied,
        rootfsWriteFailureCode: pluginProbes.rootfsWriteFailureCode,
        assignedSecretSlotsPresent: pluginProbes.assignedSecretSlotsPresent,
        foreignSecretSlotsAbsent: pluginProbes.foreignSecretSlotsAbsent,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        builtinSeccompVerifiedByDriver: true,
        cpuLimit: pluginProbes.cpuLimit,
        memoryLimitBytes: pluginProbes.memoryLimit,
        pidsLimit: pluginProbes.pidsLimit,
        pluginUnpublished: true,
        relayDeploymentId: relayId,
        relayImage: PLUGIN_RELAY_IMAGE,
        relayProgramSha256: sha256(PLUGIN_RELAY_PROGRAM),
        relayLoopbackOnlyPublishedPort: true,
        relayAssignedEnvironmentOnly: true,
        externalControlStatus: controlProbe.status,
        pluginPublicHealthStatus: pluginEgress.status,
        targetEgressDeniedOnInternalNetwork: true,
      },
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (driver) {
      try {
        const observation = await driver.reconcile({ installationId, operationId });
        const deploymentId = stagedDeploymentId ?? observation.stagedDeploymentId;
        if (deploymentId) await driver.discard({ installationId, operationId, deploymentId });
      } catch {
        cleanupFailed = true;
      }
    }
    if (controlContainerAttempted) {
      try {
        if (!removeOwnedControlContainer(controlContainerName, controlContainerId, ownerId)) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (externalNetworkAttempted) {
      try { if (!removeOwnedNetwork(externalNetwork, ownerId)) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (internalNetworkAttempted) {
      try { if (!removeOwnedNetwork(internalNetwork, ownerId)) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    if (imageBuildAttempted) {
      try { if (!removeOwnedImage(imageTag, imageId, ownerId)) cleanupFailed = true; } catch { cleanupFailed = true; }
    }
    try { await rm(tempRoot, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    try {
      const remaining = exactContainerList();
      baselineContainersRestored = [...baselineContainers].every(id => remaining.has(id))
        && [...remaining].every(id => baselineContainers.has(id));
      if (!baselineContainersRestored) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }

  if (primaryFailure !== undefined || cleanupFailed) {
    const primaryBlocker = primaryFailure === undefined ? null
      : primaryFailure instanceof QualificationFailure ? primaryFailure.category
        : primaryFailure instanceof DeploymentDriverError ? `docker_driver_${primaryFailure.outcome}` : 'qualification_failed';
    const blocker = cleanupFailed ? 'cleanup_unconfirmed' : primaryBlocker;
    return { ...summary, qualified: false, blocker, primaryBlocker, ownerId, installationId, operationId, cleanupVerified: !cleanupFailed && baselineContainersRestored };
  }
  assert(baselineContainersRestored, 'container_inventory_not_restored');
  assert(summary !== undefined, 'qualification_summary_missing');
  return { ...summary, cleanupVerified: true };
}

// Operator-only reusable fixtures. Importing this module never launches Docker.
export const qualificationFixtures = Object.freeze({
  requireOptIn, dockerSocketPath, assertLocalNodeImage, pluginSourceSha256,
  packageReferencePluginWithAllowlistedEnvironment, readArtifactManifest,
  pluginLauncherDockerfile, createQualificationNetwork, runDocker,
  dockerImageIdentity, createAndVerifySyntheticRelease, ephemeralLoopbackPort,
  launchPolicy, containerSecuritySnapshot, relaySecuritySnapshot,
  verifyPinnedManifestAndRead, exactContainerList, removeOwnedNetwork,
  removeOwnedImage, sha256, assert, fail,
});

export function qualificationFailureCategory(error: unknown): string {
  return error instanceof QualificationFailure ? error.category : 'qualification_failed';
}
