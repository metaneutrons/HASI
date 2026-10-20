import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import {
  PluginAccountError,
  PluginAccountService,
  type PluginAccountAdapter,
  type PluginAccountActorProjection,
  type PluginAccountServiceOptions,
} from '../apps/api/src/plugin-accounts.js';
import { DemoPluginAccountAdapter } from '../packages/demo-runtime/src/plugin-account-adapter.js';

const INSTALLATION = 'de.example.calendar';
const SUBJECT = 'hasi-user:alice@example.invalid';

class RecordingStore implements JsonStore {
  readonly writes: { key: string; value: unknown }[] = [];
  constructor(private readonly inner: JsonStore) {}
  read(key: string) { return this.inner.read(key); }
  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    this.writes.push({ key, value: structuredClone(value) });
    return this.inner.compareAndSet(key, expectedRevision, value, expiresAt);
  }
  delete(key: string) { return this.inner.delete(key); }
}

function fixture(options: Partial<PluginAccountServiceOptions> = {}) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const backing = new MemoryJsonStore('plugin-account-test');
  const store = options.store ?? new RecordingStore(backing);
  const serviceOptions: PluginAccountServiceOptions = {
    privateKey,
    store,
    scope: 'tenant:one',
    installationId: INSTALLATION,
    mode: 'test',
    ...options,
  };
  return { privateKey, store, serviceOptions, service: new PluginAccountService(serviceOptions) };
}

function trustedAdapter(options: {
  clock?: () => number;
  authorizationUrl?: (state: string) => string;
  projection?: PluginAccountActorProjection;
  inspectHangs?: boolean;
} = {}) {
  let revision = 0;
  let status: 'active' | 'expired' | 'revoked' = 'revoked';
  let expiresAt: string | null = null;
  let inspectionUnavailable = false;
  let inspectionHangs = options.inspectHangs ?? false;
  let inspectionAborted = false;
  let revokeUnavailable = false;
  let projection = options.projection ?? { permissions: ['calendar:read'], claims: { campus: 'north' } };
  const clock = options.clock ?? Date.now;
  const adapter: PluginAccountAdapter = {
    trustLevel: 'trusted',
    authorizationOrigins: ['https://identity.example'],
    begin({ state: challenge }) {
      return Promise.resolve({ authorizationUrl: options.authorizationUrl?.(challenge) ?? `https://identity.example/oauth/authorize?client_id=fixture&state=${encodeURIComponent(challenge)}` });
    },
    complete(input) {
      if (input.callback.state !== input.state || !input.callback.code) throw new Error('Invalid test callback');
      if (input.expectedAdapterRevision !== (revision === 0 ? null : revision)) throw new Error('Stale adapter revision');
      revision += 1;
      status = 'active';
      expiresAt = new Date(clock() + 60_000).toISOString();
      return Promise.resolve({ authorityRevision: revision, expiresAt });
    },
    inspect({ signal }) {
      if (inspectionHangs) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          inspectionAborted = true;
          reject(new Error('Test inspection aborted'));
        }, { once: true });
      });
      if (inspectionUnavailable) throw new Error('Test authority unavailable');
      if (status === 'active' && expiresAt !== null && Date.parse(expiresAt) <= clock()) status = 'expired';
      return Promise.resolve({ status, authorityRevision: revision, expiresAt, ...(status === 'active' ? { projection } : {}) });
    },
    revoke(input) {
      if (revokeUnavailable) throw new Error('Test revocation unavailable');
      if (status === 'revoked') return Promise.resolve();
      if (input.expectedAdapterRevision !== revision) throw new Error('Stale adapter revision');
      status = 'revoked';
      return Promise.resolve();
    },
  };
  return {
    adapter,
    setUnavailable(value: boolean) { inspectionUnavailable = value; },
    setInspectionHangs(value: boolean) { inspectionHangs = value; },
    wasInspectionAborted() { return inspectionAborted; },
    setRevokeUnavailable(value: boolean) { revokeUnavailable = value; },
    setProjection(value: typeof projection) { projection = value; },
    revokeExternally() { status = 'revoked'; },
  };
}

