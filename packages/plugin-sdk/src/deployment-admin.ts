import { z } from 'zod';
import { configurationDefinitionSchema, inspectBoundedJson, inspectJsonSchema } from './configuration.js';
import { presentationSchema } from './presentation.js';

// Browser-safe control-plane DTOs. Images, origins, launch options and secret
// references belong exclusively to the operator catalogue, never these inputs.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const base = { commandId: z.uuid(), expectedState: sha };
export const managedPluginCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('stage'), releaseId: id }),
  z.strictObject({ ...base, operation: z.literal('approve'), restorePlanId: id.optional() }),
  ...(['activate', 'cancel', 'rollback', 'reconcile', 'synchronize'] as const).map(operation => z.strictObject({ ...base, operation: z.literal(operation) })),
]);
export type ManagedPluginCommand = z.infer<typeof managedPluginCommandSchema>;
export const managedPluginReleaseSchema = z.strictObject({
  id, version: z.string().max(128), publisher: id, digest: sha,
  migration: z.enum(['none', 'reversible', 'irreversible']),
  license: z.string().min(1).max(128).nullable(), inventoryDigest: sha.nullable(), approved: z.boolean(),
});
export const managedPluginViewSchema = z.strictObject({
  id, label: z.string().min(1).max(200), stateToken: sha,
  status: z.enum(['empty', 'active', 'staging', 'stage-unknown', 'candidate-ready', 'review-required', 'activating', 'activation-unknown', 'rolling-back', 'rollback-unknown', 'discarding', 'discard-unknown']),
  configurationRevision: z.string().min(1).max(256), configurationReady: z.boolean(),
  current: managedPluginReleaseSchema.nullable(), previous: managedPluginReleaseSchema.nullable(), candidate: managedPluginReleaseSchema.nullable(),
  releases: z.array(managedPluginReleaseSchema).max(32),
  /** Configuration toggle labels only. Capability/identity review is separate. */
  tools: z.array(z.strictObject({ name: z.string().max(256), title: z.string().max(256), effect: z.enum(['read', 'prepare', 'execute']) })).max(64).optional(),
});
export type ManagedPluginView = z.infer<typeof managedPluginViewSchema>;
export const managedPluginCatalogSchema = z.strictObject({ installations: z.array(managedPluginViewSchema).max(32) });
export const managedPluginCommandResultSchema = z.strictObject({
  commandId: z.uuid(), status: z.enum(['running', 'completed', 'uncertain']),
  view: managedPluginViewSchema,
});
export type ManagedPluginCommandResult = z.infer<typeof managedPluginCommandResultSchema>;

