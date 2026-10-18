import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import {
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

describe('personal plugin account lifecycle', () => {
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
