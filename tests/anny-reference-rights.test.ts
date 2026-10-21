import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyMock, MOCK_IDS } from '@hasi/anny-mock';
import { createAnnyPlugin, annyManifest, demoPresentation } from '@hasi/anny-plugin';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import type { FastifyInstance } from 'fastify';
import { createApi, PluginAccountService, PluginRegistry } from '../apps/api/src/index.js';
import type { PluginAccountAdapter, PluginAccountAdapterInspection } from '../apps/api/src/plugin-accounts.js';
import type { IdentityProvider, Persona } from '../apps/api/src/identity.js';
import { OidcIdentityProvider } from '../apps/api/src/oidc.js';
import { startTestIdp, type TestIdpServer } from '../apps/api/src/test-idp.js';

const INSTALLATION_ID = annyManifest.id;
const API_ORIGIN = 'http://127.0.0.1:3000';
const IDP_REDIRECT_URI = 'http://127.0.0.1:43210/api/oidc/callback';
const OIDC_CLIENT_ID = 'hasi-m4-reference-rights';
const MOCK_TOKEN = 'synthetic-m4-anny-contract-token';
const PLUGIN_TOKEN = 'synthetic-m4-anny-plugin-token';
const UPSTREAM_SUBJECT_ONE = 'synthetic-pairwise-subject-0c7112';
const UPSTREAM_SUBJECT_TWO = 'synthetic-pairwise-subject-efc093';
const startDate = '2099-03-10T09:00:00.000Z';
const activeApis: Awaited<ReturnType<typeof createApi>>[] = [];
const activePlugins: ReturnType<typeof createAnnyPlugin>[] = [];
const activeMocks: FastifyInstance[] = [];
const activeIdps: TestIdpServer[] = [];

afterEach(async () => {
  await Promise.all(activeApis.splice(0).map(api => api.close()));
  await Promise.all(activePlugins.splice(0).map(plugin => plugin.close()));
  await Promise.all(activeMocks.splice(0).map(mock => mock.close()));
  await Promise.all(activeIdps.splice(0).map(idp => idp.close()));
});

interface HostSubjectFixture {
  subject: string;
  /** Opaque IDs from the isolated Anny fixture, assigned by stable subject. */
  customerId: string;
  resourceIds: string[];
}

interface MappingRow extends HostSubjectFixture {
  revision: number;
  revoked?: boolean;
}

type MappingFault = 'missing' | 'ambiguous' | 'duplicate' | 'conflicting' | 'revoked';
type MappingOutcome = 'active' | MappingFault;

/**
 * This is a synthetic reference mapping contract, not an Anny identity service.
 * Its records are keyed by provisioned pairwise host subjects, never by role or
 * email. The underlying Anny customer IDs are the fixed opaque IDs in its local
 * contract mock.
 */
class ReferenceMappingSource {
  readonly outcomes: { subject: string; outcome: MappingOutcome }[] = [];
  private readonly rows = new Map<string, MappingRow>();
  private readonly faults = new Map<string, MappingFault>();
  private readonly revisions = new Map<string, number>();

  constructor(fixtures: readonly HostSubjectFixture[]) {
    for (const fixture of fixtures) {
      this.rows.set(fixture.subject, { ...fixture, resourceIds: [...fixture.resourceIds], revision: 1 });
      this.revisions.set(fixture.subject, 1);
    }
  }

  setFault(subject: string, fault: MappingFault): void {
    this.faults.set(subject, fault);
    this.bump(subject);
  }

  setResources(subject: string, resourceIds: string[]): void {
    const current = this.rows.get(subject);
    if (!current) throw new Error('Unknown provisioned host subject.');
    const revision = this.bump(subject);
    this.rows.set(subject, { ...current, resourceIds: [...resourceIds], revision });
  }

