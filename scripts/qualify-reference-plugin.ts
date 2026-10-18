import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryJsonStore } from '@hasi/state';
import { digest, manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { createApi, PluginRegistry, type IdentityProvider, type Persona } from '../apps/api/src/index.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import type { ApprovedPluginSource, Registration } from '../apps/api/src/registry.js';
import { packageReferencePlugin } from './package-reference-plugin.js';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_ROOT = join(WORKSPACE_ROOT, 'examples/reference-plugin');
const PLUGIN_ID = 'hasi.reference';
const LABEL = 'Synthetic reading-room marker';
const ACCOUNT = 'reference-test-account-17';
const ORIGIN = 'http://127.0.0.1:3000';

export interface ReferencePluginQualificationEvidence {
  readonly pluginId: string;
  readonly initialVersion: '1.0.0';
  readonly updatedVersion: '1.0.1';
  readonly initialSourceSha: string;
  readonly updatedSourceSha: string;
  readonly initialManifestDigest: string;
  readonly updatedManifestDigest: string;
  readonly initialArtifactSha256: string;
  readonly updatedArtifactSha256: string;
  readonly initialArtifactManifestSha256: string;
  readonly updatedArtifactManifestSha256: string;
  readonly licenseInventorySha256: string;
  readonly sdkRuntimePackageCount: number;
  readonly sdkLicenseCount: number;
  readonly hostPid: number;
  readonly initialPluginPid: number;
  readonly updatedPluginPid: number;
  readonly recoveryPluginPid: number;
  readonly pluginPort: number;
  readonly confirmedActionCount: 1;
  readonly publicLabel: string;
  readonly scopedAccountClaim: string;
  readonly updateStatus: 'available';
  readonly hostRestarted: false;
  readonly rollbackSupported: true;
  readonly recoveredVersion: '1.0.0';
}

interface StartedPlugin {
  readonly child: ChildProcess;
  readonly pid: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} returned an invalid response.`);
  return value as Record<string, unknown>;
}

function runLocalCommand(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error(`The local qualification command failed: ${command} ${args[0] ?? ''}.`);
  }
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port.');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => { if (error) reject(error); else resolveClose(); });
  });
  return port;
}

async function startPlugin(artifactPath: string, port: number, serviceToken: string, publicKeyPem: string): Promise<StartedPlugin> {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: artifactPath,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      HASI_REFERENCE_PLUGIN_TEST_MODE: '1',
      HASI_REFERENCE_PLUGIN_HOST: '127.0.0.1',
      HASI_REFERENCE_PLUGIN_PORT: String(port),
      HASI_REFERENCE_PLUGIN_TOKEN: serviceToken,
      HASI_REFERENCE_PLUGIN_PUBLIC_KEY: publicKeyPem,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    diagnostic = `${diagnostic}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`.slice(-4_000);
  });
  if (!child.pid) throw new Error('The independent plugin process did not start.');

  const healthUrl = `http://127.0.0.1:${String(port)}/healthz`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The independent plugin process exited during startup.${diagnostic ? ` ${diagnostic.trim()}` : ''}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, pid: child.pid };
      await response.body?.cancel();
    } catch {
      // The separate Node process may still be binding its loopback listener.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The independent plugin process did not become healthy.${diagnostic ? ` ${diagnostic.trim()}` : ''}`);
}

async function stopPlugin(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>(resolveWait => setTimeout(() => { resolveWait(false); }, 5_000))]);
  if (graceful) return;
  const killed = once(child, 'exit');
  child.kill('SIGKILL');
  const terminated = await Promise.race([killed.then(() => true), new Promise<boolean>(resolveWait => setTimeout(() => { resolveWait(false); }, 3_000))]);
  if (!terminated) throw new Error('The independent plugin process did not stop.');
}

