import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoPostgresEnvironment, qualificationDatabase } from '../scripts/plugin-gateway-qualification-config.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('disposable gateway qualification database boundary', () => {
  it('accepts only the explicit passwordless loopback fixture', () => {
    expect(qualificationDatabase('postgresql://postgres@127.0.0.1:32775/hasi_topology_test')).toMatchObject({
      host: '127.0.0.1', user: 'postgres', password: '', port: 32775, database: 'hasi_topology_test', ssl: false,
    });
  });

  it.each([
    'postgresql://postgres@db.example:32775/hasi_topology_test',
    'postgresql://postgres@localhost:32775/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:32775/hasi',
    'postgresql://postgres:synthetic@127.0.0.1:32775/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:32775/hasi_topology_test?sslmode=require',
    'postgresql://postgres@127.0.0.1:32775/hasi_topology_test#ignored',
    'postgresql://other@127.0.0.1:32775/hasi_topology_test',
    'postgresql://postgres@127.0.0.1:543/hasi_topology_test',
    'https://postgres@127.0.0.1:32775/hasi_topology_test',
  ])('rejects a non-fixture destination or override', value => {
    expect(() => qualificationDatabase(value)).toThrow('qualification_database_not_disposable_loopback');
  });

  it('rejects ambient PostgreSQL service and password overrides without revealing values', () => {
    for (const name of Object.keys(process.env)) if (name.startsWith('PG') || name === 'NODE_PG_FORCE_NATIVE') vi.stubEnv(name, '');
    expect(() => { assertNoPostgresEnvironment(); }).not.toThrow();
    vi.stubEnv('PGSERVICE', 'synthetic-other-database');
    expect(() => { assertNoPostgresEnvironment(); }).toThrow('qualification_postgres_environment_override');
    vi.stubEnv('PGSERVICE', '');
    vi.stubEnv('PGPASSWORD', 'synthetic-only');
    expect(() => { assertNoPostgresEnvironment(); }).toThrow('qualification_postgres_environment_override');
  });
});