  resolve(subject: string): { outcome: MappingOutcome; row?: MappingRow; revision: number } {
    const revision = this.revisions.get(subject) ?? 1;
    const row = this.rows.get(subject);
    const fault = this.faults.get(subject);
    let result: { outcome: MappingOutcome; row?: MappingRow; revision: number };

    if (fault === 'missing' || !row) {
      result = { outcome: 'missing', revision };
    } else if (fault === 'ambiguous') {
      result = { outcome: 'ambiguous', revision };
    } else if (fault === 'duplicate') {
      result = { outcome: 'duplicate', revision };
    } else if (fault === 'conflicting') {
      result = { outcome: 'conflicting', revision };
    } else if (fault === 'revoked' || row.revoked) {
      result = { outcome: 'revoked', row: { ...row, revision }, revision };
    } else if (row.subject !== subject || row.resourceIds.length !== new Set(row.resourceIds).size) {
      result = { outcome: 'conflicting', revision };
    } else {
      result = { outcome: 'active', row: { ...row, resourceIds: [...row.resourceIds], revision }, revision };
    }

    this.outcomes.push({ subject, outcome: result.outcome });
    return result;
  }

  private bump(subject: string): number {
    const revision = (this.revisions.get(subject) ?? 0) + 1;
    this.revisions.set(subject, revision);
    return revision;
  }
}

/** Trusted only inside this test's reference contract; callback data has no authority fields. */
class ReferenceAnnyAccountAdapter implements PluginAccountAdapter {
  readonly trustLevel = 'trusted' as const;
  readonly authorizationOrigins = ['https://reference.anny.invalid'] as const;
  private readonly grants = new Map<string, number>();

  constructor(private readonly source: ReferenceMappingSource, private readonly permissions = ['rooms:read', 'rooms:prepare']) {}

  begin(input: { subject: string; installationId: string; operation: 'consent' | 'renewal'; state: string; signal: AbortSignal }) {
    if (input.installationId !== INSTALLATION_ID || input.signal.aborted) throw new Error('Invalid reference adapter context.');
    const url = new URL('/authorize', this.authorizationOrigins[0]);
    url.searchParams.set('state', input.state);
    return Promise.resolve({ authorizationUrl: url.href });
  }

  complete(input: {
    subject: string;
    installationId: string;
    operation: 'consent' | 'renewal';
    state: string;
    callback: Readonly<Record<string, string>>;
    expectedAuthorityRevision: number;
    expectedAdapterRevision: number | null;
    signal: AbortSignal;
  }) {
    if (input.installationId !== INSTALLATION_ID || input.signal.aborted || input.callback.code !== 'synthetic-reference-consent') {
      throw new Error('Reference consent was not confirmed.');
    }
    const mapping = this.source.resolve(input.subject);
    if (mapping.outcome !== 'active' || !mapping.row) throw new Error(`Reference mapping is ${mapping.outcome}.`);
    const current = this.grants.get(input.subject) ?? null;
    if (current !== input.expectedAdapterRevision) throw new Error('Reference grant changed during consent.');
    this.grants.set(input.subject, mapping.revision);
    return Promise.resolve({ expiresAt: null, authorityRevision: mapping.revision });
  }

  inspect(input: { subject: string; installationId: string; signal: AbortSignal }): Promise<PluginAccountAdapterInspection> {
    if (input.installationId !== INSTALLATION_ID || input.signal.aborted) throw new Error('Invalid reference adapter context.');
    const mapping = this.source.resolve(input.subject);
    if (!this.grants.has(input.subject) || mapping.outcome === 'revoked') {
      return Promise.resolve({ status: 'revoked', authorityRevision: mapping.revision, expiresAt: null });
    }
    if (mapping.outcome !== 'active' || !mapping.row) {
      return Promise.resolve({ status: 'unavailable', authorityRevision: mapping.revision, expiresAt: null });
    }
    return Promise.resolve({
      status: 'active',
      authorityRevision: mapping.revision,
      expiresAt: null,
      projection: {
        permissions: [...this.permissions],
        customerId: mapping.row.customerId,
        resourceIds: [...mapping.row.resourceIds],
      },
    });
  }

