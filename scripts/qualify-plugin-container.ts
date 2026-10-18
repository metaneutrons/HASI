import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { buildPluginContainerLaunchPolicy, DeploymentDriverError, pluginReleaseSigningBytes, verifyPluginRelease, type PluginContainerLaunchPolicy, type PluginReleaseEnvelope, type PublisherApproval, type UnsignedPluginRelease } from '../apps/api/src/plugin-artifacts.js';
import { createDockerPluginDriver, type DockerPluginRoutingController, type DockerPluginDriverOptions } from '../apps/api/src/docker-plugin-driver.js';

const APPROVED_QUALIFICATION_IMAGES = new Set([
  'docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5',
  'docker.io/library/node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03',
]);

function requiredOptIn(): string {
  if (process.env.HASI_DOCKER_QUALIFY !== '1') {
    throw new Error('Set HASI_DOCKER_QUALIFY=1 to run this local Docker qualification.');
  }
  if (process.env.VERCEL || process.env.HASI_DEMO_MODE === '1') {
    throw new Error('Local Docker qualification is unavailable in Vercel or demo mode.');
  }
  const image = process.env.HASI_DOCKER_QUALIFY_IMAGE;
  if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,447}@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Set HASI_DOCKER_QUALIFY_IMAGE to an already-local immutable image reference.');
  }
  if (!APPROVED_QUALIFICATION_IMAGES.has(image)) {
    throw new Error('Qualification accepts only the reviewed official Node 24 bookworm image digests.');
  }
  return image;
}

function runDocker(args: readonly string[]): string {
  try {
    return execFileSync('docker', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
  } catch {
    throw new Error('A required local Docker inspection or qualification operation failed.');
  }
}

function dockerSocketPath(): string {
  const host = process.env.DOCKER_HOST ?? runDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!host.startsWith('unix://')) throw new Error('Qualification requires a local Docker Unix socket.');
  const socketPath = decodeURIComponent(host.slice('unix://'.length));
  if (!isAbsolute(socketPath) || socketPath.includes('\0')) throw new Error('Docker socket path is invalid.');
  return socketPath;
}

function assertLocalImagePresent(image: string): void {
  const result = runDocker(['image', 'inspect', '--format', '{{.Id}}|{{json .RepoDigests}}', image]);
  const [imageId, repoDigestJson] = result.split('|');
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') || typeof repoDigestJson !== 'string') {
    throw new Error('The requested digest-pinned image is not present locally; this script never pulls images.');
  }
  let repoDigests: unknown;
  try { repoDigests = JSON.parse(repoDigestJson) as unknown; } catch { throw new Error('Docker returned invalid local image metadata.'); }
  if (!Array.isArray(repoDigests) || repoDigests.length === 0) {
    throw new Error('The local image has no registry digest identity; this script will not run it.');
  }
}

function unsignedRelease(image: string): UnsignedPluginRelease {
  const manifestDigest = createHash('sha256').update(`local-qualification:${image}`).digest('hex');
  return {
    schemaVersion: 1,
    pluginId: 'docker-qualification',
    version: '1.0.0',
    manifestDigest,
    image,
    publisherId: 'local-qualifier',
    configSchemaVersion: 1,
    stateMigration: 'none',
  };
}

function qualifyRelease(image: string) {
  const unsigned = unsignedRelease(image);
  const keys = generateKeyPairSync('ed25519');
  const envelope: PluginReleaseEnvelope = {
    ...unsigned,
    signature: sign(null, pluginReleaseSigningBytes(unsigned), keys.privateKey).toString('base64url'),
  };
  const approval: PublisherApproval = {
    publisherId: unsigned.publisherId,
    publicKey: keys.publicKey,
    sourceRegistryPrefix: image.slice(0, image.lastIndexOf('@sha256:')),
    allowedPluginIds: [unsigned.pluginId],
  };
  return verifyPluginRelease(envelope, publisherId => publisherId === approval.publisherId ? approval : undefined);
}

function pluginPolicy(release: ReturnType<typeof qualifyRelease>, networkName: string, hostPort: number): PluginContainerLaunchPolicy {
  return buildPluginContainerLaunchPolicy(release, {
    network: { mode: 'internal', name: networkName },
    hostPort,
    containerPort: 3000,
    cpuMillicores: 500,
    memoryBytes: 256 * 1024 * 1024,
    pidsLimit: 64,
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 1_000,
  });
}

