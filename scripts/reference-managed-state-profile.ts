import {
  canonicalJson,
  MANAGED_STATE_MCP_VERSION,
  manifestSchema,
  type PluginManifestV2,
} from '@hasi/plugin-sdk';

const REFERENCE_PLUGIN_ID = 'hasi.reference';
const REFERENCE_ACCOUNT_CLAIM = 'reference.account';

function createApplicationSchema(): Record<string, unknown> {
  const executionBindingSchema = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      installationId: { type: 'string' },
      executionId: { type: 'string', format: 'uuid' },
      tool: { type: 'string' },
      argsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      configurationRevision: { type: 'integer', minimum: 0 },
    },
    required: ['subject', 'installationId', 'executionId', 'tool', 'argsHash', 'configurationRevision'],
    additionalProperties: false,
  };

  const resultSchema = {
    type: 'object',
    properties: {
      confirmed: { const: true },
      actionCount: { type: 'integer', minimum: 1 },
      label: { type: 'string' },
      account: { type: 'string' },
    },
    required: ['confirmed', 'actionCount', 'label', 'account'],
    additionalProperties: false,
  };

  return {
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
              binding: executionBindingSchema,
              account: { type: 'string' },
              result: resultSchema,
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
  };
}

function createManagedStateDeclaration(): NonNullable<PluginManifestV2['managedState']> {
  return {
    schemaVersion: 1,
    accountIdentity: { kind: 'claim', name: REFERENCE_ACCOUNT_CLAIM },
    applicationSchema: createApplicationSchema(),
  };
}

function asReferenceManifest(value: unknown): PluginManifestV2 {
  const manifest = manifestSchema.parse(value);
  if (canonicalJson(value) !== canonicalJson(manifest)) {
    throw new Error('The reference plugin manifest must not require normalization.');
  }
  if (manifest.manifestVersion !== 2 || manifest.id !== REFERENCE_PLUGIN_ID) {
    throw new Error(`Managed reference state is restricted to ${REFERENCE_PLUGIN_ID}.`);
  }
  if (!manifest.identity?.claims.includes(REFERENCE_ACCOUNT_CLAIM)) {
    throw new Error(`Managed reference state requires the ${REFERENCE_ACCOUNT_CLAIM} identity claim.`);
  }
  return manifest;
}

/**
 * Opts the fixed reference plugin into managed MCP state before packaging and
 * signing. A manifest with a different state contract is rejected.
 */
export function createManagedReferenceManifest(value: unknown): PluginManifestV2 {
  const manifest = asReferenceManifest(value);
  const managedState = createManagedStateDeclaration();

  if (manifest.managedState !== undefined
    && canonicalJson(manifest.managedState) !== canonicalJson(managedState)) {
    throw new Error('The reference plugin already declares an unexpected managed state contract.');
  }

  const output = {
    ...manifest,
    mcpVersion: MANAGED_STATE_MCP_VERSION,
    managedState,
  };
  const validated = manifestSchema.parse(output);
  if (validated.manifestVersion !== 2) {
    throw new Error('Managed reference state requires a v2 plugin manifest.');
  }
  return validated;
}
