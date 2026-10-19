import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresJsonStore } from '@hasi/state';
import { hshDemoCatalog } from '../fixtures/catalog.js';
import { knowledgeDocumentV2Schema } from '@hasi/knowledge-plugin/contracts';
import { parsePluginAccountBegin, parsePluginAccountList } from '../apps/web/src/lib/plugin-accounts.js';
import {
  collectDemoPerformanceBatch, DEMO_PERFORMANCE_LIMIT_MS, DEMO_PERFORMANCE_SAMPLES_PER_BATCH,
  validateDemoPerformanceEnvironment,
} from './demo-performance-qualification.js';
import { ZodError, z } from 'zod';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'apps/web');
let currentPhase = 'environment_validation';
let currentNamespace: string | null = null;
const OWNER_KEY = 'qualification:owner';
const OWNER_MARKER_LIMIT = 5_001;
const MAX_NAMESPACE_ROWS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const resourceSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), description: z.string(), capacity: z.number().int().min(1).nullable(),
  location: z.string(), features: z.array(z.string()), serviceId: z.string().min(1),
  kind: z.enum(['workplace', 'meeting_room', 'lecture_hall', 'room']), parentId: z.string().nullable(),
  parentName: z.string().nullable(), officeWorkplaceCount: z.number().int().min(1).nullable(),
});
const resultMetadataSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.strictObject({
    installationId: z.string().min(1).max(128), packageId: z.literal('de.hsh.hasi.anny'),
    version: z.string().min(1), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    configurationRevision: z.number().int().nonnegative(), authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    fetchedAt: z.iso.datetime({ offset: true }), sourceId: z.literal('synthetic-demo'),
    policyRevision: z.literal('1'), dataClasses: z.tuple([z.literal('synthetic_demo')]),
  }),
  pagination: z.strictObject({ mode: z.literal('unpaged'), complete: z.literal(true) }),
});
const resourcesSchema = z.strictObject({ resources: z.array(resourceSchema).min(1).max(100), _hasi: resultMetadataSchema });
const searchSchema = z.strictObject({ documents: z.array(knowledgeDocumentV2Schema).max(5), contextId: z.uuid() });
const lookupSchema = z.strictObject({ document: knowledgeDocumentV2Schema });
const availabilitySchema = z.strictObject({ intervals: z.array(z.strictObject({ startDate: z.string().min(1), endDate: z.string().min(1), available: z.boolean() })).min(1), _hasi: resultMetadataSchema });
const sessionSchema = z.strictObject({ mode: z.literal('mock'), user: z.strictObject({ id: z.string(), displayName: z.string(), role: z.literal('employee') }).nullable() });
const contextResolutionSchema = z.strictObject({ contexts: z.array(z.strictObject({ contextId: z.uuid(), status: z.string() })) });
interface PgResult<T> { rows: T[]; rowCount: number | null }
interface PgClient { query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgResult<T>>; release(): void }
interface PgPool { connect(): Promise<PgClient>; end(): Promise<void> }
interface PgModule { Pool: new (config: object) => PgPool }

function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function requiredAt<T>(values: readonly T[], index: number, code: string): T { const value = values[index]; assert(value !== undefined, code); return value; }
function safeError(error: unknown): string {
  if (error instanceof ZodError) return 'demo_api_schema_mismatch';
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]+$/u.test(message) ? message : 'demo_performance_qualification_failed';
}

async function existingStandaloneServer(): Promise<string> {
  const buildDir = join(WEB, '.next');
  try {
    await stat(join(buildDir, 'BUILD_ID'));
    const manifest = JSON.parse(await readFile(join(buildDir, 'routes-manifest.json'), 'utf8')) as { rewrites?: unknown };
    assert(!JSON.stringify(manifest.rewrites ?? []).includes('/api/:path*'), 'production_build_routes_api_elsewhere');
    const candidates = [join(buildDir, 'standalone/apps/web/server.js'), join(buildDir, 'standalone/server.js')];
    for (const candidate of candidates) { try { await stat(candidate); return candidate; } catch { /* Check the next supported standalone layout. */ } }
  } catch (error) {
    if (error instanceof Error && error.message === 'production_build_routes_api_elsewhere') throw error;
  }
  throw new Error('production_build_required');
}

