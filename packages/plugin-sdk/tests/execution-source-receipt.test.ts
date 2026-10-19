import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryJsonStore } from '../../state/src/index.js';
import {
  createInvocationToken,
  createPluginServer,
  digest,
  ExecutionJournal,
  type ActorContext,
  type ExecutionBinding,
  type PluginManifest,
} from '../src/index.js';

const actor: ActorContext = { subject: 'user-1', customerId: 'customer-1', resourceIds: ['resource-1'], permissions: ['records:execute'] };
const manifest: PluginManifest = {
  manifestVersion: 1, id: 'records-plugin', name: 'Records', description: 'Record updates.', version: '1.0.0', apiVersion: '1.0.0', mcpVersion: '2026-07-28',
  tools: [{ name: 'update-record', title: 'Update record', description: 'Update one record.', inputSchema: { type: 'object', properties: { recordId: { type: 'string' }, value: { type: 'string' } }, required: ['recordId', 'value'], additionalProperties: false }, outputSchema: { type: 'object', properties: { updated: { type: 'boolean' } }, required: ['updated'], additionalProperties: false }, effect: 'execute', requiredPermissions: ['records:execute'] }],
};
const keys = generateKeyPairSync('ed25519');
const activeApps: ReturnType<typeof createPluginServer>[] = [];

afterEach(async () => Promise.all(activeApps.splice(0).map(app => app.close())));

