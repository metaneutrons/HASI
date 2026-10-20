import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  createInvocationToken, digest, MANAGED_STATE_METHODS, MANAGED_STATE_MCP_VERSION,
  verifyInvocationTokenClaims,
  type ActorContext, type ExecutionBinding, type ManagedStateDeclaration, type PluginManifestV2, type VerifiedInvocation,
} from '@hasi/plugin-sdk';
import { MemoryJsonStore, type FencedJsonStore, type StateFence } from '@hasi/state';
import { ManagedPluginStateSession } from '../apps/api/src/managed-plugin-state.js';

const INSTALLATION = 'fixture.managed-state';
const SCOPE = 'managed-state-host-test';
const AUTHORITY_KEY = 'authority:account';
const APP_KEY = 'profile';
const validApplicationSchema = {
  type: 'object',
  properties: { count: { type: 'integer' }, note: { type: 'string', maxLength: 100_000 } },
  required: ['count'],
  additionalProperties: false,
};
const keyPair = generateKeyPairSync('ed25519');

interface RouteSchemas {
  params: { parse(value: unknown): unknown };
  result: { parse(value: unknown): unknown };
}
type Handler = (params: never) => Promise<unknown>;
interface CapturedRoute {
  schemas: RouteSchemas;
  handler: Handler;
}

function makeManifest(accountIdentity: ManagedStateDeclaration['accountIdentity'] = { kind: 'claim', name: 'customer.number' }): PluginManifestV2 {
  return {
    manifestVersion: 2,
    id: INSTALLATION,
    name: 'Managed state fixture',
    description: 'Host-only state session test fixture',
    version: '1.0.0',
    apiVersion: '2.0.0',
    mcpVersion: MANAGED_STATE_MCP_VERSION,
    tools: [],
    managedState: { schemaVersion: 1, accountIdentity, applicationSchema: validApplicationSchema },
  };
}

function makeActor(subject = 'subject-a', account = 'account-a'): ActorContext {
  return {
    subject,
    customerId: account,
    permissions: ['fixture:execute'],
    claims: { 'customer.number': account },
  };
}

async function verifiedInvocation(actor: ActorContext, pluginId = INSTALLATION) {
  const args = { fixture: 'managed-state-host-test' };
  const token = await createInvocationToken({
    actor,
    pluginId,
    pluginVersion: '1.0.0',
    tool: 'fixture.execute',
    args,
    context: { installationId: INSTALLATION, configurationRevision: 1, configuration: {} },
  }, keyPair.privateKey);
  return verifyInvocationTokenClaims(token, {
    installationId: INSTALLATION,
    pluginId,
    pluginVersion: '1.0.0',
    tool: 'fixture.execute',
    args,
  }, keyPair.publicKey);
}

async function seedAuthority(store: MemoryJsonStore): Promise<StateFence> {
  const current = await store.read(AUTHORITY_KEY);
  if (current) return { key: AUTHORITY_KEY, revision: current.revision };
  if (!await store.compareAndSet(AUTHORITY_KEY, null, { version: 1 })) throw new Error('Could not seed fixture authority');
  const seeded = await store.read(AUTHORITY_KEY);
  if (!seeded) throw new Error('Fixture authority was not persisted');
  return { key: AUTHORITY_KEY, revision: seeded.revision };
}

interface FixtureOptions {
  store?: MemoryJsonStore;
  stateStore?: FencedJsonStore;
  actor?: ActorContext;
  invocationActor?: ActorContext;
  invocation?: VerifiedInvocation;
  accountIdentity?: ManagedStateDeclaration['accountIdentity'];
  manifest?: PluginManifestV2;
  fences?: readonly StateFence[];
  mode?: 'read' | 'prepare' | 'execute' | 'status';
  hasPersonalAccount?: boolean;
  authorityExpiresAt?: number;
  executionBinding?: ExecutionBinding;
  validateExecutionResult?: (result: Record<string, unknown>) => boolean;
  onCurrent?: () => Promise<void>;
}

