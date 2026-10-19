import { createHash } from 'node:crypto';
import type { DockerEngineResponse } from './docker-plugin-driver.js';
import { DockerPluginDriverError } from './docker-plugin-errors.js';
import { PLUGIN_RELAY_PROGRAM } from './plugin-relay-program.js';

export const DOCKER_PLUGIN_MANAGED_VALUE = 'hasi-docker-plugin-driver-v2';
export const PLUGIN_RELAY_IMAGE = 'docker.io/library/node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
export const PLUGIN_RELAY_PORT = 8080;
export const PLUGIN_RELAY_RESOURCES = Object.freeze({ cpuMillicores: 250, memoryBytes: 128 * 1024 * 1024, pidsLimit: 32 });
const PROGRAM_DIGEST = createHash('sha256').update(PLUGIN_RELAY_PROGRAM).digest('hex');
const IMAGE_DIGEST = PLUGIN_RELAY_IMAGE.slice(PLUGIN_RELAY_IMAGE.lastIndexOf('@') + 1);
const MAX_MEMBERS = 256;
const ID = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

type EngineObject = Record<string, unknown>;
export type PluginRelayRequest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<DockerEngineResponse>;

export interface RelayCandidate {
  readonly id: string;
  readonly installationId: string;
  readonly operationId: string;
  readonly pluginId: string;
  readonly releaseDigest: string;
  readonly networkName: string;
  readonly internalAddress: string | null;
  readonly running: boolean;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly shutdownTimeoutMs: number;
}

export interface PluginRelayObservation {
  readonly id: string;
  readonly running: boolean;
  readonly hostPort: number;
}

export function dockerPluginContainerName(ownerId: string, installationId: string, operationId: string): string {
  const hash = (value: string, size: number) => createHash('sha256').update(value).digest('hex').slice(0, size);
  return `hasi-plugin-${hash(ownerId, 8)}-${hash(installationId, 10)}-${hash(operationId, 10)}`;
}

function record(value: unknown): value is EngineObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0)
    || (record(value) && Object.keys(value).length === 0);
}

function port(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

export function isPrivatePluginIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u.test(value)) return false;
  const octets = value.split('.').map(Number);
  return octets.every(item => item <= 255) && (octets[0] === 10
    || (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168));
}

function environment(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > 32) throw new DockerPluginDriverError('failed');
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 8192 || item.includes('\0')) throw new DockerPluginDriverError('failed');
    const separator = item.indexOf('=');
    const name = item.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || names.has(name)) throw new DockerPluginDriverError('failed');
    names.add(name);
    entries.push([name, item.slice(separator + 1)]);
  }
  return Object.fromEntries(entries);
}

function sameEnvironment(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value);
}

function loopbackBinding(value: unknown, hostPort: number): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) return false;
  return Object.keys(value[0]).length === 2 && value[0].HostIp === '127.0.0.1' && value[0].HostPort === String(hostPort);
}

function validateCandidate(candidate: RelayCandidate): void {
  if (!ID.test(candidate.id) || !OPAQUE_ID.test(candidate.installationId) || !OPAQUE_ID.test(candidate.operationId)
    || !DIGEST.test(candidate.releaseDigest) || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(candidate.pluginId)
    || !/^[a-z][a-z0-9-]{0,62}$/u.test(candidate.networkName) || !port(candidate.hostPort) || !port(candidate.containerPort)
    || !Number.isSafeInteger(candidate.shutdownTimeoutMs) || candidate.shutdownTimeoutMs < 1 || candidate.shutdownTimeoutMs > 30_000
    || (candidate.internalAddress !== null && !isPrivatePluginIPv4(candidate.internalAddress))
    || (candidate.running && !candidate.internalAddress)) throw new DockerPluginDriverError('failed');
}

