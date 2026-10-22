import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { AnnyClient } from "@hasi/anny-client";
import { createAnnyMock, MOCK_IDS } from "@hasi/anny-mock";
import { annyManifest, createAnnyPlugin, type Presentation } from "@hasi/anny-plugin";
import { digest, type ActorContext } from "@hasi/plugin-sdk";
import { MemoryJsonStore, type JsonStore } from "@hasi/state";
import { hshDemoCatalog, hshDemoPresentation } from "../../fixtures/catalog.js";
import {
  createApi,
  OidcIdentityProvider,
  PluginAccountService,
  PluginRegistry,
  stableOidcSubject,
  startTestIdp,
} from "../../apps/api/src/index.js";
import type { Persona } from "../../apps/api/src/identity.js";
import type { PluginAccountAdapter, PluginAccountAdapterInspection } from "../../apps/api/src/plugin-accounts.js";

const webOrigin = "http://127.0.0.1:3001";
const apiOrigin = "http://127.0.0.1:4100";
const apiHost = new URL(apiOrigin).host;
const apiAllowedHost = new URL(apiOrigin).hostname;
const annyContractOrigin = "http://127.0.0.1:4102";
const annyPluginOrigin = "https://room-planning-anny.evaluation.example.edu";
const annyPluginId = "de.hsh.hasi.anny";
const oidcClientId = "hasi-evaluation-room-planning";
const upstreamSubject = "evaluation-room-planner";
const resourceIds = ["180116", "180117"] as const;
const serviceId = "76878";
const maxObservations = 64;
const maxPreparedProposals = 16;
const annyWriteTools = new Set([
  "anny.propose_booking",
  "anny.propose_cancellation",
  "anny.execute_booking",
  "anny.execute_cancellation",
]);

interface EvaluationAnnyAccountMapping {
  readonly customerId: string;
  readonly resourceIds: readonly string[];
  readonly permissions: readonly string[];
}

/** Demo-only reference mapping used through the host's normal account lifecycle. */
class EvaluationAnnyAccountAdapter implements PluginAccountAdapter {
  readonly trustLevel = "demo-only" as const;
  private readonly grants = new Map<string, number>();

  constructor(
    private readonly installationId: string,
    private readonly mappings: ReadonlyMap<string, EvaluationAnnyAccountMapping>,
    private readonly observeInspection: () => void,
  ) {}

  begin(input: Parameters<PluginAccountAdapter["begin"]>[0]): Promise<{ authorizationUrl: string }> {
    if (input.installationId !== this.installationId || input.signal.aborted || !this.mappings.has(input.subject)) {
      throw new Error("The synthetic Anny account mapping is not available for this subject.");
    }
    const authorizationUrl = new URL("/account/connections/consent", "https://hasi.invalid");
    authorizationUrl.searchParams.set("state", input.state);
    authorizationUrl.searchParams.set("installationId", input.installationId);
    return Promise.resolve({ authorizationUrl: `${authorizationUrl.pathname}${authorizationUrl.search}` });
  }

  complete(input: Parameters<PluginAccountAdapter["complete"]>[0]): Promise<{ expiresAt: string | null; authorityRevision: number }> {
    if (input.installationId !== this.installationId || input.signal.aborted
      || input.callback.approved !== "true" || input.expectedAdapterRevision !== (this.grants.get(input.subject) ?? null)
      || !this.mappings.has(input.subject)) {
      throw new Error("The synthetic Anny consent was not confirmed for the current account mapping.");
    }
    this.grants.set(input.subject, 1);
    return Promise.resolve({ expiresAt: null, authorityRevision: 1 });
  }

