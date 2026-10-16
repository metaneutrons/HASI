import { createHash } from 'node:crypto';

function quote(value: string): string {
  return JSON.stringify(value);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Non-finite numbers are not JSON serializable');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Circular values are not JSON serializable');
    }
    ancestors.add(value);
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError('Sparse arrays are not JSON serializable');
      }
      items.push(encode(value[index], ancestors));
    }
    const encoded = `[${items.join(',')}]`;
    ancestors.delete(value);
    return encoded;
  }

  if (typeof value !== 'object') {
    throw new TypeError('Value is not JSON serializable');
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Only plain JSON objects are supported');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Symbol properties are not JSON serializable');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Circular values are not JSON serializable');
  }

  ancestors.add(value);
  const fields = Object.keys(value)
    .sort()
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('Accessor properties are not JSON serializable');
      }
      return `${quote(key)}:${encode(descriptor.value, ancestors)}`;
    });
  ancestors.delete(value);
  return `{${fields.join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function parseJsonRecord(value: unknown, name = 'value'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }

  const encoded = canonicalJson(value);
  const parsed: unknown = JSON.parse(encoded);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
