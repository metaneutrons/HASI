import { z } from 'zod';

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
