import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const JOURNEY_WEB_IMAGE_SOURCE = 'https://github.com/metaneutrons/HASI';
export const JOURNEY_WEB_IMAGE_OWNER_LABEL = 'com.hasi.plugin-journey.owner';
export const JOURNEY_WEB_IMAGE_ROLE_LABEL = 'com.hasi.plugin-journey.role';
export const JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES = [
  'HOSTNAME',
  'PORT',
  'HASI_DEMO_MODE',
  'HASI_LOCAL_TEST_IDP',
  'HASI_LOCAL_TEST_IDP_SCOPE',
  'HASI_CHAT_SIGNING_SECRET',
  'HASI_WEB_ORIGIN',
  'HASI_API_ORIGIN',
  'DATABASE_URL',
  'NODE_EXTRA_CA_CERTS',
  'CUSTOM_API_KEY',
  'HASI_LLM_CONFIG',
  'HASI_MODEL_PRICES',
  'NEXT_TELEMETRY_DISABLED',
] as const;

export type JourneyWebImageSelection = 'previous' | 'current';

export interface JourneyWebImageInputs {
  readonly previousImageId: string;
  readonly currentImageId: string;
  readonly dockerHost?: string;
}

export interface JourneyWebImageIdentity {
  readonly imageId: string;
  readonly source: typeof JOURNEY_WEB_IMAGE_SOURCE;
  readonly revision: string;
  readonly os: 'linux';
  readonly architecture: 'amd64' | 'arm64';
}

export interface JourneyWebImagePair {
  readonly previous: JourneyWebImageIdentity;
  readonly current: JourneyWebImageIdentity;
}

export class JourneyWebImageError extends Error {
  constructor(message: string, readonly recoveryRequired = false) {
    super(message);
    this.name = 'JourneyWebImageError';
  }
}

export type JourneyWebDockerCommand = (arguments_: readonly string[], environment: NodeJS.ProcessEnv) => string;

export interface JourneyWebDockerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly dockerCommand?: JourneyWebDockerCommand;
}

const FULL_IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTAINER_NAME = /^hasi-plugin-journey-web-[a-f0-9]{32}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const DOCKER_JSON_FORMAT = '--format={{json .}}';
const WEB_HEALTH_URL = 'http://127.0.0.1:3001/api/health';
const WEB_SESSION_URL = 'http://127.0.0.1:3001/api/session';
const WEB_ROOT_URL = 'http://127.0.0.1:3001/';
const WEB_PORT = 3002;
const WEB_ORIGIN = 'http://127.0.0.1:3001';
const API_ORIGIN = 'http://127.0.0.1:4100';
const WEB_HEALTH_RESPONSE_LIMIT = 4096;
const UNSUPPORTED_DOCKER_SELECTION_ENV = ['DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'] as const;

interface ImageInspectRecord {
  readonly Id?: unknown;
  readonly Os?: unknown;
  readonly Architecture?: unknown;
  readonly Config?: unknown;
}

interface ContainerInspectRecord {
  readonly Id?: unknown;
  readonly Name?: unknown;
  readonly Image?: unknown;
  readonly Config?: unknown;
  readonly State?: unknown;
}

interface OwnedContainer {
  readonly name: string;
  readonly ownerId: string;
  readonly selection: JourneyWebImageSelection;
  readonly image: JourneyWebImageIdentity;
  containerId?: string;
  state: 'starting' | 'ready' | 'retiring';
}

export interface JourneyWebImageTransition {
  readonly sequence: number;
  readonly from: JourneyWebImageSelection | null;
  readonly to: JourneyWebImageSelection;
  readonly imageId: string;
  readonly revision: string;
  readonly containerId: string;
  readonly completedAt: string;
}

