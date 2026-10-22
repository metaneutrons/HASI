import { describe, expect, it, vi } from 'vitest';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { ReadableByteStreamController, UnderlyingByteSource } from 'node:stream/web';
import {
  captureJourneyWebImageInputs,
  inspectJourneyWebImagePair,
  JourneyWebImageError,
  JourneyWebImageRuntime,
  JOURNEY_WEB_IMAGE_OWNER_LABEL,
  JOURNEY_WEB_IMAGE_ROLE_LABEL,
  JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES,
  JOURNEY_WEB_IMAGE_SOURCE,
  journeyWebImageRuntimeEnvironment,
  type JourneyWebDockerCommand,
  type JourneyWebImagePair,
} from '../scripts/plugin-journey-web-images.js';
import { journeyFixtureCommands, journeyOperation, journeyWebImageProxyPath, journeyWebImageProxyTarget, parseJourneyFixtureCommand } from '../scripts/serve-plugin-journey.js';

const previousImageId = `sha256:${'a'.repeat(64)}`;
const currentImageId = `sha256:${'b'.repeat(64)}`;
const previousRevision = '1'.repeat(40);
const currentRevision = '2'.repeat(40);
const dockerHost = 'unix:///var/run/docker.sock';
const certificatePath = '/tmp/hasi-plugin-journey-test/model-cert.pem';

interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean };
}

interface FakeDocker {
  readonly command: JourneyWebDockerCommand;
  readonly calls: { readonly arguments_: readonly string[]; readonly environment: NodeJS.ProcessEnv }[];
  readonly containers: Map<string, FakeContainer>;
  readonly images: Map<string, string>;
  remove(name: string): void;
  setRunBehavior(value: 'normal' | 'create-stopped-then-throw' | 'create-then-bad-id' | 'create-then-throw'): void;
  failNextContainerInspections(count: number): void;
  setAmbiguousImageMetadata(value: boolean): void;
  setAmbiguousContainerMetadata(value: boolean): void;
  setRetainStoppedContainers(value: boolean): void;
  getActiveRevision(): string | undefined;
}

