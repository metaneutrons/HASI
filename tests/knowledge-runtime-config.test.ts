import { describe, expect, it } from 'vitest';
import { knowledgeRuntimeConfiguration } from '../scripts/knowledge-runtime-config.js';

function configuration() {
  return {
    scope: 'synthetic-runtime-test', port: 4103, allowedHosts: ['knowledge.example.edu'],
    invocationPublicKey: 'Public key fixture; constructor tests validate cryptographic format.',
    serviceCredentialSlot: 'service',
    credentialSlots: {
      service: { environmentName: 'HASI_PLUGIN_SECRET_KNOWLEDGE_SERVICE', revision: 'r1' },
      embedding: { environmentName: 'HASI_PLUGIN_SECRET_KNOWLEDGE_EMBEDDING', revision: 'r1' },
    },
    sources: ['service_it', 'intranet'].map(sourceSystem => ({ sourceSystem,
      origin: 'https://source.example.edu/', input: { type: 'signed_export', exportUrl: `https://exports.example.edu/${sourceSystem}.json` },
      publicKey: 'Public key fixture.', policyRevision: 'r1', maxAgeMs: 60_000 })),
    embedding: { endpoint: 'https://embedding.example.edu/v1/embeddings', modelId: 'synthetic-test-model',
      dimensions: 3, credentialSlot: 'embedding', allowedDataClasses: ['public', 'internal', 'confidential'],
      approvedInputMicroUsdPerMillion: 800_000 }, intervalMs: 30_000, ingestionTimeoutMs: 120_000,
  };
}

describe('operator knowledge runtime admission', () => {
  it('requires two distinct sources, declared custody slots and the full query processing ceiling', () => {
    const valid = configuration();
    expect(knowledgeRuntimeConfiguration.safeParse(valid).success).toBe(true);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, sources: [valid.sources[0], valid.sources[0]] }).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, embedding: { ...valid.embedding, credentialSlot: 'undeclared' } }).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, embedding: { ...valid.embedding, allowedDataClasses: ['public'] } }).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, credentialSlots: { ...valid.credentialSlots, embedding: { environmentName: 'NEXT_PUBLIC_EMBEDDING_KEY', revision: 'r1' } } }).success).toBe(false);
  });
  it('rejects unpriced, over-ceiling embedding calls and credentials in configuration', () => {
    const valid = configuration();
    for (const price of [0, -1, 800_001]) expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, embedding: { ...valid.embedding, approvedInputMicroUsdPerMillion: price } }).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...valid, embedding: { ...valid.embedding, apiKey: 'forbidden-inline-value' } }).success).toBe(false);
  });
});


describe('current source adapter runtime configuration', () => {
  it('accepts explicit per-source adapter chains and rejects missing custody, duplicate adapters and old flat input', () => {
    const base = configuration();
    const contentInput = { type: 'content_adapters', adapters: [
      { type: 'mediawiki', apiUrl: 'https://source.example.edu/w/api.php', requireAuthenticated: true },
      { type: 'web', container: { kind: 'id', value: 'mw-content-text' } },
    ], credential: { slot: 'source', mode: 'cookie' }, signingKeySlot: 'signer',
    policy: { completeInventory: true, validUntil: '2026-10-19T00:00:00Z', subjects: [], pages: [{
      id: 'int-guide', url: 'https://source.example.edu/wiki/Guide', title: 'Guide', language: 'en', classification: 'internal',
      acl: { authenticated: false, groups: ['staff'], subjects: [] },
    }] } };
    const configured = { ...base, credentialSlots: { ...base.credentialSlots,
      source: { environmentName: 'HASI_PLUGIN_SECRET_WIKI_SESSION', revision: 'r1' },
      signer: { environmentName: 'HASI_PLUGIN_SECRET_WIKI_SIGNER', revision: 'r1' } },
      sources: [base.sources[0], { ...base.sources[1], input: contentInput }] };
    expect(knowledgeRuntimeConfiguration.safeParse(configured).success).toBe(true);
    const replace = (input: unknown) => ({ ...configured, sources: [base.sources[0], { ...base.sources[1], input }] });
    expect(knowledgeRuntimeConfiguration.safeParse(replace({ ...contentInput, credential: undefined })).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse(replace({ ...contentInput, signingKeySlot: 'missing' })).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse(replace({ ...contentInput, adapters: [contentInput.adapters[0], contentInput.adapters[0]] })).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse({ ...configured, sources: [base.sources[0], {
      ...base.sources[1], input: undefined, exportUrl: 'https://exports.example.edu/old.json',
    }] }).success).toBe(false);
    expect(knowledgeRuntimeConfiguration.safeParse(replace({ ...contentInput, policy: { ...contentInput.policy,
      pages: [{ ...contentInput.policy.pages[0], url: 'https://unapproved.example/Guide' }] } })).success).toBe(false);
  });
});
