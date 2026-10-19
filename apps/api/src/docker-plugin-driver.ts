import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';
import { buildPluginContainerLaunchPolicy, DeploymentDriverError, type DeploymentDriver, type DeploymentObservation, type LogicalSecretAssignment, type PluginContainerLaunchPolicy, type VerifiedPluginRelease } from './plugin-artifacts.js';
import { DockerPluginDriverError } from './docker-plugin-errors.js';
import { createDockerPluginRelay, dockerPluginContainerName, DOCKER_PLUGIN_MANAGED_VALUE, isPrivatePluginIPv4, type RelayCandidate } from './docker-plugin-relay.js';

export { DockerPluginDriverError };

const ENGINE_API = '/v1.51';
const MAX_ENGINE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ENGINE_REQUEST_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_SECRET_VALUE_BYTES = 8 * 1024;
const MAX_NETWORK_MEMBERS = 256;
const MAX_RECONCILE_CONTAINERS = 512;
const DEFAULT_ENGINE_TIMEOUT_MS = 5_000;
const MAX_ENGINE_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_RESPONSE_BYTES = 4 * 1024;
const MANAGED_LABEL = 'hasi.managed-by';
const OWNER_LABEL = 'hasi.owner';
const INSTALLATION_LABEL = 'hasi.installation';
const PLUGIN_LABEL = 'hasi.plugin';
const RELEASE_LABEL = 'hasi.release';
const IMAGE_LABEL = 'hasi.image';
const OPERATION_LABEL = 'hasi.operation';
const ROLE_LABEL = 'hasi.role';
const HOST_PORT_LABEL = 'hasi.host-port';
const CONTAINER_PORT_LABEL = 'hasi.container-port';
const SHUTDOWN_MS_LABEL = 'hasi.shutdown-ms';
const STARTUP_MS_LABEL = 'hasi.startup-ms';
const CONFIGURATION_REVISION_LABEL = 'hasi.configuration-revision';
const NETWORK_LABEL = 'hasi.network';
const CPU_LABEL = 'hasi.cpu-millicores';
const MEMORY_LABEL = 'hasi.memory-bytes';
const PIDS_LABEL = 'hasi.pids-limit';
const MANAGED_VALUE = DOCKER_PLUGIN_MANAGED_VALUE;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const RELEASE_DIGEST = /^[a-f0-9]{64}$/;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]{0,447}@sha256:[a-f0-9]{64}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_HEALTH_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/;

export interface DockerEngineRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

export interface DockerEngineResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

/** Injectable only for deterministic tests; production uses the configured Unix socket. */
export interface DockerEngineTransport {
  request(input: DockerEngineRequest): Promise<DockerEngineResponse>;
}

export interface DockerPluginRoutingController {
  /** Atomically swaps the installation route if both pinned revisions still match. */
  activate(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
    readonly candidateDeploymentId: string;
    readonly candidateReleaseDigest: string;
    readonly previousDeploymentId: string | null;
    readonly baseCurrentDigest: string | null;
    readonly configurationRevision: string;
  }): Promise<void>;
  /** Atomically restores the retained route if the current digest/config still match. */
  rollback(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
    readonly currentDeploymentId: string;
    readonly currentReleaseDigest: string;
    readonly previousDeploymentId: string;
    readonly previousReleaseDigest: string;
    readonly baseCurrentDigest: string;
    readonly configurationRevision: string;
  }): Promise<void>;
  /** Reads the authoritative route target; it must not perform a write or retry. */
  readActiveDeploymentId(input: { readonly ownerId: string; readonly installationId: string }): Promise<string | null>;
  /** Full digest-pinned active target used only by the trusted host proxy. */
  readActiveRoute?(input: { readonly ownerId: string; readonly installationId: string }): Promise<{ readonly deploymentId: string; readonly releaseDigest: string } | null>;
  /**
   * Reads a durable operation journal. `committed` and `not-committed` must be
   * terminal and fenced: after either status is returned, that operation ID
   * can never commit later. `pending` and `unknown` never authorize resolution.
   */
  readOperationStatus(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
  }): Promise<'committed' | 'not-committed' | 'pending' | 'unknown'>;
}

export interface DockerPluginActiveEndpoint {
  /** Trusted worker lifecycle fence, checked by the host gateway before dispatch. */
  readonly deploymentRevision?: string;
  /** Exact original stage identity; required by the managed worker's custody fence. */
  readonly stageOperationId?: string;
  readonly deploymentId: string;
  readonly relayDeploymentId: string;
  readonly releaseDigest: string;
  readonly host: string;
  readonly port: number;
  readonly containerPort: number;
}

export interface DockerPluginActiveEndpointResolver {
  /** Resolves only the current digest-pinned route after a fresh Docker inspect. */
  resolveActiveEndpoint(input: { readonly installationId: string }): Promise<DockerPluginActiveEndpoint | null>;
  /** Rechecks the route and inspected port immediately before a proxy request. */
  assertActiveEndpoint(input: { readonly installationId: string; readonly endpoint: DockerPluginActiveEndpoint }): Promise<boolean>;
}

export interface DockerPluginCandidateEndpointResolver {
  /** Resolves only the exact fresh, staged candidate and its trusted relay pair. */
  resolveCandidateEndpoint(input: {
    readonly installationId: string;
    readonly operationId: string;
    readonly imageDigest: string;
    readonly releaseDigest: string;
    readonly configurationRevision: string;
  }): Promise<DockerPluginActiveEndpoint | null>;
}

export type DockerPluginDriver = DeploymentDriver & DockerPluginActiveEndpointResolver & DockerPluginCandidateEndpointResolver;

export interface DockerPluginSecretRequest {
  readonly ownerId: string;
  readonly installationId: string;
  readonly pluginId: string;
  readonly secretName: string;
  readonly secretRef: string;
}

export type DockerPluginSecretResolver = (input: DockerPluginSecretRequest) => string | undefined | Promise<string | undefined>;

export interface DockerLoopbackProbeInput {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly path: string;
  readonly timeoutMs: number;
}

export interface DockerPluginDriverOptions {
  /** Driver creation is impossible without this explicit local-operator opt-in. */
  readonly enabled: boolean;
  readonly deploymentTarget: string;
  readonly socketPath: string;
  readonly ownerId: string;
  /** Network names provisioned by the operator; each must inspect as Docker Internal=true. */
  readonly allowedInternalNetworks: readonly string[];
  /** Operator-provisioned bridge shared only by the trusted fixed target relay. */
  readonly relayNetwork: string;
  readonly routing: DockerPluginRoutingController;
  readonly resolveSecret: DockerPluginSecretResolver;
  /** Trusted worker policy; rechecked for runtime health, route changes and dispatch. */
  readonly authorizeRuntime?: (input: { installationId: string; stagingOperationId: string; releaseDigest: string }) => Promise<boolean>;
  readonly healthPath?: string;
  readonly requestTimeoutMs?: number;
  /** Test seam; omit in all application wiring. */
  readonly transport?: DockerEngineTransport;
  /** Test seam; production always uses the direct loopback HTTP probe. */
  readonly loopbackProbe?: (input: DockerLoopbackProbeInput) => Promise<boolean>;
}

type EngineObject = Record<string, unknown>;

interface ContainerSummary {
  readonly id: string;
  readonly labels: Record<string, string>;
  readonly state: string;
}

interface OwnedContainer {
  readonly id: string;
  readonly labels: Record<string, string>;
  readonly running: boolean;
  readonly image: string;
  readonly networkMode: string;
  readonly hostPort: number | null;
  readonly containerPort: number | null;
  readonly internalAddress: string | null;
  readonly shutdownTimeoutMs: number;
  readonly startupTimeoutMs: number;
}

