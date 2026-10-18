import { z } from 'zod';
import { digest, type ActorContext, type PluginManifest } from '@hasi/plugin-sdk';

export const sourcePolicySchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
  dataClasses: z.array(z.enum(['synthetic_demo', 'public', 'internal', 'confidential'])).min(1).max(4),
});
export type SourcePolicy = z.infer<typeof sourcePolicySchema>;
export interface ResultPaginationPolicy {
  /** Reviewed source adapter owns pagination semantics; free-text output cannot establish completeness. */
  describe(tool: string, output: Readonly<Record<string, unknown>>): { complete: boolean; nextCursor?: string };
}
export function resultEnvelope(input: { instanceId: string; manifest: PluginManifest; configurationRevision: number; actor: ActorContext; policy: SourcePolicy; output: Record<string, unknown>; tool: string; pagination?: ResultPaginationPolicy }) {
  if (Object.hasOwn(input.output, '_hasi')) throw new Error('Plugin attempted to forge host provenance');
  const policy = sourcePolicySchema.parse(input.policy);
  const pagination = input.pagination ? z.strictObject({ complete: z.boolean(), nextCursor: z.string().min(1).max(2048).optional() }).refine(value => !value.complete || value.nextCursor === undefined).parse(input.pagination.describe(input.tool, input.output)) : { complete: true };
  return {
    ...input.output,
    _hasi: {
      version: 1,
      provenance: { installationId: input.instanceId, packageId: input.manifest.id, version: input.manifest.version, manifestDigest: digest(input.manifest), configurationRevision: input.configurationRevision, authorizationDigest: digest(input.actor), fetchedAt: new Date().toISOString(), sourceId: policy.sourceId, policyRevision: policy.revision, dataClasses: policy.dataClasses },
      pagination: { mode: input.pagination ? 'paged' : 'unpaged', ...pagination },
    },
  };
}
