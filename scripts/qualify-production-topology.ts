import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest, type Server } from 'node:https';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { ProductionAuthorityDirectory, createProductionRuntime, stableOidcSubject } from '../apps/api/src/production-runtime.js';
import { startTestIdp } from '../apps/api/src/test-idp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url);
let stage = 'preflight';
interface Configuration { scope: string; webOrigin: string; issuer: string; privateKeyPath: string; port: number }
interface ProbeResponse { status: number; headers: import('node:http').IncomingHttpHeaders; text: string }

class QualificationError extends Error {}
function assert(value: unknown, message: string): asserts value { if (!value) throw new QualificationError(message); }

function database(): string {
  const value = process.env.TEST_DATABASE_URL;
  assert(value, 'An isolated TEST_DATABASE_URL is required.');
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port
    && !url.search && !url.hash && url.pathname === '/hasi_topology_test', 'Use an explicit loopback port and the hasi_topology_test database, without query overrides; never an application database.');
  return value;
}

async function port(): Promise<number> {
  const listener = netServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address !== 'string', 'Loopback port allocation failed.');
  await new Promise<void>((resolveClose, reject) => listener.close(error => { if (error) reject(error); else resolveClose(); }));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = await Promise.race([exit.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => { done(false); }, 5000); })]);
    if (!graceful) {
      clearTimeout(timer); child.kill('SIGKILL');
      const terminated = await Promise.race([exit.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => { done(false); }, 3000); })]);
      assert(terminated, 'An isolated qualification child could not be terminated.');
    }
  } finally { clearTimeout(timer); }
}

function child(command: readonly string[], environment: NodeJS.ProcessEnv): ChildProcess {
  // Explicit allowlist: no model, plugin or operator credentials are inherited.
  const process_ = spawn(process.execPath, [...command], { cwd: root, env: { PATH: process.env.PATH ?? '', ...environment }, stdio: 'ignore' });
  process_.on('error', () => undefined);
  assert(process_.pid, 'Qualification child process failed to start.');
  return process_;
}

