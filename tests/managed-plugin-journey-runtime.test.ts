import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Persona } from '../apps/api/src/index.js';
import type { ReferencePluginArtifactEvidence } from '../scripts/package-reference-plugin.js';
import {
  managedJourneyCredentialSlotContract,
  planManagedJourneyContainerRemoval,
  validateManagedPluginJourneyBoundary,
  ManagedPluginJourneyRuntimeError,
  type ManagedPluginJourneyRuntimeOptions,
} from '../scripts/managed-plugin-journey-runtime.js';

const keyPair = generateKeyPairSync('ed25519');

function evidence(version: '1.0.0' | '1.0.1'): ReferencePluginArtifactEvidence {
  return {
    pluginId: 'hasi.reference',
    pluginVersion: version,
    manifestDigest: 'a'.repeat(64),
    manifestFileSha256: 'b'.repeat(64),
    artifactSha256: version === '1.0.0' ? 'c'.repeat(64) : 'd'.repeat(64),
    artifactManifestSha256: version === '1.0.0' ? 'e'.repeat(64) : 'f'.repeat(64),
    payloadFileCount: 5,
    runtimePackageCount: 4,
    licenseInventory: [
      { name: '@hasi/plugin-sdk', version: '1.0.0', license: 'GPL-3.0-only' },
      { name: 'hasi-reference-plugin', version, license: 'GPL-3.0-only' },
    ],
  };
}

function authorities(): Persona[] {
  return [
    { id: 'synthetic-admin', displayName: 'Synthetic administrator', role: 'admin',
      actor: { subject: 'synthetic-admin', permissions: ['plugins:manage'] } },
    { id: 'synthetic-student', displayName: 'Synthetic student', role: 'student',
      actor: { subject: 'synthetic-student', permissions: ['reference:read', 'reference:prepare', 'reference:execute'] } },
  ];
}

function options(overrides: Partial<ManagedPluginJourneyRuntimeOptions> = {}): ManagedPluginJourneyRuntimeOptions {
  return {
    directory: '/tmp/hasi-managed-journey-owned',
    scope: '123e4567-e89b-42d3-a456-426614174000',
    databaseUrl: 'postgres://postgres@127.0.0.1:55432/hasi_topology_test',
    authorityPrivateKey: keyPair.privateKey,
    authorities: authorities(),
    transportToken: 'T'.repeat(43),
    releases: [
      {
        directory: '/tmp/hasi-reference-v1',
        sourceSha: '1'.repeat(40),
        sourceIdentity: { repository: 'file:///tmp/hasi-reference-source', revision: '1'.repeat(40), tag: 'v1.0.0' },
        evidence: evidence('1.0.0'),
      },
      {
        directory: '/tmp/hasi-reference-v2',
        sourceSha: '2'.repeat(40),
        sourceIdentity: { repository: 'file:///tmp/hasi-reference-source', revision: '2'.repeat(40), tag: 'v1.0.1' },
        evidence: evidence('1.0.1'),
      },
    ],
    onUnexpectedExit: () => undefined,
    ...overrides,
  };
}