  inspect(input: Parameters<PluginAccountAdapter["inspect"]>[0]): Promise<PluginAccountAdapterInspection> {
    this.observeInspection();
    if (input.installationId !== this.installationId || input.signal.aborted) {
      throw new Error("The synthetic Anny inspection context is invalid.");
    }
    const mapping = this.mappings.get(input.subject);
    if (!mapping || this.grants.get(input.subject) !== 1) {
      return Promise.resolve({ status: "revoked", authorityRevision: 1, expiresAt: null });
    }
    return Promise.resolve({
      status: "active",
      authorityRevision: 1,
      expiresAt: null,
      projection: {
        permissions: [...mapping.permissions],
        customerId: mapping.customerId,
        resourceIds: [...mapping.resourceIds],
      },
    });
  }

  revoke(input: Parameters<PluginAccountAdapter["revoke"]>[0]): Promise<void> {
    if (input.installationId !== this.installationId || input.signal.aborted
      || input.expectedAdapterRevision !== (this.grants.get(input.subject) ?? null)) {
      throw new Error("The synthetic Anny grant changed before revocation.");
    }
    this.grants.delete(input.subject);
    return Promise.resolve();
  }
}

// Authentication uses the actual loopback TestIdP listener. Capturing fetch before
// test instrumentation also ensures only that trusted listener is contacted.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export interface EvaluationRoomPlanningPreparedProposal {
  readonly id: string;
  readonly subject: string;
  readonly executionTool: "anny.execute_booking";
  readonly resourceId: string;
  readonly serviceId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: "pending";
}

export interface EvaluationRoomPlanningObservation {
  readonly kind: "request" | "write_attempt" | "write_effect" | "write_denied";
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly boundary?: "api_contract" | "read_only_fixture";
  readonly toolName?: string;
}

export type EvaluationRoomPlanningMode = "preparation" | "read_only";

export interface EvaluationRoomPlanningFixtureOptions {
  /** Trusted fixture composition only; never select this from request or model input. */
  readonly mode?: EvaluationRoomPlanningMode;
}

export interface EvaluationRoomPlanningDiagnostics {
  readonly mode: EvaluationRoomPlanningMode;
  readonly annyClientWritesEnabled: boolean;
  /** This fixture runs API, signed MCP and the contract mock through Fastify inject. */
  readonly transport: "fastify-inject-to-signed-mcp-and-anny-contract-mock";
  /** Synthetic accounts and state are process-local; they are not production authority. */
  readonly authorityScope: "test-idp-and-process-local-memory";
  readonly sourceWriteAttempts: number;
  readonly sourceWriteEffects: number;
  readonly blockedWriteAttempts: number;
  readonly accountInspections: number;
  readonly apiObservations: readonly EvaluationRoomPlanningObservation[];
  readonly sourceObservations: readonly EvaluationRoomPlanningObservation[];
  readonly apiObservationsTruncated: boolean;
  readonly sourceObservationsTruncated: boolean;
  readonly preparedProposalsTruncated: boolean;
}

export interface EvaluationRoomPlanningFixture {
  readonly mode: EvaluationRoomPlanningMode;
  readonly webOrigin: string;
  readonly apiOrigin: string;
  /** Synthetic web-only protected-local scope used by the route harness. */
  readonly localScope: string;
  /** Synthetic web-only signing material; never a deployment credential. */
  readonly signingSecret: string;
  readonly cookie: string;
  /** Stable subject and rights are projected by the code-owned verified OIDC mapper. */
  readonly actor: ActorContext;
  readonly resourceIds: readonly string[];
  readonly coreFetch: typeof fetch;
  diagnostics(): EvaluationRoomPlanningDiagnostics;
  preparedProposals(): readonly EvaluationRoomPlanningPreparedProposal[];
  close(): Promise<void>;
}

function approvedCatalog() {
  const resources = resourceIds.map(id => {
    const resource = hshDemoCatalog.resources.find(candidate => candidate.id === id);
    if (resource?.kind !== "workplace" || resource.location !== "1J" || resource.serviceId !== serviceId) {
      throw new Error("The code-owned HsH room catalog no longer matches the approved 1J fixture mapping.");
    }
    return structuredClone(resource);
  });
  const service = hshDemoCatalog.services.find(candidate => candidate.id === serviceId);
  if (!service) throw new Error("The code-owned HsH room catalog has no approved workplace service.");
  return { resources, services: [structuredClone(service)] };
}

