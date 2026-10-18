import { z } from 'zod';
import { ASSISTANT_BUDGET_POLICY } from '@hasi/state';
import { contentAdapterConfigurationSchema, contentAcquisitionPolicySchema } from '@hasi/knowledge-plugin';

const slot = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u);
const source = z.strictObject({
  sourceSystem: z.enum(['service_it', 'intranet']),
  origin: z.url(), publicKey: z.string().min(1).max(4_096),
  policyRevision: z.string().min(1).max(128), maxAgeMs: z.number().int().min(1_000).max(86_400_000),
  allowedPrivateCidrs: z.array(z.string().max(64)).max(16).optional(),
  input: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('signed_export'), exportUrl: z.url(), credentialSlot: slot.optional() }),
    z.strictObject({ type: z.literal('content_adapters'), adapters: z.array(contentAdapterConfigurationSchema).min(1).max(8),
      credential: z.strictObject({ slot, mode: z.enum(['bearer', 'cookie']) }).optional(),
      signingKeySlot: slot, policy: contentAcquisitionPolicySchema,
      minIntervalMs: z.number().int().min(100).max(10_000).default(250) }),
  ]),
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
  ingestionTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  intervalMs: z.number().int().min(1_000).max(300_000),
}).superRefine((config, ctx) => {
  if (new Set(config.sources.map(item => item.sourceSystem)).size !== 2)
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Both sources are required exactly once.' });
  if (new Set(config.embedding.allowedDataClasses).size !== 3)
    ctx.addIssue({ code: 'custom', path: ['embedding'], message: 'Approve the complete protected-query processing ceiling.' });
  for (const [index, source] of config.sources.entries()) {
    if (source.input.type !== 'content_adapters') continue;
    const input = source.input;
    const root = new URL(source.origin);
    const base = root.pathname.replace(/\/$/u, '');
    for (const page of input.policy.pages) {
      const url = new URL(page.url);
      if (url.origin !== root.origin || (base !== '' && url.pathname !== base && !url.pathname.startsWith(base + '/')))
        ctx.addIssue({ code: 'custom', path: ['sources', index, 'input', 'policy', 'pages'], message: 'Page is outside the canonical source root.' });
    }
    if (new Set(input.adapters.map(adapter => adapter.type)).size !== input.adapters.length)
      ctx.addIssue({ code: 'custom', path: ['sources', index, 'input', 'adapters'], message: 'Adapter types must be unique.' });
    if (input.adapters.some(adapter => adapter.type === 'mediawiki' && adapter.requireAuthenticated) && !input.credential)
      ctx.addIssue({ code: 'custom', path: ['sources', index, 'input'], message: 'Authenticated MediaWiki requires source credential custody.' });
  }
  for (const name of [config.serviceCredentialSlot, config.embedding.credentialSlot, ...config.sources.flatMap(item => item.input.type === 'signed_export'
    ? (item.input.credentialSlot ? [item.input.credentialSlot] : [])
    : [item.input.signingKeySlot, ...(item.input.credential ? [item.input.credential.slot] : [])])]) {
    if (!Object.hasOwn(config.credentialSlots, name))
      ctx.addIssue({ code: 'custom', path: ['credentialSlots'], message: 'Referenced credential slot is not configured.' });
  }
});
