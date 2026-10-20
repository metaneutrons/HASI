import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PostgresJsonStore } from '@hasi/state';
import { digest, manifestSchema, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { annyManifest } from '@hasi/anny-plugin';
import { knowledgeManifest } from '@hasi/knowledge-plugin';
import { hshDemoCatalog } from '../fixtures/catalog.js';
import { createApi, OidcIdentityProvider, PluginRegistry, PluginAccountService, startTestIdp, stableOidcSubject, withDemoPluginClaims } from '../apps/api/src/index.js';
import { personas, type Persona } from '../apps/api/src/identity.js';
import { createRegistryKnowledgeContexts } from '../apps/api/src/knowledge-context-runtime.js';
import { DemoPluginAccountAdapter } from '../packages/demo-runtime/src/plugin-account-adapter.js';
import { packageReferencePlugin, ReferencePackagingCommandError, type ReferencePluginArtifactEvidence } from './package-reference-plugin.js';
import { startJourneyModel } from './plugin-journey-model.js';
import { startJourneyReferenceProxy } from './plugin-journey-proxy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(import.meta.url);
const WEB_ORIGIN = 'http://127.0.0.1:3001';
const REFERENCE_ID = 'hasi.reference';
const ANNY_ID = 'de.hsh.hasi.anny';
const REFERENCE_PERMISSIONS = ['reference:read', 'reference:prepare', 'reference:execute'];
const REFERENCE_SOURCE = join(ROOT, 'examples/reference-plugin');
let stage = 'preflight';

interface ApiConfiguration {
  scope: string;
  issuer: string;
  privateKeyPath: string;
  port: number;
  annyToken: string;
  knowledgeToken: string;
  referenceToken: string;
  referencePort: number;
  referenceManifest: PluginManifestV2;
}

/** Never accept a production, remote or silently defaulted database for this fixture. */
export function journeyDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.HASI_PLUGIN_JOURNEY !== '1') throw new Error('Set HASI_PLUGIN_JOURNEY=1 for the synthetic local journey.');
  const value = environment.TEST_DATABASE_URL;
  if (!value) throw new Error('The disposable TEST_DATABASE_URL is required.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !url.port
    || url.pathname !== '/hasi_topology_test' || url.search || url.hash || url.password) {
    throw new Error('Use only the explicit loopback hasi_topology_test database without URL overrides.');
  }
  return url.href;
}

/** Next must not load an operator dotenv file into this synthetic composition. */
export async function assertJourneyEnvFilesAbsent(root = ROOT): Promise<void> {
  for (const directory of [root, join(root, 'apps/web')]) {
    for (const name of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']) {
      let present = true;
      try { await lstat(join(directory, name)); } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') present = false;
        else throw new Error('Could not verify absence of local dotenv configuration.');
      }
      if (present) throw new Error('Local dotenv configuration must be absent for the synthetic journey.');
    }
  }
}

async function advanceAccountClocks(apis: ChildProcess[], command: 'expire-anny' | 'expire-reference'): Promise<void> {
  const commandId = randomUUID();
  await Promise.all(apis.map(api => new Promise<void>((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); api.off('message', onMessage);
      if (error) reject(error); else done();
    };
    const onMessage = (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'event' in message && message.event === 'clock-advanced'
        && 'commandId' in message && message.commandId === commandId) finish();
    };
    const timer = setTimeout(() => { finish(new Error('A synthetic account clock did not acknowledge.')); }, 5000);
    api.on('message', onMessage);
    api.send({ command, commandId }, error => { if (error) finish(new Error('A synthetic account command could not be delivered.')); });
  })));
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'npm_config_store_dir'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
}

const referenceCommandSchema = z.enum(['lose-next-execution-ack', 'source-unavailable', 'source-available', 'stats']);
const referenceStatsSchema = z.strictObject({
  marks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  journalRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  invocationRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** Commands travel through an owned process channel, never through model/HTTP input. */
export function sendReferenceCommand(child: ChildProcess, command: z.infer<typeof referenceCommandSchema>): Promise<z.infer<typeof referenceStatsSchema> | undefined> {
  referenceCommandSchema.parse(command);
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error('The reference process is not available.'));
  const commandId = randomUUID();
  return new Promise((done, reject) => {
    const finish = (error?: Error, stats?: z.infer<typeof referenceStatsSchema>) => {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onExit);
      if (error) reject(error); else done(stats);
    };
    const onExit = () => { finish(new Error('The reference command lost its process.')); };
    const onMessage = (message: unknown) => {
      const ack = z.object({ event: z.literal('reference-command-applied'), commandId: z.literal(commandId), command: z.literal(command), stats: referenceStatsSchema.optional() }).safeParse(message);
      if (!ack.success) return;
      if (command === 'stats' && !ack.data.stats) { finish(new Error('The reference statistics are unavailable.')); return; }
      finish(undefined, ack.data.stats);
    };
    const timer = setTimeout(() => { finish(new Error('The reference command did not acknowledge.')); }, 5000);
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onExit);
    child.send({ type: 'reference-command', commandId, command }, error => {
      if (error) finish(new Error('The reference command could not be delivered.'));
    });
  });
}

