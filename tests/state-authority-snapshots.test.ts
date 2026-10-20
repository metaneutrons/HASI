import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore } from '@hasi/state';
import type { PluginManifestV2 } from '@hasi/plugin-sdk';
import { PluginAccountService, type PluginAccountAdapter } from '../apps/api/src/plugin-accounts.js';
import { type Persona } from '../apps/api/src/identity.js';
import { PluginRouteController, PluginRouteControllerError } from '../apps/api/src/plugin-route-controller.js';
import { PluginSettingsError, PluginSettingsStore } from '../apps/api/src/plugin-settings.js';
import { ProductionAuthorityDirectory } from '../apps/api/src/production-runtime.js';

const SUBJECT = 'oidc:issuer-hash:subject-hash';
const SCOPE = 'state-snapshot-test';
const INSTALLATION = 'test.installation';
const OWNER = 'operator-1';
const CONFIGURATION_REVISION = 'configuration-revision-1';
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  id: INSTALLATION,
  name: 'Snapshot fixture',
  description: 'Fixture for host state snapshots',
  version: '1.0.0',
  configuration: {
    schema: { type: 'object', properties: { label: { type: 'string', minLength: 1 } }, required: ['label'], additionalProperties: false },
    fields: [{ name: 'label', label: 'Label' }],
  },
  tools: [],
};

function fixtureStore() { return new MemoryJsonStore(`state-authority-snapshots-${String(Math.random())}`); }

function accountAdapter(onInspect?: (count: number, service: PluginAccountService) => Promise<void>) {
  let revision = 0;
  let active = false;
  let expiresAt: string | null = null;
  let service: PluginAccountService | undefined;
  let inspections = 0;
  const adapter: PluginAccountAdapter = {
    trustLevel: 'trusted',
    authorizationOrigins: ['https://accounts.example'],
    begin: ({ state }) => Promise.resolve({ authorizationUrl: `https://accounts.example/authorize?state=${encodeURIComponent(state)}` }),
    complete: ({ expectedAdapterRevision }) => {
      if (expectedAdapterRevision !== (revision === 0 ? null : revision)) throw new Error('stale adapter revision');
      revision += 1;
      active = true;
      expiresAt = new Date(Date.now() + 60_000).toISOString();
      return Promise.resolve({ authorityRevision: revision, expiresAt });
    },
    async inspect() {
      inspections += 1;
      const value = { status: active ? 'active' as const : 'revoked' as const, authorityRevision: revision, expiresAt, ...(active ? { projection: { permissions: ['calendar:read'] } } : {}) };
      if (service) await onInspect?.(inspections, service);
      return value;
    },
    revoke: ({ expectedAdapterRevision }) => {
      if (active && expectedAdapterRevision !== revision) throw new Error('stale adapter revision');
      active = false;
      return Promise.resolve();
    },
  };
  return {
    adapter,
    bind(value: PluginAccountService) { service = value; },
    inspections: () => inspections,
  };
}

async function linkAccount(service: PluginAccountService) {
  const started = await service.begin(SUBJECT, { operation: 'consent', returnTo: '/account/connections' });
  const challenge = new URL(started.authorizationUrl).searchParams.get('state');
  if (!challenge) throw new Error('missing challenge');
  await service.complete(SUBJECT, challenge, { state: challenge, code: 'test-code' });
}

function persona(): Persona {
  return { id: SUBJECT, displayName: 'Test user', role: 'admin', actor: { subject: SUBJECT, permissions: ['plugins:manage'] } };
}

