import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { resolveDemoStateNamespace } from '../src/lib/server/demo-runtime-namespace';

describe('demo state namespace configuration', () => {
  it('keeps the local default outside Vercel', () => {
    expect(resolveDemoStateNamespace({})).toBe('local-demo:v1');
  });

  it('keeps the production default on Vercel production', () => {
    expect(resolveDemoStateNamespace({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe('production:v1');
  });

  it('keeps preview state isolated by commit, then deployment URL', () => {
    expect(resolveDemoStateNamespace({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abc123', VERCEL_URL: 'preview.example' })).toBe('preview:abc123');
    expect(resolveDemoStateNamespace({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'preview.example' })).toBe('preview:preview.example');
    expect(resolveDemoStateNamespace({ VERCEL: '1', VERCEL_ENV: 'preview' })).toBe('preview:isolated');
  });

  it('uses a valid explicit namespace independently of hosting detection', () => {
    expect(resolveDemoStateNamespace({ HASI_DEMO_STATE_NAMESPACE: 'production:v1' })).toBe('production:v1');
    expect(resolveDemoStateNamespace({ HASI_DEMO_STATE_NAMESPACE: 'production:v1', VERCEL: '1', VERCEL_ENV: 'preview' })).toBe('production:v1');
  });

  it.each(['', ' ', '\t\n', ' production:v1 ', 'production:v1\0'])('rejects an invalid explicit namespace %s', namespace => {
    expect(() => resolveDemoStateNamespace({ HASI_DEMO_STATE_NAMESPACE: namespace })).toThrow(RangeError);
  });

  it('rejects namespaces exceeding the state store contract limit', () => {
    expect(() => resolveDemoStateNamespace({ HASI_DEMO_STATE_NAMESPACE: 'a'.repeat(257) })).toThrow(RangeError);
  });
});