async function createFixture(options: FixtureOptions = {}) {
  const memoryStore = options.store ?? new MemoryJsonStore(`managed-state-test-${randomUUID()}`);
  const actor = options.actor ?? makeActor();
  const invocationActor = options.invocationActor ?? actor;
  const manifest = options.manifest ?? makeManifest(options.accountIdentity);
  const invocation = options.invocation ?? await verifiedInvocation(invocationActor, manifest.id);
  const fences = options.fences ?? [await seedAuthority(memoryStore)];
  const currentCheck = options.onCurrent ?? vi.fn(() => Promise.resolve());
  const session = await ManagedPluginStateSession.create({
    store: options.stateStore ?? memoryStore,
    scope: SCOPE,
    installationId: INSTALLATION,
    manifest,
    actor,
    invocation,
    fences,
    hasPersonalAccount: options.hasPersonalAccount ?? true,
    mode: options.mode ?? 'execute',
    ...(options.authorityExpiresAt === undefined ? {} : { authorityExpiresAt: options.authorityExpiresAt }),
    ...(options.executionBinding ? { executionBinding: options.executionBinding } : {}),
    ...(options.validateExecutionResult ? { validateExecutionResult: options.validateExecutionResult } : {}),
    assertCurrent: currentCheck,
  });

  const routes = new Map<string, CapturedRoute>();
  const client = {
    setRequestHandler(method: string, schemas: RouteSchemas, handler: Handler) {
      routes.set(method, { schemas, handler });
    },
  } as unknown as Client;
  session.register(client);

  return {
    actor,
    fences,
    invocation,
    manifest,
    memoryStore,
    routes,
    session,
    async call<T>(method: string, params: unknown): Promise<T> {
      const route = routes.get(method);
      if (!route) throw new Error(`No captured handler for ${method}`);
      const parsedParams = route.schemas.params.parse(params);
      const result = await route.handler(parsedParams as never);
      return route.schemas.result.parse(result) as T;
    },
    activate() { session.activate(); },
    close() { return session.close(); },
    consume(invocationId = invocation.jti) {
      return this.call<{ consumed: boolean }>(MANAGED_STATE_METHODS.consumeInvocation, { invocationId });
    },
    read(area: 'application' | 'journal' = 'application', key = APP_KEY, invocationId = invocation.jti) {
      return this.call<{ entry: { revision: string; value: unknown } | null }>(MANAGED_STATE_METHODS.read, { invocationId, area, key });
    },
    cas(input: { area: 'application' | 'journal'; key: string; revision: string | null; value: unknown; invocationId?: string }) {
      return this.call<{ updated: boolean }>(MANAGED_STATE_METHODS.compareAndSet, {
        invocationId: input.invocationId ?? invocation.jti,
        area: input.area,
        key: input.key,
        revision: input.revision,
        value: input.value,
      });
    },
  };
}

function executionBinding(subject = 'subject-a'): ExecutionBinding {
  return {
    subject,
    installationId: INSTALLATION,
    executionId: randomUUID(),
    tool: 'fixture.execute',
    argsHash: digest({ fixture: 'execute' }),
    configurationRevision: 1,
  };
}

function journalKey(binding: ExecutionBinding): string {
  return `execution:v1:${digest({ namespace: INSTALLATION, subject: binding.subject, installationId: binding.installationId, executionId: binding.executionId })}`;
}

async function consume(fixture: Awaited<ReturnType<typeof createFixture>>) {
  fixture.activate();
  return fixture.consume();
}

async function denied(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow('Managed state request denied');
}