async function ephemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
  });
  return port;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectKnownFailure(operation: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DeploymentDriverError && error.outcome === 'failed') return;
    throw new Error(`${description} returned an unexpected deployment outcome.`);
  }
  throw new Error(`${description} unexpectedly succeeded.`);
}

function containerSecuritySnapshot(containerId: string): void {
  const format = '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.Privileged}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}|{{json .HostConfig.PortBindings}}';
  const fields = runDocker(['container', 'inspect', '--format', format, containerId]).split('|');
  assert(fields.length === 11, 'Docker inspect did not return the expected runtime security fields.');
  assert(fields[0] === '65532:65532', 'Runtime UID/GID did not match the non-root policy.');
  assert(fields[1] === 'true', 'Runtime root filesystem is not read-only.');
  assert(fields[2] === '["ALL"]', 'Runtime did not drop all Linux capabilities.');
  assert(fields[3] === '[]', 'Runtime added Linux capabilities.');
  assert(fields[4] === '["no-new-privileges:true"]', 'Runtime no-new-privileges setting did not match.');
  assert(fields[5] === 'false', 'Runtime container is privileged.');
  assert(fields[6] === '500000000', 'Runtime CPU limit did not match the configured policy.');
  assert(fields[7] === String(256 * 1024 * 1024), 'Runtime memory limit did not match the configured policy.');
  assert(fields[8] === String(256 * 1024 * 1024), 'Runtime swap limit did not match the configured policy.');
  assert(fields[9] === '64', 'Runtime PID limit did not match the configured policy.');
  const bindings = JSON.parse(fields[10] ?? 'null') as unknown;
  const portBindings = bindings as Record<string, { HostIp: string }[]>;
  assert(portBindings['3000/tcp']?.length === 1 && portBindings['3000/tcp'][0]?.HostIp === '127.0.0.1', 'Runtime port is not bound only to loopback.');
}

