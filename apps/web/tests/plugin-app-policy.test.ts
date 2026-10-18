import { describe, expect, it } from 'vitest';
import {
  createPluginAppFrameDocument,
  getAllowedPluginAppToolNames,
  isAllowedPluginAppToolCall,
  isApprovedPluginAppResource,
  isBoundedPluginAppResult,
  type PluginAppToolGrant,
} from '../src/lib/plugin-app-policy';

const emptyCsp = { connectDomains: [], resourceDomains: [] };

describe('plugin app resource policy', () => {
  it('requires bounded HTML, a SHA-256 digest, and safe CSP hostnames', () => {
    expect(isApprovedPluginAppResource('<p>Room results</p>', 'a'.repeat(64), emptyCsp)).toBe(true);
    expect(isApprovedPluginAppResource('<p>Room results</p>', 'not-a-digest', emptyCsp)).toBe(false);
    expect(isApprovedPluginAppResource('<p>Room results</p>', 'a'.repeat(64), {
      connectDomains: ['https://untrusted.example'],
      resourceDomains: [],
    })).toBe(false);
  });

  it('limits view tools to explicitly allowed app-visible read grants', () => {
    const grants: PluginAppToolGrant[] = [
      { name: 'search', effect: 'read', visibility: ['model', 'app'] },
      { name: 'refresh', effect: 'read', visibility: ['app'] },
      { name: 'model-only', effect: 'read', visibility: ['model'] },
      { name: 'prepare', effect: 'prepare', visibility: ['app'] },
      { name: 'execute', effect: 'execute', visibility: ['app'] },
      { name: 'default-visible', effect: 'read' },
    ];
    expect([...getAllowedPluginAppToolNames(['search', 'refresh', 'model-only', 'prepare', 'execute', 'default-visible'], grants)]).toEqual([
      'search', 'refresh',
    ]);
    const allowed = getAllowedPluginAppToolNames(['search', 'prepare'], grants);
    expect(isAllowedPluginAppToolCall('search', { query: 'room' }, allowed)).toBe(true);
    expect(isAllowedPluginAppToolCall('prepare', {}, allowed)).toBe(false);
    expect(isAllowedPluginAppToolCall('search', null, allowed)).toBe(false);
  });

  it('rejects unbounded or prototype-related tool payloads and results', () => {
    const allowed = new Set(['search']);
    expect(isAllowedPluginAppToolCall('search', { query: 'room' }, allowed)).toBe(true);
    expect(isAllowedPluginAppToolCall('search', { constructor: 'unsafe' }, allowed)).toBe(false);
    expect(isAllowedPluginAppToolCall('search', { query: 'x'.repeat(20_000) }, allowed)).toBe(false);
    expect(isBoundedPluginAppResult({ rooms: ['A-101', 'A-102'] })).toBe(true);
    expect(isBoundedPluginAppResult({ rooms: ['x'.repeat(70_000)] })).toBe(false);
    let deeplyNested: unknown = 'too deep';
    for (let index = 0; index < 14; index += 1) deeplyNested = { nested: deeplyNested };
    expect(isBoundedPluginAppResult(deeplyNested)).toBe(false);
  });

  it('injects a restrictive CSP and leaves networking disabled by default', () => {
    const document = createPluginAppFrameDocument('<!doctype html><script>fetch("https://example.org")</script><html><head></head><body><p>Ready</p></body></html>', emptyCsp);
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain('Content-Security-Policy');
    expect(document).toContain('<p>Ready</p>');
    expect(document).not.toContain('allow-same-origin');
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
    const misleadingDoctype = createPluginAppFrameDocument('<script>fetch("https://example.org")</script><!doctype html><html></html>', emptyCsp);
    expect(misleadingDoctype.indexOf('Content-Security-Policy')).toBeLessThan(misleadingDoctype.indexOf('<script>'));
  });
});
