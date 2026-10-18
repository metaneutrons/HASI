import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, ExecutionJournal, type ActorContext, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { createApi, PluginRegistry, RequestError } from '../apps/api/src/index.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

async function createHarness(resolveActor?: (subject: string) => Promise<ActorContext | undefined>) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const store = new MemoryJsonStore(`action-reconciliation-${randomUUID()}`);
  const args = object({ target: { type: 'string' } });
  const manifest: PluginManifestV2 = {
    manifestVersion: 2, id: 'fixture.actions', name: 'Actions', description: 'Synthetic actions', version: '1.0.0', apiVersion: '2.0.0', mcpVersion: '2026-07-28',
    tools: [
      { name: 'fixture.prepare', title: 'Prepare', description: '', effect: 'prepare', requiredPermissions: ['rooms:prepare'], inputSchema: args, outputSchema: object({ draft: object({ executionTool: { type: 'string' }, arguments: args, resourceName: { type: 'string' } }) }) },
      { name: 'fixture.execute', title: 'Execute', description: '', effect: 'execute', requiredPermissions: ['rooms:execute'], inputSchema: args, outputSchema: object({ recordId: { type: 'string' } }) },
    ],
  };
  let writes = 0;
  const plugin = createPluginServer({ manifest, serviceToken: 'synthetic-service', publicKey, executionJournal: new ExecutionJournal(store, 'fixture'), handlers: {
    'fixture.prepare': input => Promise.resolve({ draft: { executionTool: 'fixture.execute', arguments: input, resourceName: 'Synthetic target' } }),
    'fixture.execute': () => { writes++; return Promise.resolve({ recordId: randomUUID() }); },
  } });
  await plugin.listen({ host: '127.0.0.1', port: 0 });
  const address = plugin.server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  const registry = new PluginRegistry(privateKey, {
    store,
    envelopeResults: true,
    defaultSourcePolicy: { sourceId: 'fixture-actions', revision: 'r1', dataClasses: ['synthetic_demo'] },
    ...(resolveActor ? { resolveActor } : {}),
  });
  await registry.install({ endpoint: `http://127.0.0.1:${String(address.port)}/mcp`, serviceToken: 'synthetic-service', expectedManifestDigest: digest(manifest), allowLoopback: true });
  const api = await createApi({ mode: 'test', registry, store });
  const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1:3000' };
  return {
    api,
    headers,
    manifest,
    plugin,
    registry,
    store,
    get writes() { return writes; },
    async cookieFor(personaId: string) {
      const login = await api.inject({ method: 'POST', url: '/api/dev/login', headers, payload: { personaId } });
      return login.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    },
    async prepare(cookie: string) {
      const prepared = await api.inject({ method: 'POST', url: '/api/tools/call', headers: { ...headers, cookie }, payload: { pluginId: manifest.id, name: 'fixture.prepare', arguments: { target: 'one' } } });
      expect(prepared.statusCode, prepared.body).toBe(200);
      return prepared.json<{ proposal: { id: string } }>().proposal.id;
    },
    async close() {
      await api.close();
      await plugin.close();
    },
  };
}