export const MAX_MANAGED_PLUGIN_REVIEW_BYTES = 768 * 1_024;
const MAX_MANAGED_PLUGIN_REVIEW_CONTRACT_BYTES = 256 * 1_024;
const reviewJsonObjectSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  for (const issue of inspectJsonSchema(value)) {
    context.addIssue({
      code: 'custom',
      path: issue.path ? issue.path.split('/').filter(Boolean) : [],
      message: issue.message,
    });
  }
});
const reviewSchemaObject = (label: string) => z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (inspectBoundedJson(value, { maxBytes: MAX_MANAGED_PLUGIN_REVIEW_CONTRACT_BYTES, maxDepth: 32, maxNodes: 8_192 })) {
    context.addIssue({ code: 'custom', message: `${label} is not bounded JSON data` });
  }
  for (const issue of inspectJsonSchema(value)) {
    context.addIssue({
      code: 'custom',
      path: issue.path ? issue.path.split('/').filter(Boolean) : [],
      message: issue.message,
    });
  }
});
const reviewManagedStateSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(1_000_000),
  accountIdentity: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('subject') }),
    z.strictObject({ kind: z.literal('customerId') }),
    z.strictObject({ kind: z.literal('claim'), name: z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u) }),
  ]),
  applicationSchema: reviewJsonObjectSchema,
});
const reviewToolSchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(256),
  description: z.string().max(4_096),
  resultSemantics: z.strictObject({
    kind: z.enum(['generic', 'resources', 'bookings', 'knowledge', 'proposal']),
  }).nullable(),
  inputSchema: reviewSchemaObject('Tool input schema'),
  outputSchema: reviewSchemaObject('Tool output schema'),
  effect: z.enum(['read', 'prepare', 'execute']),
  requiredPermissions: z.array(z.string().trim().min(1).max(256)).max(128),
  visibility: z.array(z.enum(['model', 'app'])).min(1).max(2),
  presentationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).nullable(),
}).superRefine((tool, context) => {
  if (new Set(tool.requiredPermissions).size !== tool.requiredPermissions.length) {
    context.addIssue({ code: 'custom', path: ['requiredPermissions'], message: 'requiredPermissions must not contain duplicates' });
  }
  if (new Set(tool.visibility).size !== tool.visibility.length) {
    context.addIssue({ code: 'custom', path: ['visibility'], message: 'visibility must not contain duplicates' });
  }
  if (tool.presentationId && !tool.visibility.includes('app')) {
    context.addIssue({ code: 'custom', path: ['presentationId'], message: 'presentationId requires app visibility' });
  }
});
const reviewContractObjectSchema = z.strictObject({
  tools: z.array(reviewToolSchema).max(64),
  configurationSchema: configurationDefinitionSchema.nullable(),
  identityClaims: z.array(z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u)).max(64),
  secretRequirements: z.array(z.strictObject({ name: z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*$/u), required: z.boolean() })).max(32),
  presentations: z.array(presentationSchema).max(32),
  network: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({ mode: z.literal('internal'), name: z.string().min(1).max(63).regex(/^[a-z][a-z0-9-]*$/u) }),
  ]),
  ingress: z.strictObject({
    hostAddress: z.literal('127.0.0.1'),
    hostPort: z.number().int().min(1).max(65_535),
    containerPort: z.number().int().min(1).max(65_535),
    protocol: z.literal('tcp'),
  }).nullable(),
  managedState: reviewManagedStateSchema.nullable(),
}).superRefine((contract, context) => {
  if (new Set(contract.tools.map(tool => tool.name)).size !== contract.tools.length) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'tool names must not contain duplicates' });
  }
  if (new Set(contract.identityClaims).size !== contract.identityClaims.length) {
    context.addIssue({ code: 'custom', path: ['identityClaims'], message: 'identity claims must not contain duplicates' });
  }
  if (new Set(contract.secretRequirements.map(secret => secret.name)).size !== contract.secretRequirements.length) {
    context.addIssue({ code: 'custom', path: ['secretRequirements'], message: 'secret requirement names must not contain duplicates' });
  }
  const presentationIds = new Set(contract.presentations.map(presentation => presentation.id));
  if (new Set(presentationIds).size !== contract.presentations.length) {
    context.addIssue({ code: 'custom', path: ['presentations'], message: 'presentation ids must not contain duplicates' });
  }
  contract.tools.forEach((tool, index) => {
    if (tool.presentationId && !presentationIds.has(tool.presentationId)) {
      context.addIssue({ code: 'custom', path: ['tools', index, 'presentationId'], message: 'presentationId must name an approved presentation' });
    }
  });
  if ((contract.network.mode === 'none') !== (contract.ingress === null)) {
    context.addIssue({ code: 'custom', path: ['ingress'], message: 'ingress must match the validated network policy' });
  }
});
export const reviewContractSchema = z.unknown().superRefine((value, context) => {
  if (inspectBoundedJson(value, { maxBytes: MAX_MANAGED_PLUGIN_REVIEW_CONTRACT_BYTES, maxDepth: 40, maxNodes: 24_000 })) {
    context.addIssue({ code: 'custom', message: 'review contract is not bounded JSON data' });
  }
}).pipe(reviewContractObjectSchema);
export type ReviewContract = z.infer<typeof reviewContractSchema>;
export const managedPluginReviewSchema = z.unknown().superRefine((value, context) => {
  if (inspectBoundedJson(value, { maxBytes: MAX_MANAGED_PLUGIN_REVIEW_BYTES, maxDepth: 48, maxNodes: 48_000 })) {
    context.addIssue({ code: 'custom', message: 'managed plugin review is not bounded JSON data' });
  }
}).pipe(z.strictObject({
  installationId: id,
  stateToken: sha,
  currentDigest: sha.nullable(),
  candidateDigest: sha,
  current: reviewContractSchema.nullable(),
  candidate: reviewContractSchema,
}).superRefine((review, context) => {
  if ((review.currentDigest === null) !== (review.current === null)) {
    context.addIssue({ code: 'custom', path: ['current'], message: 'current contract must match currentDigest' });
  }
}));
export type ManagedPluginReview = z.infer<typeof managedPluginReviewSchema>;
