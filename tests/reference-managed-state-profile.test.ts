import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  digest,
  MANAGED_STATE_MCP_VERSION,
  managedStateValidator,
  manifestSchema,
  type ExecutionBinding,
  type PluginManifestV2,
} from '@hasi/plugin-sdk';
import { createManagedReferenceManifest } from '../scripts/reference-managed-state-profile.js';

const manifestPath = new URL('../examples/reference-plugin/src/manifest.json', import.meta.url);
const statePath = new URL('../examples/reference-plugin/src/state.js', import.meta.url);

interface ManagedReferenceStateSource {
  mark(
    binding: ExecutionBinding,
    args: Record<string, unknown>,
    actor: { subject: string; claims: Record<string, string> },
  ): Promise<Record<string, unknown>>;
}

interface ManagedStateStore {
  read(key: string): Promise<{ revision: string; value: unknown } | undefined>;
  compareAndSet(key: string, revision: string | null, value: unknown): Promise<boolean>;
}

async function sourceManifest(): Promise<PluginManifestV2> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifestV2;
}

function applicationSchema(manifest: PluginManifestV2) {
  const schema = manifest.managedState?.applicationSchema;
  if (!schema) throw new Error('Expected the managed reference application schema.');
  return schema;
}

describe('managed reference profile helper', () => {
  it('opts the source manifest into the current profile without changing its metadata, config, or tools', async () => {
    const source = await sourceManifest();
    const before = structuredClone(source);
    const result = createManagedReferenceManifest(source);

    expect(source).toEqual(before);
    expect(result).toEqual({
      ...before,
      mcpVersion: MANAGED_STATE_MCP_VERSION,
      managedState: {
        schemaVersion: 1,
        accountIdentity: { kind: 'claim', name: 'reference.account' },
        applicationSchema: applicationSchema(result),
      },
    });
    expect(result.managedState?.applicationSchema).toMatchObject({
      type: 'object',
      properties: {
        version: { const: 1 },
        actionCount: { type: 'integer', minimum: 0 },
        receipts: {
          type: 'object',
          patternProperties: {
            '^[a-f0-9]{64}$': {
              type: 'object',
              properties: {
                binding: {
                  type: 'object',
                  required: ['subject', 'installationId', 'executionId', 'tool', 'argsHash', 'configurationRevision'],
                  additionalProperties: false,
                },
                account: { type: 'string' },
                result: {
                  type: 'object',
                  properties: {
                    confirmed: { const: true },
                    actionCount: { type: 'integer', minimum: 1 },
                    label: { type: 'string' },
                    account: { type: 'string' },
                  },
                  required: ['confirmed', 'actionCount', 'label', 'account'],
                  additionalProperties: false,
                },
              },
              required: ['binding', 'account', 'result'],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      required: ['version', 'actionCount', 'receipts'],
      additionalProperties: false,
    });
    expect(manifestSchema.safeParse(result).success).toBe(true);
  });

  it('validates initial and source-generated application state and rejects malformed receipts', async () => {
    const manifest = createManagedReferenceManifest(await sourceManifest());
    const validate = managedStateValidator(applicationSchema(manifest));
    expect(validate({ version: 1, actionCount: 0, receipts: {} })).toBe(true);

    let entry: { revision: string; value: unknown } | undefined;
    const store: ManagedStateStore = {
      read(key) {
        if (key !== 'source') throw new Error('Unexpected reference source key.');
        return Promise.resolve(entry ? structuredClone(entry) : undefined);
      },
      compareAndSet(key, revision, value) {
        if (key !== 'source' || (entry?.revision ?? null) !== revision) return Promise.resolve(false);
        entry = { revision: randomUUID(), value: structuredClone(value) };
        return Promise.resolve(true);
      },
    };
    const stateModule = await import(statePath.href) as unknown as {
      createManagedReferenceState(value: ManagedStateStore): ManagedReferenceStateSource;
    };
    const state = stateModule.createManagedReferenceState(store);
    const args = { label: 'Synthetic' };
    const binding: ExecutionBinding = {
      subject: 'synthetic-managed-user',
      installationId: 'reference-installation',
      executionId: randomUUID(),
      tool: 'execute_mark',
      argsHash: digest(args),
      configurationRevision: 0,
    };
    const actor = { subject: binding.subject, claims: { 'reference.account': 'account-a' } };
    await state.mark(binding, args, actor);
    expect(entry).toBeDefined();
    expect(validate(entry?.value)).toBe(true);

    const validReceiptState = structuredClone(entry?.value) as {
      version: number;
      actionCount: number;
      receipts: Record<string, { binding: ExecutionBinding; account: string; result: Record<string, unknown> }>;
    };
    const receiptKey = Object.keys(validReceiptState.receipts)[0];
    if (!receiptKey) throw new Error('Expected the source to persist a receipt.');
    const receipt = validReceiptState.receipts[receiptKey];
    if (!receipt) throw new Error('Expected the source receipt value.');
    expect(validate({ ...validReceiptState, receipts: { invalid: receipt } })).toBe(false);
    expect(validate({
      ...validReceiptState,
      receipts: {
        [receiptKey]: {
          ...receipt,
          binding: { ...receipt.binding, unexpected: true },
        },
      },
    })).toBe(false);
    expect(validate({
      ...validReceiptState,
      receipts: {
        [receiptKey]: {
          ...receipt,
          result: { ...receipt.result, confirmed: false },
        },
      },
    })).toBe(false);
    expect(validate({ version: 1, actionCount: -1, receipts: {} })).toBe(false);
  });

  it('returns independent schema snapshots and accepts its own approved profile', async () => {
    const source = await sourceManifest();
    const first = createManagedReferenceManifest(source);
    const second = createManagedReferenceManifest(source);
    const firstVersion = applicationSchema(first).properties as Record<string, unknown>;
    const firstVersionSchema = firstVersion.version as Record<string, unknown>;
    firstVersionSchema.const = 99;

    expect(((applicationSchema(second).properties as Record<string, unknown>).version as Record<string, unknown>).const).toBe(1);
    expect(createManagedReferenceManifest(second)).not.toBe(first);
    expect(createManagedReferenceManifest(second).managedState?.applicationSchema).not.toBe(first.managedState?.applicationSchema);
    expect(manifestSchema.safeParse(createManagedReferenceManifest(second)).success).toBe(true);
  });

  it('rejects other package IDs, a missing account claim, and a different existing state contract', async () => {
    const source = await sourceManifest();

    expect(() => createManagedReferenceManifest({ ...source, id: 'hasi.other' })).toThrow(/hasi\.reference/u);
    expect(() => createManagedReferenceManifest({ ...source, id: ' hasi.reference ' })).toThrow(/normalization/u);
    const withoutClaim = structuredClone(source);
    delete withoutClaim.identity;
    expect(() => createManagedReferenceManifest(withoutClaim)).toThrow(/reference\.account/u);

    const unexpected = createManagedReferenceManifest(source);
    const properties = unexpected.managedState?.applicationSchema.properties as Record<string, unknown>;
    properties.version = { const: 2 };
    expect(manifestSchema.safeParse(unexpected).success).toBe(true);
    expect(() => createManagedReferenceManifest(unexpected)).toThrow(/unexpected managed state contract/u);
  });

  it('rejects an input that fails the SDK manifest schema', async () => {
    const source = await sourceManifest();
    const malformed = { ...structuredClone(source), apiVersion: '1.0.0' };
    expect(() => createManagedReferenceManifest(malformed)).toThrow();
  });
});