  revoke(input: { subject: string; installationId: string; expectedAdapterRevision: number | null; signal: AbortSignal }): Promise<void> {
    if (input.installationId !== INSTALLATION_ID || input.signal.aborted) throw new Error('Invalid reference adapter context.');
    if (input.expectedAdapterRevision !== (this.grants.get(input.subject) ?? null)) throw new Error('Reference grant changed before revocation.');
    this.grants.delete(input.subject);
    return Promise.resolve();
  }
}

/** Lets the API consume sessions verified independently against two local TestIdP issuers. */
class VerifiedTestIdpSessions implements IdentityProvider {
  constructor(private readonly providers: readonly OidcIdentityProvider[]) {}

  login(_id: string): never {
    throw new Error('OIDC fixture sessions are created through the local TestIdP.');
  }

  async resolve(token: string | undefined): Promise<Persona | undefined> {
    for (const provider of this.providers) {
      const user = await provider.resolve(token);
      if (user) return user;
    }
    return undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    await Promise.all(this.providers.map(provider => provider.logout(token)));
  }
}

async function authenticateTestIdpSubject(provider: OidcIdentityProvider): Promise<{ token: string; user: Persona }> {
  const started = await provider.beginAuthorization('/bookings');
  const response = await fetch(started.url, { redirect: 'manual' });
  if (response.status !== 302) throw new Error('TestIdP did not issue an authorization code.');
  const callback = new URL(response.headers.get('location') ?? '');
  const code = callback.searchParams.get('code');
  const state = callback.searchParams.get('state');
  if (!code || !state) throw new Error('TestIdP callback omitted its code or state.');
  return provider.completeAuthorization({ transactionId: started.transactionId, code, state });
}

