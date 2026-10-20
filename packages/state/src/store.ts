export interface JsonStore {
  read(key: string): Promise<{ revision: string; value: unknown } | undefined>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface StateFence {
  readonly key: string;
  readonly revision: string;
}

export type FencedReadResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly entry?: { readonly revision: string; readonly value: unknown } };

/** Atomic consistency primitive, not authentication. Trusted callers derive fences
 * from verified authority; plugin or client input must not choose these keys. */
export interface FencedJsonStore extends JsonStore {
  readWithFence(key: string, fences: readonly StateFence[]): Promise<FencedReadResult>;
  compareAndSetWithFence(
    key: string,
    expectedRevision: string | null,
    value: unknown,
    fences: readonly StateFence[],
    expiresAt?: number,
  ): Promise<boolean>;
}

export function validateNamespace(namespace: string): void {
  validateIdentifier(namespace, 'namespace');
}

export function validateKey(key: string): void {
  validateIdentifier(key, 'key');
}

function validateIdentifier(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new RangeError(`${label} must contain between 1 and 256 characters and no NUL character`);
  }
}

export function cloneJsonValue<T = unknown>(value: T): T {
  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined) {
    throw new TypeError('State values must be JSON serializable');
  }
  return JSON.parse(serialized) as T;
}

export function validateExpiry(expiresAt: number | undefined): number | null {
  if (expiresAt === undefined) return null;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())) {
    throw new RangeError('expiresAt must be a finite millisecond timestamp');
  }
  return expiresAt;
}

export function isUuidRevision(revision: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revision);
}

/** Validates and copies caller-owned fence data before any asynchronous work. */
export function snapshotStateFences(targetKey: string, fences: readonly StateFence[]): StateFence[] {
  if (!Array.isArray(fences) || fences.length < 1 || fences.length > 16) {
    throw new RangeError('fences must be an array containing between 1 and 16 entries');
  }

  const seenKeys = new Set<string>();
  const snapshot: StateFence[] = [];
  for (let index = 0; index < fences.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(fences, index)) {
      throw new TypeError('fences must not contain sparse entries');
    }
    const candidate: unknown = fences[index];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError('each fence must contain exactly key and revision fields');
    }

    const fields = Reflect.ownKeys(candidate);
    if (fields.length !== 2 || !fields.includes('key') || !fields.includes('revision')) {
      throw new TypeError('each fence must contain exactly key and revision fields');
    }

    const fence = candidate as { readonly key: unknown; readonly revision: unknown };
    const key = fence.key;
    const revision = fence.revision;
    validateKey(key as string);
    if (key === targetKey) throw new RangeError('a fence key must differ from the target key');
    if (seenKeys.has(key as string)) throw new RangeError('fence keys must be distinct');
    if (typeof revision !== 'string' || !isUuidRevision(revision)) {
      throw new RangeError('each fence revision must be a UUID');
    }

    seenKeys.add(key as string);
    snapshot.push({ key: key as string, revision: revision.toLowerCase() });
  }
  return snapshot;
}