function presentationForApprovedCatalog(): Record<string, Presentation> {
  return Object.fromEntries(resourceIds.map(id => {
    const entry = hshDemoPresentation[id];
    if (entry?.kind !== "workplace" || entry.location !== "1J" || entry.serviceId !== serviceId) {
      throw new Error("The code-owned HsH presentation no longer matches the approved 1J fixture mapping.");
    }
    return [id, structuredClone(entry)];
  }));
}

function mcpFetch(plugin: ReturnType<typeof createAnnyPlugin>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const target = new URL(request.url);
    if (target.origin !== annyPluginOrigin || target.username || target.password || target.hash) {
      throw new TypeError("Room-planning evaluation rejected an unapproved MCP destination.");
    }
    const response = await plugin.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      headers: { ...Object.fromEntries(request.headers), host: target.host },
      ...(["GET", "HEAD"].includes(request.method) ? {} : { payload: await request.text() }),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined || ["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response([204, 205, 304].includes(response.statusCode) ? null : response.body, {
      status: response.statusCode,
      headers,
    });
  };
}

function contractFetch(
  mock: ReturnType<typeof createAnnyMock>,
  mode: EvaluationRoomPlanningMode,
  observeWriteAttempt: (method: string, path: string) => void,
  observeWriteDenied: (method: string, path: string) => void,
  observeRequest: (method: string, path: string, status: number) => void,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const target = new URL(request.url);
    if (target.origin !== annyContractOrigin || target.username || target.password || target.hash) {
      throw new TypeError("Room-planning evaluation rejected an unapproved Anny contract destination.");
    }
    const isWrite = (request.method === "POST" && target.pathname === "/api/v1/orders/from-config")
      || (request.method === "GET" && /^\/api\/v1\/bookings\/[^/]+\/cancel$/u.test(target.pathname));
    if (isWrite && mode === "read_only") {
      observeWriteDenied(request.method, target.pathname);
      return Response.json({ error: "The read-only room-planning fixture denied this Anny write." }, { status: 403 });
    }
    if (isWrite) observeWriteAttempt(request.method, target.pathname);
    const response = await mock.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      headers: { ...Object.fromEntries(request.headers), host: target.host },
      ...(["GET", "HEAD"].includes(request.method) ? {} : { payload: await request.text() }),
    });
    observeRequest(request.method, target.pathname, response.statusCode);
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined || ["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response([204, 205, 304].includes(response.statusCode) ? null : response.body, {
      status: response.statusCode,
      headers,
    });
  };
}

function readOnlyMutation(method: string, path: string, body: string | undefined): { toolName?: string } | undefined {
  if (method !== "POST") return undefined;
  if (path === "/api/proposals" || path === "/api/cancellations"
    || /^\/api\/proposals\/[0-9a-f-]{36}\/(?:confirm|reconcile)$/iu.test(path)) {
    return {};
  }
  if (path !== "/api/tools/call" || body === undefined) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(body) as unknown; } catch { return undefined; }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const call = payload as Record<string, unknown>;
  if (call.pluginId !== annyPluginId || typeof call.name !== "string" || !annyWriteTools.has(call.name)) return undefined;
  return { toolName: call.name };
}

function sourceEffectProjection(value: unknown): { orders: unknown[]; bookings: unknown[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { orders: [], bookings: [] };
  const aggregate = value as Record<string, unknown>;
  return {
    orders: Array.isArray(aggregate.orders) ? aggregate.orders : [],
    bookings: Array.isArray(aggregate.bookings) ? aggregate.bookings : [],
  };
}

function proposalTrace(key: string, value: unknown, subject: string): EvaluationRoomPlanningPreparedProposal | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const proposal = value as Record<string, unknown>;
  const args = proposal.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || proposal.id !== key.slice("proposal:".length) || proposal.subject !== subject
    || proposal.status !== "pending" || proposal.executionTool !== "anny.execute_booking") return undefined;
  const argumentsRecord = args as Record<string, unknown>;
  if (typeof argumentsRecord.resourceId !== "string" || !resourceIds.includes(argumentsRecord.resourceId as typeof resourceIds[number])
    || argumentsRecord.serviceId !== serviceId || typeof argumentsRecord.startDate !== "string"
    || typeof argumentsRecord.endDate !== "string") return undefined;
  return Object.freeze({
    id: proposal.id,
    subject,
    executionTool: "anny.execute_booking",
    resourceId: argumentsRecord.resourceId,
    serviceId,
    startDate: argumentsRecord.startDate,
    endDate: argumentsRecord.endDate,
    status: "pending",
  });
}

