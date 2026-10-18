import { z } from 'zod';
import { ASSISTANT_BUDGET_POLICY } from '@hasi/state';

const slot = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u);
const source = z.strictObject({
  sourceSystem: z.enum(['service_it', 'intranet']),
  origin: z.url(), exportUrl: z.url(), publicKey: z.string().min(1).max(4_096),
  policyRevision: z.string().min(1).max(128), maxAgeMs: z.number().int().min(1_000).max(86_400_000),
  credentialSlot: slot.optional(), allowedPrivateCidrs: z.array(z.string().max(64)).max(16).optional(),
});
export const knowledgeRuntimeConfiguration = z.strictObject({
  scope: z.string().min(1).max(128), port: z.number().int().min(1_024).max(65_535),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(8),
  invocationPublicKey: z.string().min(1).max(4_096), serviceCredentialSlot: slot,
  credentialSlots: z.record(slot, z.strictObject({
    environmentName: z.string().regex(/^HASI_PLUGIN_SECRET_[A-Z0-9_]{1,80}$/u),
    revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  })),
  sources: z.array(source).length(2),
  embedding: z.strictObject({
    endpoint: z.url(), modelId: z.string().min(1).max(128), dimensions: z.number().int().min(1).max(2_048),
    credentialSlot: slot,
    // Queries can contain protected free text: the endpoint needs the complete deployment ceiling.
    allowedDataClasses: z.array(z.enum(['public', 'internal', 'confidential'])).length(3),
    approvedInputMicroUsdPerMillion: z.number().int().positive().max(ASSISTANT_BUDGET_POLICY.inputMicroUsdPerMillion),
    allowedPrivateCidrs: z.array(z.string().max(64)).max(16).optional(),
  }),
  intervalMs: z.number().int().min(1_000).max(300_000),
}).superRefine((config, ctx) => {
  if (new Set(config.sources.map(item => item.sourceSystem)).size !== 2)
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Both sources are required exactly once.' });
  if (new Set(config.embedding.allowedDataClasses).size !== 3)
    ctx.addIssue({ code: 'custom', path: ['embedding'], message: 'Approve the complete protected-query processing ceiling.' });
  for (const name of [config.serviceCredentialSlot, config.embedding.credentialSlot, ...config.sources.flatMap(item => item.credentialSlot ? [item.credentialSlot] : [])]) {
    if (!Object.hasOwn(config.credentialSlots, name))
      ctx.addIssue({ code: 'custom', path: ['credentialSlots'], message: 'Referenced credential slot is not configured.' });
  }
});
