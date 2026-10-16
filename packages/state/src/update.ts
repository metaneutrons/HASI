import type { JsonStore } from './store.js';

export class StateConflictError extends Error {
  constructor() {
    super('Unable to update JSON state after 12 attempts');
    this.name = 'StateConflictError';
  }
}

/**
 * Applies a pure update function with bounded optimistic retries. The callback
 * may run more than once after a conflict and must not perform external effects.
 */
export async function updateJson<T, R>(
  store: JsonStore,
  key: string,
  initial: () => T,
  update: (current: T) => { value: T; result: R },
  expiresAt?: number,
): Promise<R> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await store.read(key);
    const next = update(current === undefined ? initial() : current.value as T);
    const committed = await store.compareAndSet(key, current?.revision ?? null, next.value, expiresAt);
    if (committed) return next.result;
  }
  throw new StateConflictError();
}