describe('host managed plugin state session', () => {
  it('gates captured callbacks on activation and successful invocation consumption, then closes them', async () => {
    const fixture = await createFixture();
    const params = { invocationId: fixture.invocation.jti, area: 'application', key: APP_KEY } as const;
    const write = { invocationId: fixture.invocation.jti, area: 'application' as const, key: APP_KEY, revision: null, value: { count: 1 } };

    await denied(fixture.call(MANAGED_STATE_METHODS.read, params));
    await denied(fixture.call(MANAGED_STATE_METHODS.consumeInvocation, { invocationId: fixture.invocation.jti }));
    await denied(fixture.call(MANAGED_STATE_METHODS.compareAndSet, write));

    fixture.activate();
    await denied(fixture.read());
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1 } }));
    expect(await fixture.consume()).toEqual({ consumed: true });
    expect(await fixture.read()).toEqual({ entry: null });

    await fixture.close();
    await denied(fixture.read());
    await denied(fixture.consume());
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 2 } }));
  });

  it('rejects a wrong nonce, returns false for replay, and does not authorize a replayed session', async () => {
    const fixture = await createFixture();
    fixture.activate();
    await denied(fixture.consume(randomUUID()));
    expect(await fixture.consume()).toEqual({ consumed: true });
    expect(await fixture.consume()).toEqual({ consumed: false });
    expect(await fixture.read()).toEqual({ entry: null });
    await fixture.close();

    const replay = await createFixture({ store: fixture.memoryStore, manifest: fixture.manifest, actor: fixture.actor, invocation: fixture.invocation });
    replay.activate();
    expect(await replay.consume()).toEqual({ consumed: false });
    await denied(replay.read());
  });

  it('reads null, performs application CAS, reports UUID conflicts, and carries state into the next invocation', async () => {
    const first = await createFixture();
    await consume(first);
    expect(await first.read()).toEqual({ entry: null });

    expect(await first.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 7, note: 'saved' } })).toEqual({ updated: true });
    expect(await first.cas({ area: 'application', key: APP_KEY, revision: randomUUID(), value: { count: 8 } })).toEqual({ updated: false });
    const saved = await first.read();
    expect(saved.entry).toMatchObject({ value: { count: 7, note: 'saved' } });
    expect(saved.entry?.revision).toMatch(/^[0-9a-f-]{36}$/u);
    await first.close();

    const next = await createFixture({ store: first.memoryStore, manifest: first.manifest, actor: first.actor });
    await consume(next);
    expect(await next.read()).toEqual(saved);
    expect(next.manifest.managedState).toEqual(first.manifest.managedState);
  });

  it.each(['read', 'prepare', 'status'] as const)('blocks application CAS in %s mode', async mode => {
    const fixture = await createFixture({ mode });
    await consume(fixture);
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1 } }));
  });

  it.each([
    { kind: 'claim' as const, identity: { kind: 'claim' as const, name: 'customer.number' }, personal: true },
    { kind: 'customerId' as const, identity: { kind: 'customerId' as const }, personal: true },
    { kind: 'subject' as const, identity: { kind: 'subject' as const }, personal: false },
  ])('isolates application state by declared $kind identity and subject', async ({ kind, identity, personal }) => {
    const firstActor = makeActor('subject-a', 'account-a');
    const first = await createFixture({ actor: firstActor, accountIdentity: identity, hasPersonalAccount: personal });
    await consume(first);
    expect(await first.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1 } })).toEqual({ updated: true });
    await first.close();

    const changedAccount = makeActor('subject-a', 'account-b');
    if (kind === 'subject') {
      const otherSubject = await createFixture({ store: first.memoryStore, manifest: first.manifest, actor: makeActor('subject-b', 'account-a'), accountIdentity: identity, hasPersonalAccount: personal });
      await consume(otherSubject);
      expect(await otherSubject.read()).toEqual({ entry: null });
      return;
    }

    const otherAccount = await createFixture({ store: first.memoryStore, manifest: first.manifest, actor: changedAccount, accountIdentity: identity, hasPersonalAccount: personal });
    await consume(otherAccount);
    expect(await otherAccount.read()).toEqual({ entry: null });
    await otherAccount.close();

    const otherSubject = await createFixture({ store: first.memoryStore, manifest: first.manifest, actor: makeActor('subject-b', 'account-a'), accountIdentity: identity, hasPersonalAccount: personal });
    await consume(otherSubject);
    expect(await otherSubject.read()).toEqual({ entry: null });
  });

  it('does not expose old values to a different package reusing the same installation identity', async () => {
    const first = await createFixture(); await consume(first);
    expect(await first.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 9 } })).toEqual({ updated: true });
    await first.close();
    const replacement = await createFixture({ store: first.memoryStore, actor: first.actor, manifest: { ...first.manifest, id: 'different-package' } });
    await consume(replacement);
    expect(await replacement.read()).toEqual({ entry: null });
  });

  it('rejects missing authority fences and denies requests after a captured authority revision changes', async () => {
    await expect(createFixture({ fences: [] })).rejects.toThrow('Managed state authority unavailable');

    const missing = await createFixture({ fences: [{ key: 'authority:missing', revision: randomUUID() }] });
    missing.activate();
    await denied(missing.consume());

    const changed = await createFixture();
    await consume(changed);
    const authority = await changed.memoryStore.read(AUTHORITY_KEY);
    expect(authority).toBeDefined();
    expect(await changed.memoryStore.compareAndSet(AUTHORITY_KEY, authority!.revision, { version: 2 })).toBe(true);
    await denied(changed.read());
  });

  it('fences the application CAS against authority changing after the read', async () => {
    const memoryStore = new MemoryJsonStore(`managed-state-race-${randomUUID()}`);
    const fence = await seedAuthority(memoryStore);
    let changeNextFencedWrite = false;
    const racingStore: FencedJsonStore = {
      read: key => memoryStore.read(key),
      compareAndSet: (key, revision, value, expiresAt) => memoryStore.compareAndSet(key, revision, value, expiresAt),
      delete: key => memoryStore.delete(key),
      readWithFence: (key, fences) => memoryStore.readWithFence(key, fences),
      async compareAndSetWithFence(key, revision, value, fences, expiresAt) {
        if (changeNextFencedWrite) {
          changeNextFencedWrite = false;
          const current = await memoryStore.read(AUTHORITY_KEY);
          if (!current || !await memoryStore.compareAndSet(AUTHORITY_KEY, current.revision, { version: 2 })) throw new Error('Could not change fixture authority');
        }
        return memoryStore.compareAndSetWithFence(key, revision, value, fences, expiresAt);
      },
    };
    const fixture = await createFixture({ store: memoryStore, stateStore: racingStore, fences: [fence] });
    await consume(fixture);
    changeNextFencedWrite = true;
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1 } }));
    await denied(fixture.read());
  });

  it('clones caller values before awaiting current-authority checks', async () => {
    let pauseCurrent = false;
    let releaseCurrent: (() => void) | undefined;
    const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve; });
    const fixture = await createFixture({ onCurrent: async () => { if (pauseCurrent) await currentGate; } });
    await consume(fixture);

    const value = { count: 1 };
    pauseCurrent = true;
    const pending = fixture.cas({ area: 'application', key: APP_KEY, revision: null, value });
    await Promise.resolve();
    value.count = 2;
    pauseCurrent = false;
    releaseCurrent?.();
    expect(await pending).toEqual({ updated: true });
    expect((await fixture.read()).entry?.value).toEqual({ count: 1 });
  });

  it('rejects application schema violations and entries above the byte limit', async () => {
    const fixture = await createFixture();
    await consume(fixture);
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 'one' } }));
    await denied(fixture.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1, note: 'x'.repeat(60 * 1024) } }));
  });

  it('enforces per-invocation operation quota and total entry quota through registered callbacks', async () => {
    const operationFixture = await createFixture();
    await consume(operationFixture);
    for (let index = 0; index < 63; index += 1) await operationFixture.read();
    await denied(operationFixture.read());

    const store = new MemoryJsonStore(`managed-state-capacity-${randomUUID()}`);
    let written = 0;
    let capacityRejected = false;
    for (let invocationIndex = 0; invocationIndex < 5 && !capacityRejected; invocationIndex += 1) {
      const fixture = await createFixture({ store });
      await consume(fixture);
      for (let operation = 0; operation < 63 && !capacityRejected; operation += 1) {
        try {
          const result = await fixture.cas({ area: 'application', key: `entry-${String(written)}`, revision: null, value: { count: written } });
          expect(result.updated).toBe(true);
          written += 1;
        } catch {
          capacityRejected = true;
        }
      }
      await fixture.close();
    }
    expect(written).toBe(256);
    expect(capacityRejected).toBe(true);
  });

  it('allows only execute mode to create a fresh executing journal receipt', async () => {
    const store = new MemoryJsonStore(`managed-state-journal-create-${randomUUID()}`);
    const binding = executionBinding();
    const key = journalKey(binding);
    const bindingHash = digest(binding);
    const status = await createFixture({ store, mode: 'status', executionBinding: binding });
    await consume(status);

    await denied(status.read('journal', 'execution:v1:forged'));
    await denied(status.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'executing' } }));
    await denied(status.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'outcome_unknown' } }));
    await denied(status.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'confirmed', result: { recordId: 'result-1' } } }));
    await status.close();

    const execute = await createFixture({ store, mode: 'execute', executionBinding: binding, validateExecutionResult: result => typeof result.recordId === 'string' });
    await consume(execute);
    await denied(execute.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'outcome_unknown' } }));
    await denied(execute.cas({ area: 'journal', key, revision: null, value: { binding: digest({ ...binding, tool: 'forged' }), status: 'executing' } }));
    await denied(execute.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'confirmed', result: { recordId: 7 } } }));
    expect(await execute.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'executing' } })).toEqual({ updated: true });
    expect(await execute.read('journal', key)).toMatchObject({ entry: { value: { binding: bindingHash, status: 'executing' } } });
    await execute.close();
  });

  it('reconciles executing and outcome_unknown receipts, then keeps confirmed results immutable', async () => {
    const store = new MemoryJsonStore(`managed-state-journal-reconcile-${randomUUID()}`);
    const binding = executionBinding();
    const key = journalKey(binding);
    const bindingHash = digest(binding);
    const validateExecutionResult = (result: Record<string, unknown>) => typeof result.recordId === 'string';
    const initial = await createFixture({ store, mode: 'execute', executionBinding: binding, validateExecutionResult });
    await consume(initial);
    expect(await initial.cas({ area: 'journal', key, revision: null, value: { binding: bindingHash, status: 'executing' } })).toEqual({ updated: true });
    await initial.close();

    const status = await createFixture({ store, mode: 'status', executionBinding: binding, validateExecutionResult });
    await consume(status);
    const executing = await status.read('journal', key);
    const executingRevision = executing.entry?.revision;
    expect(executing.entry?.value).toEqual({ binding: bindingHash, status: 'executing' });
    if (!executingRevision) throw new Error('Executing receipt revision missing');
    await denied(status.cas({ area: 'journal', key, revision: executingRevision, value: { binding: bindingHash, status: 'executing' } }));

    const unknownReceipt = { binding: bindingHash, status: 'outcome_unknown' };
    expect(await status.cas({ area: 'journal', key, revision: executingRevision, value: unknownReceipt })).toEqual({ updated: true });
    const unknown = await status.read('journal', key);
    const unknownRevision = unknown.entry?.revision;
    expect(unknown.entry?.value).toEqual(unknownReceipt);
    if (!unknownRevision) throw new Error('Outcome-unknown receipt revision missing');
    expect(await status.cas({ area: 'journal', key, revision: unknownRevision, value: unknownReceipt })).toEqual({ updated: true });

    const refreshedUnknown = await status.read('journal', key);
    const refreshedRevision = refreshedUnknown.entry?.revision;
    if (!refreshedRevision) throw new Error('Refreshed receipt revision missing');
    const confirmed = { binding: bindingHash, status: 'confirmed', result: { recordId: 'result-1' } };
    expect(await status.cas({ area: 'journal', key, revision: refreshedRevision, value: confirmed })).toEqual({ updated: true });
    const persisted = await status.read('journal', key);
    expect(persisted.entry?.value).toEqual(confirmed);
    const confirmedRevision = persisted.entry?.revision;
    if (!confirmedRevision) throw new Error('Confirmed receipt revision missing');
    await denied(status.cas({ area: 'journal', key, revision: confirmedRevision, value: { ...confirmed, result: { recordId: 'changed' } } }));
    await denied(status.cas({ area: 'journal', key, revision: confirmedRevision, value: { binding: bindingHash, status: 'executing' } }));
    await status.close();

    const directBinding = executionBinding();
    const directKey = journalKey(directBinding);
    const directHash = digest(directBinding);
    const directExecute = await createFixture({ store, mode: 'execute', executionBinding: directBinding, validateExecutionResult });
    await consume(directExecute);
    expect(await directExecute.cas({ area: 'journal', key: directKey, revision: null, value: { binding: directHash, status: 'executing' } })).toEqual({ updated: true });
    await directExecute.close();
    const directStatus = await createFixture({ store, mode: 'status', executionBinding: directBinding, validateExecutionResult });
    await consume(directStatus);
    const directExecuting = await directStatus.read('journal', directKey);
    const directRevision = directExecuting.entry?.revision;
    if (!directRevision) throw new Error('Direct executing receipt revision missing');
    const directConfirmed = { binding: directHash, status: 'confirmed', result: { recordId: 'direct-result' } };
    expect(await directStatus.cas({ area: 'journal', key: directKey, revision: directRevision, value: directConfirmed })).toEqual({ updated: true });
    expect(await directStatus.read('journal', directKey)).toMatchObject({ entry: { value: directConfirmed } });
  });

  it('rejects changed declarations and mismatched host and verified invocation actors', async () => {
    const first = await createFixture();
    await consume(first);
    expect(await first.cas({ area: 'application', key: APP_KEY, revision: null, value: { count: 1 } })).toEqual({ updated: true });
    await first.close();

    const changedManifest = makeManifest({ kind: 'customerId' });
    const changedContract = await createFixture({ store: first.memoryStore, actor: first.actor, manifest: changedManifest });
    changedContract.activate();
    await denied(changedContract.consume());

    const verifiedActor = makeActor('verified-subject', 'account-a');
    const hostActor = makeActor('host-subject', 'account-a');
    await expect(createFixture({ actor: hostActor, invocationActor: verifiedActor })).rejects.toThrow();
  });

  it('rejects callbacks after the session authority expires', async () => {
    const fixture = await createFixture({ authorityExpiresAt: Date.now() + 500 });
    fixture.activate();
    expect(await fixture.consume()).toEqual({ consumed: true });
    await new Promise(resolve => setTimeout(resolve, 525));
    await denied(fixture.read());
  });
});