/**
 * Create a fixed, process-local authenticated Anny fixture for actual-route
 * room-planning evaluation. It uses TestIdP/OIDC, signed MCP, AnnyClient and the
 * local contract mock, but it does not represent production credentials or
 * independently enforce rights across multiple HASI deployments.
 */
export async function createEvaluationRoomPlanningFixture(
  options: EvaluationRoomPlanningFixtureOptions = {},
): Promise<EvaluationRoomPlanningFixture> {
  const requestedMode: unknown = options.mode ?? "preparation";
  if (requestedMode !== "preparation" && requestedMode !== "read_only") {
    throw new TypeError("Room-planning fixture mode is invalid.");
  }
  const mode: EvaluationRoomPlanningMode = requestedMode;
  const approved = approvedCatalog();
  const presentation = presentationForApprovedCatalog();
  const scope = randomUUID();
  const signingSecret = randomBytes(32).toString("base64url");
  const apiStore = new MemoryJsonStore(`evaluation-room-planning-api-${scope}`);
  const apiObservations: EvaluationRoomPlanningObservation[] = [];
  const sourceObservations: EvaluationRoomPlanningObservation[] = [];
  const proposals = new Map<string, EvaluationRoomPlanningPreparedProposal>();
  let apiObservationsTruncated = false;
  let sourceObservationsTruncated = false;
  let preparedProposalsTruncated = false;
  let sourceWriteAttempts = 0;
  let sourceWriteEffects = 0;
  let blockedWriteAttempts = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const remember = (target: EvaluationRoomPlanningObservation[], observation: EvaluationRoomPlanningObservation, source: boolean) => {
    if (target.length < maxObservations) target.push(Object.freeze(observation));
    else if (source) sourceObservationsTruncated = true;
    else apiObservationsTruncated = true;
  };
  const actorForSubject = new Map<string, ActorContext>();
  let accountInspections = 0;
  let actor: ActorContext | undefined;

  const cleanup: (() => Promise<void>)[] = [];
  const closeResources = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Room-planning fixture cleanup failed.");
  };

  try {
    const idp = await startTestIdp({
      mode: "test",
      clientId: oidcClientId,
      redirectUri: `${apiOrigin}/api/auth/callback`,
      subjects: [{ subject: upstreamSubject, label: "Synthetic HsH employee" }],
    });
    cleanup.push(() => idp.close());

    const stableSubject = stableOidcSubject(idp.issuer, upstreamSubject);
    actor = {
      subject: stableSubject,
      permissions: mode === "read_only" ? ["rooms:read"] : ["rooms:read", "rooms:prepare", "rooms:execute"],
    };
    actorForSubject.set(stableSubject, structuredClone(actor));
    const apiObservedStore: JsonStore = {
      read: key => apiStore.read(key),
      async compareAndSet(key, expectedRevision, value, expiresAt) {
        const committed = await apiStore.compareAndSet(key, expectedRevision, value, expiresAt);
        if (!committed || !actor) return committed;
        if (/^proposal:[0-9a-f-]{36}$/iu.test(key)) {
          const trace = proposalTrace(key, value, actor.subject);
          if (trace) {
            if (proposals.has(trace.id)) proposals.delete(trace.id);
            if (proposals.size >= maxPreparedProposals) preparedProposalsTruncated = true;
            else proposals.set(trace.id, trace);
          }
        }
        return true;
      },
      delete: key => apiStore.delete(key),
    };
    const identity = new OidcIdentityProvider({
      mode: "test",
      issuer: idp.issuer,
      clientId: oidcClientId,
      redirectUri: `${apiOrigin}/api/auth/callback`,
      store: apiObservedStore,
      fetch: nativeFetch,
      mapIdentity: verified => {
        if (verified.subject !== upstreamSubject) throw new Error("Unknown room-planning evaluation subject.");
        const trustedActor = actorForSubject.get(stableOidcSubject(verified.issuer, verified.subject));
        if (!trustedActor) throw new Error("The code-owned room-planning actor mapping is unavailable.");
        const user: Persona = {
          id: trustedActor.subject,
          displayName: "Synthetic HsH employee",
          role: "employee",
          actor: structuredClone(trustedActor),
        };
        return user;
      },
    });

    const mockToken = `evaluation-anny-${randomUUID()}`;
    const mockInnerStore = new MemoryJsonStore(`evaluation-room-planning-anny-${scope}`);
    const mockStore: JsonStore = {
      read: key => mockInnerStore.read(key),
      async compareAndSet(key, expectedRevision, value, expiresAt) {
        const before = key.startsWith("orders-bookings:") ? await mockInnerStore.read(key) : undefined;
        const committed = await mockInnerStore.compareAndSet(key, expectedRevision, value, expiresAt);
        if (!committed || !key.startsWith("orders-bookings:")) return committed;
        if (digest(sourceEffectProjection(before?.value)) !== digest(sourceEffectProjection(value))) {
          sourceWriteEffects += 1;
          remember(sourceObservations, { kind: "write_effect", method: "STORE", path: "orders-bookings:<fixture>" }, true);
        }
        return true;
      },
      delete: key => mockInnerStore.delete(key),
    };
    const mock = createAnnyMock({
      token: mockToken,
      store: mockStore,
      scope: `evaluation-room-planning-${scope}`,
      catalog: approved,
    });
    cleanup.push(() => mock.close());
    const client = new AnnyClient({
      baseUrl: annyContractOrigin,
      organizationId: MOCK_IDS.organization,
      token: mockToken,
      allowLoopback: true,
      allowWrites: mode === "preparation",
      fetchImpl: contractFetch(mock, mode, (method, path) => {
        sourceWriteAttempts += 1;
        remember(sourceObservations, { kind: "write_attempt", method, path }, true);
      }, (method, path) => {
        blockedWriteAttempts += 1;
        remember(sourceObservations, { kind: "write_denied", method, path, status: 403, boundary: "read_only_fixture" }, true);
      }, (method, path, status) => {
        remember(sourceObservations, { kind: "request", method, path, status }, true);
      }),
    });

    const pluginKeys = generateKeyPairSync("ed25519");
    const pluginToken = `evaluation-plugin-${randomUUID()}`;
    const plugin = createAnnyPlugin({
      client,
      publicKey: pluginKeys.publicKey,
      serviceToken: pluginToken,
      presentation,
      allowedHosts: [new URL(annyPluginOrigin).hostname],
    });
    cleanup.push(() => plugin.close());

    const accountAdapter = new EvaluationAnnyAccountAdapter(annyPluginId, new Map([[actor.subject, {
      customerId: MOCK_IDS.customers.employee,
      resourceIds,
      permissions: [...actor.permissions],
    }]]), () => { accountInspections += 1; });
    const account = new PluginAccountService({
      privateKey: pluginKeys.privateKey,
      store: apiStore,
      scope: `evaluation-room-planning-accounts-${scope}`,
      installationId: annyPluginId,
      mode: "test",
      adapter: accountAdapter,
    });

    const registry = new PluginRegistry(pluginKeys.privateKey, {
      store: apiStore,
      scope: `evaluation-room-planning-registry-${scope}`,
      accounts: new Map([[annyPluginId, account]]),
      resolveActor: subject => {
        const current = actorForSubject.get(subject);
        return Promise.resolve(current ? structuredClone(current) : undefined);
      },
      fetch: mcpFetch(plugin),
    });
    await registry.install({
      endpoint: `${annyPluginOrigin}/mcp`,
      serviceToken: pluginToken,
      expectedManifestDigest: digest(annyManifest),
      allowLoopback: false,
    });

    const api = await createApi({
      // The API's development/OIDC composition supplies synthetic model
      // context. TestIdP, OIDC identity, and the demo account adapter remain
      // explicitly in test mode above.
      mode: "development",
      registry,
      identity,
      store: apiObservedStore,
      origin: webOrigin,
      allowedHosts: [apiAllowedHost],
    });
    cleanup.push(() => api.close());

    const start = await api.inject({ method: "GET", url: "/api/auth/login", headers: { host: apiHost } });
    if (start.statusCode !== 302 || typeof start.headers.location !== "string") {
      throw new Error("The synthetic room-planning OIDC flow did not start.");
    }
    const transactionCookie = start.cookies.find(cookie => cookie.name === "hasi-oidc-transaction")?.value;
    if (!transactionCookie) throw new Error("The synthetic room-planning OIDC transaction cookie is missing.");
    const authorization = new URL(start.headers.location);
    if (authorization.origin !== idp.issuer || authorization.pathname !== "/authorize") {
      throw new Error("The synthetic room-planning OIDC destination is invalid.");
    }
    authorization.searchParams.set("test_subject", upstreamSubject);
    const selected = await nativeFetch(authorization, { redirect: "manual" });
    const callback = selected.headers.get("location");
    if (selected.status !== 302 || !callback) throw new Error("The synthetic room-planning TestIdP did not issue a callback.");
    const callbackLocation = new URL(callback);
    if (callbackLocation.origin !== apiOrigin || callbackLocation.pathname !== "/api/auth/callback") {
      throw new Error("The synthetic room-planning OIDC callback destination is invalid.");
    }
    const completed = await api.inject({
      method: "GET",
      url: `${callbackLocation.pathname}${callbackLocation.search}`,
      headers: { host: apiHost, cookie: `hasi-oidc-transaction=${transactionCookie}` },
    });
    if (completed.statusCode !== 302) throw new Error("The synthetic room-planning OIDC session was not established.");
    const session = completed.cookies.find(cookie => cookie.name === "hasi-session")?.value;
    if (!session) throw new Error("The synthetic room-planning session cookie is missing.");
    const accountHeaders = { host: apiHost, origin: webOrigin, cookie: `hasi-session=${session}` };
    const accountAuthorization = await api.inject({
      method: "POST",
      url: `/api/plugin-accounts/${annyPluginId}/authorization`,
      headers: accountHeaders,
      payload: { operation: "consent", returnTo: "/bookings" },
    });
    if (accountAuthorization.statusCode !== 200) throw new Error("The synthetic Anny account consent flow did not start.");
    const authorizationUrl = new URL(accountAuthorization.json<{ authorizationUrl: string }>().authorizationUrl, "https://hasi.invalid");
    const state = authorizationUrl.searchParams.get("state");
    if (authorizationUrl.pathname !== "/account/connections/consent"
      || authorizationUrl.searchParams.get("installationId") !== annyPluginId || !state) {
      throw new Error("The synthetic Anny account consent challenge is invalid.");
    }
    const consent = await api.inject({
      method: "POST",
      url: `/api/plugin-accounts/${annyPluginId}/consent`,
      headers: accountHeaders,
      payload: { state, approved: true },
    });
    if (consent.statusCode !== 200) throw new Error("The synthetic Anny account consent was not linked.");
    const accountStatus = await api.inject({ url: "/api/plugin-accounts", headers: { host: apiHost, cookie: accountHeaders.cookie } });
    if (accountStatus.statusCode !== 200
      || accountStatus.json<{ accounts: { installationId: string; status: string; adapterTrust: string }[] }>().accounts
        .some(item => item.installationId === annyPluginId && (item.status !== "linked" || item.adapterTrust !== "demo-only"))
      || !accountStatus.json<{ accounts: { installationId: string }[] }>().accounts.some(item => item.installationId === annyPluginId)) {
      throw new Error("The linked Anny account is not ready under the current host account service.");
    }

    const allowedRoutes = new Set([
      "GET /api/session",
      "GET /api/history/authority",
      "GET /api/tools",
      "GET /api/resources",
      "POST /api/availability",
      "POST /api/proposals",
      "POST /api/tools/call",
    ]);
    const coreFetch: typeof fetch = async (input, init) => {
      if (closed) throw new TypeError("Room-planning evaluation fixture is closed.");
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
      const target = new URL(request.url);
      const method = request.method.toUpperCase();
      const routeKey = `${method} ${target.pathname}`;
      const proposalPath = method === "GET" && /^\/api\/proposals\/[0-9a-f-]{36}$/iu.test(target.pathname);
      if (target.origin !== apiOrigin || target.username || target.password || target.search || target.hash) {
        throw new TypeError("Room-planning evaluation rejected an unapproved API destination.");
      }
      const headers = new Headers(request.headers);
      headers.set("host", apiHost);
      const body = ["GET", "HEAD"].includes(method) ? undefined : await request.text();
      const mutation = mode === "read_only" ? readOnlyMutation(method, target.pathname, body) : undefined;
      if (mutation) {
        blockedWriteAttempts += 1;
        remember(apiObservations, {
          kind: "write_denied", method, path: target.pathname, status: 403,
          boundary: "read_only_fixture", ...(mutation.toolName ? { toolName: mutation.toolName } : {}),
        }, false);
        return Response.json({ error: "The read-only room-planning fixture denied this operation." }, { status: 403 });
      }
      if (!allowedRoutes.has(routeKey) && !proposalPath) {
        throw new TypeError("Room-planning evaluation rejected an unapproved API destination.");
      }
      const response = await api.inject({
        method,
        url: target.pathname,
        headers: Object.fromEntries(headers.entries()),
        ...(body === undefined ? {} : { payload: body }),
      });
      remember(apiObservations, { kind: "request", method, path: target.pathname, status: response.statusCode }, false);
      const responseHeaders = new Headers();
      for (const name of ["cache-control", "content-type", "location"] as const) {
        const value = response.headers[name];
        if (typeof value === "string") responseHeaders.set(name, value);
      }
      return new Response([204, 205, 304].includes(response.statusCode) ? null : response.body, {
        status: response.statusCode,
        headers: responseHeaders,
      });
    };

    return {
      mode,
      webOrigin,
      apiOrigin,
      localScope: scope,
      signingSecret,
      cookie: `hasi-session=${session}`,
      actor: Object.freeze({ ...actor, permissions: [...actor.permissions] }),
      resourceIds: Object.freeze([...resourceIds]),
      coreFetch,
      diagnostics: () => Object.freeze({
        mode,
        annyClientWritesEnabled: mode === "preparation",
        transport: "fastify-inject-to-signed-mcp-and-anny-contract-mock",
        authorityScope: "test-idp-and-process-local-memory",
        sourceWriteAttempts,
        sourceWriteEffects,
        blockedWriteAttempts,
        accountInspections,
        apiObservations: Object.freeze(apiObservations.map(item => ({ ...item }))),
        sourceObservations: Object.freeze(sourceObservations.map(item => ({ ...item }))),
        apiObservationsTruncated,
        sourceObservationsTruncated,
        preparedProposalsTruncated,
      }),
      preparedProposals: () => Object.freeze([...proposals.values()].map(proposal => ({ ...proposal }))),
      close: () => {
        if (!closePromise) {
          closed = true;
          closePromise = closeResources();
        }
        return closePromise;
      },
    };
  } catch (error) {
    closed = true;
    try { await closeResources(); } catch { /* Preserve the fixture setup failure. */ }
    throw error;
  }
}
