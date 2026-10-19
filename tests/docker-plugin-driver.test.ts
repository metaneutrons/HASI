import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
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
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import { DOCKER_PLUGIN_MANAGED_VALUE, PLUGIN_RELAY_IMAGE } from '../apps/api/src/docker-plugin-relay.js';

const IMAGE_DIGEST = 'a'.repeat(64);
const MANIFEST_DIGEST = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const RELAY_ID = 'd'.repeat(64);
const BASE_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=24.21.0'];
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

interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly body: Record<string, unknown>;
  running: boolean;
}

class FakeDockerEngine implements DockerEngineTransport {
  readonly requests: DockerEngineRequest[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly removedIds: string[] = [];
  imageRepoDigests: string[] = [unsignedRelease().image];
  relayImageRepoDigests: string[] = [PLUGIN_RELAY_IMAGE];
  imageVolumes: unknown = null;
  daemonSecurityOptions: string[] = ['name=seccomp,profile=builtin'];
  networkInternal = true;
  networkIsolated = true;
  inspectedLabels: Record<string, string> | undefined;
  running = true;
  privileged = false;
  securityOptions: string[] | undefined;
  missingContainer = false;
  missingRelay = false;
  createFailure: 'transport' | 'server' | undefined;
  loseCreateReplyFor: 'candidate' | 'relay' | undefined;
  loseStartReplyFor: 'candidate' | 'relay' | undefined;
  mutateRelay: ((inspection: Record<string, unknown>) => void) | undefined;
  mutateCandidate: ((inspection: Record<string, unknown>) => void) | undefined;
  createdBody: Record<string, unknown> | undefined;
  createdRelayBody: Record<string, unknown> | undefined;
  stopCount = 0;
  deleteCount = 0;

  private absent(container: FakeContainer): boolean {
    return record(container.body.Labels)['hasi.role'] === 'candidate' ? this.missingContainer : this.missingRelay;
  }

  private inspection(container: FakeContainer): Record<string, unknown> {
    const relay = record(container.body.Labels)['hasi.role'] === 'relay';
    const created = container.body;
    const hostConfig = record(created.HostConfig);
    const active = container.running && (relay || this.running);
    const configuredNetworks = created.NetworkingConfig ? Object.keys(record(record(created.NetworkingConfig).EndpointsConfig)) : [String(hostConfig.NetworkMode)];
    const networks = Object.fromEntries(configuredNetworks.map(name => [name, {
      IPAddress: active ? (name === 'hasi-relay-net' ? '172.29.0.2' : relay ? '172.28.0.3' : '172.28.0.2') : '',
      GlobalIPv6Address: '',
    }]));
    const exposed = record(created.ExposedPorts ?? {});
    const bindings = record(hostConfig.PortBindings ?? {});
    const inspected: Record<string, unknown> = {
      Id: container.id,
      Name: `/${container.name}`,
      Config: {
        Image: created.Image,
        User: created.User,
        WorkingDir: created.WorkingDir ?? '',
        Entrypoint: created.Entrypoint,
        Cmd: created.Cmd,
        Env: [...BASE_ENV, ...(created.Env as string[])],
        Labels: !relay && this.inspectedLabels ? this.inspectedLabels : created.Labels,
        ExposedPorts: created.ExposedPorts,
        Volumes: null,
      },
      HostConfig: {
        ...hostConfig,
        Privileged: relay ? false : this.privileged,
        ...(!relay && this.securityOptions ? { SecurityOpt: this.securityOptions } : {}),
      },
      NetworkSettings: {
        Networks: networks,
        Ports: Object.fromEntries(Object.keys(exposed).map(key => [key, active && bindings[key] ? bindings[key] : null])),
      },
      State: { Running: active },
      Mounts: [],
    };
    if (relay) this.mutateRelay?.(inspected);
    else this.mutateCandidate?.(inspected);
    return inspected;
  }

  request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    this.requests.push(input);
    const url = new URL(input.path, 'http://docker.invalid');
    const path = url.pathname;
    if (path.startsWith('/images/')) {
      const image = decodeURIComponent(path.slice('/images/'.length, -'/json'.length));
      const relay = image === PLUGIN_RELAY_IMAGE;
      return Promise.resolve(response(200, { RepoDigests: relay ? this.relayImageRepoDigests : this.imageRepoDigests, Config: { Volumes: relay ? null : this.imageVolumes, Env: BASE_ENV } }));
    }
    if (path.startsWith('/networks/')) {
      const name = decodeURIComponent(path.slice('/networks/'.length));
      const relay = name === 'hasi-relay-net';
      const members = [...this.containers.values()].filter(item => !this.absent(item) && item.running && Object.hasOwn(record(this.inspection(item).NetworkSettings).Networks as object, name));
      return Promise.resolve(response(200, {
        Name: name, Driver: 'bridge', Internal: relay ? false : this.networkInternal, EnableIPv6: false,
        Labels: { 'hasi.owner': 'operator-1', 'hasi.managed-by': DOCKER_PLUGIN_MANAGED_VALUE },
        Options: !relay && this.networkIsolated ? { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } : {},
        Containers: Object.fromEntries(members.map(item => [item.id, {}])),
      }));
    }
    if (path === '/info') return Promise.resolve(response(200, { SecurityOptions: this.daemonSecurityOptions }));
    if (input.method === 'POST' && path === '/containers/create') {
      const body = record(input.body);
      const role = String(record(body.Labels)['hasi.role']);
      if (role === 'candidate' && this.createFailure === 'transport') return Promise.reject(new Error('private docker socket error'));
      if (role === 'candidate' && this.createFailure === 'server') return Promise.resolve(response(500, { message: 'private daemon failure' }));
      const name = url.searchParams.get('name');
      if (!name) throw new Error('Expected a named container.');
      const first = role === 'candidate' ? !this.createdBody : !this.createdRelayBody;
      const id = first ? (role === 'candidate' ? CONTAINER_ID : RELAY_ID) : createHash('sha256').update(name).digest('hex');
      this.containers.set(id, { id, name, body, running: false });
      if (role === 'candidate') this.createdBody = body;
      else this.createdRelayBody = body;
      if (this.loseCreateReplyFor === role) return Promise.reject(new Error('private reply lost after creation'));
      return Promise.resolve(response(201, { Id: id }));
    }
    if (input.method === 'GET' && path === '/containers/json') {
      const filters: unknown = JSON.parse(url.searchParams.get('filters') ?? '{}');
      const wanted = record(filters).label as string[] | undefined;
      const rows = [...this.containers.values()].filter(item => !this.absent(item)).map(item => ({
        Id: item.id,
        Labels: !this.inspectedLabels || record(item.body.Labels)['hasi.role'] === 'relay' ? item.body.Labels : this.inspectedLabels,
        State: item.running ? 'running' : 'exited',
      }));
      return Promise.resolve(response(200, rows.filter(item => (wanted ?? []).every(filter => {
        const position = filter.indexOf('=');
        return record(item.Labels)[filter.slice(0, position)] === filter.slice(position + 1);
      }))));
    }
    const match = /^\/containers\/([^/]+)(?:\/(json|start|stop))?$/u.exec(path);
    if (match) {
      const key = decodeURIComponent(match[1]!);
      const container = this.containers.get(key) ?? [...this.containers.values()].find(item => item.name === key);
      if (!container || this.absent(container)) return Promise.resolve(response(404));
      if (input.method === 'GET' && match[2] === 'json') return Promise.resolve(response(200, this.inspection(container)));
      if (input.method === 'POST' && match[2] === 'start') {
        container.running = true;
        if (this.loseStartReplyFor === record(container.body.Labels)['hasi.role']) return Promise.reject(new Error('private reply lost after start'));
        return Promise.resolve(response(204));
      }
      if (input.method === 'POST' && match[2] === 'stop') {
        container.running = false;
        this.stopCount += 1;
        return Promise.resolve(response(204));
      }
      if (input.method === 'DELETE' && !match[2]) {
        this.containers.delete(container.id);
        this.removedIds.push(container.id);
        this.deleteCount += 1;
        return Promise.resolve(response(204));
      }
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
    relayNetwork: 'hasi-relay-net',
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
    });
    expect(hostConfig.PortBindings ?? {}).toEqual({});
    const relayBody = record(engine.createdRelayBody);
    expect(relayBody.Image).toBe(PLUGIN_RELAY_IMAGE);
    expect(relayBody.Env).toEqual([
      'HASI_RELAY_TARGET_ADDRESS=172.28.0.2', 'HASI_RELAY_TARGET_PORT=3000', 'HASI_RELAY_LISTEN_PORT=8080',
    ]);
    expect(JSON.stringify(relayBody)).not.toContain('only-in-engine-request');
    expect(record(relayBody.HostConfig).PortBindings).toEqual({ '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43121' }] });
    expect(Object.keys(record(record(relayBody.NetworkingConfig).EndpointsConfig)).sort()).toEqual(['hasi-plugin-net', 'hasi-relay-net']);
    const labels = record(body.Labels);
    expect(labels).toMatchObject({
      'hasi.managed-by': DOCKER_PLUGIN_MANAGED_VALUE,
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

  it('resolves only the current digest-pinned managed container and fences a moved route', async () => {
    const engine = new FakeDockerEngine();
    let active = { deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest };
    const route = routingController({ readActiveRoute: () => Promise.resolve(active) });
    const driver = createDockerPluginDriver(driverOptions(engine, route.routing));
    await driver.stage(stageInput());

    const endpoint = await driver.resolveActiveEndpoint({ installationId: 'installation-1' });
    expect(endpoint).toEqual({
      deploymentId: CONTAINER_ID,
      relayDeploymentId: RELAY_ID,
      releaseDigest: release().releaseDigest,
      host: '127.0.0.1',
      port: 43121,
      containerPort: 3000,
    });
    await expect(driver.assertActiveEndpoint({ installationId: 'installation-1', endpoint: endpoint! })).resolves.toBe(true);

    active = { ...active, releaseDigest: 'f'.repeat(64) };
    await expect(driver.assertActiveEndpoint({ installationId: 'installation-1', endpoint: endpoint! })).resolves.toBe(false);
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

  it('activates through the shared CAS route controller and reconciles from a second controller instance', async () => {
    const store = new MemoryJsonStore(`docker-route-integration-${String(Math.random())}`);
    const routeOptions = { store, scope: 'operator-scope', ownerId: 'operator-1' } as const;
    const writer = new PluginRouteController(routeOptions);
    const observer = new PluginRouteController(routeOptions);
    await writer.initializeInstallation({ installationId: 'installation-1', configurationRevision: 'config-revision-1' });
    const engine = new FakeDockerEngine();
    const driver = createDockerPluginDriver(driverOptions(engine, writer));
    const staged = await driver.stage(stageInput());

    await driver.activate({
      installationId: 'installation-1',
      operationId: 'activation-route-integration',
      candidateDeploymentId: staged.deploymentId,
      previousDeploymentId: null,
      baseCurrentDigest: null,
      configurationRevision: 'config-revision-1',
    });

    expect(await observer.readActiveDeploymentId({ ownerId: 'operator-1', installationId: 'installation-1' })).toBe(staged.deploymentId);
    expect(await observer.readOperationStatus({ ownerId: 'operator-1', installationId: 'installation-1', operationId: 'activation-route-integration' })).toBe('committed');
    const observation = await driver.reconcile({ installationId: 'installation-1', operationId: 'activation-route-integration' });
    expect(observation).toEqual({ activeDeploymentId: staged.deploymentId, stagedDeploymentId: null, routeOperationOutcome: 'committed' });
  });

  it('removes the inactive relay before its candidate and repeats cleanup safely', async () => {
    const engine = new FakeDockerEngine();
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await driver.stage(stageInput());
    const input = { installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID };
    await driver.discard(input);
    expect(engine.removedIds).toEqual([RELAY_ID, CONTAINER_ID]);
    await driver.discard(input);
    expect(engine.removedIds).toEqual([RELAY_ID, CONTAINER_ID]);
    expect(engine.containers.size).toBe(0);
  });

  it('identifies a candidate after loss of the create reply without creating it again', async () => {
    const engine = new FakeDockerEngine();
    engine.loseCreateReplyFor = 'candidate';
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await expect(driver.stage(stageInput())).rejects.toMatchObject({ outcome: 'unknown' });
    const before = engine.requests.length;
    await expect(driver.reconcile({ installationId: 'installation-1', operationId: 'stage-operation-1' })).resolves.toMatchObject({ stagedDeploymentId: CONTAINER_ID });
    expect(engine.requests.slice(before).every(item => item.method === 'GET')).toBe(true);
    await expect(driver.check({ installationId: 'installation-1', deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest })).resolves.toBe(false);
    await driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID });
    expect(engine.removedIds).toEqual([CONTAINER_ID]);
  });

  it.each(['create', 'start'] as const)('reconciles a lost relay %s reply and cleans exactly that pair', async phase => {
    const engine = new FakeDockerEngine();
    if (phase === 'create') engine.loseCreateReplyFor = 'relay';
    else engine.loseStartReplyFor = 'relay';
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await expect(driver.stage(stageInput())).rejects.toMatchObject({ outcome: 'unknown' });
    const before = engine.requests.length;
    await expect(driver.reconcile({ installationId: 'installation-1', operationId: 'stage-operation-1' })).resolves.toMatchObject({ stagedDeploymentId: CONTAINER_ID });
    expect(engine.requests.slice(before).every(item => item.method === 'GET')).toBe(true);
    await expect(driver.check({ installationId: 'installation-1', deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest })).resolves.toBe(phase === 'start');
    expect(engine.requests.filter(item => item.method === 'POST' && item.path.startsWith('/containers/create?'))).toHaveLength(2);
    await driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID });
    expect(engine.removedIds).toEqual([RELAY_ID, CONTAINER_ID]);
  });

  it('treats an absent relay as incomplete and never probes the requested host port', async () => {
    const engine = new FakeDockerEngine();
    const loopbackProbe = vi.fn(() => Promise.resolve(true));
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing, { loopbackProbe }));
    await driver.stage(stageInput());
    engine.missingRelay = true;
    await expect(driver.check({ installationId: 'installation-1', deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest })).resolves.toBe(false);
    expect(loopbackProbe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing effective mapping', (body: Record<string, unknown>) => { record(body.NetworkSettings).Ports = { '8080/tcp': null }; }],
    ['non-loopback effective mapping', (body: Record<string, unknown>) => { record(body.NetworkSettings).Ports = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '43121' }] }; }],
    ['changed entrypoint', (body: Record<string, unknown>) => { record(body.Config).Entrypoint = ['node', '-e', 'process.exit(0)']; }],
    ['foreign candidate', (body: Record<string, unknown>) => { record(record(body.Config).Labels)['hasi.candidate'] = 'e'.repeat(64); }],
    ['extra credential', (body: Record<string, unknown>) => { (record(body.Config).Env as string[]).push('HASI_SECRET_EXTRA=private-relay-fixture'); }],
    ['host PID namespace', (body: Record<string, unknown>) => { record(body.HostConfig).PidMode = 'host'; }],
    ['extra network', (body: Record<string, unknown>) => { record(record(body.NetworkSettings).Networks).foreign = { IPAddress: '172.30.0.2' }; }],
  ] as const)('rejects a relay with %s before host traffic or cleanup', async (_label, mutate) => {
    const engine = new FakeDockerEngine();
    const loopbackProbe = vi.fn(() => Promise.resolve(true));
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing, { loopbackProbe }));
    await driver.stage(stageInput());
    engine.mutateRelay = mutate;
    const failure = await driver.check({ installationId: 'installation-1', deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DockerPluginDriverError);
    expect(String(failure)).not.toContain('private-relay-fixture');
    expect(loopbackProbe).not.toHaveBeenCalled();
    await expect(driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).rejects.toBeInstanceOf(DockerPluginDriverError);
    expect(engine.removedIds).toEqual([]);
  });

  it('rejects an extra candidate network before checking the relay', async () => {
    const engine = new FakeDockerEngine();
    const loopbackProbe = vi.fn(() => Promise.resolve(true));
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing, { loopbackProbe }));
    await driver.stage(stageInput());
    engine.mutateCandidate = body => { record(record(body.NetworkSettings).Networks).foreign = { IPAddress: '172.30.0.2' }; };
    await expect(driver.check({ installationId: 'installation-1', deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(loopbackProbe).not.toHaveBeenCalled();
  });

  it('pins the relay identity as well as the candidate across endpoint reuse', async () => {
    const engine = new FakeDockerEngine();
    const route = routingController({ readActiveRoute: () => Promise.resolve({ deploymentId: CONTAINER_ID, releaseDigest: release().releaseDigest }) });
    const driver = createDockerPluginDriver(driverOptions(engine, route.routing));
    await driver.stage(stageInput());
    const endpoint = await driver.resolveActiveEndpoint({ installationId: 'installation-1' });
    expect(endpoint?.relayDeploymentId).toBe(RELAY_ID);
    const priorRelay = engine.containers.get(RELAY_ID)!;
    engine.containers.delete(RELAY_ID);
    const replacementId = 'e'.repeat(64);
    engine.containers.set(replacementId, { ...priorRelay, id: replacementId });
    await expect(driver.assertActiveEndpoint({ installationId: 'installation-1', endpoint: endpoint! })).resolves.toBe(false);
  });

  it('retains an orphan relay as unknown instead of guessing deletion authority', async () => {
    const engine = new FakeDockerEngine();
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await driver.stage(stageInput());
    engine.missingContainer = true;
    await expect(driver.reconcile({ installationId: 'installation-1', operationId: 'stage-operation-1' })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(engine.removedIds).toEqual([]);
  });

  it('rejects reuse of an occupied generation network before any new creation', async () => {
    const engine = new FakeDockerEngine();
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await driver.stage(stageInput());
    const before = engine.requests.filter(item => item.method === 'POST').length;
    await expect(driver.stage({ ...stageInput(), operationId: 'stage-next-generation' })).rejects.toMatchObject({ outcome: 'failed' });
    expect(engine.requests.filter(item => item.method === 'POST')).toHaveLength(before);
  });


  it.each(['hasi.owner', 'hasi.installation', 'hasi.managed-by', 'hasi.operation'])('keeps a same-name orphan with changed %s unresolved despite list filtering', async label => {
    const engine = new FakeDockerEngine();
    const driver = createDockerPluginDriver(driverOptions(engine, routingController().routing));
    await driver.stage(stageInput());
    engine.missingContainer = true;
    record(engine.createdRelayBody!.Labels)[label] = 'foreign-reserved-name';
    await expect(driver.discard({ installationId: 'installation-1', operationId: 'stage-operation-1', deploymentId: CONTAINER_ID })).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(driver.reconcile({ installationId: 'installation-1', operationId: 'stage-operation-1' })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(engine.removedIds).toEqual([]);
    expect(engine.containers.has(RELAY_ID)).toBe(true);
  });

});
