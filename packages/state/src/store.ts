export interface JsonStore {
  read(key: string): Promise<{ revision: string; value: unknown } | undefined>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number): Promise<boolean>;
  delete(key: string): Promise<void>;
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
