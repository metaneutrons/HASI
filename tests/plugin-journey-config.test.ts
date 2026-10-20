import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyDatabaseUrl, assertJourneyEnvFilesAbsent } from '../scripts/serve-plugin-journey.js';

const valid = { HASI_PLUGIN_JOURNEY: '1', TEST_DATABASE_URL: 'postgresql://postgres@127.0.0.1:32775/hasi_topology_test' };

describe('held synthetic plugin journey admission', () => {
  it('accepts only explicit opt-in and the named disposable loopback database', () => {
    expect(journeyDatabaseUrl(valid)).toBe(valid.TEST_DATABASE_URL);
    expect(() => journeyDatabaseUrl({ ...valid, HASI_PLUGIN_JOURNEY: undefined })).toThrow('HASI_PLUGIN_JOURNEY=1');
    expect(() => journeyDatabaseUrl({ ...valid, TEST_DATABASE_URL: undefined })).toThrow('required');
  });

  it.each([
    'postgresql://postgres@database.example.test:5432/hasi_topology_test',
    'postgresql://postgres@127.0.0.1/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:5432/hasi',
    'postgresql://postgres@localhost:5432/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:5432/hasi_topology_test?host=production.example.test',
    'postgresql://postgres@127.0.0.1:5432/hasi_topology_test#override',
    'postgresql://postgres:synthetic-password@127.0.0.1:5432/hasi_topology_test',
    'https://127.0.0.1:5432/hasi_topology_test',
  ])('rejects an unapproved database before launching anything: %s', url => {
    expect(() => journeyDatabaseUrl({ ...valid, TEST_DATABASE_URL: url })).toThrow('loopback hasi_topology_test');
  });
  it('rejects dotenv files by presence without reading or exposing their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hasi-journey-env-'));
    try {
      await mkdir(join(root, 'apps/web'), { recursive: true });
      await expect(assertJourneyEnvFilesAbsent(root)).resolves.toBeUndefined();
      await writeFile(join(root, 'apps/web/.env.local'), 'SYNTHETIC_SENTINEL=not-an-operator-credential\n');
      await expect(assertJourneyEnvFilesAbsent(root)).rejects.toThrow('dotenv configuration must be absent');
      await rm(join(root, 'apps/web/.env.local'));
      await writeFile(join(root, '.env'), 'SYNTHETIC_SENTINEL=not-an-operator-credential\n');
      await expect(assertJourneyEnvFilesAbsent(root)).rejects.toThrow('dotenv configuration must be absent');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