function fakeDocker(overrides: {
  readonly previousRevision?: string;
  readonly currentRevision?: string;
  readonly previousSource?: string;
  readonly currentSource?: string;
  readonly previousArchitecture?: string;
  readonly currentArchitecture?: string;
} = {}): FakeDocker {
  const calls: { arguments_: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
  const containers = new Map<string, FakeContainer>();
  const images = new Map<string, string>([[previousImageId, overrides.previousRevision ?? previousRevision],
    [currentImageId, overrides.currentRevision ?? currentRevision]]);
  const imageMetadata = new Map<string, Record<string, unknown>>([
    [previousImageId, { Id: previousImageId, Os: 'linux', Architecture: overrides.previousArchitecture ?? 'amd64',
      Config: { Labels: { 'org.opencontainers.image.source': overrides.previousSource ?? JOURNEY_WEB_IMAGE_SOURCE,
        'org.opencontainers.image.revision': overrides.previousRevision ?? previousRevision } } }],
    [currentImageId, { Id: currentImageId, Os: 'linux', Architecture: overrides.currentArchitecture ?? 'amd64',
      Config: { Labels: { 'org.opencontainers.image.source': overrides.currentSource ?? JOURNEY_WEB_IMAGE_SOURCE,
        'org.opencontainers.image.revision': overrides.currentRevision ?? currentRevision } } }],
  ]);
  let nextId = 0;
  let runBehavior: FakeDocker['setRunBehavior'] extends (value: infer T) => void ? T : never = 'normal';
  let containerInspectionFailures = 0;
  let ambiguousImageMetadata = false;
  let ambiguousContainerMetadata = false;
  let retainStoppedContainers = false;
  const command: JourneyWebDockerCommand = (arguments_, environment) => {
    const copy = [...arguments_];
    calls.push({ arguments_: copy, environment: { ...environment } });
    if (copy[0] === 'context' && copy[1] === 'inspect') return dockerHost;
    if (copy[0] === 'image' && copy[1] === 'inspect') {
      const id = copy.at(-1);
      const metadata = id ? imageMetadata.get(id) : undefined;
      if (!metadata) throw new Error('missing image');
      return JSON.stringify(ambiguousImageMetadata ? [metadata] : metadata);
    }
    if (copy[0] === 'run') {
      const nameIndex = copy.indexOf('--name');
      const name = copy[nameIndex + 1];
      const ownerArgument = copy.find(argument => argument.startsWith(`${JOURNEY_WEB_IMAGE_OWNER_LABEL}=`));
      const imageId = copy.at(-1);
      const ownerId = ownerArgument?.slice(`${JOURNEY_WEB_IMAGE_OWNER_LABEL}=`.length);
      if (!name || !imageId || !ownerId || !images.has(imageId)) throw new Error('invalid test run');
      nextId += 1;
      const id = String(nextId).padStart(64, '0');
      containers.set(name, { Id: id, Name: `/${name}`, Image: imageId,
        Config: { Image: imageId, Labels: { [JOURNEY_WEB_IMAGE_OWNER_LABEL]: ownerId, [JOURNEY_WEB_IMAGE_ROLE_LABEL]: 'web' } },
        State: { Running: runBehavior !== 'create-stopped-then-throw' } });
      if (runBehavior === 'create-stopped-then-throw' || runBehavior === 'create-then-throw') throw new Error('docker run failed after create');
      return runBehavior === 'create-then-bad-id' ? 'not-a-full-id' : id;
    }
    if (copy[0] === 'container' && copy[1] === 'inspect') {
      const target = copy.at(-1);
      if (containerInspectionFailures > 0) {
        containerInspectionFailures -= 1;
        throw Object.assign(new Error('metadata unavailable'), { stderr: Buffer.from('Error: daemon temporarily unavailable') });
      }
      const container = target ? containers.get(target) ?? [...containers.values()].find(value => value.Id === target) : undefined;
      if (!container) throw Object.assign(new Error('missing container'), { stderr: Buffer.from(`Error: No such object: ${target ?? ''}`) });
      return JSON.stringify(ambiguousContainerMetadata ? [container] : container);
    }
    if (copy[0] === 'container' && copy[1] === 'stop') {
      const target = copy.at(-1);
      const found = target ? [...containers.entries()].find(([name, value]) => name === target || value.Id === target) : undefined;
      if (!found) throw new Error('missing container to stop');
      const [name, container] = found;
      if (retainStoppedContainers) container.State.Running = false;
      else containers.delete(name);
      return target ?? '';
    }
    if (copy[0] === 'container' && copy[1] === 'rm') {
      const target = copy.at(-1);
      const found = target ? [...containers.entries()].find(([name, value]) => name === target || value.Id === target) : undefined;
      if (!found) throw new Error('missing container to remove');
      containers.delete(found[0]);
      return target ?? '';
    }
    throw new Error('unexpected Docker command');
  };
  return {
    command,
    calls,
    containers,
    images,
    remove: name => { containers.delete(name); },
    setRunBehavior: value => { runBehavior = value; },
    failNextContainerInspections: count => { containerInspectionFailures = count; },
    setAmbiguousImageMetadata: value => { ambiguousImageMetadata = value; },
    setAmbiguousContainerMetadata: value => { ambiguousContainerMetadata = value; },
    setRetainStoppedContainers: value => { retainStoppedContainers = value; },
    getActiveRevision: () => {
      const active = [...containers.values()].find(container => container.State.Running);
      return active ? images.get(active.Image) : undefined;
    },
  };
}

function captureInputs(host = dockerHost) {
  return captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: previousImageId,
    HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: currentImageId, DOCKER_HOST: host }, 'linux');
}

function imagePair(docker: FakeDocker): JourneyWebImagePair {
  return inspectJourneyWebImagePair(captureInputs(), { platform: 'linux', architecture: 'x64', environment: { PATH: '/usr/bin' }, dockerCommand: docker.command });
}

function runtimeEnvironment() {
  return journeyWebImageRuntimeEnvironment({ scope: '123e4567-e89b-42d3-a456-426614174000',
    signingSecret: 's'.repeat(43), databaseUrl: 'postgres://postgres@127.0.0.1:55432/hasi_topology_test',
    certificatePath, modelToken: 'm'.repeat(43), llmConfig: '{"schemaVersion":1}', modelPrices: '[{"provider":"custom"}]' });
}