describe('authoritative action reconciliation', () => {
  it.each(['transport', 'post-call-authority-conflict'])('recovers %s after a successful write without replaying it', async failure => {
    const fixture = await createHarness();
    const { api, headers, manifest, registry } = fixture;
    try {
      const cookie = await fixture.cookieFor('student');
      const proposalId = await fixture.prepare(cookie);
      const invoke = registry.invoke.bind(registry);
      const lost = vi.spyOn(registry, 'invoke').mockImplementation(async (...input) => {
        const result = await invoke(...input);
        if (input[1] === 'fixture.execute') throw failure === 'post-call-authority-conflict' ? new RequestError(409, 'Synthetic post-dispatch authority change') : new Error('Synthetic response loss after durable receipt');
        return result;
      });
      const confirmed = await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/confirm`, headers: { ...headers, cookie }, payload: {} });
      expect(confirmed.json<{ proposal: { status: string } }>().proposal.status).toBe('outcome_unknown');
      expect(fixture.writes).toBe(1);
      const replay = await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/confirm`, headers: { ...headers, cookie }, payload: {} });
      expect(replay.json<{ proposal: { status: string } }>().proposal.status).toBe('outcome_unknown');
      const reconciled = await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/reconcile`, headers: { ...headers, cookie }, payload: {} });
      expect(reconciled.statusCode, reconciled.body).toBe(200);
      expect(reconciled.json<{ proposal: { status: string } }>().proposal.status).toBe('confirmed');
      expect(reconciled.json<{ recordId: string }>().recordId).toEqual(expect.any(String));
      expect(reconciled.json<{ _hasi: { provenance: { sourceId: string } } }>()._hasi.provenance.sourceId).toBe('fixture-actions');
      expect(() => { registry.validateExecutionResult(manifest.id, 'fixture.execute', { recordId: 'fake', _hasi: { forged: true } }); }).toThrow('Vertrag');
      expect(fixture.writes).toBe(1);
      expect(lost).toHaveBeenCalledTimes(1);
      const foreignCookie = await fixture.cookieFor('employee');
      expect((await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/reconcile`, headers: { ...headers, cookie: foreignCookie }, payload: {} })).statusCode).toBe(404);
    } finally { await fixture.close(); }
  });

  it('keeps a reconciled receipt when the original confirmation returns late', async () => {
    const fixture = await createHarness();
    const { api, headers, registry, store } = fixture;
    let markEntered: () => void = () => undefined;
    let releaseConfirmation: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const delayed = new Promise<void>(resolve => { releaseConfirmation = resolve; });
    let originalConfirmation: Promise<Awaited<ReturnType<typeof api.inject>>> | undefined;
    try {
      const cookie = await fixture.cookieFor('student');
      const proposalId = await fixture.prepare(cookie);
      const invoke = registry.invoke.bind(registry);
      vi.spyOn(registry, 'invoke').mockImplementation(async (...input) => {
        const result = await invoke(...input);
        if (input[1] === 'fixture.execute') {
          markEntered();
          await delayed;
          throw new Error('Synthetic lost response after receipt persistence');
        }
        return result;
      });

      originalConfirmation = api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/confirm`, headers: { ...headers, cookie }, payload: {} });
      await entered;

      const key = `proposal:${proposalId}`;
      const executing = await store.read(key);
      if (!executing) throw new Error('Executing proposal missing');
      const staleValue = { ...(executing.value as Record<string, unknown>), executionStartedAt: Date.now() - 61_000 };
      expect(await store.compareAndSet(key, executing.revision, staleValue)).toBe(true);

      const reconciled = await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/reconcile`, headers: { ...headers, cookie }, payload: {} });
      expect(reconciled.statusCode, reconciled.body).toBe(200);
      expect(reconciled.json<{ proposal: { status: string } }>().proposal.status).toBe('confirmed');
      const reconciledResult = reconciled.json<{ recordId: string }>().recordId;

      releaseConfirmation();
      const lateConfirmation = await originalConfirmation;
      expect(lateConfirmation.statusCode, lateConfirmation.body).toBe(200);
      expect(lateConfirmation.json<{ proposal: { status: string } }>().proposal.status).toBe('confirmed');
      expect(lateConfirmation.json<{ recordId: string }>().recordId).toBe(reconciledResult);
      const finalRecord = await store.read(key);
      expect((finalRecord?.value as { status?: string }).status).toBe('confirmed');
      expect((finalRecord?.value as { result?: { recordId?: string } }).result?.recordId).toBe(reconciledResult);
      expect(fixture.writes).toBe(1);
    } finally {
      releaseConfirmation();
      await originalConfirmation?.catch(() => undefined);
      await fixture.close();
    }
  });

  it.each(['changed rights', 'changed plugin binding'])('does not expose a stale executing proposal after %s', async change => {
    let currentPermissions = ['rooms:prepare', 'rooms:execute'];
    const fixture = await createHarness(subject => Promise.resolve(subject === 'fixture-student'
      ? { subject, permissions: [...currentPermissions] }
      : undefined));
    const { api, headers, registry, store } = fixture;
    try {
      const cookie = await fixture.cookieFor('student');
      const proposalId = await fixture.prepare(cookie);
      const key = `proposal:${proposalId}`;
      const proposalRecord = await store.read(key);
      if (!proposalRecord) throw new Error('Prepared proposal missing');
      expect(await store.compareAndSet(key, proposalRecord.revision, {
        ...(proposalRecord.value as Record<string, unknown>),
        status: 'executing',
        executionId: randomUUID(),
        executionStartedAt: Date.now() - 61_000,
      })).toBe(true);

      if (change === 'changed rights') currentPermissions = ['rooms:prepare'];
      else await registry.setEnabled(fixture.manifest.id, false);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const repeated = await api.inject({ method: 'POST', url: `/api/proposals/${proposalId}/confirm`, headers: { ...headers, cookie }, payload: {} });
        expect(repeated.statusCode, repeated.body).toBe(409);
        expect(repeated.body).not.toContain('Synthetic target');
      }
      const unchanged = await store.read(key);
      expect((unchanged?.value as { status?: string }).status).toBe('executing');
      expect(fixture.writes).toBe(0);
    } finally { await fixture.close(); }
  });

  it('holds an uncertain execution and rejects changed arguments and foreign receipt identities', async () => {
    const journal = new ExecutionJournal(new MemoryJsonStore('uncertain'), 'test');
    const binding = { subject: 'person', installationId: 'fixture', executionId: randomUUID(), tool: 'write', argsHash: digest({ target: 1 }), configurationRevision: 1 };
    const write = vi.fn(() => Promise.reject(new Error('Unknown upstream effect')));
    await expect(journal.execute(binding, write)).rejects.toThrow();
    await expect(journal.execute(binding, write)).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await journal.status(binding)).toEqual({ status: 'outcome_unknown' });
    await expect(journal.status({ ...binding, argsHash: digest({ target: 2 }) })).rejects.toThrow('binding changed');
    expect(await journal.status({ ...binding, subject: 'other' })).toEqual({ status: 'outcome_unknown' });
  });
});