describe('ExecutionJournal source reconciliation', () => {
  it('confirms an unknown execution from one bounded source result', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    await recordUnknown(journal, binding);
    const resolve = vi.fn(() => Promise.resolve({ updated: true }));
    await expect(journal.reconcile(binding, resolve)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    expect(resolve).toHaveBeenCalledOnce();
    await expect(journal.status(binding)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
  });

  it('does not call the resolver for missing, foreign, mismatched, or confirmed receipts', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    const resolve = vi.fn(() => Promise.resolve({ updated: true }));
    await expect(journal.reconcile(binding, resolve)).resolves.toEqual({ status: 'outcome_unknown' });
    await recordUnknown(journal, binding);
    await expect(journal.reconcile({ ...binding, configurationRevision: 8 }, resolve)).rejects.toThrow('binding changed');
    await expect(journal.reconcile({ ...binding, subject: 'another-user' }, resolve)).resolves.toEqual({ status: 'outcome_unknown' });
    expect(resolve).not.toHaveBeenCalled();
    const confirmedBinding = makeBinding();
    await journal.execute(confirmedBinding, () => Promise.resolve({ updated: true }));
    await expect(journal.reconcile(confirmedBinding, resolve)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves the receipt unknown when the resolver is empty, throws, or returns invalid output', async () => {
    const cases: { resolve: () => Promise<Record<string, unknown> | undefined>; rejects: boolean }[] = [
      { resolve: () => Promise.resolve(undefined), rejects: false },
      { resolve: () => Promise.reject(new Error('source unavailable')), rejects: true },
      { resolve: () => Promise.resolve({ value: undefined }), rejects: true },
      { resolve: () => Promise.resolve({ value: 'x'.repeat(61 * 1_024) }), rejects: true },
    ];
    for (const { resolve, rejects } of cases) {
      const binding = makeBinding();
      const journal = makeJournal();
      await recordUnknown(journal, binding);
      if (rejects) await expect(journal.reconcile(binding, resolve)).rejects.toThrow();
      else await expect(journal.reconcile(binding, resolve)).resolves.toEqual({ status: 'outcome_unknown' });
      await expect(journal.status(binding)).resolves.toEqual({ status: 'outcome_unknown' });
    }
  });

  it('returns the winning receipt after a reconciliation CAS race without retrying either resolver', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    await recordUnknown(journal, binding);
    const firstResult = deferred<Record<string, unknown>>();
    const secondResult = deferred<Record<string, unknown>>();
    const firstStarted = deferred<undefined>();
    const secondStarted = deferred<undefined>();
    const firstResolver = vi.fn(() => { firstStarted.resolve(undefined); return firstResult.promise; });
    const secondResolver = vi.fn(() => { secondStarted.resolve(undefined); return secondResult.promise; });
    const first = journal.reconcile(binding, firstResolver);
    const second = journal.reconcile(binding, secondResolver);
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    firstResult.resolve({ updated: true });
    await expect(first).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    secondResult.resolve({ updated: false });
    await expect(second).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    expect(firstResolver).toHaveBeenCalledOnce();
    expect(secondResolver).toHaveBeenCalledOnce();
    await expect(journal.status(binding)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
  });

  it('does not let a late successful execution overwrite a reconciled receipt', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<undefined>();
    const execution = journal.execute(binding, () => { started.resolve(undefined); return pending.promise; });
    await started.promise;
    await journal.reconcile(binding, () => Promise.resolve({ updated: true }));
    pending.resolve({ updated: true });
    await expect(execution).resolves.toEqual({ updated: true });
    await expect(journal.status(binding)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
  });

  it('fails closed on a conflicting late result and preserves the reconciled receipt', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<undefined>();
    const execution = journal.execute(binding, () => { started.resolve(undefined); return pending.promise; });
    await started.promise;
    await journal.reconcile(binding, () => Promise.resolve({ updated: true }));
    pending.resolve({ updated: false });
    await expect(execution).rejects.toThrow('Conflicting execution result');
    await expect(journal.status(binding)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
  });

  it('preserves a reconciled receipt when the original handler throws', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    const pending = deferred<Record<string, unknown>>();
    const started = deferred<undefined>();
    const execution = journal.execute(binding, () => { started.resolve(undefined); return pending.promise; });
    await started.promise;
    await journal.reconcile(binding, () => Promise.resolve({ updated: true }));
    pending.reject(new Error('reply lost'));
    await expect(execution).resolves.toEqual({ updated: true });
    await expect(journal.status(binding)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
  });

  it('retries status through the host endpoint without invoking the write handler again', async () => {
    const binding = makeBinding();
    const journal = makeJournal();
    const handler = vi.fn(() => Promise.reject(new Error('reply lost')));
    let reads = 0;
    const app = createPluginServer({
      manifest, publicKey: keys.publicKey, serviceToken: 'service-secret', executionJournal: journal,
      handlers: { 'update-record': handler },
      reconcileExecution: (candidate, checkedActor) => {
        expect(candidate).toEqual(binding);
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(checkedActor).toEqual(actor);
        reads += 1;
        if (reads === 1) return Promise.resolve(undefined);
        return Promise.resolve(reads === 2 ? { updated: true, unexpected: true } : { updated: true });
      },
    });
    activeApps.push(app);
    const args = { recordId: 'r-1', value: 'new value' };
    const context = { installationId: binding.installationId, configurationRevision: binding.configurationRevision, configuration: {}, executionId: binding.executionId };
    const executeToken = await createInvocationToken({ actor, context, pluginId: manifest.id, pluginVersion: manifest.version, tool: binding.tool, args }, keys.privateKey);
    const executed = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer service-secret', 'x-hasi-invocation': executeToken, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: binding.tool, arguments: args } } });
    expect(executed.statusCode).toBe(200);
    expect(isRpcError(executed.body)).toBe(true);

    await expect(readStatus(app, binding, actor, context)).resolves.toEqual({ status: 'outcome_unknown' });
    await expect(readStatus(app, binding, actor, context, 409)).resolves.toEqual({ error: 'Status could not be established' });
    await expect(journal.status(binding)).resolves.toEqual({ status: 'outcome_unknown' });
    await expect(readStatus(app, binding, actor, context)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    await expect(readStatus(app, binding, actor, context)).resolves.toEqual({ status: 'confirmed', result: { updated: true } });
    expect(handler).toHaveBeenCalledOnce();
    expect(reads).toBe(3);
  });
});

function makeBinding(): ExecutionBinding {
  return { subject: actor.subject, installationId: manifest.id, executionId: randomUUID(), tool: 'update-record', argsHash: digest({ recordId: 'r-1', value: 'new value' }), configurationRevision: 4 };
}

function makeJournal(): ExecutionJournal {
  return new ExecutionJournal(new MemoryJsonStore(`execution-reconcile-${randomUUID()}`), 'test-plugin');
}

async function recordUnknown(journal: ExecutionJournal, binding: ExecutionBinding): Promise<void> {
  await expect(journal.execute(binding, () => Promise.reject(new Error('lost reply')))).rejects.toThrow('outcome requires reconciliation');
  await expect(journal.status(binding)).resolves.toEqual({ status: 'outcome_unknown' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function isRpcError(body: string): boolean {
  const dataLine = body.split('\n').find(line => line.startsWith('data: '));
  if (!dataLine) throw new Error('Missing MCP response data');
  const response = JSON.parse(dataLine.slice('data: '.length)) as { result?: { isError?: boolean } };
  return response.result?.isError === true;
}

async function readStatus(
  app: ReturnType<typeof createPluginServer>,
  binding: ExecutionBinding,
  statusActor: ActorContext,
  context: { installationId: string; configurationRevision: number; configuration: Record<string, unknown>; executionId: string },
  expectedStatus = 200,
): Promise<unknown> {
  const args = { tool: binding.tool, executionId: binding.executionId, argsHash: binding.argsHash };
  const token = await createInvocationToken({ actor: statusActor, context, pluginId: manifest.id, pluginVersion: manifest.version, tool: '__hasi.action_status', args }, keys.privateKey);
  const response = await app.inject({ method: 'POST', url: '/hasi/actions/status', headers: { authorization: 'Bearer service-secret', 'x-hasi-invocation': token }, payload: args });
  expect(response.statusCode).toBe(expectedStatus);
  return response.json();
}