async function setup(options: { planning?: boolean } = {}) {
  const permissions = options.planning ? ['rooms:read', 'rooms:prepare', 'rooms:execute'] : ['rooms:read', 'rooms:prepare'];
  const store = new MemoryJsonStore(`m4-reference-rights-${randomBytes(8).toString('hex')}`);
  const idps = await Promise.all([
    startTestIdp({ mode: 'test', clientId: OIDC_CLIENT_ID, redirectUri: IDP_REDIRECT_URI, subject: UPSTREAM_SUBJECT_ONE }),
    startTestIdp({ mode: 'test', clientId: OIDC_CLIENT_ID, redirectUri: IDP_REDIRECT_URI, subject: UPSTREAM_SUBJECT_TWO }),
  ]);
  activeIdps.push(...idps);
  const providers = idps.map(idp => new OidcIdentityProvider({
    mode: 'test',
    issuer: idp.issuer,
    clientId: OIDC_CLIENT_ID,
    redirectUri: IDP_REDIRECT_URI,
    store,
    mapIdentity: () => ({
      id: 'synthetic-host-user-template',
      displayName: 'Synthetic host user',
      role: 'employee',
      actor: { subject: 'mapper-input-is-not-authority', permissions: [...permissions] },
    }),
  }));
  const sessions = await Promise.all(providers.map(provider => authenticateTestIdpSubject(provider)));
  const subjectOne = sessions[0]!.user.actor.subject;
  const subjectTwo = sessions[1]!.user.actor.subject;
  if (subjectOne === subjectTwo) throw new Error('TestIdP issuers did not produce distinct stable subjects.');
  const hostActors = new Map<string, ActorContext>(sessions.map(({ user }) => [user.actor.subject, {
    subject: user.actor.subject,
    permissions: [...permissions],
  }]));
  const fixtures: HostSubjectFixture[] = [
    { subject: subjectOne, customerId: MOCK_IDS.customers.student, resourceIds: [MOCK_IDS.resources.seminarRoom] },
    { subject: subjectTwo, customerId: MOCK_IDS.customers.admin, resourceIds: [MOCK_IDS.resources.computerLab] },
  ];
  const source = new ReferenceMappingSource(fixtures);
  const identity = new VerifiedTestIdpSessions(providers);
  const cookies = new Map(sessions.map(({ token, user }) => [user.actor.subject, `hasi-session=${token}`]));

  const mock = createAnnyMock({ token: MOCK_TOKEN });
  await mock.listen({ host: '127.0.0.1', port: 0 });
  activeMocks.push(mock);
  const mockAddress = mock.server.address();
  if (!mockAddress || typeof mockAddress === 'string') throw new Error('Anny contract mock did not bind a TCP port.');
  const annyRequests: { method: string; path: string; customerId?: string; resourceId?: string }[] = [];
  const contractFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const match = /^\/api\/v1\/customers\/([^/]+)\/bookings$/u.exec(target.pathname);
    annyRequests.push({
      method,
      path: target.pathname,
      ...(match?.[1] ? { customerId: decodeURIComponent(match[1]) } : {}),
      ...(target.searchParams.get('resource_id') ? { resourceId: target.searchParams.get('resource_id')! } : {}),
    });
    return fetch(input, init);
  };
  const client = new AnnyClient({
    baseUrl: `http://127.0.0.1:${String(mockAddress.port)}`,
    organizationId: MOCK_IDS.organization,
    token: MOCK_TOKEN,
    allowLoopback: true,
    allowWrites: false,
    fetchImpl: contractFetch,
  });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const plugin = createAnnyPlugin({ client, publicKey, serviceToken: PLUGIN_TOKEN, presentation: demoPresentation });
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  activePlugins.push(plugin);
  const pluginAddress = plugin.server.address();
  if (!pluginAddress || typeof pluginAddress === 'string') throw new Error('Anny MCP plugin did not bind a TCP port.');

  const account = new PluginAccountService({
    privateKey,
    store,
    scope: 'm4-reference-contract',
    installationId: INSTALLATION_ID,
    mode: 'test',
    adapter: new ReferenceAnnyAccountAdapter(source, permissions),
  });
  const registry = new PluginRegistry(privateKey, {
    store,
    accounts: new Map([[INSTALLATION_ID, account]]),
    resolveActor: subject => Promise.resolve(hostActors.get(subject) ? structuredClone(hostActors.get(subject)) : undefined),
  });
  await registry.install({
    endpoint: `http://127.0.0.1:${String(pluginAddress.port)}/mcp`,
    serviceToken: PLUGIN_TOKEN,
    expectedManifestDigest: digest(annyManifest),
    allowLoopback: true,
  });
  const api = await createApi({ mode: 'test', registry, identity, store, origin: API_ORIGIN, allowedHosts: ['127.0.0.1'] });
  activeApis.push(api);
  const headersFor = (subject: string) => ({
    host: '127.0.0.1:4100',
    origin: API_ORIGIN,
    cookie: cookies.get(subject)!,
  });
  return { api, source, annyRequests, headersFor, fixtures, subjectOne, subjectTwo };
}

async function linkAccount(api: Awaited<ReturnType<typeof createApi>>, headers: Record<string, string>): Promise<void> {
  const started = await api.inject({
    method: 'POST',
    url: `/api/plugin-accounts/${INSTALLATION_ID}/authorization`,
    headers,
    payload: { operation: 'consent', returnTo: '/bookings' },
  });
  expect(started.statusCode, started.body).toBe(200);
  const authorizationUrl = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
  expect(authorizationUrl.origin).toBe('https://reference.anny.invalid');
  const state = authorizationUrl.searchParams.get('state');
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const callback = await api.inject({
    method: 'GET',
    url: `/api/plugin-accounts/${INSTALLATION_ID}/callback?${new URLSearchParams({ state: state!, code: 'synthetic-reference-consent' }).toString()}`,
    headers,
  });
  expect(callback.statusCode, callback.body).toBe(302);
  expect(callback.headers.location).toBe(`${API_ORIGIN}/bookings`);
}