export interface JourneyWebImageRuntimeSnapshot {
  readonly mode: 'test-only-immutable-web-images';
  readonly source: typeof JOURNEY_WEB_IMAGE_SOURCE;
  readonly previous: JourneyWebImageIdentity;
  readonly current: JourneyWebImageIdentity;
  readonly active: null | {
    readonly selection: JourneyWebImageSelection;
    readonly imageId: string;
    readonly revision: string;
    readonly os: 'linux';
    readonly architecture: 'amd64' | 'arm64';
    readonly containerId: string | null;
    readonly containerIdVerified: boolean;
    readonly containerName: string;
    readonly expectedOwnerLabel: { readonly name: typeof JOURNEY_WEB_IMAGE_OWNER_LABEL; readonly value: string };
    readonly state: 'starting' | 'ready' | 'retiring';
  };
  readonly transitionCount: number;
  readonly recentTransitions: readonly JourneyWebImageTransition[];
}

export interface JourneyWebImageRuntimeOptions extends JourneyWebDockerOptions {
  readonly images: JourneyWebImagePair;
  readonly commandEnvironment: NodeJS.ProcessEnv;
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
  readonly certificatePath: string;
  readonly dockerHost?: string;
  readonly onUnexpectedExit: () => void;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly monitorIntervalMs?: number;
  readonly readinessTimeoutMs?: number;
}

function hostArchitecture(architecture: string | undefined): 'amd64' | 'arm64' {
  if (architecture === 'x64') return 'amd64';
  if (architecture === 'arm64') return 'arm64';
  throw new JourneyWebImageError('The host CPU architecture is not supported for local web-image qualification.');
}

