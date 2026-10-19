import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { PostgresJsonStore } from '@hasi/state';
import { KnowledgeIngestionWorker, type KnowledgeSourceRegistration } from '../apps/api/src/knowledge-worker.js';
import { KnowledgeContextStore } from '../apps/api/src/knowledge-context.js';
import { ContentSnapshotProducer, signContentSnapshot, type ContentAcquisitionPolicy } from '../apps/knowledge-plugin/src/content/acquisition.js';
import { ContentAcquisitionError, type ContentAdapter } from '../apps/knowledge-plugin/src/content/contracts.js';
import {
  InstitutionalKnowledgeRepository,
} from '../apps/knowledge-plugin/src/institutional-repository.js';
import type { KnowledgeSourceSystem } from '../apps/knowledge-plugin/src/institutional-contracts.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const START = Date.now();
const MAX_AGE_MS = 60 * 60_000;
const MODEL_ID = 'postgres-recovery-test-embedder-v1';
const DIMENSIONS = 3;
const sourceKeys = {
  service_it: generateKeyPairSync('ed25519'),
  intranet: generateKeyPairSync('ed25519'),
};

if (testDatabaseUrl === undefined) {
  describe.skip('PostgreSQL-backed knowledge recovery', () => {
    it('is skipped because TEST_DATABASE_URL is not set', () => undefined);
  });
} else {
  describe('PostgreSQL-backed knowledge recovery', () => {
    it('persists source suspension and context authority through store reconstruction, fences stale refreshes, and recovers from a fresh signed snapshot', async () => {
      const namespace = `knowledge-recovery-${randomUUID()}`;
      const scope = `recovery-${randomUUID()}`;
      const contextScope = `context-${randomUUID()}`;
      const installationBinding = 'synthetic-knowledge-installation-v1';
      const contextPrivateKey = generateKeyPairSync('ed25519').privateKey;
      let store: PostgresJsonStore | undefined;
      let contextIdForCleanup: string | undefined;
      let releasePendingStaleRun: (() => void) | undefined;
      const workers = new Set<KnowledgeIngestionWorker>();
      const nowMs = START;
      const now = () => new Date(nowMs);
      const actors = new Map<string, ActorContext>([
        ['employee', { subject: 'employee', permissions: ['knowledge:read'], claims: {} }],
        ['student', { subject: 'student', permissions: ['knowledge:read'], claims: {} }],
        ['replacement', { subject: 'replacement', permissions: ['knowledge:read'], claims: {} }],
      ]);
      const documentEmbeddingCalls = { count: 0 };

      const closeWorkers = async () => {
        const active = [...workers];
        workers.clear();
        await Promise.all(active.map(worker => worker.close()));
      };
      const closeRuntime = async () => {
        await closeWorkers();
        const activeStore = store;
        store = undefined;
        await activeStore?.close();
      };
      const openRuntime = async () => {
        const nextStore = new PostgresJsonStore(namespace, {
          poolConfig: { connectionString: testDatabaseUrl, max: 4 },
        });
        await nextStore.initialize();
        store = nextStore;
      };
      const registerWorker = (worker: KnowledgeIngestionWorker) => {
        workers.add(worker);
        return worker;
      };
      const createRepository = (activeStore: PostgresJsonStore) => {
        let queryEmbeddingCalls = 0;
        const repository = new InstitutionalKnowledgeRepository({
          store: activeStore,
          scope,
          sources: (['service_it', 'intranet'] as const).map(sourceSystem => ({
            sourceSystem,
            origin: sourceOrigin(sourceSystem),
            publicKey: sourceKeys[sourceSystem].publicKey,
            policyRevision: `${sourceSystem}-synthetic-v1`,
            maxAgeMs: MAX_AGE_MS,
          })),
          embedding: {
            modelId: MODEL_ID,
            dimensions: DIMENSIONS,
            allowedDataClasses: ['internal'],
            embedQuery: () => {
              queryEmbeddingCalls += 1;
              return Promise.resolve([1, 0, 0]);
            },
          },
          clock: () => nowMs,
        });
        return { repository, queryEmbeddingCalls: () => queryEmbeddingCalls };
      };
      const createContexts = (activeStore: PostgresJsonStore, repository: InstitutionalKnowledgeRepository) => new KnowledgeContextStore({
        store: activeStore,
        scope: contextScope,
        privateKey: contextPrivateKey,
        clock: () => nowMs,
        authorityFence: async subject => {
          const actor = actors.get(subject);
          if (!actor) throw new Error('Synthetic actor is unavailable.');
          return repository.authorityFence(actor);
        },
        resolveDocument: async (subject, reference) => {
          const actor = actors.get(subject);
          if (!actor) return undefined;
          try {
            return (await repository.getDocument(actor, {
              documentId: reference.documentId,
              revision: reference.revision,
            })).document;
          } catch {
            return undefined;
          }
        },
      });
      const createProducer = (
        activeStore: PostgresJsonStore,
        sourceSystem: KnowledgeSourceSystem,
        includeEmployeeGrant: boolean,
        includeReplacementGrant = false,
      ) => {
        const origin = new URL(sourceOrigin(sourceSystem)).origin;
        const pageUrl = `${origin}/${sourceSystem === 'service_it' ? 'knowledge/it/wireless' : 'wiki/employee-access'}`;
        const pageId = sourceSystem === 'service_it' ? 'svc-pg-wireless' : 'int-pg-employee-access';
        const pageAcl = { authenticated: false, groups: ['employees'], subjects: [] };
        const policy: ContentAcquisitionPolicy = {
          completeInventory: true,
          validUntil: new Date(nowMs + 24 * 60 * 60_000).toISOString(),
          pages: [{
            id: pageId,
            url: pageUrl,
            language: 'en',
            classification: 'internal',
            acl: pageAcl,
          }],
          subjects: [
            ...(includeEmployeeGrant ? [{ subject: 'employee', groups: ['employees'] }] : []),
            { subject: 'student', groups: ['students'] },
            ...(includeReplacementGrant ? [{ subject: 'replacement', groups: ['employees'] }] : []),
          ],
        };
        const adapter: ContentAdapter = {
          id: 'web',
          read: page => Promise.resolve({
            adapter: 'web',
            canonicalUrl: page.url,
            title: sourceSystem === 'service_it' ? 'Synthetic wireless guide' : 'Synthetic employee access guide',
            text: sourceSystem === 'service_it'
              ? 'Synthetic employee wireless access instructions.'
              : 'Synthetic employee access instructions.',
            language: 'en',
            sourceRevision: 'fixture-revision-1',
            acquiredAt: now().toISOString(),
            images: [],
          }),
        };
        return new ContentSnapshotProducer({
          sourceSystem,
          origin,
          scope,
          policyRevision: `${sourceSystem}-synthetic-v1`,
          maxAgeMs: MAX_AGE_MS,
          policy,
          adapter,
          store: activeStore,
          embedding: {
            modelId: MODEL_ID,
            dimensions: DIMENSIONS,
            allowedDataClasses: ['internal'],
            embedDocument: () => {
              documentEmbeddingCalls.count += 1;
              return Promise.resolve([1, 0, 0]);
            },
          },
          signSnapshot: snapshot => Promise.resolve(signContentSnapshot(snapshot, sourceKeys[sourceSystem].privateKey)),
          clock: now,
        });
      };
      const sourceRows = (
        serviceIt: (signal: AbortSignal) => Promise<unknown>,
        intranet: (signal: AbortSignal) => Promise<unknown>,
      ): KnowledgeSourceRegistration[] => [
        { id: 'service_it' as const, acquire: serviceIt },
        { id: 'intranet' as const, acquire: intranet },
      ];
      const ownedStoreKeys = () => [
        ...(['service_it', 'intranet'] as const).flatMap(sourceSystem => {
          const repositoryKey = `institutional-knowledge:v1:${digest({ scope, sourceSystem })}`;
          return [repositoryKey, `${repositoryKey}:availability`, `content-producer:${scope}:${sourceSystem}`];
        }),
        ...(contextIdForCleanup
          ? [`knowledge-context:v1:${digest({ scope: contextScope, contextId: contextIdForCleanup })}`]
          : []),
      ];
      const cleanupOwnedKeys = async (activeStore: PostgresJsonStore) => {
        const keys = ownedStoreKeys();
        await Promise.all(keys.map(key => activeStore.delete(key)));
        const remaining = await Promise.all(keys.map(key => activeStore.read(key)));
        expect(remaining).toEqual(keys.map(() => undefined));
      };

      try {
        await openRuntime();

        const initialRepository = createRepository(store!).repository;
        const serviceProducer = createProducer(store!, 'service_it', true);
        const intranetProducer = createProducer(store!, 'intranet', true);
        const initialWorker = registerWorker(new KnowledgeIngestionWorker({
          sources: sourceRows(
            signal => serviceProducer.acquire(signal),
            signal => intranetProducer.acquire(signal),
          ),
          repository: initialRepository,
          clock: now,
        }));
        const initialRun = await initialWorker.runOnce();
        expect(initialRun.sources.map(({ sourceSystem, status }) => [sourceSystem, status])).toEqual([
          ['service_it', 'ingested'],
          ['intranet', 'ingested'],
        ]);

        const initialSearch = await initialRepository.search(actors.get('employee')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        });
        expect(initialSearch.documents).toHaveLength(1);
        const initialDocument = initialSearch.documents[0]!;
        expect(initialDocument.citationId).toBe(`knowledge:service_it:${initialDocument.id}:1`);
        expect(await initialRepository.search(actors.get('student')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        })).toMatchObject({ documents: [] });
        await expect(initialRepository.getDocument(actors.get('student')!, {
          documentId: initialDocument.id,
          revision: 1,
        })).rejects.toMatchObject({ code: 'document_unavailable' });

        const initialContexts = createContexts(store!, initialRepository);
        const { contextId } = await initialContexts.issue('employee', installationBinding, initialSearch.documents);
        contextIdForCleanup = contextId;
        await expect(initialContexts.resolve('employee', contextId, installationBinding))
          .resolves.toMatchObject({ status: 'valid', documents: [{ id: initialDocument.id }] });
        await expect(initialContexts.resolve('student', contextId, installationBinding))
          .resolves.toEqual({ status: 'unavailable' });

        const failedWorker = registerWorker(new KnowledgeIngestionWorker({
          sources: sourceRows(
            () => Promise.reject(new ContentAcquisitionError('unauthorized')),
            signal => intranetProducer.acquire(signal),
          ),
          repository: initialRepository,
          clock: now,
        }));
        const failedRun = await failedWorker.runOnce();
        expect(failedRun.sources.map(({ sourceSystem, status }) => [sourceSystem, status])).toEqual([
          ['service_it', 'failed'],
          ['intranet', 'ingested'],
        ]);

        await closeRuntime();
        await openRuntime();

        const recoveredRepositoryState = createRepository(store!);
        const recoveredRepository = recoveredRepositoryState.repository;
        const recoveredContexts = createContexts(store!, recoveredRepository);
        expect(await recoveredContexts.resolve('employee', contextId, installationBinding))
          .toEqual({ status: 'unavailable' });
        await expect(recoveredRepository.search(actors.get('employee')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        })).rejects.toMatchObject({ code: 'source_unavailable' });
        await expect(recoveredRepository.getDocument(actors.get('employee')!, {
          documentId: initialDocument.id,
          revision: 1,
        })).rejects.toMatchObject({ code: 'source_unavailable' });
        expect(recoveredRepositoryState.queryEmbeddingCalls()).toBe(0);

        const staleProducer = createProducer(store!, 'service_it', true);
        const currentIntranetProducer = createProducer(store!, 'intranet', true);
        let releaseStaleRefresh: (() => void) | undefined;
        let signalStalePrepared: (() => void) | undefined;
        const staleRefreshGate = new Promise<void>(resolve => {
          releaseStaleRefresh = resolve;
          releasePendingStaleRun = resolve;
        });
        const stalePrepared = new Promise<void>(resolve => { signalStalePrepared = resolve; });
        const staleWorker = registerWorker(new KnowledgeIngestionWorker({
          sources: sourceRows(
            async signal => {
              const signed = await staleProducer.acquire(signal);
              signalStalePrepared?.();
              await staleRefreshGate;
              return signed;
            },
            signal => currentIntranetProducer.acquire(signal),
          ),
          repository: recoveredRepository,
          clock: now,
        }));
        const staleRunPromise = staleWorker.runOnce();
        await stalePrepared;

        const concurrentFailureWorker = registerWorker(new KnowledgeIngestionWorker({
          sources: sourceRows(
            () => Promise.reject(new ContentAcquisitionError('unavailable')),
            signal => currentIntranetProducer.acquire(signal),
          ),
          repository: recoveredRepository,
          clock: now,
        }));
        const concurrentFailure = await concurrentFailureWorker.runOnce();
        expect(concurrentFailure.sources.find(({ sourceSystem }) => sourceSystem === 'service_it')?.status).toBe('failed');
        await concurrentFailureWorker.close();
        workers.delete(concurrentFailureWorker);

        releaseStaleRefresh?.();
        const staleRun = await staleRunPromise;
        expect(staleRun.sources.find(({ sourceSystem }) => sourceSystem === 'service_it')?.status).toBe('failed');
        await staleWorker.close();
        workers.delete(staleWorker);
        await expect(recoveredRepository.getDocument(actors.get('employee')!, {
          documentId: initialDocument.id,
          revision: 1,
        })).rejects.toMatchObject({ code: 'source_unavailable' });
        expect(recoveredRepositoryState.queryEmbeddingCalls()).toBe(0);

        const recoveryProducer = createProducer(store!, 'service_it', false, true);
        const recoveryWorker = registerWorker(new KnowledgeIngestionWorker({
          sources: sourceRows(
            signal => recoveryProducer.acquire(signal),
            signal => currentIntranetProducer.acquire(signal),
          ),
          repository: recoveredRepository,
          clock: now,
        }));
        const recoveryRun = await recoveryWorker.runOnce();
        expect(recoveryRun.sources.map(({ sourceSystem, status }) => [sourceSystem, status])).toEqual([
          ['service_it', 'ingested'],
          ['intranet', 'ingested'],
        ]);

        await expect(recoveredRepository.search(actors.get('employee')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        })).resolves.toMatchObject({ documents: [] });
        await expect(recoveredRepository.search(actors.get('student')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        })).resolves.toMatchObject({ documents: [] });
        const replacementSearch = await recoveredRepository.search(actors.get('replacement')!, {
          query: 'employee wireless access instructions',
          sourceSystem: 'service_it',
        });
        expect(replacementSearch.documents).toHaveLength(1);
        const replacementDocument = replacementSearch.documents[0]!;
        await expect(recoveredRepository.getDocument(actors.get('replacement')!, {
          documentId: replacementDocument.id,
          revision: replacementDocument.revision,
        })).resolves.toMatchObject({
          document: { citationId: replacementDocument.citationId, id: replacementDocument.id },
        });
        await expect(recoveredRepository.getDocument(actors.get('employee')!, {
          documentId: initialDocument.id,
          revision: 1,
        })).rejects.toMatchObject({ code: 'document_unavailable' });
        await expect(recoveredContexts.resolve('employee', contextId, installationBinding))
          .resolves.toEqual({ status: 'unavailable' });
        expect(documentEmbeddingCalls.count).toBe(2);

        const producerState = await store!.read(`content-producer:${scope}:service_it`);
        expect(producerState?.value).toMatchObject({ envelope: { snapshot: { sequence: 3 } } });
      } finally {
        releasePendingStaleRun?.();
        try {
          await closeWorkers();
          if (!store) await openRuntime();
          await cleanupOwnedKeys(store!);
        } finally {
          await closeRuntime();
        }
      }
    });
  });
}

function sourceOrigin(sourceSystem: KnowledgeSourceSystem): string {
  return sourceSystem === 'service_it'
    ? 'https://service.example.edu/'
    : 'https://intranet.example.edu/';
}
