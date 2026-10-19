import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCoreEpochCutoverEnvironment } from '../scripts/qualify-core-epoch-cutover.js';

afterEach(() => { vi.unstubAllEnvs(); });

const safeEnvironment = {
  HASI_CORE_EPOCH_CUTOVER_QUALIFY: '1',
  HASI_CORE_EPOCH_LEGACY_ROOT: '/opt/hasi-legacy-source',
  TEST_DATABASE_URL: 'postgresql://postgres@127.0.0.1:32775/hasi_topology_test',
};

describe('core epoch cutover qualifier preflight', () => {
  it('requires explicit opt-in, a legacy source root, and the passwordless loopback qualification database', () => {
    expect(() => validateCoreEpochCutoverEnvironment({ TEST_DATABASE_URL: safeEnvironment.TEST_DATABASE_URL }))
      .toThrow('explicit_opt_in_required');
    expect(validateCoreEpochCutoverEnvironment(safeEnvironment)).toBe(safeEnvironment.TEST_DATABASE_URL);
  });

  it.each([
    'postgresql://postgres@127.0.0.1:5432/hasi',
    'postgresql://postgres:password@127.0.0.1:32775/hasi_topology_test',
    'postgresql://postgres@localhost:32775/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:32775/hasi_topology_test?sslmode=require',
  ])('rejects a database outside the guarded disposable target', TEST_DATABASE_URL => {
    expect(() => validateCoreEpochCutoverEnvironment({ ...safeEnvironment, TEST_DATABASE_URL })).toThrow();
  });

  it('requires the legacy source root to be absolute', () => {
    expect(() => validateCoreEpochCutoverEnvironment({ ...safeEnvironment, HASI_CORE_EPOCH_LEGACY_ROOT: 'relative/path' }))
      .toThrow('legacy_source_root_required');
  });

  it.each([
    { DATABASE_URL: 'postgresql://production.invalid/hasi' },
    { NODE_ENV: 'production' },
    { HASI_MODE: 'production' },
    { HASI_DEMO_MODE: '1' },
    { VERCEL: '1' },
    { PGSERVICE: 'external-service' },
  ])('rejects unsafe inherited environment without reporting its values', extra => {
    expect(() => validateCoreEpochCutoverEnvironment({ ...safeEnvironment, ...extra })).toThrow();
  });

});
