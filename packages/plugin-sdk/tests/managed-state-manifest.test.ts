import { describe, expect, it } from 'vitest';
import { manifestSchema, projectActorContext, managedStateValidator, type PluginManifestV2 } from '../src/index.js';
import { compatibleUpdate } from '../../../apps/api/src/registry.js';

const manifest: PluginManifestV2 = {
  manifestVersion: 2, apiVersion: '2.0.0', mcpVersion: '2025-11-25',
  id: 'managed-state', name: 'Managed state', description: 'Approved state profile', version: '1.0.0', tools: [],
  identity: { claims: ['external.account'] },
  managedState: { schemaVersion: 1, accountIdentity: { kind: 'claim', name: 'external.account' }, applicationSchema: { type: 'object', properties: {}, additionalProperties: false } },
};

describe('explicit managed state manifest profile', () => {
  it('admits only the explicit bidirectional profile and a declared account identity', () => {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, mcpVersion: '2026-07-28' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, identity: { claims: [] } }).success).toBe(false);
    const plain = structuredClone(manifest);
    delete plain.managedState;
    expect(manifestSchema.safeParse(plain).success).toBe(false);
    expect(manifestSchema.safeParse({ ...plain, mcpVersion: '2026-07-28' }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, managedState: { ...manifest.managedState, applicationSchema: { $ref: 'https://untrusted.example/schema' } } }).success).toBe(false);
  });

  it('compiles an admitted state schema and rejects semantically invalid schemas before access', () => {
    const validate = managedStateValidator(manifest.managedState!.applicationSchema);
    expect(validate({})).toBe(true);
    expect(validate({ unapproved: true })).toBe(false);
    expect(managedStateValidator(structuredClone(manifest.managedState!.applicationSchema))).toBe(validate);
    expect(() => managedStateValidator({ type: 'object', minimum: 1 })).toThrow();
    const mutable = { const: { approved: 'original' } };
    const immutableValidator = managedStateValidator(mutable);
    mutable.const.approved = 'changed';
    expect(immutableValidator({ approved: 'original' })).toBe(true);
    expect(immutableValidator({ approved: 'changed' })).toBe(false);
  });

  it('projects customerId only for an explicitly approved customer account state profile', () => {
    const actor = { subject: 'user', permissions: [], customerId: 'customer-a', resourceIds: ['private-resource'] };
    expect(projectActorContext(actor, manifest)).toEqual({ subject: 'user', permissions: [] });
    const selected: PluginManifestV2 = { ...manifest, managedState: { ...manifest.managedState!, accountIdentity: { kind: 'customerId' } } };
    expect(projectActorContext(actor, selected)).toEqual({ subject: 'user', permissions: [], customerId: 'customer-a' });
  });

  it('accepts unchanged state across an ordinary update and rejects silent state/profile changes', () => {
    const candidate = { ...manifest, version: '1.1.0' };
    expect(compatibleUpdate(manifest, candidate)).toBe(true);
    for (const managedState of [undefined, { ...manifest.managedState!, schemaVersion: 2 },
      { ...manifest.managedState!, accountIdentity: { kind: 'subject' as const } },
      { ...manifest.managedState!, applicationSchema: { type: 'string' } }]) {
      const changed = { ...candidate };
      if (managedState) changed.managedState = managedState; else delete changed.managedState;
      expect(compatibleUpdate(manifest, changed)).toBe(false);
    }
    expect(compatibleUpdate(manifest, { ...candidate, mcpVersion: '2026-07-28' })).toBe(false);
  });
});