describe('host state authority snapshots', () => {
  it('returns signed directory snapshots from the read and invalidates them on tombstone or tampering', async () => {
    const store = fixtureStore();
    const { privateKey } = generateKeyPairSync('ed25519');
    const directory = new ProductionAuthorityDirectory(store, privateKey, SCOPE);
    const otherStore = fixtureStore();
    expect(directory.usesStateStore(store)).toBe(true);
    expect(directory.usesStateStore(otherStore)).toBe(false);
    expect(await directory.resolveSnapshot(SUBJECT)).toBeUndefined();

    expect(await directory.replace(SUBJECT, null, persona())).toBe(true);
    const snapshot = await directory.resolveSnapshot(SUBJECT);
    expect(snapshot?.persona).toEqual(persona());
    expect(await store.readWithFence('invocation:directory', [snapshot!.fence])).toEqual({ matched: true });
    expect(await store.compareAndSetWithFence('invocation:directory', null, { started: true }, [snapshot!.fence])).toBe(true);

    expect(await directory.replace(SUBJECT, snapshot!.fence.revision, null)).toBe(true);
    expect(await directory.resolveSnapshot(SUBJECT)).toBeUndefined();
    expect(await store.readWithFence('invocation:directory', [snapshot!.fence])).toEqual({ matched: false });

    const tombstone = await store.read(snapshot!.fence.key);
    expect(tombstone).toBeDefined();
    expect(await directory.resolve(SUBJECT)).toBeUndefined();
    expect(await store.compareAndSet(snapshot!.fence.key, tombstone!.revision, { authority: persona(), signature: 'tampered' })).toBe(true);
    await expect(directory.resolveSnapshot(SUBJECT)).rejects.toThrow(/signature/u);
  });

  it('requires persisted settings authority and persists initial state with create-if-absent semantics', async () => {
    const store = fixtureStore();
    const otherStore = fixtureStore();
    const { privateKey } = generateKeyPairSync('ed25519');
    const settings = new PluginSettingsStore(privateKey, store, SCOPE);
    expect(settings.usesStateStore(store)).toBe(true);
    expect(settings.usesStateStore(otherStore)).toBe(false);
    await expect(settings.authoritySnapshot(INSTALLATION, manifest)).rejects.toBeInstanceOf(PluginSettingsError);

    const first = await settings.persistInitial(INSTALLATION, manifest);
    expect(first.state.active).toEqual({ values: {}, disabledTools: [] });
    await settings.saveDraft(INSTALLATION, manifest, { revision: 0, values: { label: 'Approved' }, disabledTools: [] }, 'operator');
    await settings.activate(INSTALLATION, manifest, 1, 'operator');
    const active = await settings.authoritySnapshot(INSTALLATION, manifest);
    expect(active.state.active.values).toEqual({ label: 'Approved' });
    expect(await store.readWithFence('invocation:settings', [active.fence])).toEqual({ matched: true });
    expect(await store.compareAndSetWithFence('invocation:settings', null, { started: true }, [active.fence])).toBe(true);
    expect(await settings.persistInitial(INSTALLATION, manifest)).toMatchObject({ state: active.state, fence: active.fence });

    await settings.saveDraft(INSTALLATION, manifest, { revision: 2, values: { label: 'Changed' }, disabledTools: [] }, 'operator');
    expect(await store.readWithFence('invocation:settings', [active.fence])).toEqual({ matched: false });
  });

  it('returns the verified route with its physical revision and rejects wrong owners', async () => {
    const store = fixtureStore();
    const routes = new PluginRouteController({ store, scope: SCOPE, ownerId: OWNER });
    expect(routes.usesStateStore(store)).toBe(true);
    expect(routes.usesStateStore(fixtureStore())).toBe(false);
    await expect(routes.authoritySnapshot({ ownerId: OWNER, installationId: INSTALLATION })).rejects.toBeInstanceOf(PluginRouteControllerError);
    await routes.initializeInstallation({ installationId: INSTALLATION, configurationRevision: CONFIGURATION_REVISION });
    const route = await routes.authoritySnapshot({ ownerId: OWNER, installationId: INSTALLATION });
    expect(route.route).toMatchObject({ ownerId: OWNER, installationId: INSTALLATION, routeRevision: 0, active: null });
    expect(await store.readWithFence('invocation:route', [route.fence])).toEqual({ matched: true });
    expect(await store.compareAndSetWithFence('invocation:route', null, { started: true }, [route.fence])).toBe(true);
    await expect(routes.authoritySnapshot({ ownerId: 'wrong-owner', installationId: INSTALLATION })).rejects.toBeInstanceOf(PluginRouteControllerError);

    await routes.updateConfigurationRevision({ ownerId: OWNER, installationId: INSTALLATION, expectedRevision: CONFIGURATION_REVISION, configurationRevision: 'configuration-revision-2' });
    expect(await store.readWithFence('invocation:route', [route.fence])).toEqual({ matched: false });
  });

  it('returns only live linked account authority and binds it to the final verified row read', async () => {
    const store = fixtureStore();
    const otherStore = fixtureStore();
    const { privateKey } = generateKeyPairSync('ed25519');
    const external = accountAdapter();
    const service = new PluginAccountService({ privateKey, store, scope: SCOPE, installationId: INSTALLATION, mode: 'test', adapter: external.adapter });
    external.bind(service);
    expect(service.usesStateStore(store)).toBe(true);
    expect(service.usesStateStore(otherStore)).toBe(false);
    await expect(service.resolveAuthoritySnapshot(SUBJECT)).rejects.toMatchObject({ statusCode: 403 });

    await linkAccount(service);
    const snapshot = await service.resolveAuthoritySnapshot(SUBJECT);
    expect(snapshot.authority.projection.permissions).toEqual(['calendar:read']);
    expect(await store.readWithFence('invocation:account', [snapshot.fence])).toEqual({ matched: true });
    expect(await store.compareAndSetWithFence('invocation:account', null, { started: true }, [snapshot.fence])).toBe(true);
    await service.disconnect(SUBJECT, snapshot.authority.authorityRevision);
    expect(await store.readWithFence('invocation:account', [snapshot.fence])).toEqual({ matched: false });

    let raceExpectedRevision = 0;
    const raceAdapter = accountAdapter(async (count, currentService) => {
      if (count === 3) await currentService.disconnect(SUBJECT, raceExpectedRevision);
    });
    const raceService = new PluginAccountService({ privateKey, store: fixtureStore(), scope: SCOPE, installationId: INSTALLATION, mode: 'test', adapter: raceAdapter.adapter });
    raceAdapter.bind(raceService);
    await linkAccount(raceService);
    const beforeRace = await raceService.status(SUBJECT);
    if (beforeRace.status !== 'linked') throw new Error('account should be linked');
    raceExpectedRevision = beforeRace.authorityRevision;
    await expect(raceService.resolveAuthoritySnapshot(SUBJECT)).rejects.toMatchObject({ statusCode: 409 });
  });
});
