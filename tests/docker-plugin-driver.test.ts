import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPluginContainerLaunchPolicy,
  DeploymentDriverError,
  pluginReleaseSigningBytes,
  verifyPluginRelease,
  type PluginReleaseEnvelope,
  type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import {
  createDockerPluginDriver,
  DockerPluginDriverError,
  type DockerEngineRequest,
  type DockerEngineResponse,
  type DockerEngineTransport,
  type DockerPluginRoutingController,
} from '../apps/api/src/docker-plugin-driver.js';

const IMAGE_DIGEST = 'a'.repeat(64);
const MANIFEST_DIGEST = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const keys = generateKeyPairSync('ed25519');
const approval: PublisherApproval = {
  publisherId: 'hasi-publisher',
  publicKey: keys.publicKey,
  sourceRegistryPrefix: 'registry.example.test/hasi',
  allowedPluginIds: ['weather'],
};

function unsignedRelease(overrides: Partial<UnsignedPluginRelease> = {}): UnsignedPluginRelease {
  return {
    schemaVersion: 1,
    pluginId: 'weather',
    version: '1.2.3',
    manifestDigest: MANIFEST_DIGEST,
    image: `registry.example.test/hasi/weather@sha256:${IMAGE_DIGEST}`,
    publisherId: approval.publisherId,
    configSchemaVersion: 1,
    stateMigration: 'none',
    ...overrides,
  };
}

function envelope(overrides: Partial<UnsignedPluginRelease> = {}): PluginReleaseEnvelope {
  const unsigned = unsignedRelease(overrides);
  const signature = sign(null, pluginReleaseSigningBytes(unsigned), keys.privateKey).toString('base64url');
  return { ...unsigned, signature };
}

function release() {
  return verifyPluginRelease(envelope(), publisher => publisher === approval.publisherId ? approval : undefined);
}

