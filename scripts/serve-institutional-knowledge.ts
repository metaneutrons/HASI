import { readFile } from 'node:fs/promises';
import { createPublicKey, randomUUID } from 'node:crypto';
import { ASSISTANT_BUDGET_NAMESPACE, ASSISTANT_BUDGET_POLICY, ModelBudgetLedger, PostgresJsonStore } from '@hasi/state';
import { createInstitutionalKnowledgePlugin, InstitutionalKnowledgeRepository } from '@hasi/knowledge-plugin';
import { createKnowledgeEmbeddingClient, KnowledgeIngestionWorker, EnvironmentPluginSecretCustody } from '../apps/api/src/index.js';
import { knowledgeRuntimeConfiguration } from './knowledge-runtime-config.js';

// Configuration contains public keys and logical secret bindings, never secret values.
const path = process.env.HASI_KNOWLEDGE_CONFIG;
if (!path || !process.env.DATABASE_URL) throw new Error('Operator knowledge configuration and durable database are required.');
const file = await readFile(path, 'utf8');
if (Buffer.byteLength(file) > 65_536) throw new Error('Knowledge configuration is too large.');
const config = knowledgeRuntimeConfiguration.parse(JSON.parse(file) as unknown);
const custody = new EnvironmentPluginSecretCustody(config.credentialSlots, process.env);
const slots = [config.serviceCredentialSlot, config.embedding.credentialSlot, ...config.sources.flatMap(source => source.credentialSlot ? [source.credentialSlot] : [])];
if (slots.some(slot => !custody.status(slot).configured)) throw new Error('Approved knowledge credential unavailable.');
const state = new PostgresJsonStore('institutional-knowledge:shared:v1', { poolConfig: { connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000 } });
const budgetState = new PostgresJsonStore(ASSISTANT_BUDGET_NAMESPACE, { poolConfig: { connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000 } });
let cleanup = async () => { await Promise.allSettled([state.close(), budgetState.close()]); };
try {
  await state.initialize();
  await budgetState.initialize();
  const ledger = new ModelBudgetLedger(budgetState, { ...ASSISTANT_BUDGET_POLICY, requireExistingState: true });
  // Never initialize or reset spending state from a worker/provider request.
  await ledger.snapshot();
  const embedding = createKnowledgeEmbeddingClient({
    endpoint: config.embedding.endpoint, modelId: config.embedding.modelId, dimensions: config.embedding.dimensions,
    allowedDataClasses: config.embedding.allowedDataClasses, custody, slot: config.embedding.credentialSlot,
    ...(config.embedding.allowedPrivateCidrs ? { allowedPrivateCidrs: config.embedding.allowedPrivateCidrs } : {}),
    budget: { reserve: async inputTokens => {
      const id = randomUUID();
      await ledger.reserve({ id, inputTokens, outputTokens: 0 });
      return { settle: usage => ledger.settle(id, usage) };
    } },
  });
  cleanup = async () => { await embedding.close(); await Promise.allSettled([state.close(), budgetState.close()]); };
  const repository = new InstitutionalKnowledgeRepository({ store: state, scope: config.scope, embedding,
    sources: config.sources.map(source => ({ sourceSystem: source.sourceSystem, origin: source.origin,
      publicKey: createPublicKey(source.publicKey), policyRevision: source.policyRevision, maxAgeMs: source.maxAgeMs })) });
  const worker = new KnowledgeIngestionWorker({ repository, intervalMs: config.intervalMs,
    sources: config.sources.map(source => ({ id: source.sourceSystem, exportUrl: source.exportUrl,
      ...(source.allowedPrivateCidrs ? { allowedPrivateCidrs: source.allowedPrivateCidrs } : {}),
      ...(source.credentialSlot ? { credential: { custody, slot: source.credentialSlot } } : {}) })) });
  cleanup = async () => { await worker.close(); await embedding.close(); await Promise.allSettled([state.close(), budgetState.close()]); };
  const plugin = await custody.use(config.serviceCredentialSlot, serviceToken => Promise.resolve(createInstitutionalKnowledgePlugin({
    repository, serviceToken, publicKey: createPublicKey(config.invocationPublicKey), allowedHosts: config.allowedHosts,
    consumeInvocation: (jti, expiresAt) => state.compareAndSet(`invocation:${jti}`, null, { consumed: true }, expiresAt * 1_000),
  })));
  cleanup = async () => { await worker.close(); await plugin.close(); await embedding.close(); await Promise.allSettled([state.close(), budgetState.close()]); };
  await plugin.listen({ port: config.port, host: '127.0.0.1' });
  worker.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void cleanup().catch(() => { process.exitCode = 1; }); });
} catch { await cleanup(); throw new Error('Institutional knowledge runtime startup failed.'); }