function isRecord(value: unknown): value is EngineObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContainerId(value: unknown): value is string {
  return typeof value === 'string' && CONTAINER_ID.test(value);
}

function asStringLabels(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, item]) => key.length <= 128 && typeof item === 'string' && item.length <= 512)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function safeInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function apiPath(path: string): string {
  if (!path.startsWith('/') || path.includes('\r') || path.includes('\n') || path.startsWith('//')) {
    throw new DockerPluginDriverError('failed');
  }
  return `${ENGINE_API}${path}`;
}

class UnixSocketDockerTransport implements DockerEngineTransport {
  constructor(private readonly socketPath: string) {}

  request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    let payload: Buffer | undefined;
    try {
      if (input.body !== undefined) {
        payload = Buffer.from(JSON.stringify(input.body), 'utf8');
      }
    } catch {
      return Promise.reject(new DockerPluginDriverError('failed'));
    }
    if (payload && payload.byteLength > MAX_ENGINE_REQUEST_BYTES) return Promise.reject(new DockerPluginDriverError('failed'));
    const timeoutMs = Math.min(MAX_ENGINE_TIMEOUT_MS, Math.max(100, input.timeoutMs));

    return new Promise((resolve, reject) => {
      let settled = false;
      let responseBytes = 0;
      const responseChunks: Buffer[] = [];
      const finish = (error?: Error, result?: DockerEngineResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(new DockerPluginDriverError('unknown'));
        else if (result) resolve(result);
        else reject(new DockerPluginDriverError('unknown'));
      };
      const deadline = setTimeout(() => { request.destroy(); }, timeoutMs);
      const headers: Record<string, string> = {};
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(payload.byteLength);
      }
      const request = httpRequest({
        socketPath: this.socketPath,
        path: apiPath(input.path),
        method: input.method,
        headers,
        agent: false,
      }, (response: IncomingMessage) => {
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > MAX_ENGINE_RESPONSE_BYTES) {
            request.destroy();
            finish(new Error('response too large'));
            return;
          }
          responseChunks.push(buffer);
        });
        response.on('error', error => { finish(error); });
        response.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(responseChunks).toString('utf8');
          let body: unknown = null;
          if (text.length > 0) {
            try { body = JSON.parse(text) as unknown; } catch { finish(new Error('invalid response')); return; }
          }
          finish(undefined, { statusCode: response.statusCode ?? 0, body });
        });
      });
      request.setTimeout(timeoutMs, () => { request.destroy(); });
      request.on('error', error => { finish(error); });
      if (payload) request.write(payload);
      request.end();
    });
  }
}

function requestLoopbackProbe(input: DockerLoopbackProbeInput): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let bytes = 0;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(healthy);
    };
    const deadline = setTimeout(() => { request.destroy(); }, input.timeoutMs);
    const request = httpRequest({
      host: '127.0.0.1',
      port: input.port,
      path: input.path,
      method: 'GET',
      agent: false,
      headers: { accept: 'application/json' },
    }, response => {
      response.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
        if (bytes > HEALTH_RESPONSE_BYTES) request.destroy();
      });
      response.on('error', () => { finish(false); });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        finish(statusCode >= 200 && statusCode < 300);
      });
    });
    request.setTimeout(input.timeoutMs, () => { request.destroy(); });
    request.on('error', () => { finish(false); });
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bounded<T>(operation: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error('operation timed out')); }, timeoutMs);
    Promise.resolve().then(operation).then(
      value => { clearTimeout(deadline); resolve(value); },
      (error: unknown) => {
        clearTimeout(deadline);
        reject(error instanceof Error ? error : new Error('operation failed'));
      },
    );
  });
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateSecretAssignments(value: readonly LogicalSecretAssignment[]): void {
  if (!Array.isArray(value) || value.length > 64) throw new DockerPluginDriverError('failed');
  const names = new Set<string>();
  const items: readonly unknown[] = value;
  for (const item of items) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.secretRef !== 'string'
      || !SECRET_NAME.test(item.name) || !SECRET_REF.test(item.secretRef) || names.has(item.name)) {
      throw new DockerPluginDriverError('failed');
    }
    names.add(item.name);
  }
}

function launchOptions(policy: PluginContainerLaunchPolicy) {
  return {
    network: policy.network.mode === 'none' ? { mode: 'none' as const } : { mode: 'internal' as const, name: policy.network.name },
    ...(policy.ingress ? { hostPort: policy.ingress.hostPort, containerPort: policy.ingress.containerPort } : {}),
    cpuMillicores: policy.cpuMillicores,
    memoryBytes: policy.memoryBytes,
    pidsLimit: policy.pidsLimit,
    startupTimeoutMs: policy.startupTimeoutMs,
    shutdownTimeoutMs: policy.shutdownTimeoutMs,
  };
}

function matchesPolicy(release: VerifiedPluginRelease, policy: PluginContainerLaunchPolicy): boolean {
  try {
    const expected = buildPluginContainerLaunchPolicy(release, launchOptions(policy));
    return digestSafe(expected) === digestSafe(policy);
  } catch {
    return false;
  }
}

