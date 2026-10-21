import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { journeyDatabaseUrl, assertJourneyEnvFilesAbsent, journeyBudgetInitializerEnvironment, journeyManagedConfiguration, journeyOperation, journeyPersonas, journeyPreflight, journeyWebBuildEnvironment, journeyFixtureCommands, parseJourneyFixtureCommand } from '../scripts/serve-plugin-journey.js';
import { captureExternalJourneyArtifactEnvironment } from '../scripts/plugin-journey-artifacts.js';
import { EXTERNAL_ARTIFACT_ENV } from '../scripts/plugin-gateway-qualification-artifacts.js';

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

  it('applies opt-in and database admission before inspecting partial external artifact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hasi-journey-preflight-'));
    const partial = { [EXTERNAL_ARTIFACT_ENV.aDirectory]: '/must-not-be-opened' };
    try {
      await expect(journeyPreflight({ environment: partial, managedMode: true, workspaceRoot: root }))
        .rejects.toThrow('Set HASI_PLUGIN_JOURNEY=1');
      await expect(journeyPreflight({
        environment: { HASI_PLUGIN_JOURNEY: '1', TEST_DATABASE_URL: 'postgresql://db.invalid/hasi', ...partial },
        managedMode: true,
        workspaceRoot: root,
      })).rejects.toThrow('loopback hasi_topology_test');
      await expect(journeyPreflight({ environment: { ...valid, ...partial }, managedMode: true, workspaceRoot: root }))
        .rejects.toThrow('external_artifact_inputs_incomplete');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('builds the optimized web app with only the clean environment and its fixed local API origin', () => {
    const externalInputs = Object.fromEntries(Object.values(EXTERNAL_ARTIFACT_ENV).map(name => [name, '/private/operator/input']));
    const environment = journeyWebBuildEnvironment({
      PATH: '/synthetic/bin', HOME: '/synthetic/home', XDG_CONFIG_HOME: '/synthetic/config', TMPDIR: '/synthetic/tmp',
      LANG: 'en_US.UTF-8', npm_config_store_dir: '/synthetic/store', DOCKER_HOST: 'tcp://remote.invalid',
      TEST_DATABASE_URL: valid.TEST_DATABASE_URL, DATABASE_URL: valid.TEST_DATABASE_URL, HASI_APP_MODE: 'production',
      HASI_LOCAL_TEST_IDP: '1', HASI_CHAT_SIGNING_SECRET: 'synthetic-signing-secret', CUSTOM_API_KEY: 'synthetic-model-token',
      HASI_LLM_CONFIG: 'synthetic-model-config', GROQ_API_KEY: 'operator-secret',
      ...externalInputs,
    });

    expect(environment).toEqual({
      PATH: '/synthetic/bin', HOME: '/synthetic/home', XDG_CONFIG_HOME: '/synthetic/config', TMPDIR: '/synthetic/tmp',
      LANG: 'en_US.UTF-8', npm_config_store_dir: '/synthetic/store', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      HASI_API_ORIGIN: 'http://127.0.0.1:4100',
    });
    expect(Object.values(EXTERNAL_ARTIFACT_ENV).some(name => name in environment)).toBe(false);
    expect(captureExternalJourneyArtifactEnvironment({ ...externalInputs, GROQ_API_KEY: 'operator-secret' }))
      .toEqual(externalInputs);
  });

  it('isolates durable budget initialization to the validated test database and synthetic tariff', () => {
    const prices = [{ provider: 'custom', baseURL: 'https://127.0.0.1:43123/v1', modelId: 'hasi-synthetic-fixture',
      inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000, basis: 'operator_estimate' }] as const;
    const environment = journeyBudgetInitializerEnvironment(valid.TEST_DATABASE_URL, prices, {
      PATH: '/synthetic/bin', HOME: '/synthetic/home', DOCKER_HOST: 'unix:///private/docker.sock',
      HASI_LLM_CONFIG: 'synthetic-model-config', CUSTOM_API_KEY: 'synthetic-model-token', GROQ_API_KEY: 'operator-secret',
    });

    expect(environment).toEqual({
      PATH: '/synthetic/bin', HOME: '/synthetic/home', NODE_ENV: 'production',
      DATABASE_URL: valid.TEST_DATABASE_URL, HASI_MODEL_PRICES: JSON.stringify(prices),
    });
    expect(() => journeyBudgetInitializerEnvironment('postgresql://postgres@db.invalid:5432/hasi_topology_test', prices, {}))
      .toThrow('loopback hasi_topology_test');
  });

  it('requires an explicit managed operator switch and rejects ambiguous CLI operations', () => {
    expect(journeyOperation([])).toEqual({ kind: 'serve', managed: false, optimized: false });
    expect(journeyOperation(['--managed'])).toEqual({ kind: 'serve', managed: true, optimized: false });
    expect(journeyOperation(['--optimized'])).toEqual({ kind: 'serve', managed: false, optimized: true });
    expect(journeyOperation(['--optimized', '--managed'])).toEqual({ kind: 'serve', managed: true, optimized: true });
    expect(journeyOperation(['--managed', '--optimized'])).toEqual({ kind: 'serve', managed: true, optimized: true });
    expect(journeyOperation(['--api', '/tmp/owned-api.json'])).toEqual({ kind: 'api', path: '/tmp/owned-api.json' });
    for (const args of [['--managed', '--managed'], ['--optimized', '--optimized'], ['--api'], ['--api', ''], ['--api', '--managed'],
      ['--managed=true'], ['--unknown'], ['model-unavailable-once'], ['--api', '/tmp/api', '--managed'], ['--optimized', '--api', '/tmp/api']]) {
      expect(() => journeyOperation(args)).toThrow('Invalid synthetic journey operation');
    }
  });

  it('keeps the one-shot model fault available only through the held terminal command set', () => {
    expect(journeyFixtureCommands(false)).toContain('model-unavailable-once');
    expect(journeyFixtureCommands(true)).toContain('model-unavailable-once');
    expect(parseJourneyFixtureCommand('model-unavailable-once', false)).toBe('model-unavailable-once');
    expect(parseJourneyFixtureCommand('model-unavailable-once', true)).toBe('model-unavailable-once');
    expect(parseJourneyFixtureCommand('unexpected-control', false)).toBeUndefined();
    expect(parseJourneyFixtureCommand('unexpected-control', true)).toBeUndefined();
    expect(parseJourneyFixtureCommand('--model-unavailable-once', false)).toBeUndefined();
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
