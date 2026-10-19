import { describe, expect, it } from 'vitest';
import { digest, type PluginManifest } from '@hasi/plugin-sdk';
import { managedPluginRuntimeContractSchema, type ManagedPluginRuntimeContract } from '../apps/api/src/managed-plugin-contract.js';

const manifest: PluginManifest = {
  manifestVersion: 2, id: 'de.example.calendar', version: '1.2.3', name: 'Calendar', description: 'Approved calendar contract',
  apiVersion: '2.0.0', mcpVersion: '2026-07-28', secrets: [{ name: 'calendarApi', required: true }, { name: 'optionalToken', required: false }], tools: [],
};

const contract: ManagedPluginRuntimeContract = {
  installationId: 'calendar-installation', manifest, manifestDigest: digest(manifest), configurationRevision: 7,
  deploymentRevision: 'a'.repeat(64), transportCredentialRevision: 'transport-9',
  secretStatuses: [
    { name: 'calendarApi', configured: true, revision: 'calendar-3' },
    { name: 'optionalToken', configured: false, revision: null },
  ],
  enabled: true,
};

describe('managed plugin active contract DTO', () => {
  it('accepts the bounded approved manifest and exposes only logical credential status', () => {
    const parsed = managedPluginRuntimeContractSchema.parse(contract);
    expect(parsed).toEqual(contract);
    expect(JSON.stringify(parsed)).not.toMatch(/secretRef|secretValue|HASI_PLUGIN_SECRET|registry\.example|https?:\/\//u);
  });

  it('rejects substituted manifest digests, duplicate or unrelated secret states, and unknown fields', () => {
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, manifestDigest: 'b'.repeat(64) }).success).toBe(false);
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, secretStatuses: [contract.secretStatuses[0], contract.secretStatuses[0]] }).success).toBe(false);
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, secretStatuses: [{ name: 'otherSecret', configured: false, revision: null }] }).success).toBe(false);
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, origin: 'http://127.0.0.1' }).success).toBe(false);
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, secretRef: 'operator-ref' }).success).toBe(false);
  });

  it('requires configured statuses to have revisions and keeps readiness explicit through enabled', () => {
    expect(managedPluginRuntimeContractSchema.safeParse({
      ...contract,
      secretStatuses: [{ name: 'calendarApi', configured: true, revision: null }, { name: 'optionalToken', configured: false, revision: null }],
    }).success).toBe(false);
    expect(managedPluginRuntimeContractSchema.safeParse({ ...contract, enabled: false }).success).toBe(false);
  });
});

