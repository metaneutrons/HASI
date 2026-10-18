export const MAX_PLUGIN_APP_HTML_BYTES = 1_024 * 1_024;
export const MAX_PLUGIN_APP_ARGUMENT_BYTES = 16 * 1_024;
export const MAX_PLUGIN_APP_RESULT_BYTES = 64 * 1_024;
export const MAX_PLUGIN_APP_DEPTH = 12;
export const MAX_PLUGIN_APP_NODES = 4_096;

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export interface PluginAppCsp {
  connectDomains: readonly string[];
  resourceDomains: readonly string[];
}

export interface PluginAppToolGrant {
  name: string;
  effect: 'read' | 'prepare' | 'execute';
  visibility?: readonly ('model' | 'app')[];
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function isApprovedPluginAppResource(html: string, sha256: string, csp: PluginAppCsp): boolean {
  if (typeof html !== 'string' || html.length === 0 || html.includes('\0') || !isSha256(sha256)) return false;
  if (new TextEncoder().encode(html).byteLength > MAX_PLUGIN_APP_HTML_BYTES) return false;
  return isSafePluginAppCsp(csp);
}

export function isSafePluginAppCsp(value: unknown): value is PluginAppCsp {
  if (!isPlainRecord(value)) return false;
  return (
    isSafeDomainList(value.connectDomains) &&
    isSafeDomainList(value.resourceDomains)
  );
}

export function getAllowedPluginAppToolNames(
  allowedToolNames: readonly string[],
  grants: readonly PluginAppToolGrant[],
): Set<string> {
  const requested = new Set(allowedToolNames);
  return new Set(
    grants
      .filter((grant) => {
        const appVisible = grant.visibility?.includes('app') === true;
        return grant.effect === 'read' && appVisible && requested.has(grant.name);
      })
      .map((grant) => grant.name),
  );
}

export function isAllowedPluginAppToolCall(
  name: unknown,
  args: unknown,
  allowedToolNames: ReadonlySet<string>,
): args is Record<string, unknown> {
  return typeof name === 'string' && allowedToolNames.has(name) && isBoundedJsonRecord(args, MAX_PLUGIN_APP_ARGUMENT_BYTES);
}

export function isBoundedPluginAppResult(value: unknown): boolean {
  return inspectBoundedJson(value, MAX_PLUGIN_APP_RESULT_BYTES);
}

export function createPluginAppFrameDocument(html: string, csp: PluginAppCsp): string {
  if (!isSafePluginAppCsp(csp)) throw new TypeError('Invalid plugin app CSP metadata');
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${sources(csp.resourceDomains)}`,
    `style-src 'unsafe-inline' ${sources(csp.resourceDomains)}`,
    `img-src data: blob: ${sources(csp.resourceDomains)}`,
    `font-src ${sources(csp.resourceDomains)}`,
    `media-src ${sources(csp.resourceDomains)}`,
    `connect-src ${sources(csp.connectDomains)}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const meta = `<meta http-equiv="Content-Security-Policy" content="${directives.join('; ')}">`;
  const doctype = /^\s*<!doctype\s+html\s*>/i.exec(html);
  if (doctype) {
    const insertionPoint = doctype[0].length;
    return `${html.slice(0, insertionPoint)}${meta}${html.slice(insertionPoint)}`;
  }
  // The policy must precede every byte of executable markup, including an
  // intentionally misplaced doctype/html element after an earlier script.
  return `<!doctype html>${meta}${html}`;
}

function isBoundedJsonRecord(value: unknown, maxBytes: number): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  return inspectBoundedJson(value, maxBytes);
}

function inspectBoundedJson(value: unknown, maxBytes: number): boolean {
  let nodes = 0;
  const seen = new Set<object>();

  function visit(item: unknown, depth: number): boolean {
    nodes += 1;
    if (nodes > MAX_PLUGIN_APP_NODES || depth > MAX_PLUGIN_APP_DEPTH) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object') return false;
    if (seen.has(item)) return false;
    seen.add(item);

    if (Array.isArray(item)) {
      if (item.length > 512) return false;
      for (const value of item) if (!visit(value, depth + 1)) return false;
      seen.delete(item);
      return true;
    }
    if (!isPlainRecord(item)) return false;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (forbiddenKeys.has(key) || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  }

  if (!visit(value, 0)) return false;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return false;
    return new TextEncoder().encode(encoded).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeDomainList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const domains: unknown[] = value;
  return (
    domains.length <= 16 &&
    domains.every((domain) => typeof domain === 'string' && domain.length <= 253 && hostnamePattern.test(domain)) &&
    new Set(domains).size === domains.length
  );
}

function sources(domains: readonly string[]): string {
  return domains.length ? domains.map((domain) => `https://${domain}`).join(' ') : "'none'";
}