function isLocalUnixSocket(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'unix:' && url.hostname === '' && url.username === '' && url.password === ''
      && url.pathname.startsWith('/') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function requireLocalDockerHost(value: string | undefined): void {
  if (value !== undefined && !isLocalUnixSocket(value)) {
    throw new JourneyWebImageError('Web-image qualification requires a local Unix Docker socket.');
  }
}

/** Capture these trusted operator inputs before the journey sanitizes its environment. */
export function captureJourneyWebImageInputs(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): JourneyWebImageInputs {
  if (platform !== 'linux') throw new JourneyWebImageError('Web-image qualification is available only on Linux.');
  if (UNSUPPORTED_DOCKER_SELECTION_ENV.some(name => environment[name] !== undefined)) {
    throw new JourneyWebImageError('Docker context, config and TLS selection overrides are not supported for web-image qualification.');
  }
  requireLocalDockerHost(environment.DOCKER_HOST);
  const previousImageId = environment.HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID;
  const currentImageId = environment.HASI_JOURNEY_WEB_CURRENT_IMAGE_ID;
  if (!previousImageId || !FULL_IMAGE_ID.test(previousImageId) || !currentImageId || !FULL_IMAGE_ID.test(currentImageId)
    || previousImageId === currentImageId) {
    throw new JourneyWebImageError('Two distinct full immutable web-image IDs are required.');
  }
  return {
    previousImageId,
    currentImageId,
    ...(environment.DOCKER_HOST === undefined ? {} : { dockerHost: environment.DOCKER_HOST }),
  };
}

function defaultDockerCommand(arguments_: readonly string[], environment: NodeJS.ProcessEnv): string {
  return execFileSync('docker', [...arguments_], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

function commandError(error?: unknown, bindMount = false): JourneyWebImageError {
  if (bindMount && typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = error.stderr;
    const message = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    if (/bind source|mount source|invalid mount config.*bind/iu.test(message)) {
      return new JourneyWebImageError('The generated public model CA certificate is not available at the same path on the Docker host.');
    }
  }
  return new JourneyWebImageError('A local Docker qualification command failed.');
}

function parseJsonRecord(output: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new JourneyWebImageError('Docker returned invalid image or container metadata.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JourneyWebImageError('Docker returned invalid image or container metadata.');
  }
  return value as Record<string, unknown>;
}

function labelsFrom(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const labels = (value as { readonly Labels?: unknown }).Labels;
  return typeof labels === 'object' && labels !== null && !Array.isArray(labels)
    ? labels as Record<string, unknown>
    : undefined;
}

function requireImageIdentity(
  output: string,
  requestedId: string,
  expectedArchitecture: 'amd64' | 'arm64',
): JourneyWebImageIdentity {
  const record = parseJsonRecord(output) as ImageInspectRecord;
  const labels = labelsFrom(record.Config);
  const revision = labels?.['org.opencontainers.image.revision'];
  if (record.Id !== requestedId || record.Os !== 'linux' || record.Architecture !== expectedArchitecture
    || labels?.['org.opencontainers.image.source'] !== JOURNEY_WEB_IMAGE_SOURCE
    || typeof revision !== 'string' || !FULL_REVISION.test(revision)) {
    throw new JourneyWebImageError('An immutable web image has an invalid source, revision, operating system or architecture.');
  }
  return { imageId: requestedId, source: JOURNEY_WEB_IMAGE_SOURCE, revision, os: 'linux', architecture: expectedArchitecture };
}

function isMissingContainerError(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return false;
  const stderr = error.stderr;
  const message = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  return message.includes(`No such object: ${name}`) || message.includes(`No such container: ${name}`);
}

/** Inspect exact local IDs and verify expected OCI labels before any fixture mutation. */
export function inspectJourneyWebImagePair(
  inputs: JourneyWebImageInputs,
  options: JourneyWebDockerOptions = {},
): JourneyWebImagePair {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') throw new JourneyWebImageError('Web-image qualification is available only on Linux.');
  if (!FULL_IMAGE_ID.test(inputs.previousImageId) || !FULL_IMAGE_ID.test(inputs.currentImageId)
    || inputs.previousImageId === inputs.currentImageId) {
    throw new JourneyWebImageError('Two distinct full immutable web-image IDs are required.');
  }
  const expectedArchitecture = hostArchitecture(options.architecture ?? process.arch);
  requireLocalDockerHost(inputs.dockerHost);
  const dockerCommand = options.dockerCommand ?? defaultDockerCommand;
  const environment = { ...(options.environment ?? process.env) };
  if (UNSUPPORTED_DOCKER_SELECTION_ENV.some(name => environment[name] !== undefined)) {
    throw new JourneyWebImageError('Docker context, config and TLS selection overrides are not supported for web-image qualification.');
  }
  if (inputs.dockerHost !== undefined) environment.DOCKER_HOST = inputs.dockerHost;
  else {
    let contextHost: string;
    try {
      contextHost = dockerCommand(['context', 'inspect', '--format={{.Endpoints.docker.Host}}'], environment).trim();
    } catch {
      throw commandError();
    }
    if (!isLocalUnixSocket(contextHost)) throw new JourneyWebImageError('The selected Docker context is not local.');
  }
  const inspect = (imageId: string) => {
    let output: string;
    try { output = dockerCommand(['image', 'inspect', DOCKER_JSON_FORMAT, imageId], environment); } catch { throw commandError(); }
    return requireImageIdentity(output, imageId, expectedArchitecture);
  };
  const previous = inspect(inputs.previousImageId);
  const current = inspect(inputs.currentImageId);
  return { previous, current };
}

function validateRuntimeEnvironment(environment: Readonly<Record<string, string>>, certificatePath: string): void {
  const keys = Object.keys(environment).sort();
  const expectedKeys = [...JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new JourneyWebImageError('The web container environment does not match the fixture allowlist.');
  }
  for (const name of JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES) {
    if (typeof environment[name] !== 'string' || environment[name] === '' || /[\r\n]/u.test(environment[name] ?? '')) {
      throw new JourneyWebImageError('A required fixture web environment value is unavailable.');
    }
  }
  if (environment.HOSTNAME !== '127.0.0.1' || environment.PORT !== String(WEB_PORT)
    || environment.HASI_DEMO_MODE !== '0' || environment.HASI_LOCAL_TEST_IDP !== '1'
    || !UUID.test(environment.HASI_LOCAL_TEST_IDP_SCOPE ?? '')
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(environment.HASI_CHAT_SIGNING_SECRET ?? '')
    || environment.HASI_WEB_ORIGIN !== WEB_ORIGIN || environment.HASI_API_ORIGIN !== API_ORIGIN
    || environment.NODE_EXTRA_CA_CERTS !== certificatePath
    || !/^[A-Za-z0-9_-]{43}$/u.test(environment.CUSTOM_API_KEY ?? '')
    || Buffer.byteLength(environment.HASI_LLM_CONFIG ?? '') > 65_536
    || Buffer.byteLength(environment.HASI_MODEL_PRICES ?? '') > 32_768
    || environment.NEXT_TELEMETRY_DISABLED !== '1') {
    throw new JourneyWebImageError('The protected local web fixture configuration is invalid.');
  }
  try {
    const database = new URL(environment.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1'
      || !database.port || database.pathname !== '/hasi_topology_test' || database.search || database.hash || database.password) {
      throw new Error('invalid database URL');
    }
  } catch {
    throw new JourneyWebImageError('The protected local web fixture database is invalid.');
  }
}

function validateDockerContainer(record: ContainerInspectRecord, container: OwnedContainer): string {
  const labels = labelsFrom(record.Config);
  const configuredImage = typeof record.Config === 'object' && record.Config !== null && !Array.isArray(record.Config)
    ? (record.Config as { readonly Image?: unknown }).Image
    : undefined;
  const ownerLabel = labels?.[JOURNEY_WEB_IMAGE_OWNER_LABEL];
  const roleLabel = labels?.[JOURNEY_WEB_IMAGE_ROLE_LABEL];
  if (typeof record.Id !== 'string' || !CONTAINER_ID.test(record.Id)
    || (container.containerId !== undefined && record.Id !== container.containerId)
    || record.Name !== `/${container.name}` || record.Image !== container.image.imageId
    || configuredImage !== container.image.imageId || ownerLabel !== container.ownerId || roleLabel !== 'web') {
    throw new JourneyWebImageError('A web container failed exact ownership or immutable-image verification.');
  }
  return record.Id;
}

function readHealthChunk(
  reader: ReadableStreamBYOBReader,
  buffer: Uint8Array,
  signal: AbortSignal,
): Promise<{ readonly done: boolean; readonly value: Uint8Array | undefined }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const removeAbortListener = () => { signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      void reader.cancel().catch(() => undefined);
      reject(new JourneyWebImageError('The web health response timed out while reading.'));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read(buffer).then(result => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resolve({ done: result.done, value: result.value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error instanceof Error ? error : new Error('The web health response stream failed.'));
    });
  });
}

async function readBoundedHealthBody(response: Response, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return '';
  let reader: ReadableStreamBYOBReader;
  try { reader = body.getReader({ mode: 'byob' }); } catch {
    void body.cancel().catch(() => undefined);
    throw new JourneyWebImageError('The web health response does not support bounded byte streaming.');
  }
  const decoded: string[] = [];
  const decoder = new TextDecoder();
  let byteLength = 0;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  try {
    while (byteLength <= WEB_HEALTH_RESPONSE_LIMIT) {
      // One extra byte proves overflow while keeping the amount read bounded.
      const remaining = WEB_HEALTH_RESPONSE_LIMIT + 1 - byteLength;
      const result = await readHealthChunk(reader, new Uint8Array(remaining), signal);
      if (result.done) {
        decoded.push(decoder.decode());
        return decoded.join('');
      }
      const value = result.value;
      if (!value || value.byteLength === 0) throw new JourneyWebImageError('The web health response stream was invalid.');
      byteLength += value.byteLength;
      if (byteLength > WEB_HEALTH_RESPONSE_LIMIT) {
        cancelReader();
        throw new JourneyWebImageError('The web health response exceeded its bound.');
      }
      decoded.push(decoder.decode(value, { stream: true }));
    }
    throw new JourneyWebImageError('The web health response exceeded its bound.');
  } catch (error) {
    cancelReader();
    if (signal.aborted && !(error instanceof JourneyWebImageError)) {
      throw new JourneyWebImageError('The web health response timed out while reading.');
    }
    throw error;
  }
}

export class JourneyWebImageRuntime {
  private active: OwnedContainer | undefined;
  private readonly transitions: JourneyWebImageTransition[] = [];
  private transitionSequence = 0;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private unexpectedExitReported = false;
  private closed = false;
  private readonly dockerCommand: JourneyWebDockerCommand;
  private readonly commandEnvironment: NodeJS.ProcessEnv;
  private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly monitorIntervalMs: number;
  private readonly readinessTimeoutMs: number;

  constructor(private readonly options: JourneyWebImageRuntimeOptions) {
    this.dockerCommand = options.dockerCommand ?? defaultDockerCommand;
    this.commandEnvironment = { ...options.commandEnvironment };
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.delay = options.sleep ?? (milliseconds => sleep(milliseconds));
    this.now = options.now ?? Date.now;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 1000;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    if (options.platform !== undefined && options.platform !== 'linux') {
      throw new JourneyWebImageError('Web-image qualification is available only on Linux.');
    }
    hostArchitecture(options.architecture ?? process.arch);
    requireLocalDockerHost(options.dockerHost);
    validateRuntimeEnvironment(options.runtimeEnvironment, options.certificatePath);
    if (!options.certificatePath.startsWith('/') || /[,\r\n]/u.test(options.certificatePath)) {
      throw new JourneyWebImageError('The public model CA certificate path is invalid.');
    }
    if (options.dockerHost !== undefined) this.commandEnvironment.DOCKER_HOST = options.dockerHost;
  }

  async start(selection: JourneyWebImageSelection = 'current'): Promise<JourneyWebImageRuntimeSnapshot> {
    if (this.closed || this.active) throw new JourneyWebImageError('The web image runtime is not available to start.');
    await this.launch(selection, null);
    this.startMonitor();
    return this.snapshot();
  }

  async switchTo(selection: JourneyWebImageSelection): Promise<JourneyWebImageRuntimeSnapshot> {
    if (this.closed || this.active?.state !== 'ready') {
      throw new JourneyWebImageError('The web image runtime is not available to switch.');
    }
    const previous = this.active;
    this.assertRunning(previous);
    if (previous.selection === selection) return this.snapshot();
    previous.state = 'retiring';
    await this.stopOwnedContainer(previous);
    if (this.active === previous) this.active = undefined;
    await this.launch(selection, previous.selection);
    return this.snapshot();
  }

  snapshot(): JourneyWebImageRuntimeSnapshot {
    const active = this.active;
    return {
      mode: 'test-only-immutable-web-images',
      source: JOURNEY_WEB_IMAGE_SOURCE,
      previous: this.options.images.previous,
      current: this.options.images.current,
      active: active ? {
        selection: active.selection,
        imageId: active.image.imageId,
        revision: active.image.revision,
        os: active.image.os,
        architecture: active.image.architecture,
        containerId: active.containerId ?? null,
        containerIdVerified: active.containerId !== undefined,
        containerName: active.name,
        expectedOwnerLabel: { name: JOURNEY_WEB_IMAGE_OWNER_LABEL, value: active.ownerId },
        state: active.state,
      } : null,
      transitionCount: this.transitionSequence,
      recentTransitions: this.transitions.slice(-8),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    const active = this.active;
    if (!active) return;
    active.state = 'retiring';
    await this.stopOwnedContainer(active, true);
    if (this.active === active) this.active = undefined;
  }

  private image(selection: JourneyWebImageSelection): JourneyWebImageIdentity {
    return this.options.images[selection];
  }

  private dockerEnvironment(): NodeJS.ProcessEnv {
    return { ...this.commandEnvironment, ...this.options.runtimeEnvironment };
  }

  private invoke(arguments_: readonly string[], withRuntimeEnvironment = false): string {
    try {
      return this.dockerCommand(arguments_, withRuntimeEnvironment ? this.dockerEnvironment() : { ...this.commandEnvironment }).trim();
    } catch (error) {
      throw commandError(error, arguments_[0] === 'run' && arguments_.includes('--mount'));
    }
  }

  private inspectContainer(container: OwnedContainer): ContainerInspectRecord | undefined {
    let output: string;
    const target = container.containerId ?? container.name;
    try {
      output = this.dockerCommand(['container', 'inspect', DOCKER_JSON_FORMAT, target], { ...this.commandEnvironment }).trim();
    } catch (error) {
      if (isMissingContainerError(error, target)) return undefined;
      throw commandError();
    }
    const record = parseJsonRecord(output) as ContainerInspectRecord;
    container.containerId = validateDockerContainer(record, container);
    return record;
  }

  private assertRunning(container: OwnedContainer): void {
    const inspected = this.inspectContainer(container);
    const state = typeof inspected?.State === 'object' && inspected.State !== null && !Array.isArray(inspected.State)
      ? inspected.State as { readonly Running?: unknown }
      : undefined;
    if (!inspected || state?.Running !== true) throw new JourneyWebImageError('The owned web container is not running.');
  }

  private async launch(selection: JourneyWebImageSelection, from: JourneyWebImageSelection | null): Promise<void> {
    const image = this.image(selection);
    const suffix = randomUUID().replaceAll('-', '');
    const name = `hasi-plugin-journey-web-${suffix}`;
    const ownerId = randomUUID();
    if (!CONTAINER_NAME.test(name)) throw new JourneyWebImageError('A unique web container name could not be created.');
    const container: OwnedContainer = { name, ownerId, selection, image, state: 'starting' };
    // Record the exact generated name and owner before Docker can create anything.
    this.active = container;
    const arguments_: string[] = [
      'run', '--detach', '--rm', '--name', name,
      '--label', `${JOURNEY_WEB_IMAGE_OWNER_LABEL}=${ownerId}`,
      '--label', `${JOURNEY_WEB_IMAGE_ROLE_LABEL}=web`,
      '--pull=never', '--network', 'host', '--read-only',
      '--user', '1000:1000', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
      '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--mount', `type=bind,source=${this.options.certificatePath},target=${this.options.certificatePath},readonly`,
    ];
    for (const name_ of JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES) arguments_.push('--env', name_);
    arguments_.push(image.imageId);
    let reportedId: string;
    try { reportedId = this.invoke(arguments_, true); } catch (error) {
      // The CLI can fail after creation. Best-effort inspection may adopt the
      // verified full ID, but failure keeps the starting recovery record.
      try { this.findContainerForCleanup(container); } catch { /* Retry from close using the retained name and owner label. */ }
      throw error;
    }
    let created: ContainerInspectRecord | undefined;
    try { created = this.inspectContainer(container); } catch {
      throw new JourneyWebImageError('The created web container could not be verified.', true);
    }
    if (!created || !CONTAINER_ID.test(reportedId) || created.Id !== reportedId) {
      throw new JourneyWebImageError('Docker did not return the verified full owned web container ID.', true);
    }
    this.assertRunning(container);
    await this.waitForReadiness(container);
    this.assertRunning(container);
    container.state = 'ready';
    const containerId = container.containerId;
    if (!containerId) throw new JourneyWebImageError('The ready web container has no verified immutable ID.', true);
    this.transitionSequence += 1;
    this.transitions.push({ sequence: this.transitionSequence, from, to: selection, imageId: image.imageId,
      revision: image.revision, containerId, completedAt: new Date().toISOString() });
    if (this.transitions.length > 32) this.transitions.splice(0, this.transitions.length - 32);
  }

  private findContainerForCleanup(container: OwnedContainer): void {
    this.inspectContainer(container);
  }

  private async waitForReadiness(container: OwnedContainer): Promise<void> {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline) {
      if (container.state === 'retiring' || this.active !== container) throw new JourneyWebImageError('The web container changed during readiness.');
      this.assertRunning(container);
      try {
        const readTimeoutMs = Math.max(1, Math.min(1000, deadline - this.now()));
        const readSignal = AbortSignal.timeout(readTimeoutMs);
        const health = await this.fetcher(WEB_HEALTH_URL, { signal: readSignal, redirect: 'error' });
        const body = await readBoundedHealthBody(health, readSignal);
        let value: unknown;
        try { value = JSON.parse(body); } catch { value = undefined; }
        if (health.ok && typeof value === 'object' && value !== null && !Array.isArray(value)
          && 'status' in value && value.status === 'ready') {
          if (!('revision' in value) || value.revision !== container.image.revision) {
            throw new JourneyWebImageError('The running web image revision did not match its immutable image label.');
          }
          await this.waitForWebEndpoint(WEB_SESSION_URL);
          await this.waitForWebEndpoint(WEB_ROOT_URL);
          return;
        }
      } catch (error) {
        if (error instanceof JourneyWebImageError) throw error;
      }
      await this.delay(100);
    }
    throw new JourneyWebImageError('The immutable web image did not become ready through the fixed loopback proxy.');
  }

  private async waitForWebEndpoint(url: string): Promise<void> {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline) {
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* Retry only this fixed local endpoint within the readiness bound. */ }
      await this.delay(100);
    }
    throw new JourneyWebImageError('A fixed protected web endpoint did not become ready.');
  }

  private startMonitor(): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => {
      const container = this.active;
      if (container?.state !== 'ready' || this.closed || this.unexpectedExitReported) return;
      try {
        this.assertRunning(container);
      } catch {
        this.unexpectedExitReported = true;
        this.options.onUnexpectedExit();
      }
    }, this.monitorIntervalMs);
    this.monitor.unref();
  }

  private async waitForContainerGone(container: OwnedContainer): Promise<boolean> {
    const deadline = this.now() + 10_000;
    while (this.now() < deadline) {
      const inspected = this.inspectContainer(container);
      if (!inspected) return true;
      const state = typeof inspected.State === 'object' && inspected.State !== null && !Array.isArray(inspected.State)
        ? inspected.State as { readonly Running?: unknown }
        : undefined;
      if (state?.Running === false) return false;
      await this.delay(100);
    }
    return !this.inspectContainer(container);
  }

  private async stopOwnedContainer(container: OwnedContainer, absenceOkay = false): Promise<void> {
    const before = this.inspectContainer(container);
    if (!before) {
      if (absenceOkay) return;
      throw new JourneyWebImageError('The owned web container stopped before its intentional transition.');
    }
    const state = typeof before.State === 'object' && before.State !== null && !Array.isArray(before.State)
      ? before.State as { readonly Running?: unknown }
      : undefined;
    const containerId = container.containerId;
    if (!containerId) throw new JourneyWebImageError('An owned web container has no verified immutable ID.');
    if (state?.Running !== true && state?.Running !== false) {
      throw new JourneyWebImageError('An owned web container has an unknown runtime state.');
    }
    if (state.Running) {
      try { this.invoke(['container', 'stop', '--time', '5', containerId]); } catch { /* Exact-ID absence and state are checked below. */ }
      if (await this.waitForContainerGone(container)) return;
    }
    // Re-inspect by immutable ID immediately before targeted removal. This
    // handles both Docker --rm races and containers retained in a stopped state.
    const lingering = this.inspectContainer(container);
    if (!lingering) return;
    const lingeringState = typeof lingering.State === 'object' && lingering.State !== null && !Array.isArray(lingering.State)
      ? lingering.State as { readonly Running?: unknown }
      : undefined;
    if (lingeringState?.Running !== false) throw new JourneyWebImageError('An owned web container did not stop.');
    const verifiedId = container.containerId;
    if (!verifiedId) throw new JourneyWebImageError('An owned web container has no verified immutable ID.');
    try { this.invoke(['container', 'rm', '--force', verifiedId]); } catch { /* Confirm absence below. */ }
    if (!await this.waitForContainerGone(container)) throw new JourneyWebImageError('An owned web container could not be removed.');
  }
}

export function journeyWebImageRuntimeEnvironment(input: {
  readonly scope: string;
  readonly signingSecret: string;
  readonly databaseUrl: string;
  readonly certificatePath: string;
  readonly modelToken: string;
  readonly llmConfig: string;
  readonly modelPrices: string;
}): Readonly<Record<string, string>> {
  return {
    HOSTNAME: '127.0.0.1',
    PORT: String(WEB_PORT),
    HASI_DEMO_MODE: '0',
    HASI_LOCAL_TEST_IDP: '1',
    HASI_LOCAL_TEST_IDP_SCOPE: input.scope,
    HASI_CHAT_SIGNING_SECRET: input.signingSecret,
    HASI_WEB_ORIGIN: WEB_ORIGIN,
    HASI_API_ORIGIN: API_ORIGIN,
    DATABASE_URL: input.databaseUrl,
    NODE_EXTRA_CA_CERTS: input.certificatePath,
    CUSTOM_API_KEY: input.modelToken,
    HASI_LLM_CONFIG: input.llmConfig,
    HASI_MODEL_PRICES: input.modelPrices,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}
