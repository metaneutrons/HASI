import { generateKeyPairSync } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
import type { ActorContext } from '@hasi/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeIngestionWorker } from '../apps/api/src/knowledge-worker.js';
import { signContentSnapshot } from '../apps/knowledge-plugin/src/content/acquisition.js';
import { ContentAcquisitionError } from '../apps/knowledge-plugin/src/content/contracts.js';
import {
  InstitutionalKnowledgeRepository,
  type InstitutionalKnowledgeRepositoryOptions,
} from '../apps/knowledge-plugin/src/institutional-repository.js';
import {
  type KnowledgeSourceExport,
  type KnowledgeSourceSystem,
  type SignedKnowledgeExport,
} from '../apps/knowledge-plugin/src/institutional-contracts.js';

const START = Date.parse('2026-10-18T10:00:00.000Z');
const sourceKeys = {
  service_it: generateKeyPairSync('ed25519'),
  intranet: generateKeyPairSync('ed25519'),
};

const reader: ActorContext = {
  subject: 'actor-reader',
  permissions: ['knowledge:read'],
  claims: {},
};

function sourceRoot(sourceSystem: KnowledgeSourceSystem): string {
  return sourceSystem === 'service_it'
    ? 'https://service.example.edu/knowledge/it'
    : 'https://intranet.example.edu/knowledge';
}

function snapshot(sourceSystem: KnowledgeSourceSystem, sequence: number, issuedAt: number): SignedKnowledgeExport {
  const id = sourceSystem === 'service_it' ? 'svc-guide-001' : 'int-guide-001';
  const exportSnapshot: KnowledgeSourceExport = {
    version: 1,
    sourceSystem,
    sequence,
    policyRevision: sourceSystem === 'service_it' ? 'service-policy-v1' : 'intranet-policy-v1',
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 15 * 60_000).toISOString(),
    embeddingModelId: 'revocation-test-embedder-v1',
    dimensions: 3,
    subjects: [{ subject: 'actor-reader', groups: ['students'] }],
    documents: [{
      id,
      revision: 1,
      title: sourceSystem === 'service_it' ? 'Service wireless guide' : 'Intranet access guide',
      language: 'en',
      canonicalUrl: `${sourceRoot(sourceSystem)}/${id}`,
      classification: 'internal',
      updatedAt: new Date(START).toISOString(),
      acl: { groups: ['students'], subjects: [], authenticated: false },
      text: 'Fictional campus wireless access guide for revocation tests.',
      vector: [1, 0, 0],
      images: [],
    }],
    retiredDocumentIds: [],
  };
  return signContentSnapshot(exportSnapshot, sourceKeys[sourceSystem].privateKey);
}

function repositoryOptions(store: MemoryJsonStore, now: () => number): InstitutionalKnowledgeRepositoryOptions & {
  queryEmbedding: ReturnType<typeof vi.fn>;
} {
  const queryEmbedding = vi.fn((_query: string, _signal: AbortSignal) => Promise.resolve([1, 0, 0]));
  return {
    store,
    scope: 'content-revocation-integration',
    sources: [
      {
        sourceSystem: 'service_it', origin: sourceRoot('service_it'), publicKey: sourceKeys.service_it.publicKey,
        policyRevision: 'service-policy-v1', maxAgeMs: 60 * 60_000,
      },
      {
        sourceSystem: 'intranet', origin: sourceRoot('intranet'), publicKey: sourceKeys.intranet.publicKey,
        policyRevision: 'intranet-policy-v1', maxAgeMs: 60 * 60_000,
      },
    ],
    embedding: {
      modelId: 'revocation-test-embedder-v1', dimensions: 3, allowedDataClasses: ['internal'],
      embedQuery: queryEmbedding,
    },
    clock: now,
    queryEmbedding,
  };
}

function repository(store: MemoryJsonStore, now: () => number) {
  const options = repositoryOptions(store, now);
  return {
    repository: new InstitutionalKnowledgeRepository(options),
    queryEmbedding: options.queryEmbedding,
  };
}

describe('institutional source refresh revocation', () => {
  it('blocks stale reads after a worker failure, fences races, and reopens only after a fresh signed snapshot', async () => {
    const store = new MemoryJsonStore('content-revocation-' + String(START));
    let currentTime = START;
    const now = () => currentTime;
    const existing = repository(store, now);
    const initialService = snapshot('service_it', 1, START);
    const initialIntranet = snapshot('intranet', 1, START);
    await existing.repository.ingest('service_it', initialService);
    await existing.repository.ingest('intranet', initialIntranet);
    currentTime += 60_000;
    expect(currentTime).toBeLessThan(Date.parse(initialService.snapshot.expiresAt));

    const successfulIntranetRefresh = snapshot('intranet', 2, currentTime);
    const worker = new KnowledgeIngestionWorker({
      sources: [
        {
          id: 'service_it',
          acquire: () => Promise.reject(new ContentAcquisitionError('unauthorized')),
        },
        { id: 'intranet', acquire: () => Promise.resolve(successfulIntranetRefresh) },
      ],
      repository: existing.repository,
      clock: () => new Date(currentTime),
    });
    try {
      const result = await worker.runOnce();
      expect(result.sources.map(({ sourceSystem, status }) => [sourceSystem, status])).toEqual([
        ['service_it', 'failed'], ['intranet', 'ingested'],
      ]);
    } finally {
      await worker.close();
    }

    const restarted = repository(store, now);
    await expect(existing.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(restarted.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(existing.queryEmbedding).not.toHaveBeenCalled();
    expect(restarted.queryEmbedding).not.toHaveBeenCalled();

    // A fence captured before a later suspension cannot reopen the source, even after new content lands.
    const staleRaceFence = await existing.repository.beginSourceRefresh('service_it');
    await existing.repository.suspendSource('service_it');
    await existing.repository.ingest('service_it', snapshot('service_it', 2, currentTime));
    await expect(existing.repository.finishSourceRefresh('service_it', staleRaceFence))
      .rejects.toMatchObject({ code: 'source_changed' });
    await expect(existing.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(restarted.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(existing.queryEmbedding).not.toHaveBeenCalled();
    expect(restarted.queryEmbedding).not.toHaveBeenCalled();

    const recoveryFence = await existing.repository.beginSourceRefresh('service_it');
    await expect(existing.repository.finishSourceRefresh('service_it', recoveryFence))
      .rejects.toMatchObject({ code: 'source_changed' });
    await expect(existing.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });

    await existing.repository.ingest('service_it', snapshot('service_it', 3, currentTime));
    await existing.repository.finishSourceRefresh('service_it', recoveryFence);
    await expect(existing.repository.getDocument(reader, { documentId: 'svc-guide-001' }))
      .resolves.toMatchObject({ document: { id: 'svc-guide-001' } });
    await expect(restarted.repository.getDocument(reader, { documentId: 'int-guide-001' }))
      .resolves.toMatchObject({ document: { id: 'int-guide-001' } });
  });
});
