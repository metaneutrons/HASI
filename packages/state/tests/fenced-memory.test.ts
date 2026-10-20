import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore, type StateFence } from '../src/index.js';

describe('MemoryJsonStore fenced operations', () => {
  it('reads and updates a target only while every fence revision is current', async () => {
    const store = new MemoryJsonStore('fenced-positive');
    expect(await store.compareAndSet('route', null, { destination: 'v1' })).toBe(true);
    expect(await store.compareAndSet('config', null, { enabled: true })).toBe(true);
    const route = await store.read('route');
    const config = await store.read('config');
    const fences = [
      { key: 'route', revision: route!.revision },
      { key: 'config', revision: config!.revision.toUpperCase() },
    ];

    expect(await store.readWithFence('target', fences)).toEqual({ matched: true });
    expect(await store.compareAndSetWithFence('target', null, { value: 1 }, fences)).toBe(true);
    const target = await store.read('target');
    expect(await store.readWithFence('target', fences)).toEqual({
      matched: true,
      entry: target,
    });
    expect(await store.compareAndSetWithFence('target', target!.revision, { value: 2 }, fences)).toBe(true);
    expect((await store.read('target'))?.value).toEqual({ value: 2 });
  });

  it('rejects stale, missing, and expired fences without exposing or changing target state', async () => {
    let now = 10_000;
    const store = new MemoryJsonStore('fenced-invalidated', { clock: () => now });
    await store.compareAndSet('route', null, { version: 1 });
    await store.compareAndSet('config', null, { version: 1 }, now + 5);
    await store.compareAndSet('target', null, { protected: true });
    const route = await store.read('route');
    const config = await store.read('config');
    const fences: StateFence[] = [
      { key: 'route', revision: route!.revision },
      { key: 'config', revision: config!.revision },
    ];
    const target = await store.read('target');

    await store.compareAndSet('route', route!.revision, { version: 2 });
    expect(await store.readWithFence('target', fences)).toEqual({ matched: false });
    expect(await store.compareAndSetWithFence('target', target!.revision, { protected: false }, fences)).toBe(false);
    expect((await store.read('target'))?.value).toEqual({ protected: true });

    const currentRoute = await store.read('route');
    const staleConfigFence = [{ key: 'config', revision: config!.revision }];
    await store.delete('config');
    expect(await store.readWithFence('target', staleConfigFence)).toEqual({ matched: false });
    expect(await store.compareAndSetWithFence('target', target!.revision, {}, staleConfigFence)).toBe(false);

    await store.compareAndSet('config', null, { version: 2 }, now + 5);
    const expiringConfig = await store.read('config');
    const expiringFence = [{ key: 'config', revision: expiringConfig!.revision }];
    now += 5;
    expect(await store.readWithFence('target', expiringFence)).toEqual({ matched: false });
    expect(await store.compareAndSetWithFence('target', target!.revision, {}, expiringFence)).toBe(false);
    expect((await store.read('route'))?.revision).toBe(currentRoute?.revision);
    expect((await store.read('target'))?.value).toEqual({ protected: true });
  });

  it('reports a missing target as a matched fence with no entry', async () => {
    const store = new MemoryJsonStore('fenced-missing-target');
    await store.compareAndSet('config', null, { active: true });
    const config = await store.read('config');

    const result = await store.readWithFence('target', [{ key: 'config', revision: config!.revision }]);
    expect(result).toEqual({ matched: true });
    expect(result).not.toHaveProperty('entry');
  });

  it('allows only one competing fenced CAS to create a missing target', async () => {
    const store = new MemoryJsonStore('fenced-race');
    await store.compareAndSet('config', null, { generation: 1 });
    const config = await store.read('config');
    const fences = [{ key: 'config', revision: config!.revision }];

    const outcomes = await Promise.all([
      store.compareAndSetWithFence('target', null, { winner: 'a' }, fences),
      store.compareAndSetWithFence('target', null, { winner: 'b' }, fences),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = (await store.read('target'))?.value as { winner: string } | undefined;
    expect(winner?.winner).toMatch(/^(a|b)$/);
  });

  it('rejects malformed fence collections and entries', async () => {
    const store = new MemoryJsonStore('fenced-validation');
    const valid = { key: 'config', revision: randomUUID() };
    const invalidCases = [
      [],
      Array.from({ length: 17 }, (_, index) => ({ key: `key-${String(index)}`, revision: randomUUID() })),
      [{ key: 'config', revision: 'not-a-uuid' }],
      [{ key: 'config', revision: randomUUID(), extra: true }],
      [valid, { ...valid }],
      [{ key: 'target', revision: randomUUID() }],
      [undefined],
    ];

    for (const fences of invalidCases) {
      await expect(store.readWithFence('target', fences as StateFence[])).rejects.toThrow();
      await expect(store.compareAndSetWithFence('target', null, {}, fences as StateFence[])).rejects.toThrow();
    }
    await expect(store.readWithFence('target', null as unknown as StateFence[])).rejects.toThrow();
  });

  it('copies fence and JSON input before returning an asynchronous result', async () => {
    const store = new MemoryJsonStore('fenced-copy');
    await store.compareAndSet('config', null, { mode: 'safe' });
    const config = await store.read('config');
    const fences = [{ key: 'config', revision: config!.revision }];
    const submitted = { nested: { count: 1 } };
    const pending = store.compareAndSetWithFence('target', null, submitted, fences);

    fences[0]!.revision = randomUUID();
    submitted.nested.count = 2;
    expect(await pending).toBe(true);
    expect((await store.read('target'))?.value).toEqual({ nested: { count: 1 } });

    const firstRead = await store.readWithFence('target', [{ key: 'config', revision: config!.revision }]);
    (firstRead as { entry?: { value: { nested: { count: number } } } }).entry!.value.nested.count = 3;
    const secondRead = await store.readWithFence('target', [{ key: 'config', revision: config!.revision }]);
    expect(secondRead).toMatchObject({ entry: { value: { nested: { count: 1 } } } });
  });
});