function launch() {
  return buildPluginContainerLaunchPolicy(release(), {
    network: { mode: 'internal', name: 'hasi-plugin-net' },
    hostPort: 43121,
    containerPort: 3000,
    startupTimeoutMs: 500,
    shutdownTimeoutMs: 1_000,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

function response(statusCode: number, body: unknown = null): DockerEngineResponse {
  return { statusCode, body };
}

class FakeDockerEngine implements DockerEngineTransport {
  readonly requests: DockerEngineRequest[] = [];
  imageRepoDigests: string[] = [unsignedRelease().image];
  imageVolumes: unknown = null;
  daemonSecurityOptions: string[] = ['name=seccomp,profile=builtin'];
  networkInternal = true;
  inspectedLabels: Record<string, string> | undefined;
  running = true;
  privileged = false;
  securityOptions: string[] | undefined;
  missingContainer = false;
  createFailure: 'transport' | 'server' | undefined;
  createdBody: Record<string, unknown> | undefined;
  stopCount = 0;
  deleteCount = 0;

  request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    this.requests.push(input);
    if (input.path.startsWith('/images/')) {
      return Promise.resolve(response(200, { RepoDigests: this.imageRepoDigests, Config: { Volumes: this.imageVolumes } }));
    }
    if (input.path.startsWith('/networks/')) {
      return Promise.resolve(response(200, { Name: 'hasi-plugin-net', Internal: this.networkInternal, Containers: {} }));
    }
    if (input.path === '/info') return Promise.resolve(response(200, { SecurityOptions: this.daemonSecurityOptions }));
    if (input.method === 'POST' && input.path.startsWith('/containers/create?')) {
      if (this.createFailure === 'transport') return Promise.reject(new Error('private docker socket error'));
      if (this.createFailure === 'server') return Promise.resolve(response(500, { message: 'private daemon failure' }));
      this.createdBody = record(input.body);
      return Promise.resolve(response(201, { Id: CONTAINER_ID }));
    }
    if (input.method === 'POST' && input.path === `/containers/${CONTAINER_ID}/start`) return Promise.resolve(response(204));
    if (input.method === 'GET' && input.path === `/containers/${CONTAINER_ID}/json`) {
      if (this.missingContainer) return Promise.resolve(response(404));
      const created = this.createdBody;
      if (!created) return Promise.resolve(response(404));
      const hostConfig = record(created.HostConfig);
      const config = {
        Image: created.Image,
        User: created.User,
        Labels: this.inspectedLabels ?? created.Labels,
        ExposedPorts: created.ExposedPorts,
        Volumes: null,
      };
      return Promise.resolve(response(200, {
        Config: config,
        HostConfig: {
          ...hostConfig,
          Privileged: this.privileged,
          ...(this.securityOptions ? { SecurityOpt: this.securityOptions } : {}),
        },
        State: { Running: this.running },
        Mounts: [],
      }));
    }
    if (input.method === 'POST' && input.path.startsWith(`/containers/${CONTAINER_ID}/stop`)) {
      this.stopCount += 1;
      return Promise.resolve(response(204));
    }
    if (input.method === 'DELETE' && input.path.startsWith(`/containers/${CONTAINER_ID}?`)) {
      this.deleteCount += 1;
      return Promise.resolve(response(204));
    }
    if (input.method === 'GET' && input.path.startsWith('/containers/json?')) {
      if (!this.createdBody) return Promise.resolve(response(200, []));
      const labels = this.inspectedLabels ?? record(this.createdBody.Labels) as Record<string, string>;
      return Promise.resolve(response(200, [{ Id: CONTAINER_ID, Labels: labels, State: this.running ? 'running' : 'exited' }]));
    }
    throw new Error(`Unexpected Docker Engine request: ${input.method} ${input.path}`);
  }
}

function routingController(overrides: Partial<DockerPluginRoutingController> = {}) {
  const calls: { readonly method: string; readonly input: unknown }[] = [];
  const statuses = new Map<string, 'committed' | 'not-committed' | 'pending' | 'unknown'>();
  const routing: DockerPluginRoutingController = {
    activate: input => {
      calls.push({ method: 'activate', input });
      statuses.set(input.operationId, 'pending');
      statuses.set(input.operationId, 'committed');
      return Promise.resolve();
    },
    rollback: input => {
      calls.push({ method: 'rollback', input });
      statuses.set(input.operationId, 'pending');
      statuses.set(input.operationId, 'committed');
      return Promise.resolve();
    },
    readActiveDeploymentId: () => Promise.resolve(null),
    readOperationStatus: input => Promise.resolve(statuses.get(input.operationId) ?? 'unknown'),
    ...overrides,
  };
  return { routing, calls };
}

function driverOptions(engine: FakeDockerEngine, routing: DockerPluginRoutingController, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    deploymentTarget: 'operator-local',
    socketPath: '/var/run/docker.sock',
    ownerId: 'operator-1',
    allowedInternalNetworks: ['hasi-plugin-net'],
    routing,
    resolveSecret: () => 'only-in-engine-request',
    transport: engine,
    loopbackProbe: (input: { host: string; port: number; path: string; timeoutMs: number }) => Promise.resolve(input.host === '127.0.0.1' && input.port === 43121 && input.path === '/healthz' && input.timeoutMs > 0),
    ...overrides,
  } as Parameters<typeof createDockerPluginDriver>[0];
}

function stageInput() {
  return {
    installationId: 'installation-1',
    operationId: 'stage-operation-1',
    baseCurrentDigest: null,
    configurationRevision: 'config-revision-1',
    release: release(),
    policy: launch(),
    secretAssignments: [{ name: 'WEATHER_KEY', secretRef: 'secret-weather-key' }],
  } as const;
}

describe('operator-local Docker plugin driver', () => {
  it('requires explicit local enablement and never activates in production targets', () => {
    const engine = new FakeDockerEngine();
    const { routing } = routingController();
    expect(() => createDockerPluginDriver(driverOptions(engine, routing, { enabled: false }))).toThrow(TypeError);
    expect(() => createDockerPluginDriver(driverOptions(engine, routing, { deploymentTarget: 'vercel-demo' }))).toThrow(TypeError);
    vi.stubEnv('VERCEL', '1');
    expect(() => createDockerPluginDriver(driverOptions(engine, routing))).toThrow(TypeError);
    vi.unstubAllEnvs();
    vi.stubEnv('HASI_DEMO_MODE', '1');
    expect(() => createDockerPluginDriver(driverOptions(engine, routing))).toThrow(TypeError);
    vi.unstubAllEnvs();
    expect(engine.requests).toEqual([]);
  });

  it('creates only a local digest-pinned image with restricted settings and keeps secrets out of its result', async () => {
    const engine = new FakeDockerEngine();
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing));
    const result = await driver.stage(stageInput());

    expect(result).toEqual({ deploymentId: CONTAINER_ID });
    expect(JSON.stringify(result)).not.toContain('only-in-engine-request');
    const create = engine.requests.find(request => request.method === 'POST' && request.path.startsWith('/containers/create?'));
    expect(create).toBeDefined();
    const body = record(create?.body);
    const hostConfig = record(body.HostConfig);
    expect(body.Image).toBe(unsignedRelease().image);
    expect(body.User).toBe('65532:65532');
    expect(body.Entrypoint).toBeUndefined();
    expect(body.Cmd).toBeUndefined();
    expect(body.Env).toEqual(['HASI_SECRET_WEATHER_KEY=only-in-engine-request']);
    expect(hostConfig).toMatchObject({
      NetworkMode: 'hasi-plugin-net',
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 64,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      Binds: [],
      Mounts: [],
      Devices: [],
      DeviceRequests: [],
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '43121' }] },
    });
    const labels = record(body.Labels);
    expect(labels).toMatchObject({
      'hasi.managed-by': 'hasi-docker-plugin-driver-v1',
      'hasi.owner': 'operator-1',
      'hasi.installation': 'installation-1',
      'hasi.plugin': 'weather',
      'hasi.release': release().releaseDigest,
      'hasi.operation': 'stage-operation-1',
      'hasi.role': 'candidate',
    });
    expect(engine.requests.some(request => request.path.includes('/images/create'))).toBe(false);
  });

  it('recognizes the Docker Hub canonical name reported for an official library image', async () => {
    const officialImage = `docker.io/library/node@sha256:${IMAGE_DIGEST}`;
    const unsigned = unsignedRelease({ image: officialImage });
    const signed = { ...unsigned, signature: sign(null, pluginReleaseSigningBytes(unsigned), keys.privateKey).toString('base64url') };
    const officialApproval: PublisherApproval = { ...approval, sourceRegistryPrefix: 'docker.io/library' };
    const verified = verifyPluginRelease(signed, publisher => publisher === officialApproval.publisherId ? officialApproval : undefined);
    const policy = buildPluginContainerLaunchPolicy(verified, {
      network: { mode: 'internal', name: 'hasi-plugin-net' },
      hostPort: 43121,
      containerPort: 3000,
      startupTimeoutMs: 500,
    });
    const engine = new FakeDockerEngine();
    engine.imageRepoDigests = [`node@sha256:${IMAGE_DIGEST}`];
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing));

    await expect(driver.stage({ ...stageInput(), release: verified, policy, secretAssignments: [] })).resolves.toEqual({ deploymentId: CONTAINER_ID });
    expect(record(engine.createdBody).Image).toBe(officialImage);
    expect(engine.requests.some(request => request.path.includes('/images/create'))).toBe(false);
  });

  it('refuses unavailable or unsafe local prerequisites before container creation', async () => {
    for (const configure of [
      (engine: FakeDockerEngine) => { engine.imageRepoDigests = []; },
      (engine: FakeDockerEngine) => { engine.networkInternal = false; },
      (engine: FakeDockerEngine) => { engine.imageVolumes = { '/var/lib/plugin': {} }; },
    ]) {
      const engine = new FakeDockerEngine();
      configure(engine);
      const { routing } = routingController();
      const driver = createDockerPluginDriver(driverOptions(engine, routing));
      await expect(driver.stage(stageInput())).rejects.toBeInstanceOf(DockerPluginDriverError);
      expect(engine.requests.some(request => request.method === 'POST' && request.path.startsWith('/containers/create?'))).toBe(false);
    }
  });

  it('requires an exact built-in daemon seccomp profile and rejects unconfined or unknown profiles', async () => {
    for (const daemonSecurityOptions of [
      ['name=seccomp,profile=unconfined'],
      ['name=seccomp,profile=custom'],
      ['name=seccomp'],
      ['name=seccomp,profile=builtin', 'name=seccomp,profile=unconfined'],
      ['name=apparmor'],
    ]) {
      const engine = new FakeDockerEngine();
      engine.daemonSecurityOptions = daemonSecurityOptions;
      const { routing } = routingController();
      const driver = createDockerPluginDriver(driverOptions(engine, routing));
      await expect(driver.stage(stageInput())).rejects.toMatchObject({ outcome: 'failed' });
      expect(engine.requests.some(request => request.method === 'POST' && request.path.startsWith('/containers/create?'))).toBe(false);
    }
  });

  it('bounds operator secret resolution before any container write', async () => {
    const engine = new FakeDockerEngine();
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing, {
      requestTimeoutMs: 100,
      resolveSecret: () => new Promise<string>(() => undefined),
    }));
    await expect(driver.stage(stageInput())).rejects.toMatchObject({ outcome: 'failed' });
    expect(engine.requests.some(request => request.method === 'POST' && request.path.startsWith('/containers/create?'))).toBe(false);
  });

  it('keeps uncertain create and routing outcomes unknown without exposing daemon errors', async () => {
    const engine = new FakeDockerEngine();
    engine.createFailure = 'transport';
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing));
    const error = await driver.stage(stageInput()).then(() => undefined, (reason: unknown) => reason);
    if (!(error instanceof DeploymentDriverError)) throw new Error('Expected an unknown Docker deployment result.');
    expect(error.outcome).toBe('unknown');
    expect(error.message).not.toContain('private docker socket error');

    const otherEngine = new FakeDockerEngine();
    const routeCalls: { readonly method: string; readonly input: unknown }[] = [];
    const route = routingController({ activate: input => {
      routeCalls.push({ method: 'activate', input });
      throw new Error('private route credentials');
    } });
    const otherDriver = createDockerPluginDriver(driverOptions(otherEngine, route.routing));
    const staged = await otherDriver.stage(stageInput());
    const activateError = await otherDriver.activate({
      installationId: 'installation-1',
      operationId: 'activate-operation-1',
      candidateDeploymentId: staged.deploymentId,
      previousDeploymentId: null,
      baseCurrentDigest: null,
      configurationRevision: 'config-revision-1',
    }).then(() => undefined, (reason: unknown) => reason);
    if (!(activateError instanceof DockerPluginDriverError)) throw new Error('Expected an unknown route outcome.');
    expect(activateError.outcome).toBe('unknown');
    expect(activateError.message).not.toContain('private route credentials');
    expect(routeCalls[0]).toMatchObject({
      method: 'activate',
      input: {
        baseCurrentDigest: null,
        configurationRevision: 'config-revision-1',
        candidateDeploymentId: CONTAINER_ID,
        candidateReleaseDigest: release().releaseDigest,
      },
    });

    const timedEngine = new FakeDockerEngine();
    const timedRoute = routingController({ activate: () => new Promise<void>(() => undefined) });
    const timedDriver = createDockerPluginDriver(driverOptions(timedEngine, timedRoute.routing, { requestTimeoutMs: 100 }));
    const timedStage = await timedDriver.stage(stageInput());
    const timedResult = await timedDriver.activate({
      installationId: 'installation-1',
      operationId: 'activate-operation-2',
      candidateDeploymentId: timedStage.deploymentId,
      previousDeploymentId: null,
      baseCurrentDigest: null,
      configurationRevision: 'config-revision-1',
    }).then(() => undefined, (reason: unknown) => reason);
    expect(timedResult).toBeInstanceOf(DockerPluginDriverError);
    if (timedResult instanceof DockerPluginDriverError) expect(timedResult.outcome).toBe('unknown');
  });

  it('keeps a timed-out route unknown until its durable operation record is terminal', async () => {
    const engine = new FakeDockerEngine();
    let finishRoute!: () => void;
    let activeDeploymentId: string | null = null;
    let routeOperationOutcome: 'committed' | 'not-committed' | 'pending' | 'unknown' = 'unknown';
    const route = routingController({
      activate: input => {
        routeOperationOutcome = 'pending';
        return new Promise<void>(resolve => {
          finishRoute = () => {
            activeDeploymentId = input.candidateDeploymentId;
            routeOperationOutcome = 'committed';
            resolve();
          };
        });
      },
      readActiveDeploymentId: () => Promise.resolve(activeDeploymentId),
      readOperationStatus: () => Promise.resolve(routeOperationOutcome),
    });
    const driver = createDockerPluginDriver(driverOptions(engine, route.routing, { requestTimeoutMs: 100 }));
    const staged = await driver.stage(stageInput());
    const result = await driver.activate({
      installationId: 'installation-1',
      operationId: 'activate-operation-delayed',
      candidateDeploymentId: staged.deploymentId,
      previousDeploymentId: null,
      baseCurrentDigest: null,
      configurationRevision: 'config-revision-1',
    }).then(() => undefined, (error: unknown) => error);
    expect(result).toMatchObject({ outcome: 'unknown' });

    const whilePending = await driver.reconcile({ installationId: 'installation-1', operationId: 'activate-operation-delayed' });
    expect(whilePending).toMatchObject({ activeDeploymentId: null, routeOperationOutcome: 'pending' });

    finishRoute();
    await new Promise<void>(resolve => setImmediate(resolve));
    const afterCommit = await driver.reconcile({ installationId: 'installation-1', operationId: 'activate-operation-delayed' });
    expect(afterCommit).toMatchObject({ activeDeploymentId: staged.deploymentId, routeOperationOutcome: 'committed' });
  });

  it('refuses to discard containers with foreign labels or an active route', async () => {
    const foreignEngine = new FakeDockerEngine();
    const { routing } = routingController();
    const foreignDriver = createDockerPluginDriver(driverOptions(foreignEngine, routing));
    await foreignDriver.stage(stageInput());
    foreignEngine.inspectedLabels = { 'hasi.managed-by': 'other', 'hasi.owner': 'someone-else', 'hasi.installation': 'installation-1' };
    await expect(foreignDriver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).rejects.toBeInstanceOf(DockerPluginDriverError);
    expect(foreignEngine.stopCount).toBe(0);
    expect(foreignEngine.deleteCount).toBe(0);

    const activeEngine = new FakeDockerEngine();
    const activeRoute = routingController({ readActiveDeploymentId: () => Promise.resolve(CONTAINER_ID) });
    const activeDriver = createDockerPluginDriver(driverOptions(activeEngine, activeRoute.routing));
    await activeDriver.stage(stageInput());
    await expect(activeDriver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).rejects.toBeInstanceOf(DockerPluginDriverError);
    expect(activeEngine.stopCount).toBe(0);
    expect(activeEngine.deleteCount).toBe(0);
  });

  it('treats an already missing owned container as an idempotent cleanup', async () => {
    const engine = new FakeDockerEngine();
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing));
    engine.missingContainer = true;
    await expect(driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).resolves.toBeUndefined();
    expect(engine.stopCount).toBe(0);
    expect(engine.deleteCount).toBe(0);
  });

  it('checks health only through the fixed loopback endpoint and rejects changed runtime hardening', async () => {
    const probeInputs: { host: string; port: number; path: string; timeoutMs: number }[] = [];
    const engine = new FakeDockerEngine();
    const { routing } = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, routing, {
      loopbackProbe: (input: { host: string; port: number; path: string; timeoutMs: number }) => {
        probeInputs.push(input);
        return Promise.resolve(true);
      },
    }));
    const staged = await driver.stage(stageInput());
    expect(await driver.check({ installationId: 'installation-1', deploymentId: staged.deploymentId, releaseDigest: release().releaseDigest })).toBe(true);
    expect(probeInputs[0]).toMatchObject({ host: '127.0.0.1', port: 43121, path: '/healthz' });

    engine.privileged = true;
    await expect(driver.check({ installationId: 'installation-1', deploymentId: staged.deploymentId, releaseDigest: release().releaseDigest })).rejects.toMatchObject({ outcome: 'unknown' });
    engine.privileged = false;
    engine.daemonSecurityOptions = ['name=seccomp,profile=unconfined'];
    await expect(driver.check({ installationId: 'installation-1', deploymentId: staged.deploymentId, releaseDigest: release().releaseDigest })).rejects.toMatchObject({ outcome: 'unknown' });
    engine.daemonSecurityOptions = ['name=seccomp,profile=builtin'];
    engine.securityOptions = ['no-new-privileges:true', 'seccomp=unconfined'];
    await expect(driver.check({ installationId: 'installation-1', deploymentId: staged.deploymentId, releaseDigest: release().releaseDigest })).rejects.toMatchObject({ outcome: 'unknown' });
  });

  it('reconciles from engine-owned labels and the routing authority without mutation', async () => {
    const engine = new FakeDockerEngine();
    const route = routingController();
    const driver = createDockerPluginDriver(driverOptions(engine, route.routing));
    const staged = await driver.stage(stageInput());
    const before = engine.requests.length;
    const observation = await driver.reconcile({ installationId: 'installation-1', operationId: 'stage-operation-1' });
    expect(observation).toEqual({ activeDeploymentId: null, stagedDeploymentId: staged.deploymentId, routeOperationOutcome: 'unknown' });
    expect(engine.requests.slice(before).every(request => request.method === 'GET')).toBe(true);
  });
});
