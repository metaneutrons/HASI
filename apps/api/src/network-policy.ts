import { lookup as defaultLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInfo as UndiciRequestInfo, type RequestInit as UndiciRequestInit } from 'undici';

const MAX_DNS_ADDRESSES = 64;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 5_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

type IpFamily = 'ipv4' | 'ipv6';

interface Cidr {
  address: string;
  family: IpFamily;
  prefix: number;
}

export class PluginNetworkError extends Error {
  constructor(message = 'Plugin network request was rejected.') {
    super(message);
    this.name = 'PluginNetworkError';
  }
}

export interface PluginFetchOptions {
  /** Exact, operator-configured origins. Paths, query strings and fragments are not accepted. */
  origins: readonly string[];
  /** Permit HTTP and DNS-resolved loopback addresses for explicitly configured loopback hosts. */
  allowLoopback?: boolean;
  /** Operator-approved non-public destination ranges, in CIDR notation. */
  allowedPrivateCidrs?: readonly string[];
  /** Injectable Node lookup used by the connector itself, not a preflight lookup. */
  lookup?: LookupFunction;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  maxResponseBytes?: number;
}

export type PluginFetch = typeof fetch & { close(): Promise<void> };

const IPV4_LOOPBACK = blockList([['127.0.0.0', 8, 'ipv4']]);
const IPV4_PROTECTED_RANGES = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['255.255.255.255', 32, 'ipv4'],
] as const;
const IPV4_PROTECTED = blockList(IPV4_PROTECTED_RANGES);
const IPV6_LOOPBACK = blockList([['::1', 128, 'ipv6']]);
const IPV6_GLOBAL_UNICAST = blockList([['2000::', 3, 'ipv6']]);
const IPV6_PROTECTED_RANGES = [
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'],
] as const;
const IPV6_PROTECTED = blockList(IPV6_PROTECTED_RANGES);
const IPV6_TRANSLATION = blockList([
  ['::ffff:0:0', 96, 'ipv6'],
  ['::ffff:0:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
]);

function blockList(ranges: readonly (readonly [string, number, IpFamily])[]): BlockList {
  const list = new BlockList();
  for (const [address, prefix, family] of ranges) list.addSubnet(address, prefix, family);
  return list;
}

function familyName(family: number): IpFamily | undefined {
  if (family === 4) return 'ipv4';
  if (family === 6) return 'ipv6';
  return undefined;
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHost(hostname: string): boolean {
  const host = unbracket(hostname).toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  const family = isIP(host);
  if (family === 4) return IPV4_LOOPBACK.check(host, 'ipv4');
  if (family === 6) return IPV6_LOOPBACK.check(host, 'ipv6');
  return false;
}

function parseCidr(value: string): Cidr {
  const slash = value.lastIndexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new TypeError('Invalid approved network range.');
  const address = value.slice(0, slash);
  const familyNumber = isIP(address);
  const family = familyName(familyNumber);
  const prefix = Number(value.slice(slash + 1));
  const maxPrefix = family === 'ipv4' ? 32 : 128;
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix || address.includes('%')) {
    throw new TypeError('Invalid approved network range.');
  }
  return { address, family, prefix };
}

function isProtectedOperatorRange(cidr: Cidr): boolean {
  if (cidr.family === 'ipv4') {
    return IPV4_PROTECTED_RANGES.some(([address, prefix]) => {
      if (cidr.prefix < prefix) return false;
      const scope = blockList([[address, prefix, 'ipv4']]);
      return scope.check(cidr.address, 'ipv4');
    });
  }
  // Public IPv6 is allocated from 2000::/3. Prefixes shorter than /4 can cross
  // that boundary, so reject them rather than allowing a wide-range exception.
  if (cidr.prefix >= 4 && !IPV6_GLOBAL_UNICAST.check(cidr.address, 'ipv6')) return true;
  return IPV6_PROTECTED_RANGES.some(([address, prefix]) => {
    if (cidr.prefix < prefix) return false;
    const scope = blockList([[address, prefix, 'ipv6']]);
    return scope.check(cidr.address, 'ipv6');
  });
}

function checkApproved(address: string, family: IpFamily, approved: BlockList): boolean {
  return approved.check(address, family);
}

function buildApprovedCidrs(values: readonly string[]): { ipv4: BlockList; ipv6: BlockList } {
  const approved = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const value of values) {
    const cidr = parseCidr(value);
    if (!isProtectedOperatorRange(cidr)) throw new TypeError('Approved ranges must be non-public network ranges.');
    approved[cidr.family].addSubnet(cidr.address, cidr.prefix, cidr.family);
  }
  return approved;
}

function addressAllowed(
  address: string,
  reportedFamily: number,
  hostname: string,
  allowLoopback: boolean,
  approved: { ipv4: BlockList; ipv6: BlockList },
): boolean {
  const actualFamily = isIP(address);
  if (actualFamily === 0 || actualFamily !== reportedFamily || address.includes('%')) return false;
  const family = familyName(actualFamily);
  if (!family) return false;

  if (family === 'ipv4') {
    if (checkApproved(address, family, approved.ipv4)) return true;
    if (IPV4_LOOPBACK.check(address, family)) return allowLoopback && isLoopbackHost(hostname);
    return !IPV4_PROTECTED.check(address, family);
  }

  // These ranges can carry an IPv4 destination inside an IPv6 address. Never
  // treat them as ordinary global IPv6, even if an adjacent range is approved.
  if (IPV6_TRANSLATION.check(address, family)) return false;
  if (checkApproved(address, family, approved.ipv6)) return true;
  if (IPV6_LOOPBACK.check(address, family)) return allowLoopback && isLoopbackHost(hostname);
  return IPV6_GLOBAL_UNICAST.check(address, family) && !IPV6_PROTECTED.check(address, family);
}

