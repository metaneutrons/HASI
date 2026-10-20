import { randomUUID } from 'node:crypto';
import type { FencedReadResult, FencedJsonStore, StateFence } from './store.js';
import { cloneJsonValue, snapshotStateFences, validateExpiry, validateKey, validateNamespace } from './store.js';

interface MemoryEntry {
  readonly revision: string;
  readonly value: unknown;
  readonly expiresAt: number | null;
}

export interface MemoryJsonStoreOptions {
  /** Supplies the current time in milliseconds since the Unix epoch. */
  readonly clock?: () => number;
}

/** A process-local store. Each instance has its own namespace-scoped key space. */
export class MemoryJsonStore implements FencedJsonStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly clock: () => number;

  constructor(private readonly namespace: string, options: MemoryJsonStoreOptions = {}) {
    validateNamespace(namespace);
    this.clock = options.clock ?? Date.now;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async read(key: string): Promise<{ revision: string; value: unknown } | undefined> {
    validateKey(key);
    const entry = this.entries.get(this.qualifiedKey(key));
    if (entry === undefined || !this.isActive(entry, this.currentTime())) return undefined;
    return { revision: entry.revision, value: cloneJsonValue(entry.value) };
  }

  // No await occurs between validating the fences, checking them, and reading the target.
  // eslint-disable-next-line @typescript-eslint/require-await
  async readWithFence(key: string, fences: readonly StateFence[]): Promise<FencedReadResult> {
    validateKey(key);
    const fenceSnapshot = snapshotStateFences(key, fences);
    const now = this.currentTime();
    if (!this.fencesMatch(fenceSnapshot, now)) return { matched: false };

    const entry = this.entries.get(this.qualifiedKey(key));
    if (entry === undefined || !this.isActive(entry, now)) return { matched: true };
    return { matched: true, entry: { revision: entry.revision, value: cloneJsonValue(entry.value) } };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number): Promise<boolean> {
    validateKey(key);
    const expiration = validateExpiry(expiresAt);
    const storedValue = cloneJsonValue(value);
    const qualifiedKey = this.qualifiedKey(key);
    const current = this.entries.get(qualifiedKey);
    const now = this.currentTime();

    if (expectedRevision === null) {
      if (current !== undefined && this.isActive(current, now)) return false;
    } else if (current === undefined || !this.isActive(current, now) || current.revision !== expectedRevision) {
      return false;
    }

    this.entries.set(qualifiedKey, {
      revision: randomUUID(),
      value: storedValue,
      expiresAt: expiration,
    });
    return true;
  }

  // No await occurs between validating the fences, checking them, and changing the target.
  // eslint-disable-next-line @typescript-eslint/require-await
  async compareAndSetWithFence(
    key: string,
    expectedRevision: string | null,
    value: unknown,
    fences: readonly StateFence[],
    expiresAt?: number,
  ): Promise<boolean> {
    validateKey(key);
    const fenceSnapshot = snapshotStateFences(key, fences);
    const expiration = validateExpiry(expiresAt);
    const storedValue = cloneJsonValue(value);
    const qualifiedKey = this.qualifiedKey(key);
    const now = this.currentTime();
    if (!this.fencesMatch(fenceSnapshot, now)) return false;

    const current = this.entries.get(qualifiedKey);
    if (expectedRevision === null) {
      if (current !== undefined && this.isActive(current, now)) return false;
    } else if (current === undefined || !this.isActive(current, now) || current.revision !== expectedRevision) {
      return false;
    }

    this.entries.set(qualifiedKey, {
      revision: randomUUID(),
      value: storedValue,
      expiresAt: expiration,
    });
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    validateKey(key);
    this.entries.delete(this.qualifiedKey(key));
  }

  private qualifiedKey(key: string): string {
    return JSON.stringify([this.namespace, key]);
  }

  private currentTime(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) throw new RangeError('The memory store clock must return a finite timestamp');
    return now;
  }

  private isActive(entry: MemoryEntry, now: number): boolean {
    return entry.expiresAt === null || entry.expiresAt > now;
  }

  private fencesMatch(fences: readonly StateFence[], now: number): boolean {
    return fences.every((fence) => {
      const entry = this.entries.get(this.qualifiedKey(fence.key));
      return entry !== undefined && this.isActive(entry, now) && entry.revision === fence.revision;
    });
  }
}
