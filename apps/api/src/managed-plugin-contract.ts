import { z } from 'zod';
import { digest, manifestSchema, type PluginManifest } from '@hasi/plugin-sdk';

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const secretStatusSchema = z.strictObject({
  name: z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*$/u),
  configured: z.boolean(),
  revision: opaqueId.nullable(),
}).superRefine((status, context) => {
  if (status.configured !== (status.revision !== null)) {
    context.addIssue({ code: 'custom', path: ['revision'], message: 'credential revision must match configured status' });
  }
});

/** Read-only active contract shared from the trusted installer to the API host.
 * It contains approved public contract data and credential status only; secret
 * custody references and transport details remain inside the worker.
 */
export const managedPluginRuntimeContractSchema = z.strictObject({
  installationId: opaqueId,
  manifest: manifestSchema,
  manifestDigest: sha256,
  configurationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deploymentRevision: sha256,
  transportCredentialRevision: opaqueId,
  secretStatuses: z.array(secretStatusSchema).max(32),
  enabled: z.literal(true),
}).superRefine((contract, context) => {
  if (digest(contract.manifest) !== contract.manifestDigest) {
    context.addIssue({ code: 'custom', path: ['manifestDigest'], message: 'manifest digest does not match the manifest' });
  }

  const declaredSecrets = contract.manifest.manifestVersion === 2 ? contract.manifest.secrets ?? [] : [];
  const declaredNames = declaredSecrets.map(secret => secret.name);
  const statusNames = contract.secretStatuses.map(status => status.name);
  if (new Set(statusNames).size !== statusNames.length) {
    context.addIssue({ code: 'custom', path: ['secretStatuses'], message: 'secret status names must be unique' });
  }
  if (declaredNames.length !== statusNames.length || declaredNames.some(name => !statusNames.includes(name))) {
    context.addIssue({ code: 'custom', path: ['secretStatuses'], message: 'secret statuses must match the manifest declarations' });
  }
  for (const declaration of declaredSecrets) {
    if (declaration.required && !contract.secretStatuses.find(status => status.name === declaration.name)?.configured) {
      context.addIssue({ code: 'custom', path: ['secretStatuses'], message: 'required manifest secrets must be configured for an enabled contract' });
    }
  }
});

export type ManagedPluginRuntimeContract = z.infer<typeof managedPluginRuntimeContractSchema> & {
  manifest: PluginManifest;
};

