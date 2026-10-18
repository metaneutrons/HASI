import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { PostgresJsonStore } from '@hasi/state';
import { createProductionRuntime } from './production-runtime.js';
import { EnvironmentPluginSecretCustody } from './plugin-secrets.js';
import type { ActionPolicy } from './action-policy.js';
import { sourcePolicySchema } from './result-envelope.js';
import { digest } from '@hasi/plugin-sdk';

const label = z.string().min(1).max(256);
const slot = z.strictObject({ environmentName: z.string().regex(/^HASI_PLUGIN_SECRET_[A-Z0-9_]{1,80}$/), revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) });
const configSchema = z.strictObject({
  version: z.literal(1), scope: label, webOrigin: z.url(), apiHostname: label,
  oidc: z.strictObject({ issuer: z.url(), clientId: label }),
  plugins: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), label,
    endpoint: z.url(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), credential: slot,
    sourcePolicy: sourcePolicySchema,
    allowedPrivateCidrs: z.array(z.string().max(64)).max(16).optional(),
    secrets: z.record(z.string().max(128), slot).default({}),
  })).max(32),
  actions: z.record(z.string().max(128), z.record(z.string().max(256), z.strictObject({ effect: label, consequences: z.array(label).min(1).max(8), costs: label }))).default({}),
});

function required(name: 'HASI_PRIVATE_KEY' | 'DATABASE_URL' | 'HASI_OPERATOR_CONFIG') {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Required production server configuration unavailable');
  return value;
}

async function main() {
  if (process.env.HASI_MODE !== 'production') throw new Error('Explicit production mode required');
  const raw = await readFile(required('HASI_OPERATOR_CONFIG'), 'utf8');
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Oversized operator configuration');
  const configuration = configSchema.parse(JSON.parse(raw) as unknown);
  if (new Set(configuration.plugins.map(plugin => plugin.id)).size !== configuration.plugins.length) throw new Error('Duplicate installation identity');
  const store = new PostgresJsonStore(`production:${configuration.scope}`, { poolConfig: { connectionString: required('DATABASE_URL'), max: 8, connectionTimeoutMillis: 5000 } });
  await store.initialize();
  try {
    const plugins = await Promise.all(configuration.plugins.map(async plugin => {
      const transport = new EnvironmentPluginSecretCustody({ service: plugin.credential }, process.env);
      const serviceToken = await transport.use('service', value => Promise.resolve(value));
      return { id: plugin.id, label: plugin.label, registration: { instanceId: plugin.id, endpoint: plugin.endpoint, expectedManifestDigest: plugin.manifestDigest, allowLoopback: false, credentialRevision: plugin.credential.revision, serviceToken, sourcePolicy: plugin.sourcePolicy, secretCustody: new EnvironmentPluginSecretCustody(plugin.secrets, process.env), ...(plugin.allowedPrivateCidrs ? { allowedPrivateCidrs: plugin.allowedPrivateCidrs } : {}) } };
    }));
    const policies: Record<string, ActionPolicy> = {};
    // These public consequences are reviewed deployment policy; live source-specific quotes/terms
    // should supply a programmatic ActionPolicy through createProductionRuntime instead.
    for (const [id, tools] of Object.entries(configuration.actions)) policies[id] = {
      revision: digest(tools),
      preview: async input => {
        const terms = Object.hasOwn(tools, input.executionTool) ? tools[input.executionTool] : undefined;
        const source = plugins.find(plugin => plugin.id === id);
        const account = await runtime.directory.resolve(input.actor.subject);
        if (!terms || !source || !account) throw new Error('Action preview policy unavailable');
        return { ...terms, instance: source.label, account: account.displayName };
      },
      reconcile: async input => runtime.registry.reconcile(id, input.executionTool, { ...input.arguments }, input.actor, input.executionId, await runtime.registry.binding(id)),
    };
    const runtime = await createProductionRuntime({ privateKey: createPrivateKey(required('HASI_PRIVATE_KEY')), store, scope: configuration.scope, webOrigin: configuration.webOrigin, apiHostname: configuration.apiHostname, plugins, identity: { ...configuration.oidc, ...(process.env.HASI_OIDC_CLIENT_SECRET ? { clientSecret: process.env.HASI_OIDC_CLIENT_SECRET } : {}) }, actionPolicies: policies });
    runtime.app.addHook('onClose', async () => { await store.close(); });
    const port = Number(process.env.HASI_API_PORT ?? '4100');
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API port');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void runtime.app.close(); });
    await runtime.app.listen({ host: process.env.HASI_API_BIND_HOST ?? '127.0.0.1', port });
    console.info('HASI production API ready');
  } catch { await store.close(); throw new Error('Production startup failed'); }
}

await main().catch(() => { console.error('HASI production API startup failed; check operator configuration and service readiness.'); process.exitCode = 1; });
