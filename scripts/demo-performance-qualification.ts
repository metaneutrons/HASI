import { qualificationDatabase } from './plugin-gateway-qualification-config.js';

export const DEMO_PERFORMANCE_OPT_IN = 'HASI_DEMO_PERFORMANCE_QUALIFY';
export const DEMO_PERFORMANCE_LIMIT_MS = 1_000;
export const DEMO_PERFORMANCE_USERS = 5;
export const DEMO_PERFORMANCE_SAMPLES_PER_USER = 20;
export const DEMO_PERFORMANCE_SAMPLES_PER_BATCH = DEMO_PERFORMANCE_USERS * DEMO_PERFORMANCE_SAMPLES_PER_USER;

export function validateDemoPerformanceEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  if (environment[DEMO_PERFORMANCE_OPT_IN] !== '1') throw new Error('demo_performance_explicit_opt_in_required');
  if (environment.TEST_DATABASE_URL === undefined || environment.TEST_DATABASE_URL.length === 0) throw new Error('demo_performance_test_database_required');
  const forbiddenExact = ['DATABASE_URL', 'HASI_DEMO_MODE', 'HASI_DEMO_STATE_NAMESPACE', 'HASI_DEMO_SECRET',
    'HASI_DEMO_ORIGIN', 'HASI_DEMO_SERVICE_IT_ORIGIN', 'VERCEL', 'VERCEL_URL', 'VERCEL_ENV'];
  if (forbiddenExact.some(name => environment[name])) throw new Error('demo_performance_ambient_runtime_configuration_forbidden');
  if (environment.HASI_APP_MODE === 'production' || environment.HASI_MODE === 'production') throw new Error('demo_performance_production_mode_forbidden');
  if (Object.keys(environment).some(name => ((name.startsWith('PG') || name === 'NODE_PG_FORCE_NATIVE') && environment[name] !== undefined && environment[name] !== '')
    || (name !== 'TEST_DATABASE_URL' && /(?:API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CREDENTIAL)/iu.test(name) && environment[name] !== undefined && environment[name] !== ''))) {
    throw new Error('demo_performance_credential_or_postgres_environment_forbidden');
  }
  const database = qualificationDatabase(environment.TEST_DATABASE_URL);
  return { databaseUrl: environment.TEST_DATABASE_URL, database };
}

export function nearestRankP95(samplesMs: readonly number[]): number {
  if (samplesMs.length === 0 || samplesMs.some(value => !Number.isFinite(value) || value < 0)) throw new Error('demo_performance_samples_invalid');
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const selected = sorted[Math.ceil(0.95 * sorted.length) - 1];
  if (selected === undefined) throw new Error('demo_performance_samples_invalid');
  return selected;
}

export interface DemoPerformanceBatch {
  readonly sampleCount: number;
  readonly errorCount: number;
  readonly p95Ms: number | null;
  readonly passed: boolean;
}

export function qualifyDemoPerformanceBatch(samplesMs: readonly number[], errorCount = 0, limitMs = DEMO_PERFORMANCE_LIMIT_MS): DemoPerformanceBatch {
  const sampleCount = samplesMs.length;
  const p95Ms = sampleCount ? nearestRankP95(samplesMs) : null;
  return { sampleCount, errorCount, p95Ms, passed: errorCount === 0 && sampleCount === DEMO_PERFORMANCE_SAMPLES_PER_BATCH && p95Ms !== null && p95Ms <= limitMs };
}

/** Runs five sequential request streams concurrently; any request error invalidates the batch. */
export async function collectDemoPerformanceBatch(
  run: (userIndex: number, sampleIndex: number) => Promise<void>,
  now: () => number = () => performance.now(),
): Promise<DemoPerformanceBatch> {
  const samples: number[] = [];
  let errorCount = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: DEMO_PERFORMANCE_USERS }, async (_, userIndex) => {
    for (let sampleIndex = 0; sampleIndex < DEMO_PERFORMANCE_SAMPLES_PER_USER && !stopped; sampleIndex += 1) {
      const started = now();
      try { await run(userIndex, sampleIndex); samples.push(Math.max(0, now() - started)); }
      catch { errorCount += 1; stopped = true; }
    }
  }));
  return qualifyDemoPerformanceBatch(samples, errorCount);
}
