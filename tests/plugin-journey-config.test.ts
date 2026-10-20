import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyDatabaseUrl, assertJourneyEnvFilesAbsent, journeyManagedConfiguration, journeyOperation, journeyPersonas } from '../scripts/serve-plugin-journey.js';

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

  it('requires an explicit managed operator switch and rejects ambiguous CLI operations', () => {
    expect(journeyOperation([])).toEqual({ kind: 'serve', managed: false });
    expect(journeyOperation(['--managed'])).toEqual({ kind: 'serve', managed: true });
    expect(journeyOperation(['--api', '/tmp/owned-api.json'])).toEqual({ kind: 'api', path: '/tmp/owned-api.json' });
    for (const args of [['--managed', '--managed'], ['--api'], ['--api', ''], ['--managed=true'], ['--api', '/tmp/api', '--managed']]) {
      expect(() => journeyOperation(args)).toThrow('Invalid synthetic journey operation');
    }
  });

  it('admits only the two distinct exact private managed origins and an owned launcher ID', () => {
    const managed = { ownerId: 'managed-journey-abcdef012345', rpcOrigin: 'http://127.0.0.1:12345', gatewayOrigin: 'http://127.0.0.1:12346' };
    expect(journeyManagedConfiguration(undefined)).toBeUndefined();
    expect(journeyManagedConfiguration(managed)).toEqual(managed);
    for (const patch of [
      { rpcOrigin: managed.gatewayOrigin }, { ownerId: 'other-owner' }, { gatewayOrigin: 'http://localhost:12346' },
      { gatewayOrigin: 'https://remote.example.test' }, { gatewayOrigin: 'http://127.0.0.1:12346/' },
      { gatewayOrigin: 'http://127.0.0.1:12346?override=1' }, { gatewayOrigin: 'http://127.0.0.1:80' },
      { gatewayOrigin: 'http://name:password@127.0.0.1:12346' }, { secret: 'not-accepted' },
    ]) expect(() => journeyManagedConfiguration({ ...managed, ...patch })).toThrow();
  });

  it('declares exactly the same stable TestIdP subjects for API and managed-worker authority', () => {
    const users = [...journeyPersonas('http://127.0.0.1:12347').values()];
    expect(users.map(user => user.role).sort()).toEqual(['admin', 'student']);
    expect(users.every(user => user.id === user.actor.subject)).toBe(true);
    expect(new Set(users.map(user => user.id)).size).toBe(2);
    expect(users.find(user => user.role === 'admin')?.actor.permissions).toContain('plugins:manage');
    expect(users.every(user => user.actor.permissions.includes('reference:read'))).toBe(true);
    // An external account projection is supplied only after its separate connection flow.
    expect(users.every(user => user.actor.claims?.['reference.account'] === undefined)).toBe(true);
  });

});