function digestSafe(value: unknown): string {
  return sha(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isReleaseDigest(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_DIGEST.test(value);
}

function readLabels(value: unknown): Record<string, string> {
  const labels = asStringLabels(value);
  if (!labels) throw new DockerPluginDriverError('failed');
  return labels;
}

function emptyArrayOrMissing(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function emptyObjectOrMissing(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

function internalAddress(body: EngineObject, networkName: string, running: boolean): string | null | undefined {
  const networkSettings = body.NetworkSettings;
  if (!isRecord(networkSettings)) return undefined;
  const networks = networkSettings.Networks;
  if (!isRecord(networks) || Object.keys(networks).length !== 1 || !Object.hasOwn(networks, networkName)) return undefined;
  const attachment = networks[networkName];
  if (!isRecord(attachment)) return undefined;
  const ports = networkSettings.Ports;
  if (ports !== undefined && ports !== null) {
    if (!isRecord(ports) || !Object.values(ports).every(value => value === null)) return undefined;
  }
  const address = attachment.IPAddress;
  if (typeof address === 'string' && address.length > 0) return isPrivatePluginIPv4(address) ? address : undefined;
  if (running) return undefined;
  return null;
}

function verifyContainerHardening(body: EngineObject, config: EngineObject, hostConfig: EngineObject, labels: Record<string, string>): boolean {
  const cpuMillicores = safeInteger(Number(labels[CPU_LABEL]), 100, 16_000);
  const memoryBytes = safeInteger(Number(labels[MEMORY_LABEL]), 64 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
  const pidsLimit = safeInteger(Number(labels[PIDS_LABEL]), 1, 4_096);
  const hostPort = safeInteger(Number(labels[HOST_PORT_LABEL]), 1, 65_535);
  const containerPort = safeInteger(Number(labels[CONTAINER_PORT_LABEL]), 1, 65_535);
  const networkName = labels[NETWORK_LABEL];
  if (!cpuMillicores || !memoryBytes || !pidsLimit || !networkName || !hostPort || !containerPort) return false;

  const capDrop = stringArray(hostConfig.CapDrop);
  const capAdd = stringArray(hostConfig.CapAdd);
  const securityOptions = stringArray(hostConfig.SecurityOpt);
  const bindings = hostConfig.PortBindings;
  const exposedPorts = config.ExposedPorts;
  const portKey = `${String(containerPort)}/tcp`;

  return config.User === '65532:65532'
    && config.Image === labels[IMAGE_LABEL]
    && stringArray(config.Env)?.filter(value => value.startsWith('HASI_PLUGIN_INSTALLATION_ID='))
      .join('\0') === `HASI_PLUGIN_INSTALLATION_ID=${labels[INSTALLATION_LABEL] ?? ''}`
    && hostConfig.NetworkMode === networkName
    && (hostConfig.PidMode === undefined || hostConfig.PidMode === '')
    && hostConfig.IpcMode === 'private'
    && (hostConfig.UTSMode === undefined || hostConfig.UTSMode === '')
    && hostConfig.CgroupnsMode === 'private'
    && (hostConfig.UsernsMode === undefined || hostConfig.UsernsMode === '')
    && hostConfig.AutoRemove === false
    && isRecord(hostConfig.RestartPolicy) && hostConfig.RestartPolicy.Name === 'no' && hostConfig.RestartPolicy.MaximumRetryCount === 0
    && hostConfig.ReadonlyRootfs === true
    && hostConfig.Privileged === false
    && capDrop?.length === 1 && capDrop[0] === 'ALL'
    && capAdd?.length === 0
    && securityOptions?.length === 1 && securityOptions[0] === 'no-new-privileges:true'
    && hostConfig.PidsLimit === pidsLimit
    && hostConfig.NanoCpus === cpuMillicores * 1_000_000
    && hostConfig.Memory === memoryBytes
    && hostConfig.MemorySwap === memoryBytes
    && emptyArrayOrMissing(hostConfig.Binds)
    && emptyArrayOrMissing(hostConfig.Mounts)
    && emptyArrayOrMissing(hostConfig.Devices)
    && emptyArrayOrMissing(hostConfig.DeviceRequests)
    && emptyArrayOrMissing(hostConfig.VolumesFrom)
    && emptyArrayOrMissing(hostConfig.Links)
    && emptyArrayOrMissing(hostConfig.ExtraHosts)
    && emptyArrayOrMissing(hostConfig.Dns)
    && emptyArrayOrMissing(hostConfig.DnsOptions)
    && emptyArrayOrMissing(hostConfig.DnsSearch)
    && emptyArrayOrMissing(hostConfig.DeviceCgroupRules)
    && emptyArrayOrMissing(hostConfig.GroupAdd)
    && emptyObjectOrMissing(hostConfig.Tmpfs)
    && emptyObjectOrMissing(hostConfig.Sysctls)
    && emptyObjectOrMissing(hostConfig.StorageOpt)
    && emptyArrayOrMissing(hostConfig.Ulimits)
    && (hostConfig.Cgroup === undefined || hostConfig.Cgroup === '')
    && (hostConfig.CgroupParent === undefined || hostConfig.CgroupParent === '')
    && emptyArrayOrMissing(body.Mounts)
    && (config.Volumes === undefined || config.Volumes === null || (isRecord(config.Volumes) && Object.keys(config.Volumes).length === 0))
    && isRecord(exposedPorts) && Object.keys(exposedPorts).length === 1 && Object.hasOwn(exposedPorts, portKey)
    && hostConfig.PublishAllPorts === false
    && emptyObjectOrMissing(bindings)
    && labels[NETWORK_LABEL] === networkName;
}

function readStatusError(response: DockerEngineResponse, mutating: boolean): never {
  const outcome = mutating && response.statusCode >= 500 ? 'unknown' : 'failed';
  throw new DockerPluginDriverError(outcome);
}

function imageMatches(image: string, release: VerifiedPluginRelease): boolean {
  return IMAGE_REFERENCE.test(image) && image === release.image && RELEASE_DIGEST.test(release.releaseDigest);
}

function hasLocalRepoDigest(image: string, repoDigests: readonly unknown[]): boolean {
  const expected = new Set([image]);
  const marker = image.lastIndexOf('@sha256:');
  const repository = image.slice(0, marker);
  const digest = image.slice(marker + 1);
  const libraryPrefix = 'docker.io/library/';
  if (repository.startsWith(libraryPrefix)) expected.add(`${repository.slice(libraryPrefix.length)}@${digest}`);
  return repoDigests.some(item => typeof item === 'string' && expected.has(item));
}

function validateOwnerInput(ownerId: string): void {
  if (!OPAQUE_ID.test(ownerId)) throw new TypeError('Docker plugin owner identifier is invalid.');
}

function validateDriverOptions(options: DockerPluginDriverOptions): void {
  if (!options.enabled || options.deploymentTarget !== 'operator-local' || process.env.VERCEL || process.env.HASI_DEMO_MODE === '1') {
    throw new TypeError('Docker plugin execution requires explicit operator-local enablement.');
  }
  validateOwnerInput(options.ownerId);
  if (!isAbsolute(options.socketPath) || options.socketPath.includes('\0')) throw new TypeError('Docker Engine socket path must be absolute.');
  if (typeof options.resolveSecret !== 'function' || typeof options.routing.activate !== 'function'
    || typeof options.routing.rollback !== 'function' || typeof options.routing.readActiveDeploymentId !== 'function'
    || typeof options.routing.readOperationStatus !== 'function') {
    throw new TypeError('Docker plugin execution requires operator-owned secret and routing controllers.');
  }
  const networks: readonly unknown[] = options.allowedInternalNetworks;
  if (!Array.isArray(networks) || networks.length === 0 || networks.length > 64) {
    throw new TypeError('At least one operator-approved internal plugin network is required.');
  }
  if (!networks.every((name): name is string => typeof name === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(name)) || new Set(networks).size !== networks.length) {
    throw new TypeError('Operator-approved Docker network names are invalid.');
  }
  if (typeof options.relayNetwork !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(options.relayNetwork)
    || ['bridge', 'default', 'host', 'none'].includes(options.relayNetwork)
    || networks.includes(options.relayNetwork)) {
    throw new TypeError('The trusted relay network must be a distinct operator-defined Docker network.');
  }
  if (options.healthPath !== undefined && (!SAFE_HEALTH_PATH.test(options.healthPath) || options.healthPath.includes('..') || options.healthPath.includes('//'))) {
    throw new TypeError('Docker plugin health path is invalid.');
  }
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100 || options.requestTimeoutMs > MAX_ENGINE_TIMEOUT_MS)) {
    throw new TypeError('Docker Engine request timeout is invalid.');
  }
}

export function createDockerPluginDriver(options: DockerPluginDriverOptions): DockerPluginDriver {
  validateDriverOptions(options);
  const transport = options.transport ?? new UnixSocketDockerTransport(options.socketPath);
  const healthPath = options.healthPath ?? '/healthz';
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  const probe = options.loopbackProbe ?? requestLoopbackProbe;

  const request = (method: DockerEngineRequest['method'], path: string, body?: unknown) => transport.request({
    method,
    path,
    ...(body !== undefined ? { body } : {}),
    timeoutMs: requestTimeoutMs,
  });
  const relay = createDockerPluginRelay({
    ownerId: options.ownerId,
    networkName: options.relayNetwork,
    request: (method, path, body) => request(method, path, body),
  });

  async function ownedContainer(id: string, installationId: string): Promise<OwnedContainer | null> {
    if (!isContainerId(id)) throw new DockerPluginDriverError('failed');
    let response: DockerEngineResponse;
    try { response = await request('GET', `/containers/${encodeURIComponent(id)}/json`); } catch { throw new DockerPluginDriverError('unknown'); }
    if (response.statusCode === 404) return null;
    if (response.statusCode !== 200 || !isRecord(response.body)) readStatusError(response, false);
    const body = response.body;
    const config = body.Config;
    const hostConfig = body.HostConfig;
    const state = body.State;
    if (!isRecord(config) || !isRecord(hostConfig) || !isRecord(state)) throw new DockerPluginDriverError('unknown');
    if (typeof state.Running !== 'boolean') throw new DockerPluginDriverError('unknown');
    const labels = readLabels(config.Labels);
    if (labels[MANAGED_LABEL] !== MANAGED_VALUE || labels[OWNER_LABEL] !== options.ownerId || labels[INSTALLATION_LABEL] !== installationId) {
      throw new DockerPluginDriverError('failed');
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(labels[PLUGIN_LABEL] ?? '')
      || !RELEASE_DIGEST.test(labels[RELEASE_LABEL] ?? '')
      || !IMAGE_REFERENCE.test(labels[IMAGE_LABEL] ?? '')
      || !OPAQUE_ID.test(labels[OPERATION_LABEL] ?? '')
      || labels[ROLE_LABEL] !== 'candidate') {
      throw new DockerPluginDriverError('failed');
    }
    if (body.Id !== id || body.Name !== `/${dockerPluginContainerName(options.ownerId, installationId, labels[OPERATION_LABEL] ?? '')}`) {
      throw new DockerPluginDriverError('failed');
    }
    await assertDaemonSeccomp();
    const hostPortLabel = labels[HOST_PORT_LABEL];
    const containerPortLabel = labels[CONTAINER_PORT_LABEL];
    const hostPort = safeInteger(Number(hostPortLabel), 1, 65_535);
    const containerPort = safeInteger(Number(containerPortLabel), 1, 65_535);
    const shutdownTimeoutMs = safeInteger(Number(labels[SHUTDOWN_MS_LABEL]), 1, 30_000);
    const startupTimeoutMs = safeInteger(Number(labels[STARTUP_MS_LABEL]), 1, 120_000);
    if (hostPort === undefined || containerPort === undefined || String(hostPort) !== hostPortLabel
      || String(containerPort) !== containerPortLabel || !shutdownTimeoutMs || !startupTimeoutMs) {
      throw new DockerPluginDriverError('unknown');
    }
    const image = typeof config.Image === 'string' ? config.Image : '';
    const networkMode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : '';
    if (!options.allowedInternalNetworks.includes(networkMode) || labels[NETWORK_LABEL] !== networkMode) throw new DockerPluginDriverError('failed');
    if (!verifyContainerHardening(body, config, hostConfig, labels)) throw new DockerPluginDriverError('failed');
    const running = state.Running;
    const address = internalAddress(body, networkMode, running);
    if (address === undefined) throw new DockerPluginDriverError('failed');
    return {
      id,
      labels,
      running,
      image,
      networkMode,
      hostPort,
      containerPort,
      internalAddress: address,
      shutdownTimeoutMs,
      startupTimeoutMs,
    };
  }

  async function assertEmptyInternalNetwork(networkName: string): Promise<void> {
    if (!options.allowedInternalNetworks.includes(networkName)) throw new DockerPluginDriverError('failed');
    let response: DockerEngineResponse;
    try { response = await request('GET', `/networks/${encodeURIComponent(networkName)}`); } catch { throw new DockerPluginDriverError('failed'); }
    if (response.statusCode !== 200 || !isRecord(response.body)) readStatusError(response, false);
    const network = response.body;
    const networkOptions = network.Options;
    const networkLabels = network.Labels;
    if (network.Name !== networkName || network.Driver !== 'bridge' || network.Internal !== true || network.EnableIPv6 !== false
      || !isRecord(networkLabels) || networkLabels[OWNER_LABEL] !== options.ownerId || networkLabels[MANAGED_LABEL] !== MANAGED_VALUE
      || !isRecord(networkOptions) || networkOptions['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated'
      || !isRecord(network.Containers)) throw new DockerPluginDriverError('failed');
    const members = Object.keys(network.Containers);
    if (members.length > MAX_NETWORK_MEMBERS || members.length !== 0) throw new DockerPluginDriverError('failed');
  }

  async function inspectLocalImage(release: VerifiedPluginRelease): Promise<void> {
    if (!imageMatches(release.image, release)) throw new DockerPluginDriverError('failed');
    let response: DockerEngineResponse;
    try { response = await request('GET', `/images/${encodeURIComponent(release.image)}/json`); } catch { throw new DockerPluginDriverError('failed'); }
    if (response.statusCode !== 200 || !isRecord(response.body)) readStatusError(response, false);
    const repoDigests = response.body.RepoDigests;
    if (!Array.isArray(repoDigests) || !hasLocalRepoDigest(release.image, repoDigests)) throw new DockerPluginDriverError('failed');
    const imageConfig = response.body.Config;
    if (isRecord(imageConfig) && isRecord(imageConfig.Volumes) && Object.keys(imageConfig.Volumes).length > 0) {
      // Image-declared volumes create anonymous writable mounts even with no HostConfig mounts.
      throw new DockerPluginDriverError('failed');
    }
  }

  async function assertDaemonSeccomp(): Promise<void> {
    let response: DockerEngineResponse;
    try { response = await request('GET', '/info'); } catch { throw new DockerPluginDriverError('failed'); }
    if (response.statusCode !== 200 || !isRecord(response.body) || !Array.isArray(response.body.SecurityOptions)) readStatusError(response, false);
    const securityOptions = response.body.SecurityOptions;
    if (!securityOptions.every(item => typeof item === 'string')) throw new DockerPluginDriverError('failed');
    const seccompOptions = securityOptions.filter(item => /^name=seccomp(?:,|$)/i.test(item));
    // Docker reports its inherited built-in profile separately from per-
    // container SecurityOpt. Reject custom, unconfined, and unknown variants.
    if (seccompOptions.length !== 1 || seccompOptions[0]?.toLowerCase() !== 'name=seccomp,profile=builtin') {
      throw new DockerPluginDriverError('failed');
    }
  }

  async function secretEnvironment(input: {
    readonly installationId: string;
    readonly release: VerifiedPluginRelease;
    readonly assignments: readonly LogicalSecretAssignment[];
  }): Promise<string[]> {
    validateSecretAssignments(input.assignments);
    const env: string[] = [];
    let totalBytes = 0;
    for (const assignment of input.assignments) {
      let value: string | undefined;
      try {
        value = await bounded(() => options.resolveSecret({
          ownerId: options.ownerId,
          installationId: input.installationId,
          pluginId: input.release.pluginId,
          secretName: assignment.name,
          secretRef: assignment.secretRef,
        }), requestTimeoutMs);
      } catch {
        throw new DockerPluginDriverError('failed');
      }
      if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
        throw new DockerPluginDriverError('failed');
      }
      const entry = `HASI_SECRET_${assignment.name}=${value}`;
      totalBytes += Buffer.byteLength(entry, 'utf8');
      if (totalBytes > MAX_SECRET_BYTES) throw new DockerPluginDriverError('failed');
      env.push(entry);
    }
    return env;
  }

  type InternalPluginPolicy = PluginContainerLaunchPolicy & {
    readonly network: Extract<PluginContainerLaunchPolicy['network'], { readonly mode: 'internal' }>;
    readonly ingress: NonNullable<PluginContainerLaunchPolicy['ingress']>;
  };

  function verifyLaunchPolicy(release: VerifiedPluginRelease, policy: PluginContainerLaunchPolicy): asserts policy is InternalPluginPolicy {
    if (!matchesPolicy(release, policy) || policy.network.mode !== 'internal' || !policy.ingress) {
      throw new DockerPluginDriverError('failed');
    }
    if (!options.allowedInternalNetworks.includes(policy.network.name)) throw new DockerPluginDriverError('failed');
  }

  function createBody(input: Parameters<DeploymentDriver['stage']>[0], env: readonly string[]): EngineObject {
    const policy = input.policy;
    const port = policy.ingress;
    if (policy.network.mode !== 'internal' || !port) throw new DockerPluginDriverError('failed');
    const portKey = `${String(port.containerPort)}/tcp`;
    const labels: Record<string, string> = {
      [MANAGED_LABEL]: MANAGED_VALUE,
      [OWNER_LABEL]: options.ownerId,
      [INSTALLATION_LABEL]: input.installationId,
      [PLUGIN_LABEL]: input.release.pluginId,
      [RELEASE_LABEL]: input.release.releaseDigest,
      [IMAGE_LABEL]: input.release.image,
      [OPERATION_LABEL]: input.operationId,
      [CONFIGURATION_REVISION_LABEL]: input.configurationRevision,
      [ROLE_LABEL]: 'candidate',
      [NETWORK_LABEL]: policy.network.name,
      [HOST_PORT_LABEL]: String(port.hostPort),
      [CONTAINER_PORT_LABEL]: String(port.containerPort),
      [SHUTDOWN_MS_LABEL]: String(policy.shutdownTimeoutMs),
      [STARTUP_MS_LABEL]: String(policy.startupTimeoutMs),
      [CPU_LABEL]: String(policy.cpuMillicores),
      [MEMORY_LABEL]: String(policy.memoryBytes),
      [PIDS_LABEL]: String(policy.pidsLimit),
    };
    return {
      Image: input.release.image,
      User: `${String(policy.user.uid)}:${String(policy.user.gid)}`,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Env: [...env],
      ExposedPorts: { [portKey]: {} },
      Labels: labels,
      StopTimeout: Math.max(1, Math.ceil(policy.shutdownTimeoutMs / 1_000)),
      HostConfig: {
        NetworkMode: policy.network.name,
        PortBindings: {},
        PublishAllPorts: false,
        PidMode: '',
        IpcMode: 'private',
        UTSMode: '',
        CgroupnsMode: 'private',
        UsernsMode: '',
        AutoRemove: false,
        ReadonlyRootfs: true,
        CapAdd: [],
        CapDrop: ['ALL'],
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: policy.pidsLimit,
        NanoCpus: policy.cpuMillicores * 1_000_000,
        Memory: policy.memoryBytes,
        MemorySwap: policy.memorySwapBytes,
        Binds: [],
        Mounts: [],
        Devices: [],
        DeviceRequests: [],
        DeviceCgroupRules: [],
        GroupAdd: [],
        Tmpfs: {},
        Sysctls: {},
        StorageOpt: {},
        Ulimits: [],
        Cgroup: '',
        CgroupParent: '',
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
    };
  }

  async function inspectLabelsBeforeRoute(id: string, installationId: string, releaseDigest?: string): Promise<OwnedContainer> {
    const container = await ownedContainer(id, installationId);
    if (!container) throw new DockerPluginDriverError('failed');
    if (releaseDigest && container.labels[RELEASE_LABEL] !== releaseDigest) throw new DockerPluginDriverError('failed');
    if (container.labels[ROLE_LABEL] !== 'candidate' || !RELEASE_DIGEST.test(container.labels[RELEASE_LABEL] ?? '')) throw new DockerPluginDriverError('failed');
    if (container.image !== container.labels[IMAGE_LABEL] || !IMAGE_REFERENCE.test(container.image)) throw new DockerPluginDriverError('failed');
    return container;
  }

  function relayCandidate(container: OwnedContainer, installationId: string): RelayCandidate {
    const pluginId = container.labels[PLUGIN_LABEL];
    const operationId = container.labels[OPERATION_LABEL];
    const releaseDigest = container.labels[RELEASE_LABEL];
    if (typeof pluginId !== 'string' || typeof operationId !== 'string' || typeof releaseDigest !== 'string'
      || !OPAQUE_ID.test(operationId) || !RELEASE_DIGEST.test(releaseDigest)
      || !container.hostPort || !container.containerPort) throw new DockerPluginDriverError('unknown');
    return {
      id: container.id,
      installationId,
      operationId,
      pluginId,
      releaseDigest,
      networkName: container.networkMode,
      internalAddress: container.internalAddress,
      running: container.running,
      hostPort: container.hostPort,
      containerPort: container.containerPort,
      shutdownTimeoutMs: container.shutdownTimeoutMs,
    };
  }

  async function inspectRelay(container: OwnedContainer, installationId: string): Promise<{ readonly id: string; readonly running: boolean; readonly hostPort: number } | null> {
    let inspected: Awaited<ReturnType<typeof relay.inspect>>;
    try {
      inspected = await relay.inspect(relayCandidate(container, installationId));
    } catch (error) {
      if (error instanceof DeploymentDriverError) throw error;
      throw new DockerPluginDriverError('unknown');
    }
    if (inspected === null) return null;
    if (!isRecord(inspected) || !isContainerId(inspected.id) || typeof inspected.running !== 'boolean') {
      throw new DockerPluginDriverError('unknown');
    }
    const hostPort = safeInteger(inspected.hostPort, 1, 65_535);
    if (hostPort === undefined || hostPort !== container.hostPort) throw new DockerPluginDriverError('unknown');
    return { id: inspected.id, running: inspected.running, hostPort };
  }

  async function runtimeAuthorized(container: OwnedContainer, installationId: string, releaseDigest: string): Promise<boolean> {
    if (!options.authorizeRuntime) return true;
    const stagingOperationId = container.labels[OPERATION_LABEL];
    if (!stagingOperationId || !OPAQUE_ID.test(stagingOperationId)) return false;
    try { return await bounded(() => options.authorizeRuntime?.({ installationId, stagingOperationId, releaseDigest }) ?? false, requestTimeoutMs); }
    catch { return false; }
  }

  async function healthCheck(container: OwnedContainer, installationId: string, releaseDigest: string, startupTimeoutMs: number): Promise<{
    readonly healthy: boolean;
    readonly relayDeploymentId: string | null;
  }> {
    if (container.labels[RELEASE_LABEL] !== releaseDigest || !container.running || !container.internalAddress
      || !isPrivatePluginIPv4(container.internalAddress) || container.networkMode === 'none'
      || !container.hostPort || !container.containerPort) return { healthy: false, relayDeploymentId: null };
    const deadline = Date.now() + startupTimeoutMs;
    let pinnedRelayId: string | null = null;
    do {
      if (!await runtimeAuthorized(container, installationId, releaseDigest)) return { healthy: false, relayDeploymentId: pinnedRelayId };
      const inspectedRelay = await inspectRelay(container, installationId);
      if (!inspectedRelay?.running || (pinnedRelayId !== null && inspectedRelay.id !== pinnedRelayId)) {
        return { healthy: false, relayDeploymentId: inspectedRelay?.id ?? pinnedRelayId };
      }
      pinnedRelayId = inspectedRelay.id;
      const remaining = Math.max(1, deadline - Date.now());
      const responsive = await probe({ host: '127.0.0.1', port: inspectedRelay.hostPort, path: healthPath, timeoutMs: Math.min(requestTimeoutMs, remaining) }).catch(() => false);
      if (responsive) return { healthy: true, relayDeploymentId: pinnedRelayId };
      if (Date.now() >= deadline) return { healthy: false, relayDeploymentId: pinnedRelayId };
      await delay(Math.min(HEALTH_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return { healthy: false, relayDeploymentId: pinnedRelayId };
  }

  async function activeRoute(installationId: string): Promise<string | null> {
    let id: string | null;
    try {
      id = await bounded(() => options.routing.readActiveDeploymentId({ ownerId: options.ownerId, installationId }), requestTimeoutMs);
    } catch {
      throw new DockerPluginDriverError('unknown');
    }
    if (id !== null && !isContainerId(id)) throw new DockerPluginDriverError('unknown');
    return id;
  }

  async function activeRouteTarget(installationId: string): Promise<{ readonly deploymentId: string; readonly releaseDigest: string } | null> {
    if (!options.routing.readActiveRoute) throw new DockerPluginDriverError('failed');
    let target: { readonly deploymentId: string; readonly releaseDigest: string } | null;
    try {
      target = await bounded(() => options.routing.readActiveRoute?.({ ownerId: options.ownerId, installationId }) ?? null, requestTimeoutMs);
    } catch {
      throw new DockerPluginDriverError('unknown');
    }
    if (target !== null && (!isContainerId(target.deploymentId) || !RELEASE_DIGEST.test(target.releaseDigest))) {
      throw new DockerPluginDriverError('unknown');
    }
    return target;
  }

  function matchesRouteTarget(
    candidate: { readonly deploymentId: string; readonly releaseDigest: string } | null,
    expected: { readonly deploymentId: string; readonly releaseDigest: string },
  ): boolean {
    return candidate !== null
      && candidate.deploymentId === expected.deploymentId
      && candidate.releaseDigest === expected.releaseDigest;
  }

  async function assertNoRelayForOperation(installationId: string, operationId: string): Promise<void> {
    // Labels can be missing or changed. A filtered empty list is not proof that
    // the operation's reserved names are free, nor authority to remove a collision.
    const name = dockerPluginContainerName(options.ownerId, installationId, operationId);
    await assertContainerNameUnused(name);
    await assertContainerNameUnused(`${name}-relay`);
    const filters = encodeURIComponent(JSON.stringify({ label: [
      `${MANAGED_LABEL}=${MANAGED_VALUE}`,
      `${OWNER_LABEL}=${options.ownerId}`,
      `${INSTALLATION_LABEL}=${installationId}`,
      `${OPERATION_LABEL}=${operationId}`,
    ] }));
    let response: DockerEngineResponse;
    try { response = await request('GET', `/containers/json?all=1&filters=${filters}`); } catch { throw new DockerPluginDriverError('unknown'); }
    if (response.statusCode !== 200 || !Array.isArray(response.body) || response.body.length > MAX_RECONCILE_CONTAINERS) {
      throw new DockerPluginDriverError('unknown');
    }
    if (response.body.length > 0) {
      for (const item of response.body) {
        if (!isRecord(item) || !isContainerId(item.Id)) throw new DockerPluginDriverError('unknown');
        const labels = asStringLabels(item.Labels);
        if (labels?.[MANAGED_LABEL] !== MANAGED_VALUE || labels[OWNER_LABEL] !== options.ownerId
          || labels[INSTALLATION_LABEL] !== installationId || labels[OPERATION_LABEL] !== operationId
          || labels[ROLE_LABEL] !== 'relay') throw new DockerPluginDriverError('unknown');
      }
      // The candidate metadata needed for a safe paired deletion is gone.
      throw new DockerPluginDriverError('unknown');
    }
  }

  async function assertContainerNameUnused(name: string): Promise<void> {
    let response: DockerEngineResponse;
    try { response = await request('GET', `/containers/${encodeURIComponent(name)}/json`); } catch { throw new DockerPluginDriverError('unknown'); }
    if (response.statusCode !== 404) throw new DockerPluginDriverError('unknown');
  }

  return {
    async resolveCandidateEndpoint(input) {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId)
        || !RELEASE_DIGEST.test(input.imageDigest) || !RELEASE_DIGEST.test(input.releaseDigest)
        || typeof input.configurationRevision !== 'string' || input.configurationRevision.length < 1
        || input.configurationRevision.length > 256 || input.configurationRevision.includes('\0')) {
        throw new DockerPluginDriverError('failed');
      }
      const expectedName = dockerPluginContainerName(options.ownerId, input.installationId, input.operationId);
      let named: DockerEngineResponse;
      try { named = await request('GET', `/containers/${encodeURIComponent(expectedName)}/json`); } catch {
        throw new DockerPluginDriverError('unknown');
      }
      if (named.statusCode === 404) return null;
      if (named.statusCode !== 200 || !isRecord(named.body) || !isContainerId(named.body.Id)
        || named.body.Name !== `/${expectedName}`) readStatusError(named, false);

      const deploymentId = named.body.Id;
      const container = await inspectLabelsBeforeRoute(deploymentId, input.installationId, input.releaseDigest);
      const image = container.image;
      const imageMarker = image.lastIndexOf('@sha256:');
      const configurationRevision = container.labels[CONFIGURATION_REVISION_LABEL];
      if (container.labels[OPERATION_LABEL] !== input.operationId
        || typeof configurationRevision !== 'string' || configurationRevision.length < 1
        || configurationRevision.length > 256 || configurationRevision.includes('\0')
        || configurationRevision !== input.configurationRevision
        || imageMarker < 1 || image.slice(imageMarker + '@sha256:'.length) !== input.imageDigest
        || !container.running || !container.hostPort || !container.containerPort || container.networkMode === 'none') {
        throw new DockerPluginDriverError('failed');
      }

      const beforeRoute = await activeRoute(input.installationId);
      if (beforeRoute === deploymentId) throw new DockerPluginDriverError('failed');
      const health = await healthCheck(container, input.installationId, input.releaseDigest,
        Math.min(container.startupTimeoutMs, requestTimeoutMs));
      if (!health.healthy || !health.relayDeploymentId) throw new DockerPluginDriverError('failed');

      const after = await inspectLabelsBeforeRoute(deploymentId, input.installationId, input.releaseDigest);
      if (after.labels[OPERATION_LABEL] !== input.operationId
        || after.labels[CONFIGURATION_REVISION_LABEL] !== input.configurationRevision
        || after.labels[IMAGE_LABEL] !== image || after.labels[RELEASE_LABEL] !== input.releaseDigest
        || !after.running || after.hostPort !== container.hostPort || after.containerPort !== container.containerPort) {
        throw new DockerPluginDriverError('unknown');
      }
      const afterRelay = await inspectRelay(after, input.installationId);
      if (!afterRelay?.running || afterRelay.id !== health.relayDeploymentId || afterRelay.hostPort !== after.hostPort) {
        throw new DockerPluginDriverError('unknown');
      }
      if (await activeRoute(input.installationId) === deploymentId) throw new DockerPluginDriverError('unknown');

      return Object.freeze({
        stageOperationId: input.operationId,
        deploymentId,
        relayDeploymentId: health.relayDeploymentId,
        releaseDigest: input.releaseDigest,
        host: '127.0.0.1' as const,
        port: after.hostPort,
        containerPort: after.containerPort,
      });
    },

    async resolveActiveEndpoint(input) {
      if (!OPAQUE_ID.test(input.installationId)) throw new DockerPluginDriverError('failed');
      const target = await activeRouteTarget(input.installationId);
      if (!target) return null;
      const container = await inspectLabelsBeforeRoute(target.deploymentId, input.installationId, target.releaseDigest);
      if (!container.running || container.networkMode === 'none' || !container.hostPort || !container.containerPort) {
        throw new DockerPluginDriverError('failed');
      }
      const health = await healthCheck(container, input.installationId, target.releaseDigest, Math.min(container.startupTimeoutMs, requestTimeoutMs));
      if (!health.healthy || !health.relayDeploymentId) {
        throw new DockerPluginDriverError('failed');
      }
      const afterRelay = await inspectRelay(container, input.installationId);
      if (!afterRelay?.running || afterRelay.id !== health.relayDeploymentId || afterRelay.hostPort !== container.hostPort) {
        throw new DockerPluginDriverError('unknown');
      }
      const after = await activeRouteTarget(input.installationId);
      if (!matchesRouteTarget(after, target)) {
        throw new DockerPluginDriverError('unknown');
      }
      const stageOperationId = container.labels[OPERATION_LABEL];
      if (!stageOperationId || !OPAQUE_ID.test(stageOperationId)) throw new DockerPluginDriverError('unknown');
      return Object.freeze({
        stageOperationId,
        deploymentId: target.deploymentId,
        relayDeploymentId: health.relayDeploymentId,
        releaseDigest: target.releaseDigest,
        host: '127.0.0.1' as const,
        port: container.hostPort,
        containerPort: container.containerPort,
      });
    },

    async assertActiveEndpoint(input) {
      if (!OPAQUE_ID.test(input.installationId) || !isContainerId(input.endpoint.deploymentId)
        || !isContainerId(input.endpoint.relayDeploymentId)
        || !RELEASE_DIGEST.test(input.endpoint.releaseDigest) || input.endpoint.host !== '127.0.0.1'
        || !safeInteger(input.endpoint.port, 1, 65_535) || !safeInteger(input.endpoint.containerPort, 1, 65_535)) {
        throw new DockerPluginDriverError('failed');
      }
      const before = await activeRouteTarget(input.installationId);
      if (!matchesRouteTarget(before, input.endpoint)) return false;
      const container = await inspectLabelsBeforeRoute(input.endpoint.deploymentId, input.installationId, input.endpoint.releaseDigest);
      if (!container.running || container.hostPort !== input.endpoint.port || container.containerPort !== input.endpoint.containerPort) return false;
      const beforeRelay = await inspectRelay(container, input.installationId);
      if (!beforeRelay?.running || beforeRelay.id !== input.endpoint.relayDeploymentId || beforeRelay.hostPort !== input.endpoint.port) return false;
      const afterRelay = await inspectRelay(container, input.installationId);
      if (!afterRelay?.running || afterRelay.id !== input.endpoint.relayDeploymentId || afterRelay.hostPort !== input.endpoint.port) return false;
      const after = await activeRouteTarget(input.installationId);
      return matchesRouteTarget(after, input.endpoint) && await runtimeAuthorized(container, input.installationId, input.endpoint.releaseDigest);
    },

    async stage(input) {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId) || !RELEASE_DIGEST.test(input.release.releaseDigest)) {
        throw new DockerPluginDriverError('failed');
      }
      verifyLaunchPolicy(input.release, input.policy);
      if (input.baseCurrentDigest !== null && !RELEASE_DIGEST.test(input.baseCurrentDigest)) throw new DockerPluginDriverError('failed');
      if (typeof input.configurationRevision !== 'string' || input.configurationRevision.length < 1 || input.configurationRevision.length > 256 || input.configurationRevision.includes('\0')) {
        throw new DockerPluginDriverError('failed');
      }

      // All read-only preflight checks complete before Docker can create anything.
      await relay.preflight();
      const name = dockerPluginContainerName(options.ownerId, input.installationId, input.operationId);
      await assertContainerNameUnused(name);
      await assertContainerNameUnused(`${name}-relay`);
      await inspectLocalImage(input.release);
      await assertEmptyInternalNetwork(input.policy.network.name);
      await assertDaemonSeccomp();
      const env = await secretEnvironment({ installationId: input.installationId, release: input.release, assignments: input.secretAssignments });
      const body = createBody(input, [`HASI_PLUGIN_INSTALLATION_ID=${input.installationId}`, ...env]);

      let created: DockerEngineResponse;
      try {
        created = await request('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
      } catch {
        // A transport failure may arrive after Docker accepted the create request.
        throw new DockerPluginDriverError('unknown');
      }
      if (created.statusCode === 409) throw new DockerPluginDriverError('unknown');
      if (created.statusCode !== 201) readStatusError(created, true);
      if (!isRecord(created.body) || typeof created.body.Id !== 'string' || !isContainerId(created.body.Id)) {
        throw new DockerPluginDriverError('unknown');
      }
      const id = created.body.Id;

      try {
        const started = await request('POST', `/containers/${encodeURIComponent(id)}/start`);
        if (started.statusCode !== 204) throw new DockerPluginDriverError('unknown');
        const container = await ownedContainer(id, input.installationId);
        if (container?.labels[OPERATION_LABEL] !== input.operationId) throw new DockerPluginDriverError('unknown');
        if (!container.running) return { deploymentId: id };
        if (!container.internalAddress || !isPrivatePluginIPv4(container.internalAddress)) throw new DockerPluginDriverError('unknown');
        await relay.stage(relayCandidate(container, input.installationId));
      } catch {
        // A candidate may exist, and the relay may also have been partially staged.
        // Reconciliation must identify the pair before any retry or cleanup.
        throw new DockerPluginDriverError('unknown');
      }
      return { deploymentId: id };
    },

    async check(input) {
      if (!OPAQUE_ID.test(input.installationId) || !isContainerId(input.deploymentId) || !RELEASE_DIGEST.test(input.releaseDigest)) return false;
      let container: OwnedContainer | null;
      try { container = await ownedContainer(input.deploymentId, input.installationId); } catch { throw new DockerPluginDriverError('unknown'); }
      if (!container) return false;
      if (container.labels[ROLE_LABEL] !== 'candidate') throw new DockerPluginDriverError('failed');
      const result = await healthCheck(container, input.installationId, input.releaseDigest, container.startupTimeoutMs);
      return result.healthy;
    },

    async discard(input) {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId) || !isContainerId(input.deploymentId)) {
        throw new DockerPluginDriverError('failed');
      }
      if (await activeRoute(input.installationId) === input.deploymentId) throw new DockerPluginDriverError('failed');
      const container = await ownedContainer(input.deploymentId, input.installationId);
      if (!container) {
        await assertNoRelayForOperation(input.installationId, input.operationId);
        return; // Repeated deletion after an earlier successful cleanup is benign.
      }
      if (container.labels[OPERATION_LABEL] !== input.operationId || container.labels[ROLE_LABEL] !== 'candidate') {
        throw new DockerPluginDriverError('failed');
      }
      try {
        await relay.discard(relayCandidate(container, input.installationId));
      } catch (error) {
        if (error instanceof DeploymentDriverError) throw error;
        throw new DockerPluginDriverError('unknown');
      }
      let stopped: DockerEngineResponse;
      try {
        stopped = await request('POST', `/containers/${encodeURIComponent(input.deploymentId)}/stop?t=${String(Math.ceil(container.shutdownTimeoutMs / 1_000))}`);
      } catch {
        throw new DockerPluginDriverError('unknown');
      }
      if (![204, 304, 404].includes(stopped.statusCode)) readStatusError(stopped, true);
      if (stopped.statusCode === 404) return;
      let removed: DockerEngineResponse;
      try { removed = await request('DELETE', `/containers/${encodeURIComponent(input.deploymentId)}?force=false&v=false`); } catch {
        throw new DockerPluginDriverError('unknown');
      }
      if (![204, 404].includes(removed.statusCode)) readStatusError(removed, true);
    },

    async activate(input) {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId) || !isContainerId(input.candidateDeploymentId)) {
        throw new DockerPluginDriverError('failed');
      }
      const candidate = await inspectLabelsBeforeRoute(input.candidateDeploymentId, input.installationId);
      const candidateReleaseDigest = candidate.labels[RELEASE_LABEL];
      if (!isReleaseDigest(candidateReleaseDigest)) throw new DockerPluginDriverError('failed');
      if ((input.previousDeploymentId === null) !== (input.baseCurrentDigest === null)) throw new DockerPluginDriverError('failed');
      if (input.baseCurrentDigest !== null && !RELEASE_DIGEST.test(input.baseCurrentDigest)) throw new DockerPluginDriverError('failed');
      if (input.previousDeploymentId !== null) {
        const previous = await inspectLabelsBeforeRoute(input.previousDeploymentId, input.installationId, input.baseCurrentDigest ?? undefined);
        if (previous.labels[ROLE_LABEL] !== 'candidate') throw new DockerPluginDriverError('failed');
      }
      if (!(await healthCheck(candidate, input.installationId, candidateReleaseDigest, 1_000)).healthy) throw new DockerPluginDriverError('failed');
      try {
        await bounded(() => options.routing.activate({
          ownerId: options.ownerId,
          installationId: input.installationId,
          operationId: input.operationId,
          candidateDeploymentId: input.candidateDeploymentId,
          candidateReleaseDigest,
          previousDeploymentId: input.previousDeploymentId,
          baseCurrentDigest: input.baseCurrentDigest,
          configurationRevision: input.configurationRevision,
        }), requestTimeoutMs);
      } catch (error) {
        if (error instanceof DeploymentDriverError) throw error;
        throw new DockerPluginDriverError('unknown');
      }
    },

    async rollback(input) {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId) || !isContainerId(input.currentDeploymentId) || !isContainerId(input.previousDeploymentId) || !RELEASE_DIGEST.test(input.baseCurrentDigest)) {
        throw new DockerPluginDriverError('failed');
      }
      const current = await inspectLabelsBeforeRoute(input.currentDeploymentId, input.installationId, input.baseCurrentDigest);
      const previous = await inspectLabelsBeforeRoute(input.previousDeploymentId, input.installationId);
      if (current.labels[ROLE_LABEL] !== 'candidate' || previous.labels[ROLE_LABEL] !== 'candidate') throw new DockerPluginDriverError('failed');
      const previousReleaseDigest = previous.labels[RELEASE_LABEL];
      if (!isReleaseDigest(previousReleaseDigest)
        || !(await healthCheck(previous, input.installationId, previousReleaseDigest, 1_000)).healthy) throw new DockerPluginDriverError('failed');
      try {
        await bounded(() => options.routing.rollback({
          ownerId: options.ownerId,
          installationId: input.installationId,
          operationId: input.operationId,
          currentDeploymentId: input.currentDeploymentId,
          currentReleaseDigest: input.baseCurrentDigest,
          previousDeploymentId: input.previousDeploymentId,
          previousReleaseDigest,
          baseCurrentDigest: input.baseCurrentDigest,
          configurationRevision: input.configurationRevision,
        }), requestTimeoutMs);
      } catch (error) {
        if (error instanceof DeploymentDriverError) throw error;
        throw new DockerPluginDriverError('unknown');
      }
    },

    async reconcile(input): Promise<DeploymentObservation> {
      if (!OPAQUE_ID.test(input.installationId) || !OPAQUE_ID.test(input.operationId)) throw new DockerPluginDriverError('failed');
      const filters = encodeURIComponent(JSON.stringify({ label: [`${MANAGED_LABEL}=${MANAGED_VALUE}`, `${OWNER_LABEL}=${options.ownerId}`, `${INSTALLATION_LABEL}=${input.installationId}`] }));
      let response: DockerEngineResponse;
      try { response = await request('GET', `/containers/json?all=1&filters=${filters}`); } catch { throw new DockerPluginDriverError('unknown'); }
      if (response.statusCode !== 200 || !Array.isArray(response.body)) readStatusError(response, false);
      if (response.body.length > MAX_RECONCILE_CONTAINERS) throw new DockerPluginDriverError('unknown');
      const candidates = new Map<string, OwnedContainer>();
      const relaySummaries = new Map<string, ContainerSummary>();
      const listedIds = new Set<string>();
      for (const item of response.body) {
        if (!isRecord(item) || !isContainerId(item.Id) || listedIds.has(item.Id)) throw new DockerPluginDriverError('unknown');
        listedIds.add(item.Id);
        const listedLabels = asStringLabels(item.Labels);
        if (!listedLabels) throw new DockerPluginDriverError('unknown');
        if (listedLabels[MANAGED_LABEL] !== MANAGED_VALUE || listedLabels[OWNER_LABEL] !== options.ownerId || listedLabels[INSTALLATION_LABEL] !== input.installationId) {
          throw new DockerPluginDriverError('unknown');
        }
        const role = listedLabels[ROLE_LABEL];
        const operationId = listedLabels[OPERATION_LABEL];
        if (typeof operationId !== 'string' || !OPAQUE_ID.test(operationId)) throw new DockerPluginDriverError('unknown');
        const summary = { id: item.Id, labels: listedLabels, state: typeof item.State === 'string' ? item.State : '' };
        if (role === 'candidate') {
          if (candidates.has(operationId)) throw new DockerPluginDriverError('unknown');
          let inspected: OwnedContainer | null;
          try { inspected = await ownedContainer(item.Id, input.installationId); } catch { throw new DockerPluginDriverError('unknown'); }
          if (!inspected || digestSafe(inspected.labels) !== digestSafe(listedLabels)) throw new DockerPluginDriverError('unknown');
          candidates.set(operationId, inspected);
        } else if (role === 'relay') {
          if (relaySummaries.has(operationId) || !isContainerId(listedLabels['hasi.candidate'] ?? '')
            || listedLabels['hasi.relay-network'] !== options.relayNetwork
            || !options.allowedInternalNetworks.includes(listedLabels[NETWORK_LABEL] ?? '')
            || !isReleaseDigest(listedLabels[RELEASE_LABEL])
            || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(listedLabels[PLUGIN_LABEL] ?? '')) {
            throw new DockerPluginDriverError('unknown');
          }
          relaySummaries.set(operationId, summary);
        } else {
          throw new DockerPluginDriverError('unknown');
        }
      }
      const activeDeploymentId = await activeRoute(input.installationId);
      if (!candidates.has(input.operationId)) await assertNoRelayForOperation(input.installationId, input.operationId);
      if (activeDeploymentId && ![...candidates.values()].some(item => item.id === activeDeploymentId)) throw new DockerPluginDriverError('unknown');
      for (const [operationId, relaySummary] of relaySummaries) {
        const matching = candidates.get(operationId);
        if (!matching) throw new DockerPluginDriverError('unknown');
        if (relaySummary.labels['hasi.candidate'] !== matching.id
          || relaySummary.labels[PLUGIN_LABEL] !== matching.labels[PLUGIN_LABEL]
          || relaySummary.labels[RELEASE_LABEL] !== matching.labels[RELEASE_LABEL]
          || relaySummary.labels[NETWORK_LABEL] !== matching.networkMode
          || relaySummary.labels[HOST_PORT_LABEL] !== String(matching.hostPort)
          || relaySummary.labels[CONTAINER_PORT_LABEL] !== String(matching.containerPort)) {
          throw new DockerPluginDriverError('unknown');
        }
        let inspectedRelay: { readonly id: string; readonly running: boolean; readonly hostPort: number } | null;
        try { inspectedRelay = await inspectRelay(matching, input.installationId); } catch { throw new DockerPluginDriverError('unknown'); }
        if (inspectedRelay?.id !== relaySummary.id) throw new DockerPluginDriverError('unknown');
      }
      for (const [operationId, candidate] of candidates) {
        let inspectedRelay: { readonly id: string; readonly running: boolean; readonly hostPort: number } | null;
        try { inspectedRelay = await inspectRelay(candidate, input.installationId); } catch { throw new DockerPluginDriverError('unknown'); }
        if (inspectedRelay) {
          const listed = relaySummaries.get(operationId);
          if (listed?.id !== inspectedRelay.id) throw new DockerPluginDriverError('unknown');
          if (candidate.id === activeDeploymentId && (!candidate.running || !inspectedRelay.running)) throw new DockerPluginDriverError('unknown');
        } else if (operationId !== input.operationId || candidate.id === activeDeploymentId) {
          throw new DockerPluginDriverError('unknown');
        }
      }
      let routeOperationOutcome: DeploymentObservation['routeOperationOutcome'] = 'unknown';
      try {
        routeOperationOutcome = await bounded(() => options.routing.readOperationStatus({
          ownerId: options.ownerId,
          installationId: input.installationId,
          operationId: input.operationId,
        }), requestTimeoutMs);
      } catch {
        routeOperationOutcome = 'unknown';
      }
      if (!['committed', 'not-committed', 'pending', 'unknown'].includes(routeOperationOutcome)) routeOperationOutcome = 'unknown';
      const staged = candidates.get(input.operationId);
      return { activeDeploymentId, stagedDeploymentId: staged?.id ?? null, routeOperationOutcome };
    },
  };
}
