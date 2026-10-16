import { describe, expect, it, vi } from 'vitest';
import {
  MemoryJsonStore,
  StateConflictError,
  updateJson,
  type JsonStore,
} from '../src/index.js';

describe('MemoryJsonStore', () => {
  it('allows only one of two competing compare-and-set operations to win', async () => {
    const store = new MemoryJsonStore('compare-and-set');
    expect(await store.compareAndSet('key', null, { count: 0 })).toBe(true);
    const original = await store.read('key');
    expect(original).toBeDefined();

    const attempts = await Promise.all([
      store.compareAndSet('key', original!.revision, { count: 1 }),
      store.compareAndSet('key', original!.revision, { count: 2 }),
    ]);

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await store.compareAndSet('key', original!.revision, { count: 3 })).toBe(false);
  });

  it('replaces expired entries and assigns a revision that cannot reuse the old token', async () => {
    let now = 1_000;
    const store = new MemoryJsonStore('expiry', { clock: () => now });
    expect(await store.compareAndSet('key', null, { value: 'same' }, now + 10)).toBe(true);
    const original = await store.read('key');
    expect(original).toBeDefined();

    now += 10;
    expect(await store.read('key')).toBeUndefined();
    expect(await store.compareAndSet('key', null, { value: 'same' })).toBe(true);
    const replacement = await store.read('key');

    expect(replacement?.revision).not.toBe(original!.revision);
    expect(await store.compareAndSet('key', original!.revision, { value: 'stale' })).toBe(false);
  });

  it('clones values when committing and reading', async () => {
    const store = new MemoryJsonStore('cloning');
    const submitted = { nested: { count: 1 } };
    expect(await store.compareAndSet('key', null, submitted)).toBe(true);
    submitted.nested.count = 2;

    const firstRead = await store.read('key');
    expect(firstRead?.value).toEqual({ nested: { count: 1 } });
    (firstRead?.value as { nested: { count: number } }).nested.count = 3;
    expect(await store.read('key')).toMatchObject({ value: { nested: { count: 1 } } });
  });

  it('keeps equal keys isolated between namespaces', async () => {
    const students = new MemoryJsonStore('students');
    const staff = new MemoryJsonStore('staff');

    expect(await students.compareAndSet('profile', null, { role: 'student' })).toBe(true);
    expect(await staff.compareAndSet('profile', null, { role: 'staff' })).toBe(true);
    expect((await students.read('profile'))?.value).toEqual({ role: 'student' });
    expect((await staff.read('profile'))?.value).toEqual({ role: 'staff' });
  });

  it('serializes concurrent increments with updateJson retries', async () => {
    const store = new MemoryJsonStore('counter');
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => updateJson(
      store,
      'counter',
      () => ({ count: 0 }),
      (current: { count: number }) => ({ value: { count: current.count + 1 }, result: index }),
    )));

    expect(new Set(results)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect((await store.read('counter'))?.value).toEqual({ count: 8 });
  });

  it('throws StateConflictError after twelve unsuccessful attempts', async () => {
    const compareAndSet = vi.fn(() => Promise.resolve(false));
    const read = vi.fn(() => Promise.resolve(undefined));
    const store: JsonStore = { read, compareAndSet, delete: () => Promise.resolve() };

    await expect(updateJson(store, 'key', () => 0, (count: number) => ({ value: count + 1, result: count })))
      .rejects.toBeInstanceOf(StateConflictError);
    expect(read).toHaveBeenCalledTimes(12);
    expect(compareAndSet).toHaveBeenCalledTimes(12);
  });

  it('validates namespaces, keys, and expiration timestamps', async () => {
    expect(() => new MemoryJsonStore('')).toThrow(RangeError);
    expect(() => new MemoryJsonStore('x'.repeat(257))).toThrow(RangeError);

    const store = new MemoryJsonStore('validation');
    await expect(store.read('')).rejects.toThrow(RangeError);
    await expect(store.read('x'.repeat(257))).rejects.toThrow(RangeError);
    await expect(store.compareAndSet('key', null, {}, Number.NaN)).rejects.toThrow(RangeError);
  });
});