async function jsonResponse(response: Response, route: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error(`${route} did not return JSON.`); }
  const value = asRecord(parsed, route);
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status.toString()}.`);
  return value;
}

async function coreRequest(baseUrl: string, route: string, input: {
  method?: 'GET' | 'POST';
  body?: unknown;
  cookie?: string;
} = {}): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const method = input.method ?? 'POST';
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (input.cookie) headers.cookie = input.cookie;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await jsonResponse(response, route);
  return { response, body };
}

async function login(baseUrl: string, personaId: 'admin' | 'student'): Promise<string> {
  const { response } = await coreRequest(baseUrl, '/api/dev/login', { body: { personaId } });
  const setCookie = response.headers.get('set-cookie');
  const value = setCookie?.match(/(?:^|[,;]\s*)hasi-session=([^;,\s]+)/u)?.[1];
  if (!value) throw new Error('Core login did not set a session cookie.');
  return `hasi-session=${value}`;
}

function createTestIdentity(): IdentityProvider {
  const admin: Persona = {
    id: 'reference-admin',
    displayName: 'Reference administrator',
    role: 'admin',
    actor: { subject: 'reference-admin-subject', permissions: ['plugins:manage'] },
  };
  const student: Persona = {
    id: 'reference-student',
    displayName: 'Reference student',
    role: 'student',
    actor: {
      subject: 'reference-student-subject',
      permissions: ['reference:read', 'reference:prepare', 'reference:execute'],
      claims: { 'reference.account': ACCOUNT },
    },
  };
  const personas: Readonly<Record<string, Persona>> = { admin, student };
  const sessions = new Map<string, Persona>();
  return {
    login(id) {
      const user = personas[id];
      if (!user) throw new Error('Unknown synthetic reference persona.');
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, structuredClone(user));
      return { token, user: structuredClone(user) };
    },
    resolve(token) {
      const user = token ? sessions.get(token) : undefined;
      return user ? structuredClone(user) : undefined;
    },
    logout(token) {
      if (token) sessions.delete(token);
    },
  };
}

function assertSuccessBody(value: Record<string, unknown>, predicate: (body: Record<string, unknown>) => boolean, message: string): void {
  assert(predicate(value), message);
}

function gitCommit(repoPath: string, message: string, files: readonly string[]): string {
  runLocalCommand('git', ['add', ...files], repoPath);
  runLocalCommand('git', ['-c', 'user.name=HASI local qualification', '-c', 'user.email=qualification@example.test', 'commit', '--quiet', '-m', message], repoPath);
  return runLocalCommand('git', ['rev-parse', 'HEAD'], repoPath);
}

export async function runReferencePluginQualification(): Promise<ReferencePluginQualificationEvidence> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hasi-reference-plugin-'));
  const repoPath = join(tempRoot, 'plugin-repo');
  const initialArtifactPath = join(tempRoot, 'reference-plugin-v1');
  const updatedArtifactPath = join(tempRoot, 'reference-plugin-v2');
  await mkdir(join(repoPath, 'src'), { recursive: true });
  await cp(join(EXAMPLE_ROOT, 'package.json'), join(repoPath, 'package.json'));
  await cp(join(EXAMPLE_ROOT, 'README.md'), join(repoPath, 'README.md'));
  await cp(join(EXAMPLE_ROOT, 'src/server.js'), join(repoPath, 'src/server.js'));
  await cp(join(EXAMPLE_ROOT, 'src/manifest.json'), join(repoPath, 'src/manifest.json'));

  const activeProcesses: ChildProcess[] = [];
  let api: Awaited<ReturnType<typeof createApi>> | undefined;
  try {
    runLocalCommand('git', ['init', '--quiet'], repoPath);
    const initialSourceSha = gitCommit(repoPath, 'Add local reference plugin v1.0.0', ['README.md', 'package.json', 'src']);
    const initialManifest = manifestSchema.parse(JSON.parse(await readFile(join(repoPath, 'src/manifest.json'), 'utf8'))) as PluginManifestV2;
    assert(initialManifest.version === '1.0.0' && initialManifest.id === PLUGIN_ID, 'The committed reference plugin source has the wrong identity or version.');
    const initialArtifact = await packageReferencePlugin({ outputDirectory: initialArtifactPath, sourceDirectory: repoPath });

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const serviceToken = `reference-test-${randomBytes(24).toString('base64url')}`;
    const pluginPort = await allocatePort();
    let pluginProcess = await startPlugin(initialArtifactPath, pluginPort, serviceToken, publicKeyPem);
    activeProcesses.push(pluginProcess.child);
    const initialPluginPid = pluginProcess.pid;
    const store = new MemoryJsonStore(`reference-plugin-${randomBytes(8).toString('hex')}`);
    const registry = new PluginRegistry(privateKey, { store, scope: `reference-${randomBytes(8).toString('hex')}` });
    const registration: Registration = {
      instanceId: PLUGIN_ID,
      endpoint: `http://127.0.0.1:${String(pluginPort)}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(initialManifest),
      allowLoopback: true,
    };
    const source: ApprovedPluginSource = { id: PLUGIN_ID, label: 'Local reference plugin', registration };
    api = await createApi({
      mode: 'test',
      registry,
      store,
      identity: createTestIdentity(),
      pluginCatalog: [source],
      origin: ORIGIN,
      allowedHosts: ['127.0.0.1'],
    });
    await api.listen({ host: '127.0.0.1', port: 0 });
    const hostAddress = api.server.address();
    if (!hostAddress || typeof hostAddress === 'string') throw new Error('Core did not bind an ephemeral loopback port.');
    const baseUrl = `http://127.0.0.1:${String(hostAddress.port)}`;
    const adminCookie = await login(baseUrl, 'admin');
    const studentCookie = await login(baseUrl, 'student');

    await coreRequest(baseUrl, '/api/admin/plugin-catalog/connect', { cookie: adminCookie, body: { sourceId: PLUGIN_ID } });
    await coreRequest(baseUrl, `/api/admin/plugins/${PLUGIN_ID}/configuration/draft`, {
      cookie: adminCookie,
      body: { revision: 0, values: { label: LABEL }, disabledTools: [] },
    });
    await coreRequest(baseUrl, `/api/admin/plugins/${PLUGIN_ID}/configuration/activate`, { cookie: adminCookie, body: { revision: 1 } });

    const firstRead = (await coreRequest(baseUrl, '/api/tools/call', {
      cookie: studentCookie,
      body: { pluginId: PLUGIN_ID, name: 'read_status', arguments: {} },
    })).body;
    assertSuccessBody(firstRead, body => body.label === LABEL && body.account === ACCOUNT && body.version === '1.0.0', 'The host did not apply the public configuration or scoped claim on an independent plugin call.');

    const prepared = (await coreRequest(baseUrl, '/api/tools/call', {
      cookie: studentCookie,
      body: { pluginId: PLUGIN_ID, name: 'prepare_mark', arguments: {} },
    })).body;
    const proposal = asRecord(prepared.proposal, 'prepare_mark');
    const preparedArguments = asRecord(proposal.arguments, 'prepare_mark proposal');
    assert(proposal.resourceName === LABEL && preparedArguments.label === LABEL && proposal.executionTool === 'execute_mark', 'The host did not preserve the prepared synthetic action.');
    if (typeof proposal.id !== 'string') throw new Error('The host did not return a confirmation ID.');

    const confirmed = (await coreRequest(baseUrl, `/api/proposals/${proposal.id}/confirm`, { cookie: studentCookie, body: {} })).body;
    assertSuccessBody(confirmed, body => body.confirmed === true && body.actionCount === 1 && body.label === LABEL && body.account === ACCOUNT, 'The host confirmation did not execute the synthetic action once.');
    const proposalStatus = (await coreRequest(baseUrl, `/api/proposals/${proposal.id}`, { method: 'GET', cookie: studentCookie })).body;
    const confirmedProposal = asRecord(proposalStatus.proposal, 'proposal status');
    assert(confirmedProposal.status === 'confirmed', 'The host did not record the confirmed proposal state.');

    await stopPlugin(pluginProcess.child);
    const manifestPath = join(repoPath, 'src/manifest.json');
    const updatedManifest = { ...initialManifest, version: '1.0.1', description: 'Updated local synthetic reference plugin.' };
    await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, 'utf8');
    const updatedSourceSha = gitCommit(repoPath, 'Update local reference plugin to v1.0.1', ['src/manifest.json']);
    const updatedArtifact = await packageReferencePlugin({ outputDirectory: updatedArtifactPath, sourceDirectory: repoPath });
    pluginProcess = await startPlugin(updatedArtifactPath, pluginPort, serviceToken, publicKeyPem);
    activeProcesses.push(pluginProcess.child);
    const updatedPluginPid = pluginProcess.pid;
    assert(updatedPluginPid !== initialPluginPid, 'The plugin update did not replace the independent Node process.');

    const updateCheck = (await coreRequest(baseUrl, `/api/admin/plugins/${PLUGIN_ID}/check-update`, { cookie: adminCookie, body: {} })).body;
    assert(updateCheck.status === 'available', 'The host did not find a compatible plugin update.');
    await coreRequest(baseUrl, `/api/admin/plugins/${PLUGIN_ID}/activate-update`, { cookie: adminCookie, body: {} });
    const updatedRead = (await coreRequest(baseUrl, '/api/tools/call', {
      cookie: studentCookie,
      body: { pluginId: PLUGIN_ID, name: 'read_status', arguments: {} },
    })).body;
    assertSuccessBody(updatedRead, body => body.label === LABEL && body.account === ACCOUNT && body.version === '1.0.1', 'The existing host did not invoke the updated plugin process after activation.');

    // Keep both packaged versions live on separate loopback ports. Two
    // independently constructed controller objects share only durable state;
    // the second one activates the new route and the first one later restores
    // the retained v1 route.
    const recoveryPort = await allocatePort();
    const recoveryProcess = await startPlugin(initialArtifactPath, recoveryPort, serviceToken, publicKeyPem);
    activeProcesses.push(recoveryProcess.child);
    const routeStore = new MemoryJsonStore(`reference-route-${randomBytes(8).toString('hex')}`);
    const routeOptions = { store: routeStore, scope: `reference-route-${randomBytes(8).toString('hex')}`, ownerId: 'reference-operator' } as const;
    const firstRouteController = new PluginRouteController(routeOptions);
    const secondRouteController = new PluginRouteController(routeOptions);
    const installationId = 'reference-artifact-installation';
    const previousDeploymentId = `reference-v1-${String(recoveryProcess.pid)}`;
    const updatedDeploymentId = `reference-v2-${String(updatedPluginPid)}`;
    await firstRouteController.initializeInstallation({
      installationId,
      configurationRevision: 'reference-config-1',
      activeDeploymentId: previousDeploymentId,
      activeReleaseDigest: initialArtifact.artifactSha256,
    });
    const healthInputs = [
      { deploymentId: previousDeploymentId, artifactPath: initialArtifactPath, port: recoveryPort, version: '1.0.0' },
      { deploymentId: updatedDeploymentId, artifactPath: updatedArtifactPath, port: pluginPort, version: '1.0.1' },
    ] as const;
    for (const target of healthInputs) {
      const health = await fetch(`http://127.0.0.1:${String(target.port)}/healthz`, { signal: AbortSignal.timeout(1_000) });
      const packageManifest = JSON.parse(await readFile(join(target.artifactPath, 'src/manifest.json'), 'utf8')) as Record<string, unknown>;
      assert(health.ok && packageManifest.version === target.version, 'A packaged plugin version failed its health check.');
      await health.body?.cancel();
    }
    await secondRouteController.activate({
      ownerId: routeOptions.ownerId,
      installationId,
      operationId: 'reference-update-activation',
      candidateDeploymentId: updatedDeploymentId,
      candidateReleaseDigest: updatedArtifact.artifactSha256,
      previousDeploymentId,
      baseCurrentDigest: initialArtifact.artifactSha256,
      configurationRevision: 'reference-config-1',
    });
    assert(await firstRouteController.resolveActiveDeploymentId({ ownerId: routeOptions.ownerId, installationId }) === updatedDeploymentId, 'The independent route controller did not activate the packaged update across instances.');
    await firstRouteController.rollback({
      ownerId: routeOptions.ownerId,
      installationId,
      operationId: 'reference-update-rollback',
      currentDeploymentId: updatedDeploymentId,
      currentReleaseDigest: updatedArtifact.artifactSha256,
      previousDeploymentId,
      previousReleaseDigest: initialArtifact.artifactSha256,
      baseCurrentDigest: updatedArtifact.artifactSha256,
      configurationRevision: 'reference-config-1',
    });
    const recoveredRoute = await secondRouteController.read({ ownerId: routeOptions.ownerId, installationId });
    assert(recoveredRoute.active?.deploymentId === previousDeploymentId && recoveredRoute.active.releaseDigest === initialArtifact.artifactSha256, 'The independent route controller did not restore the retained compatible artifact.');
    const recoveredHealth = await fetch(`http://127.0.0.1:${String(recoveryPort)}/healthz`, { signal: AbortSignal.timeout(1_000) });
    assert(recoveredHealth.ok, 'The restored v1 artifact did not remain healthy.');
    await recoveredHealth.body?.cancel();

    const sdkLicenseInventory = initialArtifact.licenseInventory.filter(item => item.name !== 'hasi-reference-plugin');
    const updatedSdkLicenseInventory = updatedArtifact.licenseInventory.filter(item => item.name !== 'hasi-reference-plugin');
    const licenseInventorySha256 = createHash('sha256').update(JSON.stringify(sdkLicenseInventory)).digest('hex');
    assert(initialArtifact.runtimePackageCount === updatedArtifact.runtimePackageCount, 'The SDK runtime package inventory changed between reference releases.');
    assert(licenseInventorySha256 === createHash('sha256').update(JSON.stringify(updatedSdkLicenseInventory)).digest('hex'), 'The SDK license inventory changed between reference releases.');

    return {
      pluginId: PLUGIN_ID,
      initialVersion: '1.0.0',
      updatedVersion: '1.0.1',
      initialSourceSha,
      updatedSourceSha,
      initialManifestDigest: initialArtifact.manifestDigest,
      updatedManifestDigest: updatedArtifact.manifestDigest,
      initialArtifactSha256: initialArtifact.artifactSha256,
      updatedArtifactSha256: updatedArtifact.artifactSha256,
      initialArtifactManifestSha256: initialArtifact.artifactManifestSha256,
      updatedArtifactManifestSha256: updatedArtifact.artifactManifestSha256,
      licenseInventorySha256,
      sdkRuntimePackageCount: initialArtifact.runtimePackageCount,
      sdkLicenseCount: sdkLicenseInventory.length,
      hostPid: process.pid,
      initialPluginPid,
      updatedPluginPid,
      recoveryPluginPid: recoveryProcess.pid,
      pluginPort,
      confirmedActionCount: 1,
      publicLabel: LABEL,
      scopedAccountClaim: ACCOUNT,
      updateStatus: 'available',
      hostRestarted: false,
      rollbackSupported: true,
      recoveredVersion: '1.0.0',
    };
  } finally {
    for (const child of activeProcesses.reverse()) await stopPlugin(child);
    if (api) await api.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const scriptPath = process.argv[1];
if (scriptPath && resolve(scriptPath) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = await runReferencePluginQualification();
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write('Reference plugin qualification failed.\n');
    process.exitCode = 1;
  }
}