function safeError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

function boundedLookup(
  resolver: LookupFunction,
  allowLoopback: boolean,
  approved: { ipv4: BlockList; ipv6: BlockList },
): LookupFunction {
  return (hostname, options, callback) => {
    let called = false;
    const finish = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[] = '', family?: number) => {
      if (called) return;
      called = true;
      callback(error, address, family);
    };

    try {
      // Resolve every address at the socket's own lookup hook and verify the
      // full answer set before returning any address to net/tls.
      resolver(hostname, { ...options, all: true }, (error, result, family) => {
        if (error) {
          finish(safeError('Plugin destination could not be resolved.'));
          return;
        }
        const records: LookupAddress[] = Array.isArray(result)
          ? result
          : typeof result === 'string' && family !== undefined
            ? [{ address: result, family }]
            : [];
        if (records.length === 0 || records.length > MAX_DNS_ADDRESSES) {
          finish(safeError('Plugin destination could not be resolved.'));
          return;
        }
        if (!records.every(record => addressAllowed(record.address, record.family, hostname, allowLoopback, approved))) {
          finish(safeError('Plugin destination is not permitted.'));
          return;
        }
        if (options.all) finish(null, records);
        else {
          const selected = records.find(record => !options.family || options.family === 0 || options.family === record.family);
          if (!selected) finish(safeError('Plugin destination could not be resolved.'));
          else finish(null, selected.address, selected.family);
        }
      });
    } catch {
      finish(safeError('Plugin destination could not be resolved.'));
    }
  };
}

function validateTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new TypeError('Network timeouts must be between 1 and 60000 milliseconds.');
  return timeout;
}

function validateResponseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESPONSE_BYTES) throw new TypeError('Response limit must be between 1 byte and 100 MiB.');
  return limit;
}

function configuredOrigins(values: readonly string[], allowLoopback: boolean, approved: { ipv4: BlockList; ipv6: BlockList }): Set<string> {
  if (values.length === 0) throw new TypeError('At least one plugin origin must be configured.');
  const origins = new Set<string>();
  for (const value of values) {
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError('Invalid plugin origin.'); }
    const host = unbracket(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.includes('?') || value.includes('#')) {
      throw new TypeError('Plugin origins must be bare origins without credentials, paths, queries, or fragments.');
    }
    const loopbackHost = isLoopbackHost(host);
    if (loopbackHost && !allowLoopback) throw new TypeError('Loopback plugin origins must be explicitly enabled.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback && loopbackHost)) {
      throw new TypeError('Plugin origins must use HTTPS; HTTP is limited to explicitly enabled loopback origins.');
    }
    const family = isIP(host);
    if (family && !addressAllowed(host, family, host, allowLoopback, approved)) throw new TypeError('Plugin origin address is not permitted.');
    if (url.protocol === 'http:' && !loopbackHost) throw new TypeError('HTTP is limited to loopback plugin origins.');
    origins.add(url.origin);
  }
  return origins;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
    return new URL(raw.toString());
  } catch {
    throw new PluginNetworkError('Plugin request URL is invalid.');
  }
}

function withResponseLimit(response: Response, maxBytes: number): Response {
  const body = response.body;
  if (!body) return response;
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    void body.cancel().catch(() => undefined);
    throw new PluginNetworkError('Plugin response exceeded the configured size limit.');
  }

  let received = 0;
  const limited = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) throw new PluginNetworkError('Plugin response exceeded the configured size limit.');
      controller.enqueue(chunk);
    },
  }));
  const wrapped = new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
}

function containsPolicyError(value: unknown): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof PluginNetworkError || current.message.startsWith('Plugin destination ')) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Creates an origin-restricted fetch. The Undici connector runs the wrapped
 * lookup at connection time, returns only the verified addresses, retains
 * normal TLS hostname verification, and never follows redirects.
 */
export function createPluginFetch(options: PluginFetchOptions): PluginFetch {
  const allowLoopback = options.allowLoopback ?? false;
  if (allowLoopback && process.env.NODE_ENV === 'production') throw new TypeError('Loopback plugin access is unavailable in production.');
  const approved = buildApprovedCidrs(options.allowedPrivateCidrs ?? []);
  const origins = configuredOrigins(options.origins, allowLoopback, approved);
  const connectTimeoutMs = validateTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const headersTimeoutMs = validateTimeout(options.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS);
  const bodyTimeoutMs = validateTimeout(options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  const maxResponseBytes = validateResponseLimit(options.maxResponseBytes);
  const lookup = boundedLookup(options.lookup ?? defaultLookup, allowLoopback, approved);
  const dispatcher = new Agent({
    maxOrigins: origins.size,
    headersTimeout: headersTimeoutMs,
    bodyTimeout: bodyTimeoutMs,
    autoSelectFamily: false,
    connect: { lookup, timeout: connectTimeoutMs },
  });

  const pluginFetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.username || url.password || url.hash || !origins.has(url.origin)) {
      throw new PluginNetworkError('Plugin request origin is not permitted.');
    }
    const host = unbracket(url.hostname);
    const family = isIP(host);
    if (family && !addressAllowed(host, family, host, allowLoopback, approved)) {
      throw new PluginNetworkError('Plugin destination is not permitted.');
    }
    try {
      const response = await undiciFetch(input as unknown as UndiciRequestInfo, {
        ...(init as unknown as UndiciRequestInit | undefined),
        redirect: 'error',
        dispatcher,
      });
      return withResponseLimit(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof PluginNetworkError) throw error;
      if (containsPolicyError(error)) throw new PluginNetworkError('Plugin destination is not permitted.');
      throw new PluginNetworkError('Plugin network request failed.');
    }
  };
  return Object.assign(pluginFetch, { close: () => dispatcher.close() });
}