export function createDockerPluginRelay(options: {
  readonly ownerId: string;
  readonly networkName: string;
  readonly request: PluginRelayRequest;
}) {
  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<DockerEngineResponse> => {
    try { return await options.request(method, path, body); } catch { throw new DockerPluginDriverError('unknown'); }
  };
  const name = (candidate: RelayCandidate) => `${dockerPluginContainerName(options.ownerId, candidate.installationId, candidate.operationId)}-relay`;

  async function relayImageEnvironment(): Promise<Record<string, string>> {
    const response = await request('GET', `/images/${encodeURIComponent(PLUGIN_RELAY_IMAGE)}/json`);
    if (response.statusCode !== 200 || !record(response.body) || !Array.isArray(response.body.RepoDigests)
      || !response.body.RepoDigests.some(value => value === PLUGIN_RELAY_IMAGE || value === `node@${IMAGE_DIGEST}`)
      || !record(response.body.Config) || !empty(response.body.Config.Volumes)) throw new DockerPluginDriverError('failed');
    const values = environment(response.body.Config.Env);
    if (!Object.keys(values).every(key => ['PATH', 'NODE_VERSION', 'YARN_VERSION'].includes(key))) throw new DockerPluginDriverError('failed');
    return values;
  }

  async function network(networkName: string, internal: boolean): Promise<EngineObject> {
    const response = await request('GET', `/networks/${encodeURIComponent(networkName)}`);
    if (response.statusCode !== 200 || !record(response.body)) throw new DockerPluginDriverError('failed');
    const value = response.body;
    if (value.Name !== networkName || value.Driver !== 'bridge' || value.Internal !== internal || value.EnableIPv6 !== false
      || !record(value.Labels) || value.Labels['hasi.owner'] !== options.ownerId
      || value.Labels['hasi.managed-by'] !== DOCKER_PLUGIN_MANAGED_VALUE
      || !record(value.Containers) || Object.keys(value.Containers).length > MAX_MEMBERS) throw new DockerPluginDriverError('failed');
    if (internal && (!record(value.Options) || value.Options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated')) throw new DockerPluginDriverError('failed');
    return value;
  }

  async function preflight(): Promise<void> {
    await relayImageEnvironment();
    const details = await network(options.networkName, false);
    for (const id of Object.keys(details.Containers as EngineObject)) {
      if (!ID.test(id)) throw new DockerPluginDriverError('failed');
      const response = await request('GET', `/containers/${id}/json`);
      if (response.statusCode !== 200 || !record(response.body) || !record(response.body.Config)
        || !record(response.body.Config.Labels)) throw new DockerPluginDriverError('failed');
      const labels = response.body.Config.Labels;
      if (labels['hasi.owner'] !== options.ownerId || labels['hasi.managed-by'] !== DOCKER_PLUGIN_MANAGED_VALUE
        || labels['hasi.role'] !== 'relay' || response.body.Config.Image !== PLUGIN_RELAY_IMAGE) throw new DockerPluginDriverError('failed');
    }
  }

  function labels(candidate: RelayCandidate, address: string): Record<string, string> {
    return {
      'hasi.managed-by': DOCKER_PLUGIN_MANAGED_VALUE,
      'hasi.owner': options.ownerId,
      'hasi.installation': candidate.installationId,
      'hasi.plugin': candidate.pluginId,
      'hasi.release': candidate.releaseDigest,
      'hasi.image': PLUGIN_RELAY_IMAGE,
      'hasi.operation': candidate.operationId,
      'hasi.role': 'relay',
      'hasi.candidate': candidate.id,
      'hasi.network': candidate.networkName,
      'hasi.relay-network': options.networkName,
      'hasi.target-address': address,
      'hasi.host-port': String(candidate.hostPort),
      'hasi.container-port': String(candidate.containerPort),
      'hasi.relay-program': PROGRAM_DIGEST,
    };
  }

  function assignedEnvironment(candidate: RelayCandidate, address: string): Record<string, string> {
    return { HASI_RELAY_TARGET_ADDRESS: address, HASI_RELAY_TARGET_PORT: String(candidate.containerPort), HASI_RELAY_LISTEN_PORT: String(PLUGIN_RELAY_PORT) };
  }

  async function internalMembers(candidate: RelayCandidate, relayId?: string, relayRunning = false): Promise<void> {
    const details = await network(candidate.networkName, true);
    const members = Object.keys(details.Containers as EngineObject);
    if (!members.every(id => id === candidate.id || id === relayId)
      || (candidate.running && !members.includes(candidate.id))
      || (relayRunning && (!relayId || !members.includes(relayId)))) throw new DockerPluginDriverError('failed');
  }

  async function inspect(candidate: RelayCandidate): Promise<PluginRelayObservation | null> {
    validateCandidate(candidate);
    const response = await request('GET', `/containers/${encodeURIComponent(name(candidate))}/json`);
    if (response.statusCode === 404) return null;
    if (response.statusCode !== 200 || !record(response.body)) throw new DockerPluginDriverError('unknown');
    const body = response.body;
    if (!ID.test(String(body.Id)) || body.Name !== `/${name(candidate)}` || !record(body.Config)
      || !record(body.HostConfig) || !record(body.State) || !record(body.NetworkSettings)) throw new DockerPluginDriverError('failed');
    const id = String(body.Id);
    const config = body.Config;
    const host = body.HostConfig;
    const settings = body.NetworkSettings;
    const actualLabels = config.Labels;
    if (!record(actualLabels) || !isPrivatePluginIPv4(actualLabels['hasi.target-address'])) throw new DockerPluginDriverError('failed');
    const address = candidate.internalAddress ?? actualLabels['hasi.target-address'];
    const expectedLabels = labels(candidate, address);
    if (Object.keys(actualLabels).length !== Object.keys(expectedLabels).length
      || !Object.entries(expectedLabels).every(([key, value]) => actualLabels[key] === value)) throw new DockerPluginDriverError('failed');
    const baseEnvironment = await relayImageEnvironment();
    if (!sameEnvironment(environment(config.Env), { ...baseEnvironment, ...assignedEnvironment(candidate, address) })) throw new DockerPluginDriverError('failed');
    if (config.Image !== PLUGIN_RELAY_IMAGE || config.User !== '65532:65532' || config.WorkingDir !== '/'
      || JSON.stringify(config.Entrypoint) !== JSON.stringify(['node', '--input-type=module', '-e', PLUGIN_RELAY_PROGRAM])
      || !empty(config.Cmd) || !empty(config.Volumes)
      || host.NetworkMode !== options.networkName || host.ReadonlyRootfs !== true || host.Privileged !== false
      || JSON.stringify(host.CapDrop) !== '["ALL"]' || !empty(host.CapAdd)
      || JSON.stringify(host.SecurityOpt) !== '["no-new-privileges:true"]'
      || host.NanoCpus !== PLUGIN_RELAY_RESOURCES.cpuMillicores * 1_000_000
      || host.Memory !== PLUGIN_RELAY_RESOURCES.memoryBytes || host.MemorySwap !== PLUGIN_RELAY_RESOURCES.memoryBytes
      || host.PidsLimit !== PLUGIN_RELAY_RESOURCES.pidsLimit || host.PublishAllPorts !== false
      || host.AutoRemove !== false || !record(host.RestartPolicy)
      || host.RestartPolicy.Name !== 'no' || host.RestartPolicy.MaximumRetryCount !== 0
      || !empty(host.Binds) || !empty(host.Mounts) || !empty(body.Mounts) || !empty(host.Tmpfs)
      || !empty(host.Devices) || !empty(host.DeviceRequests) || !empty(host.DeviceCgroupRules)
      || !empty(host.Links) || !empty(host.VolumesFrom) || !empty(host.ExtraHosts)
      || ![undefined, ''].includes(host.PidMode as string | undefined)
      || ![undefined, ''].includes(host.UTSMode as string | undefined)
      || host.IpcMode !== 'private' || host.CgroupnsMode !== 'private'
      || ![undefined, ''].includes(host.UsernsMode as string | undefined)) throw new DockerPluginDriverError('failed');
    const key = `${String(PLUGIN_RELAY_PORT)}/tcp`;
    if (!record(config.ExposedPorts) || Object.keys(config.ExposedPorts).length !== 1 || !Object.hasOwn(config.ExposedPorts, key)
      || !record(host.PortBindings) || Object.keys(host.PortBindings).length !== 1
      || !loopbackBinding(host.PortBindings[key], candidate.hostPort)
      || !record(settings.Networks) || Object.keys(settings.Networks).length !== 2
      || !Object.hasOwn(settings.Networks, candidate.networkName) || !Object.hasOwn(settings.Networks, options.networkName)) throw new DockerPluginDriverError('failed');
    const running = body.State.Running === true;
    if (running && (!record(settings.Ports) || Object.keys(settings.Ports).length !== 1
      || !loopbackBinding(settings.Ports[key], candidate.hostPort))) throw new DockerPluginDriverError('failed');
    await preflight();
    await internalMembers(candidate, id, running);
    return { id, running, hostPort: candidate.hostPort };
  }

  async function stage(candidate: RelayCandidate): Promise<void> {
    validateCandidate(candidate);
    if (!candidate.running || !candidate.internalAddress) throw new DockerPluginDriverError('failed');
    await preflight();
    await internalMembers(candidate);
    const key = `${String(PLUGIN_RELAY_PORT)}/tcp`;
    const body = {
      Image: PLUGIN_RELAY_IMAGE, User: '65532:65532', WorkingDir: '/',
      Entrypoint: ['node', '--input-type=module', '-e', PLUGIN_RELAY_PROGRAM], Cmd: [],
      Env: Object.entries(assignedEnvironment(candidate, candidate.internalAddress)).map(([key, value]) => `${key}=${value}`),
      Labels: labels(candidate, candidate.internalAddress), ExposedPorts: { [key]: {} },
      AttachStdin: false, AttachStdout: false, AttachStderr: false, OpenStdin: false, StdinOnce: false, Tty: false,
      StopTimeout: Math.max(1, Math.ceil(candidate.shutdownTimeoutMs / 1_000)),
      HostConfig: {
        NetworkMode: options.networkName,
        PortBindings: { [key]: [{ HostIp: '127.0.0.1', HostPort: String(candidate.hostPort) }] },
        PublishAllPorts: false, AutoRemove: false, ReadonlyRootfs: true, Privileged: false,
        CapAdd: [], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: PLUGIN_RELAY_RESOURCES.pidsLimit, NanoCpus: PLUGIN_RELAY_RESOURCES.cpuMillicores * 1_000_000,
        Memory: PLUGIN_RELAY_RESOURCES.memoryBytes, MemorySwap: PLUGIN_RELAY_RESOURCES.memoryBytes,
        IpcMode: 'private', CgroupnsMode: 'private', PidMode: '', UTSMode: '', UsernsMode: '',
        Binds: [], Mounts: [], Devices: [], DeviceRequests: [], RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
      NetworkingConfig: { EndpointsConfig: { [options.networkName]: {}, [candidate.networkName]: {} } },
    };
    const created = await request('POST', `/containers/create?name=${encodeURIComponent(name(candidate))}`, body);
    if (created.statusCode !== 201 || !record(created.body) || !ID.test(String(created.body.Id))) throw new DockerPluginDriverError('unknown');
    const started = await request('POST', `/containers/${String(created.body.Id)}/start`);
    if (started.statusCode !== 204) throw new DockerPluginDriverError('unknown');
    const observed = await inspect(candidate);
    if (!observed?.running || observed.id !== created.body.Id) throw new DockerPluginDriverError('unknown');
  }

  async function discard(candidate: RelayCandidate): Promise<void> {
    const observed = await inspect(candidate);
    if (!observed) return;
    const stopped = await request('POST', `/containers/${observed.id}/stop?t=${String(Math.ceil(candidate.shutdownTimeoutMs / 1_000))}`);
    if (![204, 304, 404].includes(stopped.statusCode)) throw new DockerPluginDriverError('unknown');
    if (stopped.statusCode === 404) return;
    const removed = await request('DELETE', `/containers/${observed.id}?force=false&v=false`);
    if (![204, 404].includes(removed.statusCode)) throw new DockerPluginDriverError('unknown');
  }

  return { preflight, stage, inspect, discard };
}
