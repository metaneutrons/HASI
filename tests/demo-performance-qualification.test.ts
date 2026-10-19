import { describe, expect, it } from 'vitest';
import {
  collectDemoPerformanceBatch, nearestRankP95, qualifyDemoPerformanceBatch, validateDemoPerformanceEnvironment,
  DEMO_PERFORMANCE_OPT_IN, DEMO_PERFORMANCE_SAMPLES_PER_BATCH,
} from '../scripts/demo-performance-qualification.js';

const safeEnvironment = {
  [DEMO_PERFORMANCE_OPT_IN]: '1',
  TEST_DATABASE_URL: 'postgresql://postgres@127.0.0.1:32775/hasi_topology_test',
};

describe('demo performance qualification guards and collector', () => {
  it('requires explicit opt-in and the fixed disposable loopback database', () => {
    expect(() => validateDemoPerformanceEnvironment({ TEST_DATABASE_URL: safeEnvironment.TEST_DATABASE_URL })).toThrow('demo_performance_explicit_opt_in_required');
    expect(() => validateDemoPerformanceEnvironment({ ...safeEnvironment, DATABASE_URL: 'postgresql://elsewhere/hasi' })).toThrow('demo_performance_ambient_runtime_configuration_forbidden');
    expect(() => validateDemoPerformanceEnvironment({ ...safeEnvironment, GROQ_API_KEY: 'present' })).toThrow('demo_performance_credential_or_postgres_environment_forbidden');
    expect(() => validateDemoPerformanceEnvironment({ ...safeEnvironment, PGHOST: '127.0.0.1' })).toThrow('demo_performance_credential_or_postgres_environment_forbidden');
    expect(() => validateDemoPerformanceEnvironment({ ...safeEnvironment, TEST_DATABASE_URL: 'postgresql://postgres@db.example/hasi_topology_test' })).toThrow('qualification_database_not_disposable_loopback');
    expect(validateDemoPerformanceEnvironment(safeEnvironment).database).toMatchObject({ host: '127.0.0.1', database: 'hasi_topology_test' });
  });

  it('uses nearest-rank p95 and requires exactly 100 error-free samples at or below one second', () => {
    const samples = Array.from({ length: DEMO_PERFORMANCE_SAMPLES_PER_BATCH }, (_, index) => index + 1);
    expect(nearestRankP95(samples)).toBe(95);
    expect(qualifyDemoPerformanceBatch(samples).passed).toBe(true);
    expect(qualifyDemoPerformanceBatch(samples, 1).passed).toBe(false);
    expect(qualifyDemoPerformanceBatch(samples.map(() => 1_001)).passed).toBe(false);
    expect(qualifyDemoPerformanceBatch(samples.slice(1)).passed).toBe(false);
  });

  it('collects five concurrent users and marks a failed request as a failed batch', async () => {
    let calls = 0;
    const batch = await collectDemoPerformanceBatch(() => { calls += 1; return Promise.resolve(); }, () => 42);
    expect(calls).toBe(100);
    expect(batch).toMatchObject({ sampleCount: 100, errorCount: 0, p95Ms: 0, passed: true });

    const failed = await collectDemoPerformanceBatch((_user, sample) => sample === 0 ? Promise.reject(new Error('request failed')) : Promise.resolve());
    expect(failed.errorCount).toBeGreaterThan(0);
    expect(failed.passed).toBe(false);
  });
});
