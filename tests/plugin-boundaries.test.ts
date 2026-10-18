import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore } from '@hasi/state';
import { EnvironmentPluginSecretCustody } from '../apps/api/src/plugin-secrets.js';
import { resultEnvelope } from '../apps/api/src/result-envelope.js';
import { ProductionAuthorityDirectory, stableOidcSubject } from '../apps/api/src/production-runtime.js';
import { annyManifest } from '../apps/anny-plugin/src/manifest.js';

describe('host-owned plugin boundaries', () => {
  it('keeps credential values/references out of readiness and changes operator revisions independently', async () => {
    const environment: Record<string, string | undefined> = { HASI_PLUGIN_SECRET_FIXTURE: 'synthetic-secret' };
    const custody = new EnvironmentPluginSecretCustody({ upstream: { environmentName: 'HASI_PLUGIN_SECRET_FIXTURE', revision: 'r1' } }, environment);
    expect(custody.status('upstream')).toEqual({ configured: true, revision: 'r1' });
    expect(custody.status('constructor')).toEqual({ configured: false, revision: null });
    expect(await custody.use('upstream', value => Promise.resolve(value.length))).toBe(16);
    delete environment.HASI_PLUGIN_SECRET_FIXTURE;
    expect(custody.status('upstream')).toEqual({ configured: false, revision: null });
    await expect(custody.use('upstream', () => Promise.resolve(true))).rejects.toThrow('unavailable');
    expect(() => new EnvironmentPluginSecretCustody({ malicious: { environmentName: 'GROQ_API_KEY', revision: 'r1' } }, environment)).toThrow();
  });

  it('rejects forged provenance and inconsistent pagination while retaining host source/authority identity', () => {
    const input = { instanceId: 'rooms', manifest: annyManifest, configurationRevision: 2, actor: { subject: 'person', permissions: ['rooms:read'] }, policy: { sourceId: 'approved-fixture', revision: 'r1', dataClasses: ['synthetic_demo'] as const }, tool: 'anny.search_resources', output: { resources: [] } };
    const envelope = resultEnvelope({ ...input, policy: { ...input.policy, dataClasses: [...input.policy.dataClasses] } });
    expect(envelope._hasi.provenance).toMatchObject({ installationId: 'rooms', sourceId: 'approved-fixture', configurationRevision: 2, dataClasses: ['synthetic_demo'] });
    expect(() => resultEnvelope({ ...input, policy: { ...input.policy, dataClasses: [...input.policy.dataClasses] }, output: { _hasi: {} } })).toThrow('forge');
    expect(() => resultEnvelope({ ...input, policy: { ...input.policy, dataClasses: [...input.policy.dataClasses] }, pagination: { describe: () => ({ complete: true, nextCursor: 'contradictory' }) } })).toThrow();
  });

  it('binds signed institutional authority to scope and subject and preserves revocation tombstones', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const store = new MemoryJsonStore('operator-authorities');
    const directory = new ProductionAuthorityDirectory(store, privateKey, 'one');
    const other = new ProductionAuthorityDirectory(store, privateKey, 'two');
    const subject = stableOidcSubject('https://idp.example.edu', 'opaque-subject');
    const user = { id: subject, displayName: 'Synthetic employee', role: 'employee' as const, actor: { subject, permissions: ['rooms:read'] } };
    expect(await directory.replace(subject, null, user)).toBe(true);
    expect(await directory.resolve(subject)).toEqual(user);
    await expect(other.resolve(subject)).rejects.toThrow('signature');
    expect(await directory.replace(subject, null, user)).toBe(false);
    const key = `authority:v1:${(await import('node:crypto')).createHash('sha256').update(subject).digest('hex')}`;
    const revision = (await store.read(key))?.revision;
    expect(revision).toBeDefined();
    expect(await directory.replace(subject, revision ?? null, null)).toBe(true);
    expect(await directory.resolve(subject)).toBeUndefined();
    expect(await directory.replace(subject, null, user)).toBe(false);
  });
});