function runtimeOptions(docker: FakeDocker, onUnexpectedExit: () => void, overrides: {
  monitorIntervalMs?: number;
  readinessTimeoutMs?: number;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
} = {}) {
  return {
    images: imagePair(docker), platform: 'linux' as const, architecture: 'x64', dockerHost,
    commandEnvironment: { PATH: '/usr/bin', HOME: '/tmp', DOCKER_HOST: dockerHost },
    runtimeEnvironment: runtimeEnvironment(), certificatePath,
    dockerCommand: docker.command,
    fetcher: (input: string) => {
      if (input.endsWith('/api/health')) {
        const revision = docker.getActiveRevision();
        return Promise.resolve(new Response(JSON.stringify(revision ? { status: 'ready', revision } : { status: 'unavailable' }), { status: revision ? 200 : 503 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    sleep: () => Promise.resolve(),
    onUnexpectedExit,
    readinessTimeoutMs: 100,
    ...overrides,
  };
}

type ByteReadableStreamConstructor = new (source: UnderlyingByteSource) => ReadableStream<Uint8Array>;
const ByteReadableStream = NodeReadableStream as unknown as ByteReadableStreamConstructor;

function byteStreamResponse(input: Uint8Array, options: { readonly onCancel: () => void; readonly onRead: (count: number) => void }): Response {
  let offset = 0;
  const source: UnderlyingByteSource = {
    type: 'bytes',
    pull(controller: ReadableByteStreamController) {
      const request = controller.byobRequest;
      const view = request?.view;
      if (!request || !(view instanceof Uint8Array)) throw new Error('Expected a bounded BYOB health read.');
      if (offset >= input.byteLength) {
        controller.close();
        request.respond(0);
        return;
      }
      const length = Math.min(2048, view.byteLength, input.byteLength - offset);
      view.set(input.subarray(offset, offset + length));
      offset += length;
      options.onRead(length);
      request.respond(length);
    },
    cancel() { options.onCancel(); },
  };
  const stream = new ByteReadableStream(source);
  return new Response(stream, { status: 200 });
}

describe('test-only immutable web-image admission', () => {
  it('requires distinct full image IDs on Linux and a local Unix Docker socket', () => {
    expect(() => captureJourneyWebImageInputs({ DOCKER_HOST: dockerHost }, 'linux')).toThrow(JourneyWebImageError);
    expect(() => captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: 'latest',
      HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: currentImageId, DOCKER_HOST: dockerHost }, 'linux')).toThrow('full immutable web-image IDs');
    expect(() => captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: previousImageId,
      HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: previousImageId, DOCKER_HOST: dockerHost }, 'linux')).toThrow('full immutable web-image IDs');
    expect(() => captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: previousImageId,
      HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: currentImageId, DOCKER_HOST: 'tcp://docker.example:2375' }, 'linux')).toThrow('local Unix Docker socket');
    expect(() => captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: previousImageId,
      HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: currentImageId, DOCKER_HOST: dockerHost }, 'darwin')).toThrow('only on Linux');
  });

  it.each(['DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'] as const)(
    'rejects %s before any Docker command or mutation', name => {
      const docker = fakeDocker();
      expect(() => captureJourneyWebImageInputs({ HASI_JOURNEY_WEB_PREVIOUS_IMAGE_ID: previousImageId,
        HASI_JOURNEY_WEB_CURRENT_IMAGE_ID: currentImageId, DOCKER_HOST: dockerHost, [name]: '/operator/override' }, 'linux'))
        .toThrow('selection overrides are not supported');
      expect(() => inspectJourneyWebImagePair(captureInputs(), { platform: 'linux', architecture: 'x64',
        environment: { PATH: '/usr/bin', [name]: '/operator/override' }, dockerCommand: docker.command }))
        .toThrow('selection overrides are not supported');
      expect(docker.calls).toHaveLength(0);
    });

  it.each([
    ['untrusted source', { currentSource: 'https://example.invalid/repo' }],
    ['invalid revision', { currentRevision: 'unknown' }],
    ['incompatible architecture', { currentArchitecture: 'arm64' }],
  ] as const)('rejects %s before any container mutation', (_label, metadataOverrides) => {
    const docker = fakeDocker(metadataOverrides);
    const inputs = captureInputs();
    expect(() => inspectJourneyWebImagePair(inputs, { platform: 'linux', architecture: 'x64',
      environment: { PATH: '/usr/bin', DOCKER_HOST: dockerHost }, dockerCommand: docker.command })).toThrow(JourneyWebImageError);
    expect(docker.calls.some(call => call.arguments_[0] === 'run' || call.arguments_.includes('stop') || call.arguments_.includes('rm'))).toBe(false);
  });

  it('inspects both immutable IDs and verifies source, revision, OS and host architecture', () => {
    const docker = fakeDocker();
    expect(imagePair(docker)).toEqual({
      previous: { imageId: previousImageId, source: JOURNEY_WEB_IMAGE_SOURCE, revision: previousRevision, os: 'linux', architecture: 'amd64' },
      current: { imageId: currentImageId, source: JOURNEY_WEB_IMAGE_SOURCE, revision: currentRevision, os: 'linux', architecture: 'amd64' },
    });
    expect(docker.calls.map(call => call.arguments_[0])).toEqual(['image', 'image']);
    expect(docker.calls.map(call => call.arguments_.at(-1))).toEqual([previousImageId, currentImageId]);
  });

  it('rejects a remote default Docker context before inspecting images', () => {
    const calls: string[][] = [];
    const command: JourneyWebDockerCommand = arguments_ => {
      calls.push([...arguments_]);
      return 'ssh://docker.example';
    };
    expect(() => inspectJourneyWebImagePair({ previousImageId, currentImageId }, { platform: 'linux', architecture: 'x64',
      environment: { PATH: '/usr/bin' }, dockerCommand: command })).toThrow('selected Docker context is not local');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('context');
  });

  it('rejects ambiguous array image metadata instead of selecting its first item', () => {
    const docker = fakeDocker();
    docker.setAmbiguousImageMetadata(true);
    expect(() => imagePair(docker)).toThrow('invalid image or container metadata');
    expect(docker.calls.map(call => call.arguments_[0])).toEqual(['image']);
  });

  it('starts current, swaps by exact owner after stopping the old image, and passes only environment names in arguments', async () => {
    const docker = fakeDocker();
    const unexpectedExit = vi.fn();
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, unexpectedExit));
    const started = await runtime.start('current');
    expect(started.active).toMatchObject({ selection: 'current', imageId: currentImageId, revision: currentRevision });
    const firstRun = docker.calls.find(call => call.arguments_[0] === 'run');
    if (!firstRun) throw new Error('The owned image container was not started.');
    const argumentText = firstRun.arguments_.join('\u0000');
    expect(JOURNEY_WEB_IMAGE_RUNTIME_ENV_NAMES.every(name => argumentText.includes(`--env\u0000${name}`))).toBe(true);
    for (const secret of ['s'.repeat(43), 'm'.repeat(43), 'postgres://postgres@127.0.0.1:55432/hasi_topology_test']) {
      expect(argumentText).not.toContain(secret);
    }
    expect(firstRun.arguments_).toContain('--pull=never');
    expect(firstRun.arguments_).toContain('--network');
    expect(firstRun.arguments_).toContain('host');
    expect(firstRun.arguments_).toContain('--read-only');
    expect(firstRun.arguments_).toContain('--cap-drop=ALL');
    expect(firstRun.arguments_).toContain('--security-opt=no-new-privileges');
    expect(firstRun.arguments_).toContain('--user');
    expect(firstRun.arguments_).toContain('1000:1000');
    expect(firstRun.arguments_).toContain('--pids-limit');
    expect(firstRun.arguments_).toContain('128');
    expect(firstRun.arguments_).toContain('--memory');
    expect(firstRun.arguments_).toContain('768m');
    expect(firstRun.arguments_).toContain('--cpus');
    expect(firstRun.arguments_).toContain('1');
    expect(firstRun.arguments_).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777');
    expect(firstRun.arguments_.some(argument => argument === 'type=bind,source=' + certificatePath + ',target=' + certificatePath + ',readonly')).toBe(true);
    expect(firstRun.arguments_.some(argument => argument.includes('docker.sock') || argument.includes('model-key.pem'))).toBe(false);

    const previous = await runtime.switchTo('previous');
    expect(previous.active).toMatchObject({ selection: 'previous', imageId: previousImageId, revision: previousRevision });
    expect(previous.transitionCount).toBe(2);
    const calls = docker.calls.map(call => call.arguments_);
    const firstRunIndex = calls.findIndex(args => args[0] === 'run');
    const stopIndex = calls.findIndex(args => args[0] === 'container' && args[1] === 'stop');
    const secondRunIndex = calls.findIndex((args, index) => args[0] === 'run' && index > firstRunIndex);
    expect(stopIndex).toBeGreaterThan(firstRunIndex);
    expect(secondRunIndex).toBeGreaterThan(stopIndex);
    expect(calls[stopIndex]?.at(-1)).toMatch(/^[a-f0-9]{64}$/u);
    const runCalls = docker.calls.filter(call => call.arguments_[0] === 'run');
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0]?.environment).toEqual(runCalls[1]?.environment);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.some(call => call.arguments_.includes('prune'))).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  it('cancels chunked health streams after reading only 4097 bytes when oversized', async () => {
    const docker = fakeDocker();
    const healthJson = new TextEncoder().encode(JSON.stringify({ status: 'ready', revision: currentRevision }));
    const source = new Uint8Array(8192).fill(0x20);
    source.set(healthJson);
    let bytesRead = 0;
    const onCancel = vi.fn();
    const healthResponse = byteStreamResponse(source, { onCancel, onRead: count => { bytesRead += count; } });
    expect(healthResponse.headers.has('content-length')).toBe(false);
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn(), {
      readinessTimeoutMs: 1000,
      fetcher: input => Promise.resolve(input.endsWith('/api/health') ? healthResponse : new Response('{}', { status: 200 })),
    }));
    await expect(runtime.start()).rejects.toThrow('health response exceeded its bound');
    expect(bytesRead).toBe(4097);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
  });

  it('accepts a valid health JSON body that is exactly 4096 bytes', async () => {
    const docker = fakeDocker();
    const healthJson = new TextEncoder().encode(JSON.stringify({ status: 'ready', revision: currentRevision }));
    const source = new Uint8Array(4096).fill(0x20);
    source.set(healthJson);
    let bytesRead = 0;
    const onCancel = vi.fn();
    const healthResponse = byteStreamResponse(source, { onCancel, onRead: count => { bytesRead += count; } });
    expect(healthResponse.headers.has('content-length')).toBe(false);
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn(), {
      readinessTimeoutMs: 1000,
      fetcher: input => Promise.resolve(input.endsWith('/api/health') ? healthResponse : new Response('{}', { status: 200 })),
    }));
    const started = await runtime.start();
    expect(started.active).toMatchObject({ state: 'ready', revision: currentRevision });
    expect(bytesRead).toBe(4096);
    expect(onCancel).not.toHaveBeenCalled();
    await runtime.close();
    expect(docker.containers.size).toBe(0);
  });

  it('cancels a stalled health body within the readiness timeout and cleans the image', async () => {
    const docker = fakeDocker();
    const onCancel = vi.fn();
    const stalledSource: UnderlyingByteSource = {
      type: 'bytes',
      pull(_controller: ReadableByteStreamController) { /* Remain pending until the bounded read signal aborts. */ },
      cancel() { onCancel(); },
    };
    const stalledBody = new ByteReadableStream(stalledSource);
    const healthResponse = new Response(stalledBody, { status: 200 });
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn(), {
      readinessTimeoutMs: 100,
      fetcher: input => Promise.resolve(input.endsWith('/api/health') ? healthResponse : new Response('{}', { status: 200 })),
    }));
    const startedAt = performance.now();
    await expect(runtime.start()).rejects.toThrow('health response timed out while reading');
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
  });

  it('reports an unexpected container exit and verifies absence during cleanup', async () => {
    const docker = fakeDocker();
    const unexpectedExit = vi.fn();
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, unexpectedExit, { monitorIntervalMs: 5 }));
    await runtime.start('current');
    const activeName = runtime.snapshot().active?.containerName;
    if (!activeName) throw new Error('The image container was not recorded.');
    docker.remove(activeName);
    await expect(runtime.switchTo('previous')).rejects.toThrow('not running');
    expect(docker.calls.filter(call => call.arguments_[0] === 'run')).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(unexpectedExit).toHaveBeenCalledTimes(1);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(docker.containers.size).toBe(0);
    expect(docker.calls.filter(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'stop')).toHaveLength(0);
  });

  it('reports a missing shared CA bind source without leaving an unknown container', async () => {
    const docker = fakeDocker();
    const unexpectedExit = vi.fn();
    const baseOptions = runtimeOptions(docker, unexpectedExit);
    const command: JourneyWebDockerCommand = (arguments_, environment) => {
      if (arguments_[0] === 'run') {
        throw Object.assign(new Error('bind source unavailable'), {
          stderr: Buffer.from('docker: invalid mount config for type bind: bind source path does not exist'),
        });
      }
      return docker.command(arguments_, environment);
    };
    const runtime = new JourneyWebImageRuntime({ ...baseOptions, dockerCommand: command });
    await expect(runtime.start()).rejects.toThrow('public model CA certificate is not available at the same path');
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(docker.containers.size).toBe(0);
  });

  it('recovers and removes a stopped owned container left by a failed run', async () => {
    const docker = fakeDocker();
    docker.setRunBehavior('create-stopped-then-throw');
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await expect(runtime.start()).rejects.toThrow('local Docker qualification command failed');
    const recovery = runtime.snapshot().active;
    expect(recovery).toMatchObject({ state: 'starting', containerIdVerified: true,
      expectedOwnerLabel: { name: JOURNEY_WEB_IMAGE_OWNER_LABEL } });
    expect(recovery?.containerId).toMatch(/^[a-f0-9]{64}$/u);
    const run = docker.calls.find(call => call.arguments_[0] === 'run');
    expect(run?.arguments_).toContain(`${JOURNEY_WEB_IMAGE_OWNER_LABEL}=${recovery?.expectedOwnerLabel.value ?? ''}`);
    expect(recovery?.imageId).toBe(currentImageId);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
    const remove = docker.calls.find(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'rm');
    expect(remove?.arguments_.slice(2, 4)).toEqual(['--force', recovery?.containerId]);
    expect(docker.calls.some(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'stop')).toBe(false);
  });

  it('verifies metadata before accepting a malformed run ID and cleans by the verified full ID', async () => {
    const docker = fakeDocker();
    docker.setRunBehavior('create-then-bad-id');
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await expect(runtime.start()).rejects.toThrow('verified full owned web container ID');
    const recovery = runtime.snapshot().active;
    expect(recovery).toMatchObject({ state: 'starting', containerIdVerified: true });
    expect(recovery?.containerId).toMatch(/^[a-f0-9]{64}$/u);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
    const inspectCalls = docker.calls.filter(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'inspect');
    expect(inspectCalls[0]?.arguments_.at(-1)).toBe(recovery?.containerName);
    expect(inspectCalls.slice(1).every(call => call.arguments_.at(-1) === recovery?.containerId)).toBe(true);
    const stop = docker.calls.find(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'stop');
    expect(stop?.arguments_.at(-1)).toBe(recovery?.containerId);
  });

  it('retains exact recovery metadata when post-create inspection is unavailable and permits close retry', async () => {
    const docker = fakeDocker();
    docker.setRunBehavior('create-then-throw');
    docker.failNextContainerInspections(1);
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await expect(runtime.start()).rejects.toThrow('local Docker qualification command failed');
    const recovery = runtime.snapshot().active;
    expect(recovery).toMatchObject({ state: 'starting', containerId: null, containerIdVerified: false,
      expectedOwnerLabel: { name: JOURNEY_WEB_IMAGE_OWNER_LABEL } });
    expect(recovery?.containerName).toMatch(/^hasi-plugin-journey-web-[a-f0-9]{32}$/u);
    await expect(runtime.start()).rejects.toThrow('not available to start');
    docker.failNextContainerInspections(0);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(docker.containers.size).toBe(0);
    const stop = docker.calls.find(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'stop');
    expect(stop?.arguments_.at(-1)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('allows close to retry after cleanup inspection fails and denies new starts', async () => {
    const docker = fakeDocker();
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await runtime.start();
    docker.failNextContainerInspections(1);
    await expect(runtime.close()).rejects.toThrow('local Docker qualification command failed');
    expect(runtime.snapshot().active).toMatchObject({ state: 'retiring', containerIdVerified: true });
    await expect(runtime.start()).rejects.toThrow('not available to start');
    expect(docker.calls.some(call => call.arguments_[0] === 'container' && ['stop', 'rm'].includes(call.arguments_[1] ?? ''))).toBe(false);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(docker.containers.size).toBe(0);
  });

  it('rejects ambiguous container array metadata and does not mutate until exact metadata is available', async () => {
    const docker = fakeDocker();
    docker.setAmbiguousContainerMetadata(true);
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await expect(runtime.start()).rejects.toThrow('created web container could not be verified');
    expect(runtime.snapshot().active).toMatchObject({ state: 'starting', containerId: null, containerIdVerified: false });
    expect(docker.calls.some(call => call.arguments_[0] === 'container' && ['stop', 'rm'].includes(call.arguments_[1] ?? ''))).toBe(false);
    docker.setAmbiguousContainerMetadata(false);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
  });

  it('removes a stopped container retained by Docker after normal stop using its immutable ID', async () => {
    const docker = fakeDocker();
    docker.setRetainStoppedContainers(true);
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    const started = await runtime.start('current');
    const firstId = started.active?.containerId;
    await runtime.switchTo('previous');
    const stopIndex = docker.calls.findIndex(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'stop');
    const rmIndex = docker.calls.findIndex(call => call.arguments_[0] === 'container' && call.arguments_[1] === 'rm');
    expect(docker.calls[stopIndex]?.arguments_.at(-1)).toBe(firstId);
    expect(docker.calls[rmIndex]?.arguments_.at(-1)).toBe(firstId);
    expect(rmIndex).toBeGreaterThan(stopIndex);
    expect(docker.containers.size).toBe(1);
    await runtime.close();
    expect(docker.containers.size).toBe(0);
  });

  it('refuses targeted cleanup when the exact container owner label has changed', async () => {
    const docker = fakeDocker();
    const runtime = new JourneyWebImageRuntime(runtimeOptions(docker, vi.fn()));
    await runtime.start('current');
    const name = runtime.snapshot().active?.containerName;
    const container = name ? docker.containers.get(name) : undefined;
    if (!name || !container) throw new Error('The image container was not recorded.');
    container.Config.Labels[JOURNEY_WEB_IMAGE_OWNER_LABEL] = 'foreign-owner';
    await expect(runtime.close()).rejects.toThrow('exact ownership');
    expect(docker.calls.some(call => call.arguments_[0] === 'container' && ['stop', 'rm'].includes(call.arguments_[1] ?? ''))).toBe(false);
    expect(docker.containers.get(name)).toBe(container);
    docker.remove(name);
  });
});

describe('web-image mode command and proxy boundaries', () => {
  it('exposes only explicit CLI mode and terminal controls and rejects mode combinations', () => {
    expect(journeyOperation(['--web-images'])).toEqual({ kind: 'serve', managed: false, optimized: false, webImages: true });
    expect(() => journeyOperation(['--web-images', '--managed'])).toThrow('Invalid synthetic journey operation');
    expect(() => journeyOperation(['--web-images', '--optimized'])).toThrow('Invalid synthetic journey operation');
    expect(journeyFixtureCommands(false)).not.toContain('web-current');
    expect(journeyFixtureCommands(false, true)).toContain('web-previous');
    expect(journeyFixtureCommands(false, true)).toContain('web-current');
    expect(parseJourneyFixtureCommand('web-current', false)).toBeUndefined();
    expect(parseJourneyFixtureCommand('web-current', false, true)).toBe('web-current');
    expect(parseJourneyFixtureCommand('sha256:' + 'a'.repeat(64), false, true)).toBeUndefined();
  });

  it('routes only fixed web-owned API endpoints to the image and all other APIs to the API proxy', () => {
    expect(journeyWebImageProxyTarget('/api/chat')).toBe('web');
    expect(journeyWebImageProxyTarget('/api/chat/workspace?limit=1')).toBe('web');
    expect(journeyWebImageProxyTarget('/api/health')).toBe('web');
    expect(journeyWebImageProxyTarget('/api/session')).toBe('api');
    expect(journeyWebImageProxyTarget('/api/auth/login')).toBe('api');
    expect(journeyWebImageProxyTarget('/api/plugin-catalog')).toBe('api');
    expect(journeyWebImageProxyTarget('/_next/static/app.js')).toBe('web');
    expect(journeyWebImageProxyPath('/api/chat?limit=1')).toBe('/api/chat?limit=1');
    for (const requestUrl of ['https://attacker.invalid/api/chat', '//attacker.invalid/api/chat', '/\\attacker.invalid/api/chat',
      '/api/chat#fragment', '/prefix/../api/chat', '/%2e%2e/api/chat']) {
      expect(() => journeyWebImageProxyPath(requestUrl)).toThrow('Invalid local web-proxy request path');
      expect(() => journeyWebImageProxyTarget(requestUrl)).toThrow('Invalid local web-proxy request path');
    }
  });
});