async function reserveLoopbackPorts(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  try {
    const ports = await Promise.all(servers.map(server => new Promise<number>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('loopback_port_unavailable'));
        else resolve(address.port);
      });
    })));
    const first = ports[0]; const second = ports[1];
    assert(first !== undefined && second !== undefined && first !== second, 'loopback_ports_collided');
    return [first, second];
  } finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => { resolve(); })))); }
}

async function createLoopbackProxy(nextPort: number, port: number, delayMs = 0): Promise<Server> {
  assert(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 2_000, 'delay_control_invalid');
  const publicHost = `127.0.0.1:${String(port)}`;
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.headers.host !== publicHost) { outgoing.writeHead(421).end(); return; }
    const forward = () => {
      const path = incoming.url ?? '/';
      if (!path.startsWith('/') || path.startsWith('//')) { outgoing.writeHead(400).end(); return; }
      const headers = { ...incoming.headers, host: publicHost, connection: 'close' };
      const upstream = httpRequest({ hostname: '127.0.0.1', port: nextPort, method: incoming.method, path, headers }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
        response.pipe(outgoing);
      });
      upstream.setTimeout(REQUEST_TIMEOUT_MS, () => { upstream.destroy(new Error('proxy_upstream_timeout')); });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    };
    if (delayMs > 0 && incoming.method === 'GET' && (incoming.url ?? '').split('?')[0] === '/api/resources') setTimeout(forward, delayMs);
    else forward();
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(port, '127.0.0.1', resolve); });
  return proxy;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<void>(resolve => child.once('exit', () => { resolve(); }));
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => { resolve(false); }, 5_000); })]);
  if (timer) clearTimeout(timer);
  if (graceful) return true;
  child.kill('SIGKILL');
  return Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { setTimeout(() => { resolve(false); }, 2_000); })]);
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('demo_next_server_exited_early');
    try {
      const response = await fetch(`${origin}/`, { redirect: 'error', signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) { await response.body?.cancel(); return; }
      await response.body?.cancel();
    } catch { /* Keep waiting for the exact child process to bind its loopback port. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('demo_next_server_start_timeout');
}

interface DemoSession { cookies: Map<string, string>; knownWorkspaces: Set<string> }

function updateJar(jar: DemoSession, response: Response): void {
  for (const value of response.headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (separator < 1 || !pair) continue;
    const name = pair.slice(0, separator).trim();
    const maxAge = attributes.find(attribute => attribute.trim().toLowerCase().startsWith('max-age='));
    const cookie = pair.slice(separator + 1).trim();
    if (maxAge && Number(maxAge.trim().slice(8)) <= 0) jar.cookies.delete(name);
    else {
      if (name === 'hasi-demo-workspace') {
        const id = cookie.split('.')[0];
        assert(typeof id === 'string' && UUID.test(id), 'demo_workspace_cookie_invalid');
        assert(jar.knownWorkspaces.has(id) || jar.knownWorkspaces.size < 5, 'demo_workspace_cookie_limit_exceeded');
        jar.knownWorkspaces.add(id);
      }
      jar.cookies.set(name, cookie);
    }
  }
}

async function jsonRequest(origin: string, jar: DemoSession, path: string, body?: unknown): Promise<unknown> {
  const headers = new Headers({ origin });
  if (jar.cookies.size) headers.set('cookie', [...jar.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (body !== undefined) { headers.set('content-type', 'application/json'); init.body = JSON.stringify(body); }
  const response = await fetch(new URL(path, origin), init);
  updateJar(jar, response);
  const length = Number(response.headers.get('content-length'));
  assert(!Number.isFinite(length) || length <= 2_000_000, 'demo_api_response_too_large');
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 2_000_000, 'demo_api_response_too_large');
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error('demo_api_response_invalid_json'); }
  assert(response.ok, 'demo_api_http_error');
  return value;
}

function workspaceId(jar: DemoSession): string {
  const signed = jar.cookies.get('hasi-demo-workspace');
  const id = signed?.split('.')[0];
  assert(typeof id === 'string' && UUID.test(id), 'demo_workspace_cookie_invalid');
  assert(jar.knownWorkspaces.has(id), 'demo_workspace_cookie_not_recorded');
  return id;
}

async function bootstrapUser(origin: string, jar: DemoSession): Promise<{ id: string; workspaceId: string }> {
  const session = sessionSchema.parse(await jsonRequest(origin, jar, '/api/session'));
  assert(session.user === null, 'demo_workspace_session_unexpected');
  const workspace = workspaceId(jar);
  const login = z.strictObject({ mode: z.literal('mock'), user: z.strictObject({ id: z.string(), displayName: z.string(), role: z.literal('employee') }) })
    .parse(await jsonRequest(origin, jar, '/api/dev/login', { personaId: 'employee' }));
  assert(login.user.id === `${workspace}:employee`, 'demo_employee_subject_mismatch');
  const current = sessionSchema.parse(await jsonRequest(origin, jar, '/api/session'));
  assert(current.user?.id === login.user.id, 'demo_employee_session_mismatch');
  const accounts = parsePluginAccountList(await jsonRequest(origin, jar, '/api/plugin-accounts'));
  const account = accounts[0];
  assert(accounts.length === 1 && account?.installationId === 'de.hsh.hasi.anny', 'demo_plugin_account_shape_invalid');
  if (account.status !== 'linked') {
    const begin = parsePluginAccountBegin(await jsonRequest(origin, jar, `/api/plugin-accounts/${account.installationId}/authorization`, { operation: 'consent', returnTo: '/' }));
    const state = new URL(begin.authorizationUrl, origin).searchParams.get('state');
    assert(state, 'demo_consent_state_missing');
    await jsonRequest(origin, jar, `/api/plugin-accounts/${account.installationId}/consent`, { state, approved: true });
  }
  const linked = parsePluginAccountList(await jsonRequest(origin, jar, '/api/plugin-accounts'));
  assert(linked[0]?.status === 'linked' && linked[0].adapterTrust === 'demo-only', 'demo_plugin_account_not_synthetic');
  return { id: login.user.id, workspaceId: workspace };
}

async function assertReadPayloads(origin: string, jar: DemoSession, expectedResourceIds: ReadonlySet<string>): Promise<void> {
  const resources = resourcesSchema.parse(await jsonRequest(origin, jar, '/api/resources')).resources;
  assert(resources.length === expectedResourceIds.size && new Set(resources.map(resource => resource.id)).size === expectedResourceIds.size && resources.every(resource => expectedResourceIds.has(resource.id)), 'demo_resources_payload_mismatch');
  const search = searchSchema.parse(await jsonRequest(origin, jar, '/api/tools/call', {
    pluginId: 'de.hsh.hasi.knowledge', name: 'knowledge.search', arguments: { query: 'Morgenstern-Lab', sourceSystem: 'service_it', limit: 3 },
  }));
  assert(search.documents.some(document => document.id === 'svc-001' && document.synthetic && document.dataClass === 'synthetic_demo'), 'demo_knowledge_search_payload_mismatch');
  const lookup = lookupSchema.parse(await jsonRequest(origin, jar, '/api/knowledge/documents/svc-001?revision=1'));
  assert(lookup.document.citationId === 'knowledge:service_it:svc-001:1' && lookup.document.synthetic, 'demo_knowledge_lookup_payload_mismatch');
  const accounts = parsePluginAccountList(await jsonRequest(origin, jar, '/api/plugin-accounts'));
  assert(accounts.length === 1 && accounts[0]?.status === 'linked' && accounts[0].adapterTrust === 'demo-only', 'demo_plugin_account_payload_mismatch');
}

async function searchContext(origin: string, jar: DemoSession): Promise<string> {
  const result = searchSchema.parse(await jsonRequest(origin, jar, '/api/tools/call', {
    pluginId: 'de.hsh.hasi.knowledge', name: 'knowledge.search', arguments: { query: 'Morgenstern-Lab', sourceSystem: 'service_it', limit: 3 },
  }));
  assert(result.documents.some(document => document.id === 'svc-001'), 'demo_knowledge_context_fixture_missing');
  return result.contextId;
}

async function assertWorkspaceIsolation(origin: string, jars: readonly DemoSession[]): Promise<void> {
  const contexts = await Promise.all(jars.map(jar => searchContext(origin, jar)));
  assert(new Set(contexts).size === jars.length, 'demo_knowledge_context_ids_not_distinct');
  for (let index = 0; index < jars.length; index += 1) {
    const other = (index + 1) % jars.length;
    const contextId = contexts[index]; const otherJar = jars[other];
    assert(contextId !== undefined && otherJar !== undefined, 'demo_workspace_isolation_fixture_invalid');
    const result = contextResolutionSchema.parse(await jsonRequest(origin, otherJar, '/api/knowledge/contexts/resolve', { contextIds: [contextId] }));
    assert(result.contexts.length === 1 && result.contexts[0]?.contextId === contextId && result.contexts[0].status === 'unavailable', 'demo_knowledge_workspace_isolation_failed');
  }
}

function createCleanupPool(database: object): PgPool {
  const stateEntry = import.meta.resolve('@hasi/state');
  const stateRequire = createRequire(stateEntry);
  const pg = stateRequire('pg') as PgModule;
  return new pg.Pool({ ...database, max: 1, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 1_000 });
}

async function cleanupNamespace(database: object, namespace: string, ownerNonce: string, workspaceIds: readonly string[]): Promise<void> {
  const pool = createCleanupPool(database);
  let client: PgClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const marker = await client.query<{ value: unknown }>('SELECT value FROM hasi_state_v1 WHERE namespace = $1 AND key = $2 FOR UPDATE', [namespace, OWNER_KEY]);
    const value = marker.rows[0]?.value as { nonce?: unknown } | undefined;
    assert(value?.nonce === ownerNonce, 'demo_cleanup_owner_marker_mismatch');
    const selected = await client.query<{ key: string }>('SELECT key FROM hasi_state_v1 WHERE namespace = $1 ORDER BY key LIMIT $2', [namespace, OWNER_MARKER_LIMIT]);
    assert(selected.rows.length <= MAX_NAMESPACE_ROWS, 'demo_cleanup_namespace_row_limit_exceeded');
    const ids = new Set(workspaceIds);
    const keys = selected.rows.map(row => row.key);
    assert(keys.includes(OWNER_KEY) && keys.every(key => key === OWNER_KEY
      || /^invocation:[A-Za-z0-9_-]{1,128}$/u.test(key)
      || /^execution:v1:[a-f0-9]{64}$/u.test(key)
      || [...ids].some(id => key.startsWith(`workspace:${id}:`))), 'demo_cleanup_unknown_namespace_key');
    const deleted = await client.query('DELETE FROM hasi_state_v1 WHERE namespace = $1 AND key = ANY($2::text[]) RETURNING key', [namespace, keys]);
    assert((deleted.rowCount ?? deleted.rows.length) === keys.length, 'demo_cleanup_delete_count_mismatch');
    const remaining = await client.query('SELECT key FROM hasi_state_v1 WHERE namespace = $1 LIMIT 1', [namespace]);
    assert(remaining.rows.length === 0, 'demo_cleanup_namespace_not_empty');
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client?.release(); await pool.end(); }
}

async function main(): Promise<void> {
  currentPhase = 'environment_validation';
  const { databaseUrl, database } = validateDemoPerformanceEnvironment(process.env);
  currentPhase = 'standalone_build';
  const standaloneServer = await existingStandaloneServer();
  const namespace = `demo-performance-${randomUUID()}`;
  currentNamespace = namespace;
  currentPhase = 'namespace_initialization';
  const ownerNonce = randomBytes(24).toString('base64url');
  const report: Record<string, unknown> = {
    phase: currentPhase, namespace, cleanupFailure: null,
    topology: 'local-standalone-next-demo-api-loopback-postgres', transport: 'http-loopback', apiMode: 'test',
    publicHttpsPerformanceQualified: false, users: 5, role: 'employee', batchesPerRoute: 2,
    samplesPerUserPerBatch: 20, samplesPerBatch: DEMO_PERFORMANCE_SAMPLES_PER_BATCH, p95LimitMs: DEMO_PERFORMANCE_LIMIT_MS,
    coldSessionMs: null, routes: [], delayControl: null, cleanupVerified: false,
  };
  let store: PostgresJsonStore | undefined;
  let proxy: Server | undefined;
  let child: ChildProcess | undefined;
  let namespaceMarked = false;
  let cleanupVerified = false;
  let failure: string | undefined;
  const knownWorkspaces = new Set<string>();
  try {
    store = new PostgresJsonStore(namespace, { poolConfig: database });
    await store.initialize();
    namespaceMarked = await store.compareAndSet(OWNER_KEY, null, { nonce: ownerNonce, namespace });
    assert(namespaceMarked, 'demo_namespace_owner_marker_collision');
    currentPhase = 'demo_server_start';
    const [nextPort, proxyPort] = await reserveLoopbackPorts();
    const origin = `http://127.0.0.1:${String(proxyPort)}`;
    proxy = await createLoopbackProxy(nextPort, proxyPort);
    const secret = randomBytes(32).toString('base64url');
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(nextPort), NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: databaseUrl, HASI_DEMO_MODE: '1', HASI_DEMO_SECRET: secret,
      HASI_DEMO_STATE_NAMESPACE: namespace, HASI_DEMO_ORIGIN: origin,
    };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG']) if (process.env[name]) childEnv[name] = process.env[name];
    child = spawn(process.execPath, [standaloneServer], { cwd: dirname(standaloneServer), env: childEnv, stdio: 'ignore' });
    await waitForServer(origin, child);
    currentPhase = 'user_bootstrap';
    const jars: DemoSession[] = Array.from({ length: 5 }, () => ({ cookies: new Map(), knownWorkspaces }));
    const firstJar = requiredAt(jars, 0, 'demo_cookie_jar_missing');
    const coldStarted = performance.now();
    const coldSession = sessionSchema.parse(await jsonRequest(origin, firstJar, '/api/session'));
    assert(coldSession.user === null, 'demo_cold_session_unexpected');
    report.coldSessionMs = Math.round((performance.now() - coldStarted) * 100) / 100;
    for (let index = 1; index < jars.length; index += 1) {
      const jar = requiredAt(jars, index, 'demo_cookie_jar_missing');
      sessionSchema.parse(await jsonRequest(origin, jar, '/api/session'));
    }
    const identities = await Promise.all(jars.map(jar => bootstrapUser(origin, jar)));
    assert(new Set(identities.map(user => user.id)).size === 5 && new Set(identities.map(user => user.workspaceId)).size === 5, 'demo_employee_subjects_not_distinct');
    const expectedResourceIds = new Set(hshDemoCatalog.resources.map(resource => resource.id));
    currentPhase = 'read_preflight';
    await Promise.all(jars.map(jar => assertReadPayloads(origin, jar, expectedResourceIds)));
    await assertWorkspaceIsolation(origin, jars);

    const availabilityResource = hshDemoCatalog.resources.find(resource => resource.kind === 'workplace');
    assert(availabilityResource, 'demo_workplace_fixture_missing');
    const startDate = new Date(Date.now() + 8 * 86_400_000); startDate.setUTCHours(9, 0, 0, 0);
    const intervalStart = startDate.toISOString(); const intervalEnd = new Date(startDate.getTime() + 3_600_000).toISOString();
    const routes = [
      { id: 'anny.resources', run: async (jar: DemoSession) => { const parsed = resourcesSchema.parse(await jsonRequest(origin, jar, '/api/resources')); assert(parsed.resources.length === expectedResourceIds.size && new Set(parsed.resources.map(item => item.id)).size === expectedResourceIds.size && parsed.resources.every(item => expectedResourceIds.has(item.id)), 'demo_resources_payload_mismatch'); } },
      { id: 'anny.availability', run: async (jar: DemoSession) => {
        const parsed = availabilitySchema.parse(await jsonRequest(origin, jar, '/api/availability', { resourceId: availabilityResource.id, serviceId: availabilityResource.serviceId, startDate: intervalStart, durationMinutes: 60 })); const interval = parsed.intervals.find(item => item.startDate === intervalStart);
        assert(interval?.available === true && interval.endDate === intervalEnd, 'demo_availability_payload_mismatch'); } },
      { id: 'knowledge.search', run: async (jar: DemoSession) => { const parsed = searchSchema.parse(await jsonRequest(origin, jar, '/api/tools/call', { pluginId: 'de.hsh.hasi.knowledge', name: 'knowledge.search', arguments: { query: 'Morgenstern-Lab', sourceSystem: 'service_it', limit: 3 } })); assert(parsed.documents.some(document => document.id === 'svc-001' && document.synthetic && document.dataClass === 'synthetic_demo'), 'demo_knowledge_search_payload_mismatch'); } },
      { id: 'knowledge.document', run: async (jar: DemoSession) => { const parsed = lookupSchema.parse(await jsonRequest(origin, jar, '/api/knowledge/documents/svc-001?revision=1')); assert(parsed.document.citationId === 'knowledge:service_it:svc-001:1' && parsed.document.synthetic, 'demo_knowledge_lookup_payload_mismatch'); } },
      { id: 'plugin-accounts.status', run: async (jar: DemoSession) => { const accounts = parsePluginAccountList(await jsonRequest(origin, jar, '/api/plugin-accounts')); assert(accounts.length === 1 && accounts[0]?.status === 'linked' && accounts[0].adapterTrust === 'demo-only', 'demo_plugin_account_payload_mismatch'); } },
    ];
    currentPhase = 'route_measurement';
    const routeResults: Record<string, unknown>[] = [];
    for (const route of routes) {
      const batches: Record<string, unknown>[] = []; routeResults.push({ route: route.id, batches }); report.routes = routeResults;
      for (let batchIndex = 0; batchIndex < 2; batchIndex += 1) {
        const result = await collectDemoPerformanceBatch(userIndex => route.run(requiredAt(jars, userIndex, 'demo_cookie_jar_missing')));
        batches.push({ batch: batchIndex + 1, ...result, p95Ms: result.p95Ms === null ? null : Math.round(result.p95Ms * 100) / 100 });
        assert(result.passed, 'demo_performance_target_failed');
      }
    }
    report.routes = routeResults;

    currentPhase = 'delay_control';
    await closeServer(proxy); proxy = await createLoopbackProxy(nextPort, proxyPort, 1_200);
    const resourceRoute = requiredAt(routes, 0, 'demo_resources_route_missing');
    const delayed = await collectDemoPerformanceBatch(userIndex => resourceRoute.run(requiredAt(jars, userIndex, 'demo_cookie_jar_missing')));
    report.delayControl = { route: 'anny.resources', delayMs: 1_200, ...delayed, p95Ms: delayed.p95Ms === null ? null : Math.round(delayed.p95Ms * 100) / 100, rejectedBySameGate: !delayed.passed };
    assert(delayed.errorCount === 0 && delayed.sampleCount === DEMO_PERFORMANCE_SAMPLES_PER_BATCH && !delayed.passed, 'demo_delay_control_not_rejected');
  } catch (error) { failure = safeError(error); report.phase = currentPhase; }
  finally {
    currentPhase = 'cleanup';
    const stopped = child ? await stopChild(child).catch(() => false) : true;
    if (proxy) await closeServer(proxy).catch(() => undefined);
    if (store && namespaceMarked && stopped) {
      try { await cleanupNamespace(database, namespace, ownerNonce, [...knownWorkspaces]); cleanupVerified = true; }
      catch (error) { const cleanupFailure = safeError(error); report.cleanupFailure = cleanupFailure; if (!failure) { failure = cleanupFailure; report.phase = currentPhase; } }
    } else if (namespaceMarked) { report.cleanupFailure = 'demo_cleanup_child_not_stopped'; if (!failure) { failure = 'demo_cleanup_child_not_stopped'; report.phase = currentPhase; } }
    await store?.close().catch(() => undefined);
  }
  report.cleanupVerified = cleanupVerified;
  report.status = failure ? 'failed' : 'passed';
  if (failure) report.failure = failure;
  else report.phase = 'complete';
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failure || !cleanupVerified) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', phase: currentPhase, namespace: currentNamespace, cleanupFailure: null, failure: safeError(error), cleanupVerified: false })}\n`);
  process.exitCode = 1;
});