async function available(port: number): Promise<void> {
  const listener = netServer();
  await new Promise<void>((done, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', done);
  });
  await new Promise<void>((done, reject) => listener.close(error => { if (error) reject(error); else done(); }));
}

async function allocatePort(): Promise<number> {
  const listener = netServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local fixture port.');
  await new Promise<void>((done, reject) => listener.close(error => { if (error) reject(error); else done(); }));
  return address.port;
}

export async function stopJourneyChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => { done(false); }, 5000); })]);
    if (!graceful) {
      clearTimeout(timer); child.kill('SIGKILL');
      await Promise.race([exited, new Promise<never>((_done, reject) => { timer = setTimeout(() => { reject(new Error('Owned fixture child did not stop.')); }, 3000); })]);
    }
  } finally { clearTimeout(timer); }
}

export function spawnJourneyChild(options: {
  executable: string;
  arguments: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  ipc: boolean;
  children: ChildProcess[];
  onUnexpectedExit: () => void;
}): ChildProcess {
  const child = spawn(options.executable, options.arguments, { cwd: options.cwd, env: options.environment,
    stdio: options.ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
  // A failed spawn emits error asynchronously. Register it for teardown and
  // handle that event before checking the synchronously available PID.
  options.children.push(child);
  child.on('error', options.onUnexpectedExit);
  child.once('exit', options.onUnexpectedExit);
  if (!child.pid) throw new Error('A local fixture child could not start.');
  return child;
}

async function ready(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('A fixture child exited before readiness.');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* A bounded wait for this exact child only. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('The local fixture did not become ready.');
}

function localCommand(command: string, arguments_: string[], cwd: string): string {
  return execFileSync(command, arguments_, { cwd, env: { ...cleanEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).trim();
}

async function artifacts(directory: string): Promise<{ manifest: PluginManifestV2; releases: { directory: string; sourceSha: string; evidence: ReferencePluginArtifactEvidence }[] }> {
  const source = join(directory, 'independent-source');
  await mkdir(join(source, 'src'), { recursive: true, mode: 0o700 });
  for (const path of ['package.json', 'README.md', 'src/server.js', 'src/state.js', 'src/manifest.json']) await cp(join(REFERENCE_SOURCE, path), join(source, path));
  localCommand('git', ['init', '--quiet'], source);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(source, 'src/manifest.json'), 'utf8'))) as PluginManifestV2;
  const releases: { directory: string; sourceSha: string; evidence: ReferencePluginArtifactEvidence }[] = [];
  for (const version of ['1.0.0', '1.0.1']) {
    await writeFile(join(source, 'src/manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    localCommand('git', ['add', 'package.json', 'README.md', 'src'], source);
    localCommand('git', ['-c', 'user.name=HASI local qualification', '-c', 'user.email=qualification@example.test', 'commit', '--quiet', '-m', `test: prepare independent reference ${version}`], source);
    const sourceSha = localCommand('git', ['rev-parse', 'HEAD'], source);
    const output = join(directory, `reference-${version}`);
    const evidence = await packageReferencePlugin({ sourceDirectory: source, outputDirectory: output });
    releases.push({ directory: output, sourceSha, evidence });
  }
  return { manifest, releases };
}

async function apiChild(path: string): Promise<void> {
  const connectionString = journeyDatabaseUrl(process.env);
  const config = JSON.parse(await readFile(path, 'utf8')) as ApiConfiguration;
  z.uuid().parse(config.scope);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(config.issuer)) throw new Error('Invalid local fixture configuration.');
  const privateKey = createPrivateKey(await readFile(config.privateKeyPath));
  const store = new PostgresJsonStore(`journey:${config.scope}`, { poolConfig: { connectionString, max: 4 } });
  await store.initialize();
  const users = new Map<string, Persona>();
  for (const role of ['admin', 'student'] as const) {
    const template = personas.find(persona => persona.id === role);
    if (!template) throw new Error('Synthetic persona missing.');
    const subject = stableOidcSubject(config.issuer, `journey-${role}`);
    const user = structuredClone(template);
    user.id = subject; user.actor.subject = subject; user.displayName = `Test-IdP · ${role === 'admin' ? 'Administration' : 'Studentin'}`;
    user.actor.resourceIds = hshDemoCatalog.resources.slice(0, role === 'admin' ? undefined : 6).map(resource => resource.id);
    user.actor.permissions.push(...REFERENCE_PERMISSIONS);
    user.actor = withDemoPluginClaims(user.actor);
    users.set(subject, user);
  }
  const identity = new OidcIdentityProvider({ mode: 'test', issuer: config.issuer, clientId: 'hasi-plugin-journey', redirectUri: `${WEB_ORIGIN}/api/auth/callback`, store,
    mapIdentity: ({ issuer, subject }) => {
      const user = users.get(stableOidcSubject(issuer, subject));
      if (!user) throw new Error('Undeclared synthetic identity.');
      return structuredClone(user);
    }, resolveAuthority: subject => Promise.resolve(users.get(subject)) });
  const offsets = new Map<string, number>();
  const accounts = new Map<string, PluginAccountService>();
  for (const installationId of [ANNY_ID, REFERENCE_ID]) {
    const clock = () => Date.now() + (offsets.get(installationId) ?? 0);
    const adapter = new DemoPluginAccountAdapter({ mode: 'test', privateKey, store, scope: config.scope, installationId, clock,
      resolveProjection: ({ subject }) => {
        const user = users.get(subject);
        if (!user) return undefined;
        return installationId === REFERENCE_ID
          ? { permissions: REFERENCE_PERMISSIONS, claims: { 'reference.account': `synthetic-${user.role}` } }
          : { permissions: user.actor.permissions.filter(permission => permission.startsWith('rooms:')), customerId: user.actor.customerId,
            resourceIds: user.actor.resourceIds, claims: { 'anny.customerId': user.actor.customerId ?? '', 'anny.resourceIds': user.actor.resourceIds ?? [] } };
      } });
    accounts.set(installationId, new PluginAccountService({ mode: 'test', privateKey, store, scope: config.scope, installationId, adapter, clock }));
  }
  const registry = new PluginRegistry(privateKey, { store, scope: config.scope, accounts, envelopeResults: true,
    defaultSourcePolicy: { sourceId: 'synthetic-journey', revision: '1', dataClasses: ['synthetic_demo'] },
    resolveActor: subject => Promise.resolve(users.get(subject)?.actor) });
  await registry.install({ endpoint: 'http://127.0.0.1:4101/mcp', serviceToken: config.annyToken, expectedManifestDigest: digest(annyManifest), allowLoopback: true });
  await registry.install({ endpoint: 'http://127.0.0.1:4103/mcp', serviceToken: config.knowledgeToken, expectedManifestDigest: digest(knowledgeManifest), allowLoopback: true });
  const knowledgeContexts = createRegistryKnowledgeContexts({ registry, store, privateKey, scope: config.scope, resolveActor: subject => Promise.resolve(users.get(subject)?.actor) });
  const app = await createApi({ mode: 'development', registry, identity, store, knowledgeContexts, origin: WEB_ORIGIN, allowedHosts: ['127.0.0.1'],
    pluginCatalog: [{ id: REFERENCE_ID, label: 'Unabhängiges Referenz-Plugin · synthetisch', registration: {
      instanceId: REFERENCE_ID, endpoint: `http://127.0.0.1:${String(config.referencePort)}/mcp`, serviceToken: config.referenceToken,
      expectedManifestDigest: digest(config.referenceManifest), allowLoopback: true,
      sourcePolicy: { sourceId: 'synthetic-reference', revision: '1', dataClasses: ['synthetic_demo'] },
    } }] });
  app.get('/health', () => ({ status: 'ok' }));
  app.addHook('onClose', () => store.close());
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('command' in message)) return;
    if (message.command === 'expire-anny' || message.command === 'expire-reference') {
      const id = message.command === 'expire-anny' ? ANNY_ID : REFERENCE_ID;
      if (!('commandId' in message) || !z.uuid().safeParse(message.commandId).success) return;
      offsets.set(id, (offsets.get(id) ?? 0) + 9 * 60 * 60 * 1000);
      process.send?.({ event: 'clock-advanced', commandId: message.commandId });
    }
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close().then(() => { if (process.connected) process.disconnect(); }); });
  await app.listen({ host: '127.0.0.1', port: config.port });
  process.send?.({ event: 'journey-api-ready' });
}

