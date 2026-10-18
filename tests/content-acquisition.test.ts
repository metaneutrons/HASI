import { generateKeyPairSync } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
import type { ActorContext } from '@hasi/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ContentSnapshotProducer,
  contentReviewDigest,
  signContentSnapshot,
  type ContentAcquisitionPolicy,
} from '../apps/knowledge-plugin/src/content/acquisition.js';
import {
  ContentAcquisitionError,
  type AcquiredContent,
  type ContentAdapter,
  type ContentPage,
} from '../apps/knowledge-plugin/src/content/contracts.js';
import {
  InstitutionalKnowledgeRepository,
} from '../apps/knowledge-plugin/src/institutional-repository.js';
import type { KnowledgeSourceSystem } from '../apps/knowledge-plugin/src/institutional-contracts.js';

const START = Date.parse('2026-10-18T10:00:00.000Z');
const MAX_AGE_MS = 60 * 60 * 1_000;
const sourceKeys = {
  service_it: generateKeyPairSync('ed25519'),
  intranet: generateKeyPairSync('ed25519'),
};
let namespaceNumber = 0;

function sourceOrigin(sourceSystem: KnowledgeSourceSystem): string {
  return sourceSystem === 'service_it' ? 'https://service.example.edu' : 'https://intranet.example.edu';
}

function sourceRoot(sourceSystem: KnowledgeSourceSystem): string {
  return sourceSystem === 'service_it'
    ? 'https://service.example.edu/knowledge/it'
    : 'https://intranet.example.edu/knowledge';
}

function pageFor(sourceSystem: KnowledgeSourceSystem, suffix = 'guide'): ContentAcquisitionPolicy['pages'][number] {
  const id = sourceSystem === 'service_it' ? `svc-${suffix}` : `int-${suffix}`;
  return {
    id,
    url: `${sourceRoot(sourceSystem)}/${suffix}`,
    title: suffix,
    language: 'en',
    classification: 'internal',
    acl: { groups: ['students'], subjects: [], authenticated: false },
  };
}

function policyFor(
  sourceSystem: KnowledgeSourceSystem,
  pages: ContentAcquisitionPolicy['pages'] = [pageFor(sourceSystem)],
  validUntil = new Date(START + 12 * 60 * 60 * 1_000).toISOString(),
): ContentAcquisitionPolicy {
  return {
    completeInventory: true,
    validUntil,
    pages,
    subjects: [{ subject: 'actor-reader', groups: ['students'] }],
  };
}

function producerFixture(options: {
  sourceSystem?: KnowledgeSourceSystem;
  store?: MemoryJsonStore;
  scope?: string;
  page?: ContentAcquisitionPolicy['pages'][number];
  pages?: ContentAcquisitionPolicy['pages'];
} = {}) {
  const sourceSystem = options.sourceSystem ?? 'service_it';
  const page = options.page ?? pageFor(sourceSystem);
  const pages = options.pages ?? [page];
  const policy = policyFor(sourceSystem, pages);
  const namespace = namespaceNumber++;
  const store = options.store ?? new MemoryJsonStore(`content-producer-test-${String(namespace)}`);
  const scope = options.scope ?? `content-producer-scope-${String(namespace)}`;
  let currentTime = START;
  let readCount = 0;
  let failure: Error | undefined;
  let current: AcquiredContent = {
    adapter: 'fixture',
    canonicalUrl: page.url,
    title: sourceSystem === 'service_it' ? 'Service guide' : 'Intranet guide',
    text: 'Fictional campus wireless access instructions.',
    sourceRevision: 'source-r1',
    acquiredAt: new Date(START).toISOString(),
    images: [],
  };
  const adapter: ContentAdapter = {
    id: 'fixture',
    read: vi.fn((requested: ContentPage) => {
      readCount += 1;
      if (failure !== undefined) throw failure;
      return Promise.resolve({ ...structuredClone(current), canonicalUrl: requested.url, acquiredAt: new Date(currentTime).toISOString() });
    }),
  };
  const embeddingCalls: string[] = [];
  const embedding = {
    modelId: 'approved-document-embedder-v1',
    dimensions: 3,
    allowedDataClasses: ['internal'],
    embedDocument: vi.fn((text: string) => {
      embeddingCalls.push(text);
      return Promise.resolve([1, 0, 0]);
    }),
  };
  const basePolicy = policy;
  const createProducer = (
    nextPolicy = basePolicy,
    policyRevision = 'fixture-policy-v1',
  ) => new ContentSnapshotProducer({
    sourceSystem,
    origin: sourceOrigin(sourceSystem),
    scope,
    policyRevision,
    maxAgeMs: MAX_AGE_MS,
    policy: nextPolicy,
    adapter,
    store,
    embedding,
    signSnapshot: snapshot => Promise.resolve(signContentSnapshot(snapshot, sourceKeys[sourceSystem].privateKey)),
    clock: () => new Date(currentTime),
  });

  return {
    sourceSystem,
    page,
    policy: basePolicy,
    scope,
    store,
    adapter,
    embedding,
    embeddingCalls,
    createProducer,
    setContent: (next: Partial<AcquiredContent>) => { current = { ...current, ...next }; },
    setFailure: (next: Error) => { failure = next; },
    setTime: (next: number) => { currentTime = next; },
    readCount: () => readCount,
  };
}

