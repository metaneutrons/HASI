import { describe, expect, it } from 'vitest';
import {
  MemoryJsonStore,
  ModelBudgetError,
  ModelBudgetLedger,
  type JsonStore,
  type ModelBudgetLedgerOptions,
} from '../src/index.js';

const defaults: Omit<ModelBudgetLedgerOptions, 'now'> = {
  scope: 'preview:user-42:groq-demo',
  windowMs: 60_000,
  inputTokenLimit: 100,
  outputTokenLimit: 100,
  microUsdLimit: 1_000,
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
};

function ledger(
  store: JsonStore,
  now: () => number,
  overrides: Partial<ModelBudgetLedgerOptions> = {},
): ModelBudgetLedger {
  return new ModelBudgetLedger(store, { ...defaults, now, ...overrides });
}

async function expectCode(operation: Promise<unknown>, code: ModelBudgetError['code']): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: 'ModelBudgetError', code });
}

describe('ModelBudgetLedger', () => {
  it('requires explicit bootstrap in deployment mode and denies a deleted record after restart', async () => {
    const memory = new MemoryJsonStore('explicit-budget');
    let recordedKey = '';
    const store: JsonStore = {
      read: key => memory.read(key),
      compareAndSet: (key, revision, value, expiresAt) => { recordedKey = key; return memory.compareAndSet(key, revision, value, expiresAt); },
      delete: key => memory.delete(key),
    };
    const options = { ...defaults, requireExistingState: true, now: () => 0 };
    const first = new ModelBudgetLedger(store, options);
    await expectCode(first.reserve({ id: 'denied', inputTokens: 1, outputTokens: 1 }), 'unavailable');
    await first.initialize();
    await first.reserve({ id: 'admitted', inputTokens: 10, outputTokens: 10 });
    await first.initialize();
    expect((await first.snapshot()).inputTokensUsed).toBe(10);
    await store.delete(recordedKey);
    const restarted = new ModelBudgetLedger(store, options);
    await expectCode(restarted.reserve({ id: 'no-reset', inputTokens: 1, outputTokens: 1 }), 'unavailable');
  });
  it('serializes concurrent reservations across ledger instances and rejects over-budget attempts', async () => {
    const store = new MemoryJsonStore('concurrent-budget');
    const now = () => 120_000;
    const options = { ...defaults, inputTokenLimit: 50, outputTokenLimit: 50, microUsdLimit: 100 };
    const ledgers = Array.from({ length: 10 }, () => new ModelBudgetLedger(store, { ...options, now }));

    const results = await Promise.allSettled(ledgers.map((instance, index) => instance.reserve({
      id: `request-${String(index)}`,
      inputTokens: 10,
      outputTokens: 0,
    })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected'
      && result.reason instanceof ModelBudgetError
      && result.reason.code === 'exhausted')).toHaveLength(5);
    const snapshot = await ledgers[0]!.snapshot();
    expect(snapshot).toMatchObject({ inputTokensUsed: 50, outputTokensUsed: 0, microUsdUsed: 50 });
  });

  it('rejects duplicate reservations without freeing capacity and holds missing usage at the full bound', async () => {
    const store = new MemoryJsonStore('duplicate-budget');
    const instance = ledger(store, () => 0, { inputTokenLimit: 20, outputTokenLimit: 20, microUsdLimit: 20 });
    await instance.reserve({ id: 'opaque-call-a', inputTokens: 10, outputTokens: 0 });
    const before = await instance.snapshot();

    await expectCode(instance.reserve({ id: 'opaque-call-a', inputTokens: 1, outputTokens: 0 }), 'conflict');
    await instance.settle('opaque-call-a');
    await expectCode(instance.release('opaque-call-a'), 'conflict');
    await expectCode(instance.reserve({ id: 'opaque-call-b', inputTokens: 11, outputTokens: 0 }), 'exhausted');

    expect(await instance.snapshot()).toMatchObject({
      inputTokensUsed: before.inputTokensUsed,
      outputTokensUsed: before.outputTokensUsed,
      microUsdUsed: before.microUsdUsed,
      unresolvedReservations: 1,
      unknownUsageReservations: 1,
    });
  });

  it('settles verified usage idempotently, reconciles an unknown hold, and rejects conflicting usage', async () => {
    const instance = ledger(new MemoryJsonStore('settlement-budget'), () => 0);
    await instance.reserve({ id: 'call-with-usage', inputTokens: 40, outputTokens: 30 });
    await instance.settle('call-with-usage');
    expect(await instance.snapshot()).toMatchObject({
      inputTokensUsed: 40,
      outputTokensUsed: 30,
      microUsdUsed: 70,
      unknownUsageReservations: 1,
    });

    await instance.settle('call-with-usage', { inputTokens: 20, outputTokens: 10 });
    await instance.settle('call-with-usage', { inputTokens: 20, outputTokens: 10 });
    await expectCode(instance.settle('call-with-usage', { inputTokens: 21, outputTokens: 10 }), 'conflict');
    expect(await instance.snapshot()).toMatchObject({
      inputTokensUsed: 20,
      outputTokensUsed: 10,
      microUsdUsed: 30,
      unresolvedReservations: 0,
      unknownUsageReservations: 0,
    });
  });

  it('rejects zero/zero settled usage without refunding the reservation', async () => {
    const instance = ledger(new MemoryJsonStore('zero-usage-budget'), () => 0);
    await instance.reserve({ id: 'zero-usage', inputTokens: 40, outputTokens: 30 });

    await expectCode(instance.settle('zero-usage', { inputTokens: 0, outputTokens: 0 }), 'invalid');

    expect(await instance.snapshot()).toMatchObject({
      inputTokensUsed: 40,
      outputTokensUsed: 30,
      microUsdUsed: 70,
      unresolvedReservations: 1,
    });
  });

  // Exhaustive 2,048-window accounting is a functional bound check, not a latency benchmark.
  it('archives older unresolved holds while retaining recent prior-window IDs for reconciliation', async () => {
    let now = 0;
    const instance = ledger(new MemoryJsonStore('archived-unknown-budget'), () => now, {
      windowMs: 1_000,
      inputTokenLimit: 100,
      outputTokenLimit: 100,
      microUsdLimit: 1_000_000,
      inputMicroUsdPerMillion: 1,
      outputMicroUsdPerMillion: 1,
    });

    for (let index = 0; index < 2_048; index += 1) {
      const id = `unknown-${String(index)}`;
      await instance.reserve({ id, inputTokens: 1, outputTokens: 1 });
      await instance.settle(id);
      now += 1_000;
    }

    await instance.reserve({ id: 'new-window-call', inputTokens: 1, outputTokens: 1 });
    expect(await instance.snapshot()).toMatchObject({
      windowStart: 2_048_000,
      inputTokensUsed: 1,
      outputTokensUsed: 1,
      microUsdUsed: 2,
      unresolvedReservations: 513,
      unknownUsageReservations: 512,
      archivedUnknown: {
        reservations: 1_536,
        inputTokens: 1_536,
        outputTokens: 1_536,
        microUsd: 3_072,
      },
    });
  }, 60_000);

  it('allows a late settlement to protect its prior-window ID while archiving other excess holds', async () => {
    let now = 0;
    const instance = ledger(new MemoryJsonStore('protected-late-settlement'), () => now, {
      windowMs: 1_000,
      inputTokenLimit: 1_000,
      outputTokenLimit: 1_000,
      microUsdLimit: 1_000_000,
      inputMicroUsdPerMillion: 1,
      outputMicroUsdPerMillion: 1,
    });
    for (let index = 0; index < 513; index += 1) {
      const id = `late-${String(index)}`;
      await instance.reserve({ id, inputTokens: 1, outputTokens: 1 });
      await instance.settle(id);
    }

    now = 1_000;
    await instance.settle('late-0', { inputTokens: 1, outputTokens: 0 });

    expect(await instance.snapshot()).toMatchObject({
      windowStart: 1_000,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      microUsdUsed: 0,
      unresolvedReservations: 511,
      unknownUsageReservations: 511,
      archivedUnknown: { reservations: 1, inputTokens: 1, outputTokens: 1, microUsd: 2 },
    });
  });

  it('reads existing v1 records without archived-unknown fields', async () => {
    const backing = new MemoryJsonStore('legacy-v1-budget');
    const legacyStore: JsonStore = {
      read: key => backing.read(key),
      compareAndSet: (key, revision, value, expiresAt) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new TypeError('Expected an object ledger state');
        }
        const legacyValue = { ...value } as Record<string, unknown>;
        delete legacyValue.archivedUnknown;
        return backing.compareAndSet(key, revision, legacyValue, expiresAt);
      },
      delete: key => backing.delete(key),
    };
    const instance = ledger(legacyStore, () => 0);
    await instance.initialize();

    expect(await instance.snapshot()).toMatchObject({
      initialized: true,
      archivedUnknown: { reservations: 0, inputTokens: 0, outputTokens: 0, microUsd: 0 },
    });
  });

  it('keeps unresolved IDs across window rollover and settles their old window without charging the new one', async () => {
    const store = new MemoryJsonStore('window-budget');
    let now = 10_000;
    const instance = ledger(store, () => now, { windowMs: 10_000 });
    await instance.reserve({ id: 'uncertain-call', inputTokens: 20, outputTokens: 10 });
    await instance.settle('uncertain-call');

    now = 20_000;
    expect(await instance.snapshot()).toMatchObject({
      windowStart: 20_000,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      microUsdUsed: 0,
      initialized: true,
      unresolvedReservations: 1,
      unknownUsageReservations: 1,
    });
    await expectCode(instance.reserve({ id: 'uncertain-call', inputTokens: 1, outputTokens: 0 }), 'conflict');
    await instance.reserve({ id: 'new-window-call', inputTokens: 10, outputTokens: 5 });
    await instance.settle('uncertain-call', { inputTokens: 12, outputTokens: 4 });

    expect(await instance.snapshot()).toMatchObject({
      windowStart: 20_000,
      inputTokensUsed: 10,
      outputTokensUsed: 5,
      microUsdUsed: 15,
      unresolvedReservations: 1,
    });
    now = 19_999;
    await expectCode(instance.snapshot(), 'conflict');
  });

  it('releases a known pre-provider cancellation and keeps released IDs reserved against reuse', async () => {
    const instance = ledger(new MemoryJsonStore('release-budget'), () => 0, {
      inputTokenLimit: 10,
      outputTokenLimit: 10,
      microUsdLimit: 10,
    });
    await instance.reserve({ id: 'cancelled-call', inputTokens: 10, outputTokens: 0 });
    await instance.release('cancelled-call');
    await instance.release('cancelled-call');
    await expectCode(instance.reserve({ id: 'cancelled-call', inputTokens: 1, outputTokens: 0 }), 'conflict');
    expect(await instance.snapshot()).toMatchObject({ inputTokensUsed: 0, microUsdUsed: 0 });
    await instance.reserve({ id: 'replacement-call', inputTokens: 10, outputTokens: 0 });
  });

  it('rounds estimated micro-USD charges upward and binds persisted state to the full policy', async () => {
    const store = new MemoryJsonStore('policy-budget');
    const instance = ledger(store, () => 0, {
      microUsdLimit: 2,
      inputMicroUsdPerMillion: 1,
      outputMicroUsdPerMillion: 1,
    });
    await instance.reserve({ id: 'round-up', inputTokens: 1, outputTokens: 1 });
    expect(await instance.snapshot()).toMatchObject({ microUsdUsed: 2 });

    const changedPolicy = ledger(store, () => 0, { inputMicroUsdPerMillion: 2 });
    await expectCode(changedPolicy.snapshot(), 'conflict');
  });

  it('rejects invalid policies, token counts, usage and backwards-moving clocks', async () => {
    const store = new MemoryJsonStore('invalid-budget');
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_001]) {
      expect(() => new ModelBudgetLedger(store, { ...defaults, inputTokenLimit: invalid })).toThrow(
        expect.objectContaining({ name: 'ModelBudgetError', code: 'invalid' }),
      );
    }

    let now = 0;
    const instance = ledger(store, () => now);
    await expectCode(instance.reserve({ id: 'bad-count', inputTokens: Number.NaN, outputTokens: 0 }), 'invalid');
    await expectCode(instance.reserve({ id: 'empty-reservation', inputTokens: 0, outputTokens: 0 }), 'invalid');
    await instance.reserve({ id: 'clock-check', inputTokens: 1, outputTokens: 0 });
    now = defaults.windowMs;
    await instance.reserve({ id: 'next-window', inputTokens: 1, outputTokens: 0 });
    now = defaults.windowMs - 1;
    await expectCode(instance.snapshot(), 'conflict');
  });

  it('fails closed when durable state disappears or the store is unavailable', async () => {
    const backing = new MemoryJsonStore('missing-budget');
    let hidden = false;
    const store: JsonStore = {
      read: async (key) => hidden ? undefined : backing.read(key),
      compareAndSet: (key, revision, value, expiresAt) => backing.compareAndSet(key, revision, value, expiresAt),
      delete: (key) => backing.delete(key),
    };
    const instance = ledger(store, () => 0);
    await instance.reserve({ id: 'first-call', inputTokens: 1, outputTokens: 0 });
    hidden = true;
    await expectCode(instance.reserve({ id: 'second-call', inputTokens: 1, outputTokens: 0 }), 'unavailable');

    const failingStore: JsonStore = {
      read: () => Promise.reject(new Error('private database detail')),
      compareAndSet: () => Promise.reject(new Error('private database detail')),
      delete: () => Promise.reject(new Error('private database detail')),
    };
    const unavailable = ledger(failingStore, () => 0);
    const failure = await unavailable.reserve({ id: 'opaque', inputTokens: 1, outputTokens: 0 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'ModelBudgetError', code: 'unavailable' });
    expect((failure as Error).message).not.toContain('private database detail');

    const failingCasStore: JsonStore = {
      read: () => Promise.resolve(undefined),
      compareAndSet: () => Promise.reject(new Error('private database detail')),
      delete: () => Promise.resolve(),
    };
    await expectCode(ledger(failingCasStore, () => 0).reserve({
      id: 'opaque-cas',
      inputTokens: 1,
      outputTokens: 0,
    }), 'unavailable');
  });
});