function request(url: string, ca: Buffer | undefined, input: { method?: string; cookie?: string; origin?: string; host?: string; requestId?: string; body?: unknown } = {}): Promise<ProbeResponse> {
  return new Promise((done, reject) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const transport = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = transport(url, {
      ca, servername: 'localhost', method: input.method ?? 'GET', timeout: 10_000,
      headers: { ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.origin ? { origin: input.origin } : {}),
        ...(input.host ? { host: input.host } : {}), ...(input.requestId ? { 'x-request-id': input.requestId } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(new Error('Oversized qualification response.')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { done({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(new Error('Qualification request timed out.')));
    req.end(body);
  });
}

async function proxy(key: Buffer, cert: Buffer, targetPort: () => number): Promise<{ server: Server; origin: string }> {
  const server = httpsServer({ key, cert }, (incoming, outgoing) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort(), path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' }, timeout: 15_000 }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
    upstream.once('timeout', () => upstream.destroy()); incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string', 'TLS proxy failed to bind.');
  return { server, origin: `https://127.0.0.1:${address.port.toString()}` };
}

async function ready(url: string, ca: Buffer, process_: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert(process_.exitCode === null && process_.signalCode === null, 'Qualification child exited before readiness.');
    try { if ((await request(url, ca)).status === 200) return; } catch { /* Bounded startup only. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new QualificationError('Qualification runtime did not become ready.');
}

async function apiChild(path: string): Promise<void> {
  const config = JSON.parse(await readFile(path, 'utf8')) as Configuration;
  const store = new PostgresJsonStore(`topology:${config.scope}`, { poolConfig: { connectionString: database(), max: 4 } });
  await store.initialize();
  const runtime = await createProductionRuntime({ privateKey: createPrivateKey(await readFile(config.privateKeyPath)), store, scope: config.scope,
    webOrigin: config.webOrigin, apiHostname: '127.0.0.1', plugins: [], identity: { issuer: config.issuer, clientId: 'hasi-topology-test' } });
  runtime.app.addHook('onClose', () => store.close());
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void runtime.app.close(); });
  await runtime.app.listen({ host: '127.0.0.1', port: config.port });
}

async function main(): Promise<void> {
  assert(process.env.HASI_TOPOLOGY_QUALIFY === '1', 'Set HASI_TOPOLOGY_QUALIFY=1 for the isolated local topology run.');
  const connectionString = database();
  const directory = await mkdtemp(join(tmpdir(), 'hasi-topology-'));
  const children: ChildProcess[] = []; const servers: Server[] = [];
  let identity: Awaited<ReturnType<typeof startTestIdp>> | undefined;
  let store: PostgresJsonStore | undefined;
  try {
    stage = 'ephemeral-tls';
    const keyPath = join(directory, 'tls-key.pem'); const certPath = join(directory, 'tls-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const key = await readFile(keyPath); const cert = await readFile(certPath);
    const apiPorts = [await port(), await port()]; const webPort = await port(); let selectedApi = 0;
    const web = await proxy(key, cert, () => webPort); servers.push(web.server);
    const api = await proxy(key, cert, () => { const selected = apiPorts[selectedApi % 2]; selectedApi += 1; assert(selected, 'Missing API route.'); return selected; }); servers.push(api.server);
    stage = 'test-idp';
    identity = await startTestIdp({ mode: 'test', clientId: 'hasi-topology-test', redirectUri: `${web.origin}/api/auth/callback`, subject: 'synthetic-operator', tls: { key, cert } });
    const scope = randomUUID(); const keys = generateKeyPairSync('ed25519'); const signingPath = join(directory, 'api-signing.pem');
    await writeFile(signingPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    stage = 'postgres';
    store = new PostgresJsonStore(`topology:${scope}`, { poolConfig: { connectionString, max: 4 } }); await store.initialize();
    const authorities = new ProductionAuthorityDirectory(store, keys.privateKey, scope);
    const subject = stableOidcSubject(identity.issuer, 'synthetic-operator');
    const grant = { id: subject, displayName: 'Synthetic operator', role: 'admin' as const, actor: { subject, permissions: ['plugins:manage'] } };
    assert(await authorities.replace(subject, null, grant), 'Synthetic authority could not be provisioned.');
    stage = 'child-process-start';
    const configurationPaths: string[] = [];
    const apiEnvironment = { TEST_DATABASE_URL: connectionString, NODE_EXTRA_CA_CERTS: certPath, NODE_ENV: 'production' };
    for (const apiPort of apiPorts) {
      const path = join(directory, `api-${apiPort.toString()}.json`); configurationPaths.push(path);
      await writeFile(path, JSON.stringify({ scope, webOrigin: web.origin, issuer: identity.issuer, privateKeyPath: signingPath, port: apiPort } satisfies Configuration), { mode: 0o600 });
      children.push(child(['--import', 'tsx', script, '--api', path], apiEnvironment));
    }
    // The existing build must have no development API rewrite. The README command
    // builds the production frontend first; this runner never inherits secrets.
    const routes = JSON.parse(await readFile(join(root, 'apps/web/.next/routes-manifest.json'), 'utf8')) as { rewrites?: unknown };
    assert(!JSON.stringify(routes.rewrites).includes('/api/:path*'), 'Build the frontend in HASI_APP_MODE=production before qualification.');
    const webChild = child([join(root, 'apps/web/node_modules/next/dist/bin/next'), 'start', join(root, 'apps/web'), '--hostname', '127.0.0.1', '--port', webPort.toString()], {
      NODE_ENV: 'production', NODE_EXTRA_CA_CERTS: certPath, HASI_APP_MODE: 'production', HASI_WEB_ORIGIN: web.origin, HASI_API_ORIGIN: api.origin,
      HASI_CHAT_SIGNING_SECRET: randomBytes(32).toString('base64url'), DATABASE_URL: connectionString,
    }); children.push(webChild);
    stage = 'api-readiness';
    await Promise.all(children.slice(0, 2).map((process_, index) => ready(`http://127.0.0.1:${String(apiPorts[index])}/health`, cert, process_)));
    stage = 'web-readiness';
    await ready(`${web.origin}/api/session`, cert, webChild);
    assert((await request(`${web.origin}/`, cert)).status === 200, 'Next.js frontend did not serve its page.');
    let tlsDenied = false;
    try { await request(`${web.origin}/api/session`, undefined); } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      tlsDenied = code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN';
    }
    assert(tlsDenied, 'TLS counter-probe accepted an untrusted certificate.');
    assert((await request(`${web.origin}/api/admin/plugin-catalog`, cert)).status === 401, 'Anonymous administration was not denied.');
    const correlated = await request(`${web.origin}/api/session`, cert, { requestId: 'forged-request-id' });
    assert(typeof correlated.headers['x-request-id'] === 'string' && /^[a-f0-9-]{36}$/iu.test(correlated.headers['x-request-id']), 'Frontend did not return the backend-generated request identifier.');
    assert((await request(`${web.origin}/api/dev/login`, cert, { method: 'POST', origin: web.origin, body: { personaId: 'admin' } })).status === 404, 'Production exposed mock persona login.');
    assert((await request(`${web.origin}/api/session`, cert, { host: 'attacker.invalid' })).status === 403, 'Frontend accepted an unapproved Host.');
    stage = 'oidc-login';
    const login = await request(`${web.origin}/api/auth/login?returnTo=%2Fadmin`, cert);
    assert(login.status === 302 && typeof login.headers.location === 'string', 'OIDC authorization did not start.');
    const transaction = login.headers['set-cookie']?.find(value => value.startsWith('hasi-oidc-transaction='));
    assert(transaction, 'OIDC transaction cookie missing.');
    const transactionCookie = transaction.split(';')[0]; assert(transactionCookie, 'OIDC transaction cookie missing.');
    const authorized = await request(login.headers.location, cert);
    assert(authorized.status === 302 && typeof authorized.headers.location === 'string', 'Test-IdP did not authorize the bound request.');
    const callback = await request(authorized.headers.location, cert, { cookie: transactionCookie });
    assert(callback.status === 302 && callback.headers.location === `${web.origin}/admin`, 'Cross-replica OIDC callback failed.');
    const session = callback.headers['set-cookie']?.find(value => value.startsWith('__Host-hasi-session='));
    assert(session && /; Secure(?:;|$)/iu.test(session) && /; HttpOnly(?:;|$)/iu.test(session)
      && /; Path=\/(?:;|$)/iu.test(session) && !/;\s*Domain=/iu.test(session), 'Production session cookie is not secure and host-bound.');
    const cookie = session.split(';')[0]; assert(cookie, 'Session cookie missing.');
    assert((await request(authorized.headers.location, cert, { cookie: transactionCookie })).status >= 400, 'OIDC callback replay succeeded.');
    stage = 'concurrent-sessions';
    const latencies = await Promise.all(Array.from({ length: 24 }, async () => {
      const started = performance.now(); const response = await request(`${web.origin}/api/session`, cert, { cookie });
      assert(response.status === 200 && (JSON.parse(response.text) as { user?: { id: string } }).user?.id === subject, 'Replica session authority diverged.');
      return Math.round((performance.now() - started) * 100) / 100;
    }));
    assert((await request(`${web.origin}/api/admin/plugin-catalog`, cert, { cookie })).status === 200, 'Approved operator access failed.');
    assert((await request(`${web.origin}/api/admin/plugin-catalog`, cert, { cookie: '__Host-hasi-session=forged' })).status === 401, 'Forged session gained authority.');
    assert((await request(`${web.origin}/api/logout`, cert, { method: 'POST', origin: 'https://attacker.invalid', cookie })).status === 403, 'Cross-origin mutation succeeded.');
    stage = 'replica-restart';
    const firstApi = children[0]; assert(firstApi, 'Missing API replica.'); const originalPid = firstApi.pid; await stop(firstApi);
    const configurationPath = configurationPaths[0]; assert(configurationPath, 'Missing API configuration.');
    const restarted = child(['--import', 'tsx', script, '--api', configurationPath], apiEnvironment); children[0] = restarted;
    await ready(`http://127.0.0.1:${String(apiPorts[0])}/health`, cert, restarted);
    assert(restarted.pid !== originalPid && (await request(`http://127.0.0.1:${String(apiPorts[0])}/api/admin/plugin-catalog`, cert, { cookie })).status === 200, 'Process restart lost durable identity.');
    stage = 'authority-downgrade-and-logout';
    const authorityKey = `authority:v1:${createHash('sha256').update(subject).digest('hex')}`;
    const current = await store.read(authorityKey); assert(current, 'Authority revision missing.');
    assert(await authorities.replace(subject, current.revision, { ...grant, role: 'student', actor: { subject, permissions: [] } }), 'Authority downgrade failed.');
    for (let index = 0; index < 4; index += 1) assert((await request(`${web.origin}/api/admin/plugin-catalog`, cert, { cookie })).status === 403, 'A replica retained revoked administrator authority.');
    assert((await request(`${web.origin}/api/logout`, cert, { method: 'POST', origin: web.origin, cookie })).status === 200, 'Logout failed.');
    for (let index = 0; index < 4; index += 1) assert((await request(`${web.origin}/api/tools`, cert, { cookie })).status === 401, 'Logout did not propagate across replicas.');
    latencies.sort((a, b) => a - b);
    console.info(JSON.stringify({ event: 'production_topology_qualified', scope: 'synthetic-identity-and-api-only', node: process.version,
      apiReplicas: 2, separateNextProcess: true, tlsVerified: true, sharedPostgres: true, restartPreservedSession: true,
      requests: latencies.length, p50Ms: latencies[11], p95Ms: latencies[22], liveModelCalls: 0,
      remaining: ['isolated-plugin-worker', 'model-budget-topology', 'browser-journeys', 'M8-real-device-and-institutional-acceptance'] }));
  } finally {
    const cleanup = await Promise.allSettled(children.map(stop));
    cleanup.push(...await Promise.allSettled(servers.map(server => new Promise<void>((done, reject) => {
      server.closeAllConnections(); server.close(error => { if (error) reject(error); else done(); });
    }))));
    cleanup.push(...await Promise.allSettled([identity?.close(), store?.close()]));
    await rm(directory, { recursive: true, force: true });
    assert(cleanup.every(result => result.status === 'fulfilled'), 'An isolated qualification runtime could not be cleaned up.');
  }
}

if (process.argv[2] === '--api') {
  const path = process.argv[3]; assert(path, 'Missing qualification configuration.');
  await apiChild(path).catch(() => { console.error('Synthetic API replica startup failed.'); process.exitCode = 1; });
} else {
  await main().catch((error: unknown) => {
    // Only our static assertion text is publishable; upstream exceptions may
    // contain connection details and must never be echoed.
    const frame = error instanceof Error ? error.stack?.split('\n').find(line => line.includes(script))?.match(/:(\d+):(\d+)\)?$/u)?.[1] : undefined;
    console.error(`Production topology qualification failed at ${stage}${frame ? ` (script line ${frame})` : ''}: ${error instanceof QualificationError ? error.message : 'check the isolated fixture and build prerequisites.'}`);
    process.exitCode = 1;
  });
}