const reader: ActorContext = {
  subject: 'actor-reader',
  permissions: ['knowledge:read'],
  claims: {},
};

describe('content snapshot acquisition', () => {
  it('renews unchanged signed snapshots without re-embedding, bumps changed content, and leaves source time absent when unknown', async () => {
    const fixture = producerFixture();
    expect(fixture.policy.completeInventory).toBe(true);
    expect(Date.parse(fixture.policy.validUntil)).toBeGreaterThan(START);
    expect(Date.parse(fixture.policy.validUntil) - START).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    expect(fixture.policy.pages[0]?.acl).toEqual({ groups: ['students'], subjects: [], authenticated: false });
    expect(fixture.policy.subjects).toEqual([{ subject: 'actor-reader', groups: ['students'] }]);

    const first = await fixture.createProducer().acquire(new AbortController().signal);
    const firstDocument = first.snapshot.documents[0];
    expect(firstDocument).toMatchObject({
      id: 'svc-guide-c1', revision: 1,
      acl: { groups: ['students'], subjects: [], authenticated: false },
      acquisition: { adapter: 'fixture', sourceRevision: 'source-r1' },
    });
    expect(firstDocument?.acquisition).not.toHaveProperty('sourceUpdatedAt');
    expect(Date.parse(first.snapshot.expiresAt)).toBeLessThanOrEqual(Date.parse(fixture.policy.validUntil));
    expect(fixture.embeddingCalls).toHaveLength(1);

    fixture.setTime(START + 60_000);
    const renewed = await fixture.createProducer().acquire(new AbortController().signal);
    expect(renewed.snapshot.sequence).toBe(2);
    expect(renewed.snapshot.documents).toEqual(first.snapshot.documents);
    expect(renewed.snapshot.issuedAt).not.toBe(first.snapshot.issuedAt);
    expect(fixture.embeddingCalls).toHaveLength(1);

    fixture.setTime(START + 120_000);
    fixture.setContent({ text: 'Updated campus wireless instructions.', sourceRevision: 'source-r2' });
    const changed = await fixture.createProducer().acquire(new AbortController().signal);
    expect(changed.snapshot.sequence).toBe(3);
    expect(changed.snapshot.documents[0]).toMatchObject({ revision: 2, text: 'Updated campus wireless instructions.' });
    expect(changed.snapshot.documents[0]?.acquisition).toMatchObject({ sourceRevision: 'source-r2' });
    expect(fixture.embeddingCalls).toHaveLength(2);
  });

  it('bumps the document revision when reviewed source ACL policy changes', async () => {
    const fixture = producerFixture();
    const first = await fixture.createProducer().acquire(new AbortController().signal);
    const changedPolicy: ContentAcquisitionPolicy = {
      ...fixture.policy,
      pages: fixture.policy.pages.map(page => ({
        ...page,
        acl: { groups: ['admins'], subjects: [], authenticated: false },
      })),
    };

    const updated = await fixture.createProducer(changedPolicy, 'fixture-policy-v2').acquire(new AbortController().signal);

    expect(updated.snapshot.sequence).toBe(2);
    expect(updated.snapshot.policyRevision).toBe('fixture-policy-v2');
    expect(updated.snapshot.documents[0]).toMatchObject({ revision: 2, acl: { groups: ['admins'] } });
    expect(updated.snapshot.documents[0]?.id).toBe(first.snapshot.documents[0]?.id);
    expect(fixture.embeddingCalls).toHaveLength(1);
  });

  it('leaves the last persisted export and page state intact after a failed reacquisition', async () => {
    const fixture = producerFixture();
    const producerKey = `content-producer:${fixture.scope}:${fixture.sourceSystem}`;
    const first = await fixture.createProducer().acquire(new AbortController().signal);
    const before = await fixture.store.read(producerKey);
    fixture.setFailure(new ContentAcquisitionError('unauthorized'));

    await expect(fixture.createProducer().acquire(new AbortController().signal))
      .rejects.toMatchObject({ code: 'unauthorized' });

    const after = await fixture.store.read(producerKey);
    expect(after).toEqual(before);
    expect((after?.value as { envelope: typeof first }).envelope).toEqual(first);
    expect(fixture.embeddingCalls).toHaveLength(1);
  });

  it('tombstones only documents removed from the explicit inventory and never reuses retired chunk IDs', async () => {
    const pageOne = pageFor('service_it', 'guide');
    const pageTwo = pageFor('service_it', 'extra');
    const removalFixture = producerFixture({ pages: [pageOne, pageTwo] });
    const complete = await removalFixture.createProducer().acquire(new AbortController().signal);
    const removedId = complete.snapshot.documents.find(document => document.canonicalUrl === pageTwo.url)?.id;
    const reducedPolicy: ContentAcquisitionPolicy = { ...removalFixture.policy, pages: [pageOne] };
    const reduced = await removalFixture.createProducer(reducedPolicy).acquire(new AbortController().signal);
    expect(reduced.snapshot.documents.map(document => document.id)).toEqual(['svc-guide-c1']);
    expect(reduced.snapshot.retiredDocumentIds).toEqual([removedId]);

    const chunks = producerFixture();
    chunks.setContent({ text: 'x'.repeat(3_600) });
    const expanded = await chunks.createProducer().acquire(new AbortController().signal);
    expect(expanded.snapshot.documents.map(document => document.id)).toEqual(['svc-guide-c1', 'svc-guide-c2']);

    chunks.setContent({ text: 'shorter replacement', sourceRevision: 'source-r2' });
    const shrunk = await chunks.createProducer().acquire(new AbortController().signal);
    expect(shrunk.snapshot.documents.map(document => document.id)).toEqual(['svc-guide-c1']);
    expect(shrunk.snapshot.retiredDocumentIds).toEqual(['svc-guide-c2']);

    chunks.setContent({ text: 'y'.repeat(3_600), sourceRevision: 'source-r3' });
    const expandedAgain = await chunks.createProducer().acquire(new AbortController().signal);
    expect(expandedAgain.snapshot.documents.map(document => document.id)).toEqual(['svc-guide-c1', 'svc-guide-c3']);
    expect(expandedAgain.snapshot.retiredDocumentIds).toEqual(['svc-guide-c2']);
  });

  it('requires image review before embedding and rejects an expired operator policy before reading', async () => {
    const imageFixture = producerFixture();
    imageFixture.setContent({ images: [{ alt: 'Unreviewed setup diagram', sourceUrl: 'https://assets.example.edu/diagram.png' }] });

    await expect(imageFixture.createProducer().acquire(new AbortController().signal))
      .rejects.toMatchObject({ code: 'review_required' });
    expect(imageFixture.embedding.embedDocument).not.toHaveBeenCalled();
    expect(await imageFixture.store.read(`content-producer:${imageFixture.scope}:${imageFixture.sourceSystem}`)).toBeUndefined();

    const expiredFixture = producerFixture();
    const expiredPolicy = {
      ...expiredFixture.policy,
      validUntil: new Date(START - 1_000).toISOString(),
    };
    await expect(expiredFixture.createProducer(expiredPolicy).acquire(new AbortController().signal))
      .rejects.toMatchObject({ code: 'review_required' });
    expect(expiredFixture.readCount()).toBe(0);
    expect(expiredFixture.embedding.embedDocument).not.toHaveBeenCalled();
  });

  it('quarantines changed or unreviewed aggregate rendering before embeddings, including wiki transclusions', async () => {
    const fixture = producerFixture();
    const acquired: AcquiredContent = { adapter: 'mediawiki', canonicalUrl: fixture.page.url, title: 'Rendered guide',
      text: 'Reviewed guide including template instructions.', sourceRevision: '71', acquiredAt: new Date(START).toISOString(),
      images: [], requiresContentReview: true };
    fixture.setContent(acquired);
    await expect(fixture.createProducer().acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'review_required' });
    expect(fixture.embeddingCalls).toHaveLength(0);
    const approved = { ...fixture.policy, pages: fixture.policy.pages.map(page => ({ ...page, reviews: { mediawiki: { digest: contentReviewDigest(acquired, page, 'fixture-policy-v1') } } })) };
    await expect(fixture.createProducer(approved).acquire(new AbortController().signal)).resolves.toMatchObject({ snapshot: { sequence: 1 } });
    expect(fixture.embeddingCalls).toHaveLength(1);
    const broadened = { ...approved, pages: approved.pages.map(page => ({ ...page, acl: { ...page.acl, authenticated: true } })) };
    await expect(fixture.createProducer(broadened).acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'review_required' });
    expect(fixture.embeddingCalls).toHaveLength(1);
    const retargeted = { ...approved, pages: approved.pages.map(page => ({ ...page, url: page.url + '-other' })) };
    await expect(fixture.createProducer(retargeted).acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'review_required' });
    expect(fixture.embeddingCalls).toHaveLength(1);
    fixture.setContent({ text: 'Template changed while the parent revision is still 71.' });
    await expect(fixture.createProducer(approved).acquire(new AbortController().signal)).rejects.toMatchObject({ code: 'review_required' });
    expect(fixture.embeddingCalls).toHaveLength(1);
  });

  it('feeds signed snapshots for both mandatory sources into the repository and enforces the updated ACL', async () => {
    const producerStore = new MemoryJsonStore(`content-repository-producer-${String(namespaceNumber++)}`);
    const service = producerFixture({ sourceSystem: 'service_it', store: producerStore, scope: 'content-repository' });
    const intranet = producerFixture({ sourceSystem: 'intranet', store: producerStore, scope: 'content-repository' });
    await service.createProducer().acquire(new AbortController().signal);
    const intranetSnapshot = await intranet.createProducer(undefined, 'intranet-policy-v1').acquire(new AbortController().signal);
    const servicePolicyV2: ContentAcquisitionPolicy = {
      ...service.policy,
      pages: service.policy.pages.map(page => ({ ...page, acl: { groups: ['admins'], subjects: [], authenticated: false } })),
    };
    const serviceSnapshot = await service.createProducer(servicePolicyV2, 'service-policy-v2').acquire(new AbortController().signal);
    expect(serviceSnapshot.snapshot.documents[0]?.revision).toBe(2);

    const repositoryStore = new MemoryJsonStore(`content-repository-read-${String(namespaceNumber++)}`);
    const repository = new InstitutionalKnowledgeRepository({
      store: repositoryStore,
      scope: 'content-repository-read-scope',
      sources: [
        {
          sourceSystem: 'service_it', origin: sourceRoot('service_it'), publicKey: sourceKeys.service_it.publicKey,
          policyRevision: 'service-policy-v2', maxAgeMs: MAX_AGE_MS,
        },
        {
          sourceSystem: 'intranet', origin: sourceRoot('intranet'), publicKey: sourceKeys.intranet.publicKey,
          policyRevision: 'intranet-policy-v1', maxAgeMs: MAX_AGE_MS,
        },
      ],
      embedding: {
        modelId: 'approved-document-embedder-v1', dimensions: 3, allowedDataClasses: ['internal'],
        embedQuery: () => Promise.resolve([1, 0, 0]),
      },
      clock: () => START,
    });

    await repository.ingest('service_it', serviceSnapshot);
    await repository.ingest('intranet', intranetSnapshot);
    await expect(repository.getDocument(reader, { documentId: 'int-guide-c1' }))
      .resolves.toMatchObject({ document: { sourceSystem: 'intranet', revision: 1 } });
    await expect(repository.getDocument(reader, { documentId: 'svc-guide-c1' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(repository.getDocument({ ...reader, subject: 'unlisted-reader' }, { documentId: 'int-guide-c1' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
  });
});