async function beginAndComplete(service: PluginAccountService, subject = SUBJECT, operation: 'consent' | 'renewal' = 'consent') {
  const started = await service.begin(subject, { operation, returnTo: '/account/connections' });
  const url = new URL(started.authorizationUrl, 'https://hasi.invalid');
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Adapter authorization URL omitted state');
  const callback = url.origin === 'https://hasi.invalid'
    ? { state, approved: 'true' }
    : { state, code: 'synthetic-code' };
  const result = await service.complete(subject, state, callback);
  return { state, result };
}

function sharedServices(adapter: PluginAccountAdapter, clock: () => number = Date.now) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const store = new MemoryJsonStore('plugin-account-shared-status-race');
  const options: PluginAccountServiceOptions = { privateKey, store, scope: 'tenant:one', installationId: INSTALLATION, mode: 'test', adapter, clock };
  return { store, first: new PluginAccountService(options), second: new PluginAccountService(options) };
}

function recordAdapterRevocations(delegate: PluginAccountAdapter) {
  let calls = 0;
  const adapter: PluginAccountAdapter = {
    ...delegate,
    revoke(input) {
      calls++;
      return delegate.revoke(input);
    },
  };
  return { adapter, calls: () => calls };
}

function deferFirstInspection(delegate: PluginAccountAdapter) {
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inspectionCaptured = new Promise<void>(resolve => { captured = resolve; });
  let hasDeferred = false;
  const adapter: PluginAccountAdapter = {
    ...delegate,
    async inspect(input) {
      const snapshot = await delegate.inspect(input);
      if (!hasDeferred) {
        hasDeferred = true;
        captured();
        await gate;
      }
      return snapshot;
    },
  };
  return { adapter, inspectionCaptured, release: () => { release(); } };
}

function barrierInspections(delegate: PluginAccountAdapter, expected: number): PluginAccountAdapter {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  return {
    ...delegate,
    async inspect(input) {
      const snapshot = await delegate.inspect(input);
      arrived++;
      if (arrived === expected) release();
      await barrier;
      return snapshot;
    },
  };
}