describe('Anny read rights through the host API, signed MCP and local contract mock', () => {
  it('uses current installation account scope in the browser planning routes without global Anny claims', async () => {
    const { api, source, annyRequests, headersFor, subjectOne, subjectTwo } = await setup({ planning: true });
    const headers = headersFor(subjectOne);
    await linkAccount(api, headers);
    await linkAccount(api, headersFor(subjectTwo));
    const args = { resourceId: MOCK_IDS.resources.seminarRoom, serviceId: MOCK_IDS.services.students2,
      startDate, durationMinutes: 60 };
    const direct = await api.inject({ method: 'POST', url: '/api/tools/call', headers,
      payload: { pluginId: INSTALLATION_ID, name: 'anny.get_availability', arguments: args } });
    expect(direct.statusCode, direct.body).toBe(200);

    const proposalArgs = { resourceId: args.resourceId, serviceId: args.serviceId, startDate,
      endDate: new Date(Date.parse(startDate) + 3_600_000).toISOString() };
    const genericProposal = await api.inject({ method: 'POST', url: '/api/tools/call', headers,
      payload: { pluginId: INSTALLATION_ID, name: 'anny.propose_booking', arguments: proposalArgs } });
    expect(genericProposal.statusCode, genericProposal.body).toBe(200);
    const available = await api.inject({ method: 'POST', url: '/api/availability', headers, payload: args });
    const proposed = await api.inject({ method: 'POST', url: '/api/proposals', headers, payload: proposalArgs });
    expect([available.statusCode, proposed.statusCode]).toEqual([200, 200]);
    expect(available.json<{ intervals: unknown[] }>().intervals.length).toBeGreaterThan(0);
    expect(proposed.json<{ proposal: { status: string } }>().proposal.status).toBe('pending');

    const sourceReads = annyRequests.filter(request => request.path.includes('/availability/')).length;
    const foreign = await api.inject({ method: 'POST', url: '/api/availability', headers,
      payload: { ...args, resourceId: MOCK_IDS.resources.computerLab, serviceId: MOCK_IDS.services.hybridMeeting } });
    expect(foreign.statusCode).toBe(502);
    const foreignProposal = await api.inject({ method: 'POST', url: '/api/proposals', headers,
      payload: { ...proposalArgs, resourceId: MOCK_IDS.resources.computerLab, serviceId: MOCK_IDS.services.hybridMeeting } });
    expect(foreignProposal.statusCode).toBe(502);
    expect(annyRequests.filter(request => request.path.includes('/availability/'))).toHaveLength(sourceReads);
    const forged = await api.inject({ method: 'POST', url: '/api/availability', headers,
      payload: { ...args, actor: { subject: subjectTwo, resourceIds: [MOCK_IDS.resources.computerLab] } } });
    expect(forged.statusCode).toBe(400);
    source.setResources(subjectOne, []);
    const revoked = await api.inject({ method: 'POST', url: '/api/availability', headers, payload: args });
    expect(revoked.statusCode).toBe(502);
    const revokedProposal = await api.inject({ method: 'POST', url: '/api/proposals', headers, payload: proposalArgs });
    expect(revokedProposal.statusCode).toBe(502);
    expect(annyRequests.filter(request => request.path.includes('/availability/'))).toHaveLength(sourceReads);
    expect(annyRequests.every(request => request.method === 'GET')).toBe(true);
  });

  it('keeps host execution permission required for a browser proposal after account projection', async () => {
    const { api, annyRequests, headersFor, subjectOne } = await setup();
    const headers = headersFor(subjectOne);
    await linkAccount(api, headers);
    const args = { resourceId: MOCK_IDS.resources.seminarRoom, serviceId: MOCK_IDS.services.students2,
      startDate, durationMinutes: 60 };
    const available = await api.inject({ method: 'POST', url: '/api/availability', headers, payload: args });
    expect(available.statusCode, available.body).toBe(200);
    const proposed = await api.inject({ method: 'POST', url: '/api/proposals', headers,
      payload: { resourceId: args.resourceId, serviceId: args.serviceId, startDate,
        endDate: new Date(Date.parse(startDate) + 3_600_000).toISOString() } });
    expect(proposed.statusCode).toBe(403);
    expect(annyRequests.every(request => request.method === 'GET')).toBe(true);
  });

  it('uses stable-subject account authority, filters current resources and own bookings, and rejects forged or stale scope', async () => {
    const { api, source, annyRequests, headersFor, fixtures, subjectOne, subjectTwo } = await setup();
    const firstHeaders = headersFor(subjectOne);
    const secondHeaders = headersFor(subjectTwo);
    await linkAccount(api, firstHeaders);
    await linkAccount(api, secondHeaders);

    const firstResources = await api.inject({
      url: `/api/resources?subject=${encodeURIComponent(subjectTwo)}&customerId=${MOCK_IDS.customers.admin}&resourceId=${MOCK_IDS.resources.computerLab}`,
      headers: firstHeaders,
    });
    const secondResources = await api.inject({ url: '/api/resources', headers: secondHeaders });
    expect(firstResources.statusCode, firstResources.body).toBe(200);
    expect(firstResources.json<{ resources: { id: string }[] }>().resources.map(item => item.id)).toEqual([MOCK_IDS.resources.seminarRoom]);
    expect(secondResources.statusCode, secondResources.body).toBe(200);
    expect(secondResources.json<{ resources: { id: string }[] }>().resources.map(item => item.id)).toEqual([MOCK_IDS.resources.computerLab]);

    const firstBookings = await api.inject({ url: '/api/bookings', headers: firstHeaders });
    const secondBookings = await api.inject({ url: '/api/bookings', headers: secondHeaders });
    expect(firstBookings.statusCode, firstBookings.body).toBe(200);
    expect(firstBookings.json<{ bookings: { id: string }[] }>().bookings.map(item => item.id)).toEqual([MOCK_IDS.bookings.studentA]);
    expect(secondBookings.statusCode, secondBookings.body).toBe(200);
    expect(secondBookings.json<{ bookings: { id: string }[] }>().bookings.map(item => item.id)).toEqual([MOCK_IDS.bookings.adminA]);
    expect(annyRequests.filter(request => request.customerId).map(request => request.customerId)).toEqual([
      fixtures[0]!.customerId,
      fixtures[1]!.customerId,
    ]);

    const forgedArguments = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: firstHeaders,
      payload: {
        pluginId: INSTALLATION_ID,
        name: 'anny.list_my_bookings',
        arguments: { subject: subjectTwo, customerId: fixtures[1]!.customerId, resourceIds: [MOCK_IDS.resources.computerLab] },
      },
    });
    const forgedActor = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: firstHeaders,
      payload: { pluginId: INSTALLATION_ID, name: 'anny.search_resources', arguments: {}, actor: { subject: subjectTwo } },
    });
    expect(forgedArguments.statusCode).toBe(400);
    expect(forgedActor.statusCode).toBe(400);

    const availabilityRequestsBeforeOwnResource = annyRequests.filter(request => request.path.includes('/availability/')).length;
    const ownResource = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: firstHeaders,
      payload: {
        pluginId: INSTALLATION_ID,
        name: 'anny.get_availability',
        arguments: {
          resourceId: MOCK_IDS.resources.seminarRoom,
          serviceId: MOCK_IDS.services.students2,
          startDate,
          durationMinutes: 60,
        },
      },
    });
    expect(ownResource.statusCode, ownResource.body).toBe(200);
    expect(ownResource.json<{ intervals: { startDate: string; available: boolean }[] }>().intervals.length).toBeGreaterThan(0);
    const ownAvailabilityRequests = annyRequests.filter(request => request.path.includes('/availability/'));
    expect(ownAvailabilityRequests).toHaveLength(availabilityRequestsBeforeOwnResource + 1);
    expect(ownAvailabilityRequests.at(-1)).toMatchObject({
      method: 'GET',
      resourceId: MOCK_IDS.resources.seminarRoom,
    });

    const availabilityRequestsBeforeDeniedResource = ownAvailabilityRequests.length;
    const foreignResource = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: firstHeaders,
      payload: {
        pluginId: INSTALLATION_ID,
        name: 'anny.get_availability',
        arguments: {
          resourceId: MOCK_IDS.resources.computerLab,
          serviceId: MOCK_IDS.services.hybridMeeting,
          startDate,
          durationMinutes: 60,
        },
      },
    });
    expect(foreignResource.statusCode).toBe(502);
    expect(annyRequests.filter(request => request.path.includes('/availability/'))).toHaveLength(availabilityRequestsBeforeDeniedResource);

    const foreignBooking = await api.inject({
      method: 'POST',
      url: '/api/tools/call',
      headers: firstHeaders,
      payload: { pluginId: INSTALLATION_ID, name: 'anny.propose_cancellation', arguments: { bookingId: MOCK_IDS.bookings.adminA } },
    });
    expect(foreignBooking.statusCode).toBe(502);
    expect(annyRequests.filter(request => request.customerId).at(-1)?.customerId).toBe(fixtures[0]!.customerId);
    expect(annyRequests.some(request => request.path.includes('/cancel'))).toBe(false);

    source.setResources(subjectOne, [MOCK_IDS.resources.projectRoom]);
    const changedResources = await api.inject({ url: '/api/resources', headers: firstHeaders });
    const changedBookings = await api.inject({ url: '/api/bookings', headers: firstHeaders });
    expect(changedResources.statusCode, changedResources.body).toBe(200);
    expect(changedResources.json<{ resources: { id: string }[] }>().resources.map(item => item.id)).toEqual([MOCK_IDS.resources.projectRoom]);
    expect(changedBookings.statusCode, changedBookings.body).toBe(200);
    expect(changedBookings.json<{ bookings: { id: string }[] }>().bookings.map(item => item.id)).toEqual([MOCK_IDS.bookings.studentB]);

    source.setFault(subjectOne, 'revoked');
    const requestsBeforeRevocation = annyRequests.length;
    const revokedResources = await api.inject({ url: '/api/resources', headers: firstHeaders });
    expect(revokedResources.statusCode).toBe(403);
    expect(source.outcomes.some(item => item.subject === subjectOne && item.outcome === 'revoked')).toBe(true);
    expect(annyRequests).toHaveLength(requestsBeforeRevocation);
  });

  it.each(['missing', 'ambiguous', 'duplicate', 'conflicting'] as const)(
    'fails closed when the reference source reports a %s subject-to-account mapping',
    async fault => {
      const { api, source, annyRequests, headersFor, subjectOne } = await setup();
      const headers = headersFor(subjectOne);
      await linkAccount(api, headers);
      const requestsBeforeFailure = annyRequests.length;
      source.setFault(subjectOne, fault);

      const denied = await api.inject({ url: '/api/resources', headers });
      expect(denied.statusCode).toBe(503);
      expect(source.outcomes.at(-1)).toEqual({ subject: subjectOne, outcome: fault });
      expect(annyRequests).toHaveLength(requestsBeforeFailure);

      const accountStatus = await api.inject({ url: '/api/plugin-accounts', headers });
      expect(accountStatus.statusCode, accountStatus.body).toBe(200);
      expect(accountStatus.json<{ accounts: { status: string }[] }>().accounts[0]?.status).toBe('unavailable');
    },
  );
});
