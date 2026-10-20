import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest, type ActorContext, type ExecutionBinding, type ExecutionStore } from '@hasi/plugin-sdk';

interface ManagedReferenceState {
  mark(binding: ExecutionBinding, args: Record<string, unknown>, actor: ActorContext): Promise<MarkResult>;
  resolve(binding: ExecutionBinding, actor: ActorContext): Promise<MarkResult | undefined>;
  count(installationId: string, actor: ActorContext): Promise<number>;
}

interface MarkResult extends Record<string, unknown> {
  confirmed: true;
  actionCount: number;
  label: string;
  account: string;
}

interface MemoryEntry { revision: string; value: unknown }

function memoryStore(initial?: unknown, conflicts = 0): ExecutionStore & {
  entries: Map<string, MemoryEntry>;
  casCalls: number;
} {
  const entries = new Map<string, MemoryEntry>();
  if (initial !== undefined) entries.set('source', { revision: randomUUID(), value: structuredClone(initial) });
  let remainingConflicts = conflicts;
  let casCalls = 0;
  return {
    entries,
    get casCalls() { return casCalls; },
    read(key) {
      const entry = entries.get(key);
      return Promise.resolve(entry ? structuredClone(entry) : undefined);
    },
    compareAndSet(key, revision, value) {
      casCalls += 1;
      if (remainingConflicts > 0) {
        remainingConflicts -= 1;
        const entry = entries.get(key);
        entries.set(key, {
          revision: randomUUID(),
          value: structuredClone(entry?.value ?? { version: 1, actionCount: 0, receipts: {} }),
        });
        return Promise.resolve(false);
      }
      const current = entries.get(key);
      if ((current?.revision ?? null) !== revision) return Promise.resolve(false);
      entries.set(key, { revision: randomUUID(), value: structuredClone(value) });
      return Promise.resolve(true);
    },
  };
}

async function createManagedState(store: ExecutionStore): Promise<ManagedReferenceState> {
  const module = await import(new URL('../examples/reference-plugin/src/state.js', import.meta.url).href) as unknown as {
    createManagedReferenceState(input: ExecutionStore): ManagedReferenceState;
  };
  return module.createManagedReferenceState(store);
}

const actor = (subject: string, account: string): ActorContext => ({
  subject,
  permissions: ['reference:execute'],
  claims: { 'reference.account': account },
});

function bindingFor(currentActor: ActorContext, args: Record<string, unknown>, overrides: Partial<ExecutionBinding> = {}): ExecutionBinding {
  return {
    subject: currentActor.subject,
    installationId: 'hasi.reference.installation',
    executionId: randomUUID(),
    tool: 'execute_mark',
    argsHash: digest(args),
    configurationRevision: 1,
    ...overrides,
  };
}

describe('managed reference source state', () => {
  it('stores one source receipt and returns it on same-binding retries without incrementing twice', async () => {
    const currentActor = actor('person-1', 'account-a');
    const args = { label: 'Synthetic managed marker' };
    const binding = bindingFor(currentActor, args);
    const firstStore = memoryStore();
    const first = await createManagedState(firstStore);

    const result = await first.mark(binding, args, currentActor);
    expect(result).toEqual({ confirmed: true, actionCount: 1, label: args.label, account: 'account-a' });
    expect(await first.mark(binding, args, currentActor)).toEqual(result);
    expect(await first.resolve(binding, currentActor)).toEqual(result);
    expect(await first.count(binding.installationId, currentActor)).toBe(1);
    expect(firstStore.casCalls).toBe(1);
    expect([...firstStore.entries.keys()]).toEqual(['source']);
    await expect(first.count('hasi.reference.other', currentActor)).rejects.toThrow('Invalid managed reference state');
    await expect(first.count(binding.installationId, actor('person-1', 'account-b'))).rejects.toThrow('Invalid managed reference state');
    await expect(first.count(binding.installationId, actor('person-2', 'account-a'))).rejects.toThrow('Invalid managed reference state');

    const otherPartition = await createManagedState(memoryStore());
    expect(await otherPartition.count(binding.installationId, currentActor)).toBe(0);
    expect(await otherPartition.mark(binding, args, currentActor)).toEqual(result);
  });

  it('retries a compare-and-set conflict and commits the counter with its receipt', async () => {
    const currentActor = actor('person-2', 'account-a');
    const args = { label: 'Concurrent managed marker' };
    const binding = bindingFor(currentActor, args);
    const store = memoryStore(undefined, 1);
    const state = await createManagedState(store);

    expect(await state.mark(binding, args, currentActor)).toEqual({
      confirmed: true,
      actionCount: 1,
      label: args.label,
      account: 'account-a',
    });
    expect(store.casCalls).toBe(2);
    expect(await state.count(binding.installationId, currentActor)).toBe(1);
  });

  it('rejects an execution identity rebound to different arguments, configuration, or account', async () => {
    const currentActor = actor('person-3', 'account-a');
    const args = { label: 'Original managed marker' };
    const binding = bindingFor(currentActor, args);
    const state = await createManagedState(memoryStore());
    const result = await state.mark(binding, args, currentActor);

    const changedArgs = { label: 'Rebound managed marker' };
    await expect(state.mark({ ...binding, argsHash: digest(changedArgs) }, changedArgs, currentActor)).rejects.toThrow('Reference source binding changed');
    await expect(state.resolve({ ...binding, configurationRevision: 2 }, currentActor)).rejects.toThrow('Reference source binding changed');
    await expect(state.resolve(binding, actor('person-3', 'account-b'))).rejects.toThrow('Invalid managed reference state');
    expect(await state.count(binding.installationId, currentActor)).toBe(result.actionCount);
  });

  it('rejects a receipt whose key does not bind its execution identity', async () => {
    const currentActor = actor('person-4', 'account-a');
    const args = { label: 'Forged managed marker' };
    const binding = bindingFor(currentActor, args);
    const store = memoryStore({
      version: 1,
      actionCount: 1,
      receipts: {
        ['0'.repeat(64)]: {
          binding,
          account: 'account-a',
          result: { confirmed: true, actionCount: 1, label: args.label, account: 'account-a' },
        },
      },
    });
    const state = await createManagedState(store);

    await expect(state.resolve(binding, currentActor)).rejects.toThrow('Invalid managed reference state');
    expect(store.casCalls).toBe(0);
  });

  it('rejects invalid current blobs and values above the 60 KiB bound', async () => {
    const currentActor = actor('person-5', 'account-a');
    const args = { label: 'Bounded managed marker' };
    const binding = bindingFor(currentActor, args);

    const invalidState = await createManagedState(memoryStore({ version: 2, actionCount: 0, receipts: {} }));
    await expect(invalidState.count(binding.installationId, currentActor)).rejects.toThrow('Invalid managed reference state');

    const oversizedState = await createManagedState(memoryStore({
      version: 1,
      actionCount: 0,
      receipts: {},
      padding: 'x'.repeat(60 * 1_024),
    }));
    await expect(oversizedState.count(binding.installationId, currentActor)).rejects.toThrow('Managed reference state is too large');
  });
});