describe('managed journey runtime admission boundary', () => {
  it('accepts only the synthetic loopback database and the exact independently identified release pair', () => {
    expect(() => { validateManagedPluginJourneyBoundary(options()); }).not.toThrow();
    expect(() => { validateManagedPluginJourneyBoundary(options({
      databaseUrl: 'postgres://postgres@database.internal:5432/hasi_topology_test',
    })); }).toThrow();
    expect(() => { validateManagedPluginJourneyBoundary(options({
      releases: [
        { directory: '/tmp/a', sourceSha: '1'.repeat(40), sourceIdentity: { repository: 'file:///tmp/a-source', revision: '1'.repeat(40), tag: 'v1.0.0' }, evidence: evidence('1.0.0') },
        { directory: '/tmp/b', sourceSha: '1'.repeat(40), sourceIdentity: { repository: 'file:///tmp/b-source', revision: '1'.repeat(40), tag: 'v1.0.1' }, evidence: evidence('1.0.1') },
      ],
    })); }).toThrow();
    expect(() => { validateManagedPluginJourneyBoundary(options({
      releases: [
        { directory: '/tmp/a', sourceSha: '1'.repeat(40), sourceIdentity: { repository: 'file:///tmp/a-source', revision: '1'.repeat(40), tag: 'v1.0.0' }, evidence: evidence('1.0.0') },
        { directory: '/tmp/b', sourceSha: '2'.repeat(40), sourceIdentity: { repository: 'file:///tmp/b-source', revision: '2'.repeat(40), tag: 'v1.0.1' }, evidence: evidence('1.0.0') },
      ],
    })); }).toThrow();
    const valid = options();
    expect(() => { validateManagedPluginJourneyBoundary(options({
      releases: [{ ...valid.releases[0]!, sourceIdentity: undefined as never }, valid.releases[1]!],
    })); }).toThrow(ManagedPluginJourneyRuntimeError);
    expect(() => { validateManagedPluginJourneyBoundary(options({
      releases: [{ ...valid.releases[0]!, sourceIdentity: { ...valid.releases[0]!.sourceIdentity, tag: 'v9.9.9' } }, valid.releases[1]!],
    })); }).toThrow();
    expect(() => { validateManagedPluginJourneyBoundary(options({
      releases: [{ ...valid.releases[0]!, sourceIdentity: { ...valid.releases[0]!.sourceIdentity, repository: 'file:///tmp/another-source' } }, valid.releases[1]!],
    })); }).toThrow();
  });

  it('rejects credentials and authorities outside the synthetic instance contract without touching Docker or PostgreSQL', () => {
    expect(() => { validateManagedPluginJourneyBoundary(options({ transportToken: 'short' })); }).toThrow();
    const invalidAdmin = authorities();
    invalidAdmin[0] = { ...invalidAdmin[0]!, actor: { subject: 'synthetic-admin', permissions: [] } };
    expect(() => { validateManagedPluginJourneyBoundary(options({ authorities: invalidAdmin })); }).toThrow();
    const invalidStudent = authorities();
    invalidStudent[1] = { ...invalidStudent[1]!, actor: { subject: 'synthetic-student', permissions: ['reference:read'] } };
    expect(() => { validateManagedPluginJourneyBoundary(options({ authorities: invalidStudent })); }).toThrow();
    expect(() => { validateManagedPluginJourneyBoundary(options({ authorityPrivateKey: keyPair.publicKey })); }).toThrow();
  });

  it('keeps the transport and SERVICE_TOKEN logical slots distinct while documenting their same-instance alias', () => {
    expect(managedJourneyCredentialSlotContract.transport.logicalName).not.toBe(managedJourneyCredentialSlotContract.plugin.logicalName);
    expect(managedJourneyCredentialSlotContract.transport.environmentName).not.toBe(managedJourneyCredentialSlotContract.plugin.environmentName);
    expect(managedJourneyCredentialSlotContract.transport.valueBinding).toBe(managedJourneyCredentialSlotContract.plugin.valueBinding);
  });

  it('plans only owner-filtered full container IDs and rejects an ambiguous ownership batch', () => {
    const baseline = 'a'.repeat(64);
    const owned = 'b'.repeat(64);
    const unrelated = 'c'.repeat(64);
    expect(planManagedJourneyContainerRemoval({
      baselineIds: [baseline],
      currentIds: [baseline, owned, unrelated],
      ownerFilteredIds: [owned],
    })).toEqual([owned]);
    expect(() => { planManagedJourneyContainerRemoval({
      baselineIds: [baseline],
      currentIds: [baseline, 'short-id'],
      ownerFilteredIds: ['short-id'],
    }); }).toThrow();
    expect(() => { planManagedJourneyContainerRemoval({
      baselineIds: [baseline],
      currentIds: [baseline],
      ownerFilteredIds: [owned],
    }); }).toThrow();
    expect(() => { planManagedJourneyContainerRemoval({
      baselineIds: [baseline],
      currentIds: [baseline],
      ownerFilteredIds: [baseline],
    }); }).toThrow();
  });
});
