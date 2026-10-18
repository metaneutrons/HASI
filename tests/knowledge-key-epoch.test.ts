import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { expect, it } from 'vitest';
import { digest } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import { InstitutionalKnowledgeRepository } from '../apps/knowledge-plugin/src/institutional-repository.js';
import type { KnowledgeSourceExport, KnowledgeSourceSystem } from '../apps/knowledge-plugin/src/institutional-contracts.js';

it('requires an explicit new scope and document namespace after source-key rotation', async () => {
  const oldKey = generateKeyPairSync('ed25519');
  const newKey = generateKeyPairSync('ed25519');
  const store = new MemoryJsonStore(`knowledge-key-epoch-${randomUUID()}`);
  const now = Date.parse('2026-10-18T12:00:00Z');
  const reader = { subject: 'key-epoch-test-user', permissions: ['knowledge:read'] };
  const repository = (scope: string, publicKey: KeyObject) => new InstitutionalKnowledgeRepository({
    store, scope, clock: () => now,
    sources: (['service_it', 'intranet'] as const).map(sourceSystem => ({ sourceSystem,
      origin: 'https://source.example.edu/', publicKey, policyRevision: 'approved-key-epoch', maxAgeMs: 60_000 })),
    embedding: { modelId: 'synthetic-embedding-fixture', dimensions: 2, allowedDataClasses: ['internal'], embedQuery: () => Promise.resolve([1, 0]) },
  });
  const snapshot = (sourceSystem: KnowledgeSourceSystem, id: string, sequence: number): KnowledgeSourceExport => ({
    version: 1, sourceSystem, sequence, policyRevision: 'approved-key-epoch', issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), embeddingModelId: 'synthetic-embedding-fixture', dimensions: 2,
    subjects: [{ subject: reader.subject, groups: ['readers'] }], retiredDocumentIds: [],
    documents: [{ id, revision: 1, title: 'Synthetic key-rotation test', language: 'de',
      canonicalUrl: `https://source.example.edu/${id}`, classification: 'internal', updatedAt: new Date(now).toISOString(),
      acl: { groups: ['readers'], subjects: [], authenticated: false }, text: 'Fictional test content.', vector: [1, 0], images: [] }],
  });
  const envelope = (value: KnowledgeSourceExport, privateKey: KeyObject) => ({ snapshot: value, signature: sign(null, Buffer.from(digest(value)), privateKey).toString('base64url') });
  const old = repository('old-key-epoch', oldKey.publicKey);
  for (const source of ['service_it', 'intranet'] as const) await old.ingest(source, envelope(snapshot(source, source === 'service_it' ? 'svc-old-001' : 'int-old-001', 1), oldKey.privateKey));
  const oldFence = await old.authorityFence(reader);
  const invalidInPlace = repository('old-key-epoch', newKey.publicKey);
  await expect(invalidInPlace.getDocument(reader, { documentId: 'svc-old-001' })).rejects.toThrow();
  await expect(invalidInPlace.ingest('service_it', envelope(snapshot('service_it', 'svc-new-001', 2), newKey.privateKey))).rejects.toThrow();
  const rotated = repository('new-key-epoch', newKey.publicKey);
  for (const source of ['service_it', 'intranet'] as const) await rotated.ingest(source, envelope(snapshot(source, source === 'service_it' ? 'svc-new-001' : 'int-new-001', 1), newKey.privateKey));
  expect((await rotated.getDocument(reader, { documentId: 'svc-new-001', revision: 1 })).document.id).toBe('svc-new-001');
  await expect(rotated.getDocument(reader, { documentId: 'svc-old-001', revision: 1 })).rejects.toMatchObject({ code: 'document_unavailable' });
  expect(await rotated.authorityFence(reader)).not.toBe(oldFence);
});