describe('personal plugin account lifecycle', () => {
  it('offers a real renewal after expiry and restores access only after explicit completion', async () => {
    let now = Date.now();
    const clock = () => now;
    const external = trustedAdapter({ clock });
    const base = fixture({ adapter: external.adapter, clock });
    expect((await base.service.status(SUBJECT)).remedies).toEqual(['connect']);
    await beginAndComplete(base.service);
    now += 60_001;
    const expired = await base.service.status(SUBJECT);
    expect(expired).toMatchObject({ status: 'expired', remedies: ['renew'] });
    await expect(base.service.resolveAuthority(SUBJECT)).rejects.toMatchObject({ code: 'account_not_linked' });
    await beginAndComplete(base.service, SUBJECT, 'renewal');
    expect((await base.service.status(SUBJECT)).status).toBe('linked');
    expect((await base.service.resolveAuthority(SUBJECT)).projection.permissions).toEqual(['calendar:read']);
  });
  it('requires a trusted production adapter, pins authorization, and rejects unsafe return paths', async () => {
    const base = fixture();
    expect(() => new PluginAccountService({ ...base.serviceOptions, mode: 'production' })).toThrow(/trusted adapter/u);
    expect(() => new PluginAccountService({ ...base.serviceOptions, mode: 'production', adapter: { ...trustedAdapter().adapter, trustLevel: 'demo-only' } })).toThrow(/reject demo-only/u);
    expect(() => new PluginAccountService({ ...base.serviceOptions, adapter: { ...trustedAdapter().adapter, authorizationOrigins: ['http://identity.example'] } })).toThrow(/pinned HTTPS/u);

    const unsafe = trustedAdapter({ authorizationUrl: state => `https://evil.example/authorize?state=${state}` });
    const withUnsafeAdapter = new PluginAccountService({ ...base.serviceOptions, adapter: unsafe.adapter });
    await expect(withUnsafeAdapter.begin(SUBJECT, { operation: 'consent', returnTo: 'https://evil.example' })).rejects.toMatchObject({ code: 'invalid_return_path' });
    await expect(withUnsafeAdapter.begin(SUBJECT, { operation: 'consent', returnTo: '/\\evil.example' })).rejects.toMatchObject({ code: 'invalid_return_path' });
    await expect(withUnsafeAdapter.begin(SUBJECT, { operation: 'consent', returnTo: '/' })).rejects.toMatchObject({ code: 'adapter_response_invalid' });
    expect((await withUnsafeAdapter.status(SUBJECT)).flow).toBe('idle');
  });

  it('binds one-use consent to the authenticated subject and installation, then persists only signed metadata', async () => {
    const external = trustedAdapter();
    const base = fixture({ adapter: external.adapter });
    const started = await base.service.begin(SUBJECT, { operation: 'consent', returnTo: '/' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(base.service.complete('hasi-user:bob@example.invalid', state!, { state, code: 'synthetic-code' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(base.service.complete(SUBJECT, state!, { state: 'wrong', code: 'synthetic-code' })).rejects.toMatchObject({ code: 'invalid_callback' });

    const completed = await base.service.complete(SUBJECT, state!, { state, code: 'opaque-provider-code' });
    expect(completed).toMatchObject({ status: 'linked', authorityRevision: 1, returnTo: '/' });
    await expect(base.service.complete(SUBJECT, state!, { state, code: 'synthetic-code' })).rejects.toMatchObject({ code: 'challenge_replayed' });
    const authority = await base.service.resolveAuthority(SUBJECT);
    expect(authority.projection).toEqual({ permissions: ['calendar:read'], claims: { campus: 'north' } });

    const written = (base.store as RecordingStore).writes;
    const storedJson = JSON.stringify(written);
    expect(storedJson).not.toContain(SUBJECT);
    expect(storedJson).not.toContain('opaque-provider-code');
    expect(storedJson).not.toContain('access_token');
    expect(written.some(entry => entry.key.includes('plugin-account:v1'))).toBe(true);
  });

  it('serializes concurrent completions, rechecks live authority, and fails closed during an outage', async () => {
    const external = trustedAdapter();
    const base = fixture({ adapter: external.adapter });
    const started = await base.service.begin(SUBJECT, { operation: 'consent', returnTo: '/bookings' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const callback = { state, code: 'synthetic-code' };
    const attempts = await Promise.allSettled([
      base.service.complete(SUBJECT, state, callback),
      base.service.complete(SUBJECT, state, callback),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await base.service.status(SUBJECT)).authorityRevision).toBe(1);

    external.setUnavailable(true);
    await expect(base.service.resolveAuthority(SUBJECT)).rejects.toMatchObject({ statusCode: 503 });
    expect((await base.service.status(SUBJECT)).status).toBe('unavailable');
    external.setUnavailable(false);
    const authority = await base.service.resolveAuthority(SUBJECT);
    expect(await base.service.assertCurrent(SUBJECT, authority.authorityRevision)).toEqual(authority);
    external.revokeExternally();
    expect((await base.service.status(SUBJECT))).toMatchObject({ status: 'revoked', authorityRevision: 2 });
    await expect(base.service.assertCurrent(SUBJECT, authority.authorityRevision)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('reconciles one external revocation consistently across concurrent status reads on shared services', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const store = new MemoryJsonStore('plugin-account-concurrent-external-revocation');
    const external = trustedAdapter();
    let inspectionsArrived = 0;
    let releaseInspections!: () => void;
    const bothInspectionsStarted = new Promise<void>(resolve => { releaseInspections = resolve; });
    let delegateRevokeCalls = 0;
    const adapter: PluginAccountAdapter = {
      ...external.adapter,
      async inspect(input) {
        inspectionsArrived++;
        if (inspectionsArrived === 2) releaseInspections();
        await bothInspectionsStarted;
        return external.adapter.inspect(input);
      },
      revoke(input) {
        delegateRevokeCalls++;
        return external.adapter.revoke(input);
      },
    };
    const serviceOptions: PluginAccountServiceOptions = {
      privateKey,
      store,
      scope: 'tenant:one',
      installationId: INSTALLATION,
      mode: 'test',
      adapter,
    };
    const first = new PluginAccountService(serviceOptions);
    const second = new PluginAccountService(serviceOptions);
    await beginAndComplete(first);
    external.revokeExternally();

    const attempts = await Promise.allSettled([first.status(SUBJECT), second.status(SUBJECT)]);
    const attemptSummary = attempts.map(result => result.status === 'fulfilled'
      ? { status: result.status, accountStatus: result.value.status, authorityRevision: result.value.authorityRevision }
      : { status: result.status, error: result.reason instanceof PluginAccountError
        ? { statusCode: result.reason.statusCode, code: result.reason.code, message: result.reason.message }
        : String(result.reason) });
    expect(attemptSummary).toEqual([
      { status: 'fulfilled', accountStatus: 'revoked', authorityRevision: 2 },
      { status: 'fulfilled', accountStatus: 'revoked', authorityRevision: 2 },
    ]);
    const reconciled = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(reconciled).toHaveLength(2);
    expect(reconciled.map(({ status, authorityRevision }) => ({ status, authorityRevision }))).toEqual([
      { status: 'revoked', authorityRevision: 2 },
      { status: 'revoked', authorityRevision: 2 },
    ]);
    expect(reconciled[0]?.history).toEqual(reconciled[1]?.history);
    expect(reconciled[0]?.history.filter(entry => entry.operation === 'external_revocation')).toHaveLength(1);
    expect(delegateRevokeCalls).toBe(0);
  });

  it('rejects a stale revocation inspection after a newer consent completes', async () => {
    const external = trustedAdapter();
    const counted = recordAdapterRevocations(external.adapter);
    const gate = deferFirstInspection(counted.adapter);
    const services = sharedServices(gate.adapter);
    await beginAndComplete(services.first);
    external.revokeExternally();

    const staleInspection = services.first.status(SUBJECT);
    await gate.inspectionCaptured;
    const started = await services.second.begin(SUBJECT, { operation: 'consent', returnTo: '/account/connections' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    if (!state) throw new Error('The newer consent omitted its state');
    await services.second.complete(SUBJECT, state, { state, code: 'synthetic-code' });

    gate.release();
    await expect(staleInspection).rejects.toMatchObject({ statusCode: 409, code: 'account_changed' });
    const latest = await services.second.status(SUBJECT);
    expect(latest).toMatchObject({ status: 'linked', authorityRevision: 3, flow: 'idle' });
    expect(latest.history.map(entry => entry.operation)).toEqual(['consent', 'external_revocation', 'consent']);
    expect(latest.history.filter(entry => entry.operation === 'external_revocation')).toHaveLength(1);
    expect(counted.calls()).toBe(0);
  });

  it('rejects a stale revocation inspection while preserving a newer pending consent', async () => {
    const external = trustedAdapter();
    const counted = recordAdapterRevocations(external.adapter);
    const gate = deferFirstInspection(counted.adapter);
    const services = sharedServices(gate.adapter);
    await beginAndComplete(services.first);
    external.revokeExternally();

    const staleInspection = services.first.status(SUBJECT);
    await gate.inspectionCaptured;
    await expect(services.second.status(SUBJECT)).resolves.toMatchObject({ status: 'revoked', authorityRevision: 2 });
    const pending = await services.second.begin(SUBJECT, { operation: 'consent', returnTo: '/account/connections' });
    expect(new URL(pending.authorizationUrl).searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    gate.release();
    await expect(staleInspection).rejects.toMatchObject({ statusCode: 409, code: 'account_changed' });
    const latest = await services.second.status(SUBJECT);
    expect(latest).toMatchObject({ status: 'revoked', authorityRevision: 2, flow: 'consent_pending' });
    expect(latest.history.map(entry => entry.operation)).toEqual(['consent', 'external_revocation']);
    expect(latest.history.filter(entry => entry.operation === 'external_revocation')).toHaveLength(1);
    expect(counted.calls()).toBe(0);
  });

  it('reconciles concurrent expired inspections with one transition', async () => {
    let now = Date.now();
    const clock = () => now;
    const external = trustedAdapter({ clock });
    const counted = recordAdapterRevocations(external.adapter);
    const adapter = barrierInspections(counted.adapter, 2);
    const services = sharedServices(adapter, clock);
    await beginAndComplete(services.first);
    now += 60_001;

    const attempts = await Promise.all([services.first.status(SUBJECT), services.second.status(SUBJECT)]);
    expect(attempts.map(({ status, authorityRevision }) => ({ status, authorityRevision }))).toEqual([
      { status: 'expired', authorityRevision: 2 },
      { status: 'expired', authorityRevision: 2 },
    ]);
    expect(attempts[0].history).toEqual(attempts[1].history);
    expect(attempts[0].history.filter(entry => entry.operation === 'expired')).toHaveLength(1);
    expect(counted.calls()).toBe(0);
  });

  it('invalidates local authority before remote disconnect and keeps a retryable revocation record', async () => {
    const external = trustedAdapter();
    const base = fixture({ adapter: external.adapter });
    await beginAndComplete(base.service);
    external.setUnavailable(true);
    external.setRevokeUnavailable(true);
    const disconnected = await base.service.disconnect(SUBJECT, 1);
    expect(disconnected).toEqual({ authorityRevision: 2, status: 'disconnected', revocationStatus: 'pending' });
    await expect(base.service.resolveAuthority(SUBJECT)).rejects.toMatchObject({ statusCode: 403 });
    expect((await base.service.status(SUBJECT)).disconnectImpact).toEqual({
      pendingConfirmations: 'invalidated',
      inFlightExecutions: 'may_complete',
      completedExternalChanges: 'not_undone',
      conversationHistory: 'retained',
    });

    external.setRevokeUnavailable(false);
    await expect(base.service.retryRevocation(SUBJECT, 2)).resolves.toEqual({ authorityRevision: 2, status: 'disconnected', revocationStatus: 'confirmed' });
    expect((await base.service.status(SUBJECT)).history.map(event => event.operation)).toContain('revocation_confirmed');
  });

  it('bounds adapter inspection and aborts the call without returning stale rights', async () => {
    const external = trustedAdapter();
    const base = fixture({ adapter: external.adapter, adapterTimeoutMs: 100 });
    await beginAndComplete(base.service);
    external.setInspectionHangs(true);
    expect((await base.service.status(SUBJECT)).status).toBe('unavailable');
    expect(external.wasInspectionAborted()).toBe(true);
    await expect(base.service.resolveAuthority(SUBJECT)).rejects.toMatchObject({ statusCode: 503 });
    external.setInspectionHangs(false);
    expect((await base.service.resolveAuthority(SUBJECT)).projection.permissions).toEqual(['calendar:read']);
  });

  it('detects signed state tampering instead of trusting stored linked status', async () => {
    const external = trustedAdapter();
    const base = fixture({ adapter: external.adapter });
    await beginAndComplete(base.service);
    const entry = (base.store as RecordingStore).writes.find(write => write.key.includes('plugin-account:v1'));
    expect(entry).toBeDefined();
    const stored = await base.store.read(entry!.key);
    expect(stored).toBeDefined();
    const tampered = { ...(stored!.value as Record<string, unknown>), status: 'revoked' };
    expect(await base.store.compareAndSet(entry!.key, stored!.revision, tampered)).toBe(true);
    await expect(base.service.status(SUBJECT)).rejects.toMatchObject({ code: 'account_state_invalid' });
  });

  it('keeps the synthetic adapter demo-only, state-only, and dependent on its host projection resolver', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const store = new RecordingStore(new MemoryJsonStore('demo-plugin-account-test'));
    expect(() => new DemoPluginAccountAdapter({ mode: 'production', privateKey, store, scope: 'tenant:one', installationId: INSTALLATION, resolveProjection: () => ({ permissions: [] }) })).toThrow(/cannot run in production/u);
    let permission = 'calendar:read';
    const adapter = new DemoPluginAccountAdapter({
      mode: 'public-demo', privateKey, store, scope: 'tenant:one', installationId: INSTALLATION,
      resolveProjection: ({ subject, installationId }) => subject === SUBJECT && installationId === INSTALLATION ? { permissions: [permission] } : undefined,
    });
    const service = new PluginAccountService({ privateKey, store, scope: 'tenant:one', installationId: INSTALLATION, mode: 'public-demo', adapter });
    await beginAndComplete(service);
    expect((await service.resolveAuthority(SUBJECT)).projection.permissions).toEqual(['calendar:read']);
    permission = 'calendar:write';
    expect((await service.resolveAuthority(SUBJECT)).projection.permissions).toEqual(['calendar:write']);
    expect(JSON.stringify(store.writes)).not.toContain('calendar:read');
    await expect(service.resolveAuthority('other-user')).rejects.toMatchObject({ statusCode: 403 });
  });
});