async function main(): Promise<void> {
  const image = requiredOptIn();
  assertLocalImagePresent(image);
  const socketPath = dockerSocketPath();
  const nonce = randomUUID().replaceAll('-', '').slice(0, 10);
  const internalNetwork = `hasi-plugin-qual-${nonce}`;
  const externalNetwork = `hasi-plugin-deny-${nonce}`;
  const ownerId = `local-qualifier-${nonce}`;
  const installationId = `docker-qualification-${nonce}`;
  const operationId = `stage-${randomUUID()}`;
  const baselineContainers = new Set(runDocker(['container', 'ls', '--all', '--quiet']).split('\n').filter(Boolean));
  const release = qualifyRelease(image);
  const port = await ephemeralLoopbackPort();
  let activeDeploymentId: string | null = null;
  const routeOperations = new Map<string, 'committed' | 'not-committed' | 'pending' | 'unknown'>();
  let createdInternalNetwork = false;
  let createdExternalNetwork = false;
  let stagedDeploymentId: string | null = null;
  const routing: DockerPluginRoutingController = {
    activate: input => {
      routeOperations.set(input.operationId, 'pending');
      try {
        assert(activeDeploymentId === input.previousDeploymentId, 'Local route base changed before activation.');
        activeDeploymentId = input.candidateDeploymentId;
        routeOperations.set(input.operationId, 'committed');
      } catch (error) {
        routeOperations.set(input.operationId, 'not-committed');
        throw error;
      }
      return Promise.resolve();
    },
    rollback: input => {
      routeOperations.set(input.operationId, 'pending');
      try {
        assert(activeDeploymentId === input.currentDeploymentId, 'Local route base changed before rollback.');
        activeDeploymentId = input.previousDeploymentId;
        routeOperations.set(input.operationId, 'committed');
      } catch (error) {
        routeOperations.set(input.operationId, 'not-committed');
        throw error;
      }
      return Promise.resolve();
    },
    readActiveDeploymentId: () => Promise.resolve(activeDeploymentId),
    readOperationStatus: input => Promise.resolve(routeOperations.get(input.operationId) ?? 'unknown'),
  };
  const options: DockerPluginDriverOptions = {
    enabled: true,
    deploymentTarget: 'operator-local',
    socketPath,
    ownerId,
    allowedInternalNetworks: [internalNetwork, externalNetwork],
    routing,
    resolveSecret: () => undefined,
    healthPath: '/healthz',
    requestTimeoutMs: 5_000,
  };
  const driver = createDockerPluginDriver(options);
  const baseInput = {
    installationId,
    operationId,
    baseCurrentDigest: null,
    configurationRevision: 'local-qualification-config-v1',
    release,
    policy: pluginPolicy(release, internalNetwork, port),
    secretAssignments: [],
  } as const;

  let operationError: unknown;
  let operationFailed = false;
  let cleanupError: Error | undefined;
  try {
    runDocker(['network', 'create', '--internal', internalNetwork]);
    createdInternalNetwork = true;
    runDocker(['network', 'create', externalNetwork]);
    createdExternalNetwork = true;

    const policy = baseInput.policy;
    const denials: readonly [string, PluginContainerLaunchPolicy][] = [
      ['read-only root filesystem', { ...policy, readOnlyRootFilesystem: false } as unknown as PluginContainerLaunchPolicy],
      ['non-root UID/GID', { ...policy, user: { uid: 0, gid: 0 } } as unknown as PluginContainerLaunchPolicy],
      ['capability drop', { ...policy, capDrop: [] } as unknown as PluginContainerLaunchPolicy],
      ['resource limits', { ...policy, memoryBytes: 0 }],
    ];
    for (const [description, deniedPolicy] of denials) {
      await expectKnownFailure(() => driver.stage({ ...baseInput, policy: deniedPolicy }), description);
    }
    await expectKnownFailure(
      () => driver.stage({ ...baseInput, policy: pluginPolicy(release, externalNetwork, port) }),
      'non-internal Docker network',
    );

    const afterDenials = new Set(runDocker(['container', 'ls', '--all', '--quiet']).split('\n').filter(Boolean));
    assert([...afterDenials].every(id => baselineContainers.has(id)), 'A denial probe created a Docker container.');
    assert([...baselineContainers].every(id => afterDenials.has(id)), 'A denial probe removed an existing Docker container.');

    const staged = await driver.stage(baseInput);
    stagedDeploymentId = staged.deploymentId;
    containerSecuritySnapshot(staged.deploymentId);
    const observed = await driver.reconcile({ installationId, operationId });
    assert(observed.activeDeploymentId === null && observed.stagedDeploymentId === staged.deploymentId, 'Docker reconciliation did not find the exact staged container.');

    const healthy = await driver.check({ installationId, deploymentId: staged.deploymentId, releaseDigest: release.releaseDigest });
    console.log(`Local Docker driver qualification passed for ${image}. Denial probes created no containers; the admitted Node image was staged, inspected and reconciled (health=${String(healthy)}).`);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    try {
      const observation = await driver.reconcile({ installationId, operationId });
      const targetId = stagedDeploymentId ?? observation.stagedDeploymentId;
      if (targetId) await driver.discard({ installationId, operationId, deploymentId: targetId });
    } catch {
      // If the write response was lost, reconciliation above is the only safe path to cleanup.
      console.error('The exact qualification container could not be safely reconciled or removed.');
      cleanupError = new Error('The exact qualification container could not be safely reconciled or removed.');
    }
    if (createdExternalNetwork) {
      try { runDocker(['network', 'rm', externalNetwork]); } catch {
        console.error('The qualification deny network requires manual cleanup.');
        cleanupError ??= new Error('The qualification deny network requires manual cleanup.');
      }
    }
    if (createdInternalNetwork) {
      try { runDocker(['network', 'rm', internalNetwork]); } catch {
        console.error('The qualification internal network requires manual cleanup.');
        cleanupError ??= new Error('The qualification internal network requires manual cleanup.');
      }
    }
    try {
      const remainingContainers = new Set(runDocker(['container', 'ls', '--all', '--quiet']).split('\n').filter(Boolean));
      if ([...baselineContainers].some(id => !remainingContainers.has(id))) {
        cleanupError ??= new Error('A pre-existing Docker container disappeared during qualification.');
      }
      if (stagedDeploymentId && remainingContainers.has(stagedDeploymentId)) {
        cleanupError ??= new Error('The exact qualification container remains after cleanup.');
      }
    } catch {
      cleanupError ??= new Error('Docker cleanup verification failed.');
    }
  }
  if (operationFailed) throw operationError;
  if (cleanupError) throw cleanupError;
}

await main();