function privateCookie(response: Response, name: string): string {
  const cookies = response.headers.getSetCookie().filter(value => value.startsWith(`${name}=`));
  if (cookies.length !== 1) throw new Error('A synthetic authentication cookie was missing or ambiguous.');
  const cookie = cookies[0]?.split(';', 1)[0];
  if (!cookie) throw new Error('The synthetic authentication cookie was empty.');
  return cookie;
}

/** Probe the actual protected web path before announcing readiness. Values never leave this process. */
async function protectedWebProbe(issuer: string): Promise<void> {
  const login = await fetch(`${WEB_ORIGIN}/api/auth/login`, { redirect: 'manual' });
  const destination = login.headers.get('location');
  if (login.status !== 302 || !destination) throw new Error('Synthetic authorization did not start.');
  const target = new URL(destination);
  if (target.origin !== issuer || target.pathname !== '/authorize') throw new Error('Unexpected synthetic identity destination.');
  target.searchParams.set('test_subject', 'journey-admin');
  const authorized = await fetch(target, { redirect: 'manual' });
  const callback = authorized.headers.get('location');
  if (authorized.status !== 302 || !callback || new URL(callback).origin !== WEB_ORIGIN
    || new URL(callback).pathname !== '/api/auth/callback') throw new Error('Unexpected synthetic callback.');
  const completed = await fetch(callback, { redirect: 'manual', headers: { cookie: privateCookie(login, 'hasi-oidc-transaction') } });
  if (completed.status !== 302) throw new Error('Synthetic callback failed.');
  const cookie = privateCookie(completed, 'hasi-session');
  const session = await fetch(`${WEB_ORIGIN}/api/session`, { headers: { cookie }, redirect: 'error' });
  const parsed = z.object({ mode: z.literal('oidc'), user: z.object({ role: z.literal('admin') }),
    modelContext: z.object({ dataClasses: z.tuple([z.literal('synthetic_demo')]) }) }).safeParse(await session.json());
  let workspaceReady = false;
  if (session.ok && parsed.success) {
    const workspace = await fetch(`${WEB_ORIGIN}/api/chat/workspace`, { headers: { cookie, origin: WEB_ORIGIN }, redirect: 'error' });
    workspaceReady = workspace.ok;
    await workspace.body?.cancel();
  }
  const logout = await fetch(`${WEB_ORIGIN}/api/logout`, { method: 'POST', headers: { cookie, origin: WEB_ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  await logout.body?.cancel();
  if (!workspaceReady || !logout.ok) throw new Error('The protected synthetic web path failed its readiness probe.');
}

/** A held, explicit synthetic composition for actual browser qualification. */
async function serve(): Promise<void> {
  const connectionString = journeyDatabaseUrl(process.env);
  await assertJourneyEnvFilesAbsent();
  for (const port of [3001, 4100, 4101, 4102, 4103]) await available(port);
  const directory = await mkdtemp(join(tmpdir(), 'hasi-plugin-journey-'));
  const children: ChildProcess[] = [];
  const retiring = new WeakSet<ChildProcess>();
  const servers: Server[] = [];
  let referenceProxy: Awaited<ReturnType<typeof startJourneyReferenceProxy>> | undefined;
  let idp: Awaited<ReturnType<typeof startTestIdp>> | undefined;
  let model: Awaited<ReturnType<typeof startJourneyModel>> | undefined;
  let commands = Promise.resolve();
  let shutdown: (() => void) | undefined;
  const complete = new Promise<void>(done => { shutdown = done; });
  const state = { unexpectedExit: false, cleanupFailed: false, shutdownRequested: false };
  const onSignal = () => { state.shutdownRequested = true; shutdown?.(); };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, onSignal);
  let failure: Error | undefined;
  let stopping = false;
  const child = (arguments_: string[], environment: NodeJS.ProcessEnv, cwd = ROOT, ipc = false, executable = process.execPath) => {
    if (state.shutdownRequested) throw new Error('Synthetic journey startup was interrupted.');
    const spawned = spawnJourneyChild({ executable, arguments: arguments_, cwd,
      environment: { ...cleanEnvironment(), ...environment }, ipc, children,
      onUnexpectedExit: () => { if (!stopping && !retiring.has(spawned)) { state.unexpectedExit = true; onSignal(); } } });
    return spawned;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  try {
    console.info(JSON.stringify({ event: 'journey-preparing', syntheticOnly: true, realProviderCalls: false }));
    // Packaging is offline. Its subprocesses must not inherit operator credentials.
    const inherited = cleanEnvironment();
    for (const name of Object.keys(process.env)) if (!(name in inherited) && !['TEST_DATABASE_URL', 'HASI_PLUGIN_JOURNEY'].includes(name)) Reflect.deleteProperty(process.env, name);
    stage = 'independent-artifacts';
    const packaged = await artifacts(directory);
    const first = packaged.releases[0];
    if (!first || packaged.releases.length !== 2) throw new Error('Independent release pair missing.');
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPath = join(directory, 'signing.pem');
    await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const tlsKeyPath = join(directory, 'model-key.pem'); const tlsCertPath = join(directory, 'model-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', tlsKeyPath, '-out', tlsCertPath], { stdio: 'ignore', env: cleanEnvironment() });
    const modelToken = randomBytes(32).toString('base64url');
    model = await startJourneyModel({ key: await readFile(tlsKeyPath), cert: await readFile(tlsCertPath), token: modelToken });
    const annyToken = randomBytes(32).toString('base64url'); const mockToken = randomBytes(32).toString('base64url');
    const knowledgeToken = randomBytes(32).toString('base64url'); const referenceToken = randomBytes(32).toString('base64url');
    stage = 'native-services';
    const mock = child(['--import', 'tsx', 'apps/anny-mock/src/server.ts'], { HASI_MODE: 'development', ANNY_MOCK_TOKEN: mockToken });
    await ready('http://127.0.0.1:4102/health', mock);
    const anny = child(['--import', 'tsx', 'apps/anny-plugin/src/server.ts'], { HASI_MODE: 'development', HASI_PUBLIC_KEY: publicKey, HASI_PLUGIN_TOKEN: annyToken, ANNY_MOCK_TOKEN: mockToken });
    const knowledge = child(['--import', 'tsx', 'apps/knowledge-plugin/src/server.ts'], { HASI_MODE: 'development', HASI_PUBLIC_KEY: publicKey, HASI_KNOWLEDGE_TOKEN: knowledgeToken });
    await Promise.all([ready('http://127.0.0.1:4101/health', anny), ready('http://127.0.0.1:4103/health', knowledge)]);
    stage = 'reference-process';
    const referenceTargetPort = await allocatePort();
    const referenceStatePath = join(directory, 'reference-state.sqlite');
    const startReference = async (release: typeof first) => {
      const started = child(['src/server.js'], { NODE_ENV: 'test', HASI_REFERENCE_PLUGIN_TEST_MODE: '1', HASI_REFERENCE_PLUGIN_HOST: '127.0.0.1',
        HASI_REFERENCE_PLUGIN_PORT: String(referenceTargetPort), HASI_REFERENCE_PLUGIN_TOKEN: referenceToken, HASI_REFERENCE_PLUGIN_PUBLIC_KEY: publicKey,
        HASI_REFERENCE_STATE_FILE: referenceStatePath }, release.directory, true);
      await ready(`http://127.0.0.1:${String(referenceTargetPort)}/healthz`, started);
      return started;
    };
    let activeRelease = first;
    let reference = await startReference(activeRelease);
    referenceProxy = await startJourneyReferenceProxy({ targetOrigin: `http://127.0.0.1:${String(referenceTargetPort)}` });
    const referencePort = Number(new URL(referenceProxy.origin).port);
    stage = 'test-idp';
    idp = await startTestIdp({ mode: 'test', clientId: 'hasi-plugin-journey', redirectUri: `${WEB_ORIGIN}/api/auth/callback`,
      subjects: [{ subject: 'journey-admin', label: 'Test-Administration' }, { subject: 'journey-student', label: 'Test-Studentin' }] });
    const scope = randomUUID();
    const apiPorts: number[] = [];
    const apis: ChildProcess[] = [];
    stage = 'api-replicas';
    for (let index = 0; index < 2; index += 1) {
      const port = await allocatePort(); apiPorts.push(port);
      const path = join(directory, `api-${String(port)}.json`);
      await writeFile(path, JSON.stringify({ scope, issuer: idp.issuer, privateKeyPath, port, annyToken, knowledgeToken,
        referenceToken, referencePort, referenceManifest: packaged.manifest } satisfies ApiConfiguration), { mode: 0o600 });
      const api = child(['--import', 'tsx', SCRIPT, '--api', path], { HASI_PLUGIN_JOURNEY: '1', TEST_DATABASE_URL: connectionString }, ROOT, true);
      apis.push(api); await ready(`http://127.0.0.1:${String(port)}/health`, api);
    }
    let selected = 0;
    const apiProxy = httpServer((request, response) => {
      const port = apiPorts[selected++ % apiPorts.length];
      const upstream = httpRequest({ hostname: '127.0.0.1', port, method: request.method, path: request.url, headers: request.headers, timeout: 45_000 }, received => {
        response.writeHead(received.statusCode ?? 502, received.headers); received.pipe(response);
      });
      upstream.once('error', () => { if (!response.headersSent) response.writeHead(503); response.end(); });
      upstream.once('timeout', () => upstream.destroy()); request.pipe(upstream);
    });
    servers.push(apiProxy); apiProxy.listen(4100, '127.0.0.1'); await once(apiProxy, 'listening');
    const endpoint = `${model.origin}/v1`;
    const config = { schemaVersion: 1, connections: [{ id: 'synthetic-journey', label: 'Local synthetic fixture', provider: 'custom',
      endpoint, credentialRef: 'env:CUSTOM_API_KEY' }], profiles: [{ id: 'synthetic-journey', label: 'Synthetisches Testmodell · kein KI-Anbieter',
      connectionId: 'synthetic-journey', modelId: 'hasi-synthetic-fixture', capabilities: { tools: true }, allowedDataClasses: ['synthetic_demo'],
      parameters: { temperature: null, maxOutputTokens: 512, timeoutMs: 20_000 } }],
    policy: { defaultProfileId: 'synthetic-journey', userChoice: { enabled: true, profileIds: ['synthetic-journey'] }, fallbacks: [], maxAttempts: 2, totalTimeoutMs: 45_000 } };
    stage = 'web-process';
    const web = child(['dev', join(ROOT, 'apps/web'), '--hostname', '127.0.0.1', '--port', '3001'], {
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', HASI_LOCAL_TEST_IDP: '1', HASI_LOCAL_TEST_IDP_SCOPE: scope,
      HASI_CHAT_SIGNING_SECRET: randomBytes(32).toString('base64url'), HASI_WEB_ORIGIN: WEB_ORIGIN, HASI_API_ORIGIN: 'http://127.0.0.1:4100', DATABASE_URL: connectionString,
      NODE_EXTRA_CA_CERTS: tlsCertPath, CUSTOM_API_KEY: modelToken, HASI_LLM_CONFIG: JSON.stringify(config),
      HASI_MODEL_PRICES: JSON.stringify([{ provider: 'custom', baseURL: endpoint, modelId: 'hasi-synthetic-fixture',
        inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000, basis: 'operator_estimate' }]),
    }, ROOT, false, join(ROOT, 'apps/web/node_modules/.bin/next'));
    await ready(`${WEB_ORIGIN}/api/session`, web);
    await ready(`${WEB_ORIGIN}/`, web);
    stage = 'protected-web-probe';
    await protectedWebProbe(idp.issuer);
    const writeEvidence = async () => writeFile(join(directory, 'evidence.json'), JSON.stringify({ scope, webOrigin: WEB_ORIGIN, apiReplicas: 2, hostPid: process.pid,
      apiPids: apis.map(process_ => process_.pid), referencePid: reference.pid, referenceVersion: activeRelease.evidence.pluginVersion,
      persistentReferenceState: true, referenceProxy: referenceProxy?.stats(),
      releases: packaged.releases.map(release => ({ sourceSha: release.sourceSha, ...release.evidence })) }, null, 2), { mode: 0o600 });
    await writeEvidence();
    console.info(JSON.stringify({ event: 'plugin-journey-ready', webOrigin: WEB_ORIGIN, evidence: join(directory, 'evidence.json'), apiReplicas: 2,
      independentReferencePid: reference.pid, syntheticOnly: true, commands: ['expire-anny', 'expire-reference', 'reference-lose-ack', 'reference-source-unavailable', 'reference-source-available', 'reference-drop-reply', 'restart-reference', 'reference-v2', 'reference-v1', 'stats', 'quit'] }));
    stage = 'ready';
    input = createInterface({ input: process.stdin, terminal: false });
    input.on('line', line => {
      if (state.shutdownRequested) return;
      commands = commands.then(async () => {
        if (state.shutdownRequested) return;
        if (line === 'quit') { onSignal(); return; }
        if (line === 'expire-anny' || line === 'expire-reference') {
          await advanceAccountClocks(apis, line);
          console.info(JSON.stringify({ event: 'synthetic-account-clock-advanced', service: line, replicasAcknowledged: apis.length }));
        } else if (line === 'reference-lose-ack' || line === 'reference-source-unavailable' || line === 'reference-source-available') {
          const command = line === 'reference-lose-ack' ? 'lose-next-execution-ack' : line === 'reference-source-unavailable' ? 'source-unavailable' : 'source-available';
          await sendReferenceCommand(reference, command);
          console.info(JSON.stringify({ event: 'reference-control-applied', command }));
        } else if (line === 'reference-drop-reply') {
          referenceProxy?.armNextExecutionReplyDrop();
          console.info(JSON.stringify({ event: 'reference-reply-drop-armed' }));
        } else if (line === 'restart-reference' || line === 'reference-v2' || line === 'reference-v1') {
          const nextRelease = line === 'restart-reference' ? activeRelease : packaged.releases[line === 'reference-v2' ? 1 : 0];
          if (!nextRelease) throw new Error('The independent reference release is unavailable.');
          retiring.add(reference);
          await stopJourneyChild(reference);
          if (reference.exitCode !== 0 || reference.signalCode !== null) throw new Error('Reference process did not stop gracefully.');
          reference = await startReference(nextRelease);
          activeRelease = nextRelease;
          await writeEvidence();
          console.info(JSON.stringify({ event: 'reference-process-restarted', referencePid: reference.pid, version: activeRelease.evidence.pluginVersion,
            stats: await sendReferenceCommand(reference, 'stats'), artifactDigest: activeRelease.evidence.artifactSha256 }));
        } else if (line === 'stats') {
          console.info(JSON.stringify({ event: 'synthetic-model-stats', calls: model?.calls(), resultObservations: model?.resultObservations(), realProviderCalls: 0,
            reference: await sendReferenceCommand(reference, 'stats'), proxy: referenceProxy?.stats() }));
          await writeEvidence();
        } else console.info(JSON.stringify({ event: 'unknown-fixture-command' }));
      }).catch(() => { if (!state.shutdownRequested) { state.unexpectedExit = true; onSignal(); } });
    });
    timer = setTimeout(onSignal, 30 * 60 * 1000);
    await complete;
    if (state.unexpectedExit) throw new Error('A fixture child stopped unexpectedly.');
  } catch (error) {
    failure = error instanceof Error ? error : new Error('Synthetic fixture failed.');
  } finally {
    stopping = true; state.shutdownRequested = true; clearTimeout(timer); input?.close();
    await commands;
    const results = await Promise.allSettled(children.map(stopJourneyChild));
    results.push(...await Promise.allSettled(servers.map(server => new Promise<void>((done, reject) => {
      server.closeAllConnections(); server.close(error => { if (error) reject(error); else done(); });
    }))));
    results.push(...await Promise.allSettled([idp?.close(), model?.close(), referenceProxy?.close()]));
    results.push(...await Promise.allSettled([rm(directory, { recursive: true, force: true })]));
    state.cleanupFailed = results.some(result => result.status === 'rejected');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.off(signal, onSignal);
    console.info(JSON.stringify({ event: 'plugin-journey-stopped', ownedProcessesStopped: !state.cleanupFailed, callerOwnedTestDatabaseRetained: true }));
  }
  if (state.cleanupFailed) throw new Error('An owned fixture process or server did not stop.');
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const operation = process.argv[2] === '--api' ? apiChild(process.argv[3] ?? '') : serve();
  await operation.catch((error: unknown) => { console.error(JSON.stringify({ event: 'synthetic-plugin-journey-failed', stage, operatorCredentialsUsed: false, productionStateUsed: false, ...(error instanceof ReferencePackagingCommandError ? { diagnostic: error.message } : {}) })); process.exitCode = 1; });
}
