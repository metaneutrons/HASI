import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createInvocationToken, digest, type ActorContext } from '@hasi/plugin-sdk';
import { MemoryJsonStore } from '@hasi/state';
import {
  InstitutionalKnowledgeRepository,
  type InstitutionalKnowledgeSource,
  type InstitutionalKnowledgeRepositoryOptions,
} from '../apps/knowledge-plugin/src/institutional-repository.js';
import {
  createInstitutionalKnowledgePlugin,
  institutionalKnowledgeManifest,
} from '../apps/knowledge-plugin/src/institutional-plugin.js';
import type {
  KnowledgeDocumentExport,
  KnowledgeDocumentV2,
  KnowledgeSourceClassification,
  KnowledgeSourceExport,
  KnowledgeSourceSystem,
  SignedKnowledgeExport,
} from '../apps/knowledge-plugin/src/institutional-contracts.js';

const sourceKeys = {
  service_it: generateKeyPairSync('ed25519'),
  intranet: generateKeyPairSync('ed25519'),
};
const pluginKeys = generateKeyPairSync('ed25519');
const serviceToken = 'institutional-knowledge-test-service-token';
const openPlugins: ReturnType<typeof createInstitutionalKnowledgePlugin>[] = [];
let storeCounter = 0;

afterEach(async () => {
  await Promise.all(openPlugins.splice(0).map((plugin) => plugin.close()));
});

describe('institutional knowledge repository', () => {
  it('keeps evidence stable across identical signed heartbeats but invalidates changed grants', async () => {
    const fixture = repositoryFixture();
    const documents = [document('service_it', 'svc-heartbeat')];
    await seedBoth(fixture.repository, fixture.now(), { service_it: documents, intranet: [] });
    const before = (await fixture.repository.getDocument(reader, { documentId: 'svc-heartbeat' })).document;
    const fence = await fixture.repository.authorityFence(reader);
    fixture.advance(60_000);
    const renewed = createSnapshot('service_it', 2, documents, fixture.now());
    await fixture.repository.ingest('service_it', signedExport(renewed, sourceKeys.service_it.privateKey));
    const after = (await fixture.repository.getDocument(reader, { documentId: 'svc-heartbeat' })).document;
    expect(after.authorityRevision).toBe(before.authorityRevision);
    expect(after.corpusRevision).toBe(before.corpusRevision);
    expect(after.fetchedAt).not.toBe(before.fetchedAt);
    expect(await fixture.repository.authorityFence(reader)).toBe(fence);
    const revoked = { ...renewed, sequence: 3, subjects: [] };
    await fixture.repository.ingest('service_it', signedExport(revoked, sourceKeys.service_it.privateKey));
    expect(await fixture.repository.authorityFence(reader)).not.toBe(fence);
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-heartbeat' })).rejects.toMatchObject({ code: 'document_unavailable' });
  });

  it('requires both pinned Ed25519 sources and rejects origins with query data', () => {
    const common = repositoryOptions();
    expect(() => new InstitutionalKnowledgeRepository({ ...common, sources: common.sources.slice(0, 1) })).toThrow();
    expect(() => new InstitutionalKnowledgeRepository({
      ...common,
      sources: common.sources.map((source) => source.sourceSystem === 'service_it'
        ? { ...source, origin: 'https://service.example.edu/knowledge/it?token=bad' }
        : source),
    })).toThrow();
  });

  it('verifies signed full snapshots and authorizes from fresh source grants before hybrid ranking', async () => {
    const fixture = repositoryFixture();
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [
        document('service_it', 'svc-wireless-001', {
          title: 'WLAN Zugang',
          text: 'Eduroam campus wireless access is available in this fictional guide.',
          acl: { groups: ['students'], subjects: [], authenticated: false },
          vector: [1, 0, 0],
        }),
        document('service_it', 'svc-private-001', {
          title: 'Administration access policy',
          text: 'Admin-only access and confidential procedures.',
          acl: { groups: ['admins'], subjects: [], authenticated: false },
          vector: [0, 1, 0],
        }),
      ],
      intranet: [
        document('intranet', 'int-software-001', {
          title: 'Software access',
          text: 'Request access to the fictional software portal.',
          acl: { groups: ['students'], subjects: [], authenticated: false },
          vector: [0, 1, 0],
        }),
      ],
    });

    const german = await fixture.repository.search(reader, { query: 'WLAN Campus', limit: 1 });
    expect(german.documents.map(({ id }) => id)).toEqual(['svc-wireless-001']);
    const english = await fixture.repository.search(reader, { query: 'software access' });
    expect(english.documents[0]?.id).toBe('int-software-001');
    expect(english.documents[0]).toMatchObject({
      synthetic: false,
      sourceSystem: 'intranet',
      citationId: 'knowledge:intranet:int-software-001:1',
      dataClass: 'internal',
    });
    expect(fixture.embeddingCalls()).toBe(2);

    const firstRead = await fixture.repository.getDocument(reader, { documentId: 'svc-wireless-001' });
    fixture.advance(1_000);
    const repeatedRead = await fixture.repository.getDocument(reader, { documentId: 'svc-wireless-001' });
    expect(repeatedRead.document).toEqual(firstRead.document);
    expect(repeatedRead.document.fetchedAt).toBe('2026-10-18T10:00:00.000Z');

    const forgedBrowserGroups: ActorContext = {
      ...reader,
      subject: 'unlisted-actor',
      claims: { 'hasi.groups': ['admins'] },
    };
    await expect(fixture.repository.search(forgedBrowserGroups, { query: 'administration access' }))
      .resolves.toEqual({ documents: [] });
    await expect(fixture.repository.getDocument(forgedBrowserGroups, { documentId: 'svc-private-001' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
  });

  it('requires knowledge:read and does not infer document access from public classification', async () => {
    const fixture = repositoryFixture();
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [document('service_it', 'svc-public-001', {
        classification: 'public',
        acl: { groups: ['public-readers'], subjects: [], authenticated: false },
      })],
      intranet: [],
    });
    await expect(fixture.repository.search(reader, { query: 'wireless access' }))
      .resolves.toEqual({ documents: [] });
    await expect(fixture.repository.search({ ...reader, permissions: [] }, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(fixture.repository.getDocument({ ...reader, permissions: [] }, { documentId: 'svc-public-001' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('requires a current source grant even when the source marks a document authenticated', async () => {
    const fixture = repositoryFixture();
    const authenticated = document('service_it', 'svc-authenticated-001', {
      acl: { groups: [], subjects: [], authenticated: true },
    });
    const snapshot = createSnapshot('service_it', 1, [authenticated], fixture.now());
    snapshot.subjects = [];
    await fixture.repository.ingest('service_it', signedExport(snapshot, sourceKeys.service_it.privateKey));
    await fixture.repository.ingest('intranet', signedExport(
      createSnapshot('intranet', 1, [], fixture.now()),
      sourceKeys.intranet.privateKey,
    ));
    await expect(fixture.repository.getDocument(reader, { documentId: authenticated.id }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
  });

  it('atomically replaces source snapshots, removes deletions, changes ACLs, and rejects replay or reused revisions', async () => {
    const fixture = repositoryFixture();
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [
        document('service_it', 'svc-change-001', { title: 'Wireless guide' }),
        document('service_it', 'svc-delete-001', { title: 'Deleted guide' }),
      ],
      intranet: [],
    });
    const before = await fixture.repository.authorityFence(reader);
    const next = createSnapshot('service_it', 2, [
      document('service_it', 'svc-change-001', {
        revision: 2,
        title: 'Updated wireless guide',
        acl: { groups: ['admins'], subjects: [], authenticated: false },
      }),
    ], fixture.now(), 600_000, ['svc-delete-001']);
    await fixture.repository.ingest('service_it', signedExport(next, sourceKeys.service_it.privateKey));
    const after = await fixture.repository.authorityFence(reader);

    expect(after).not.toBe(before);
    await expect(fixture.repository.search(reader, { query: 'wireless guide' })).resolves.toEqual({ documents: [] });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-change-001', revision: 1 }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-delete-001' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-delete-001', revision: 1 }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(fixture.repository.ingest('service_it', signedExport(next, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });

    const reintroducedOldRevision = createSnapshot('service_it', 3, [
      document('service_it', 'svc-change-001', {
        revision: 2,
        title: 'Updated wireless guide',
        acl: { groups: ['admins'], subjects: [], authenticated: false },
      }),
      document('service_it', 'svc-delete-001', { revision: 1, title: 'Deleted guide' }),
    ], fixture.now(), 600_000, ['svc-delete-001']);
    await expect(fixture.repository.ingest('service_it', signedExport(reintroducedOldRevision, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-delete-001', revision: 1 }))
      .rejects.toMatchObject({ code: 'document_unavailable' });

    const reintroducedHigherRevision = createSnapshot('service_it', 3, [
      document('service_it', 'svc-change-001', {
        revision: 2,
        title: 'Updated wireless guide',
        acl: { groups: ['admins'], subjects: [], authenticated: false },
      }),
      document('service_it', 'svc-delete-001', { revision: 2, title: 'Recreated deleted guide' }),
    ], fixture.now(), 600_000, ['svc-delete-001']);
    await expect(fixture.repository.ingest('service_it', signedExport(reintroducedHigherRevision, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-delete-001', revision: 2 }))
      .rejects.toMatchObject({ code: 'document_unavailable' });

    const droppedTombstone = createSnapshot('service_it', 3, [
      document('service_it', 'svc-change-001', {
        revision: 2,
        title: 'Updated wireless guide',
        acl: { groups: ['admins'], subjects: [], authenticated: false },
      }),
    ], fixture.now());
    await expect(fixture.repository.ingest('service_it', signedExport(droppedTombstone, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });

    const reusedRevision = createSnapshot('service_it', 3, [
      document('service_it', 'svc-change-001', { title: 'Content changed without a revision bump' }),
    ], fixture.now(), 600_000, ['svc-delete-001']);
    await expect(fixture.repository.ingest('service_it', signedExport(reusedRevision, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });
  });

  it('requires valid, unique, source-prefixed tombstones that do not overlap current documents', async () => {
    const fixture = repositoryFixture();
    const legacySnapshot: Partial<KnowledgeSourceExport> = { ...createSnapshot('service_it', 1, [], fixture.now()) };
    delete legacySnapshot.retiredDocumentIds;
    await expect(fixture.repository.ingest('service_it', {
      snapshot: legacySnapshot,
      signature: 'A'.repeat(86),
    })).rejects.toMatchObject({ code: 'invalid_export' });

    for (const retiredDocumentIds of [
      ['int-wrong-source-001'],
      ['svc-duplicate-001', 'svc-duplicate-001'],
      ['svc-overlap-001'],
    ]) {
      const snapshot = createSnapshot('service_it', 1, [
        ...(retiredDocumentIds[0] === 'svc-overlap-001' ? [document('service_it', 'svc-overlap-001')] : []),
      ], fixture.now());
      snapshot.retiredDocumentIds = retiredDocumentIds;
      await expect(fixture.repository.ingest('service_it', signedExport(snapshot, sourceKeys.service_it.privateKey)))
        .rejects.toMatchObject({ code: 'invalid_export' });
    }
  });

  it('rejects stale feeds and canonical URLs outside the pinned source path', async () => {
    const fixture = repositoryFixture({ maxAgeMs: 60_000 });
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [document('service_it', 'svc-fresh-001')],
      intranet: [],
    }, 30_000);
    fixture.advance(31_000);
    await expect(fixture.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(fixture.repository.authorityFence(reader))
      .rejects.toMatchObject({ code: 'source_unavailable' });

    const later = repositoryFixture();
    const badUrl = createSnapshot('service_it', 1, [
      document('service_it', 'svc-outside-001', {
        canonicalUrl: 'https://attacker.example.edu/knowledge/it/svc-outside-001',
      }),
    ], later.now());
    await expect(later.repository.ingest('service_it', signedExport(badUrl, sourceKeys.service_it.privateKey)))
      .rejects.toMatchObject({ code: 'invalid_export' });

    for (const [index, canonicalUrl] of [
      'https://operator@service.example.edu/knowledge/it/svc-url-001',
      'https://service.example.edu/knowledge/it/svc-url-001?token=secret',
    ].entries()) {
      const invalidUrlFixture = repositoryFixture();
      const invalidUrlSnapshot = createSnapshot('service_it', 1, [
        document('service_it', `svc-url-${String(index).padStart(3, '0')}`, { canonicalUrl }),
      ], invalidUrlFixture.now());
      await expect(invalidUrlFixture.repository.ingest(
        'service_it',
        signedExport(invalidUrlSnapshot, sourceKeys.service_it.privateKey),
      )).rejects.toMatchObject({ code: 'invalid_export' });
    }

    const badSignatureFixture = repositoryFixture();
    const signedSnapshot = createSnapshot('service_it', 1, [], badSignatureFixture.now());
    await expect(badSignatureFixture.repository.ingest(
      'service_it',
      signedExport(signedSnapshot, sourceKeys.intranet.privateKey),
    )).rejects.toMatchObject({ code: 'invalid_export' });
  });

  it('quarantines unreviewed instructional images, returns only reviewed transcripts, and denies expired incident bodies', async () => {
    const fixture = repositoryFixture();
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [
        document('service_it', 'svc-reviewed-001', {
          text: 'A reviewed accessibility guide.',
          images: [
            { id: 'fig-reviewed', alt: 'Fictional setup screen', transcript: 'Select network profile.', reviewed: true, instructional: true },
            { id: 'fig-decorative', alt: 'Reviewed decorative image', transcript: 'Decorative footer image.', reviewed: true, instructional: false },
            { id: 'fig-unreviewed', alt: 'Decorative diagram', transcript: 'Unreviewed words are not trusted.', reviewed: false, instructional: false },
          ],
          incident: { status: 'active', validUntil: new Date(fixture.now() + 60_000).toISOString() },
        }),
        document('service_it', 'svc-quarantined-001', {
          text: 'This guide includes an unreviewed instructional image.',
          images: [{ id: 'fig-quarantine', alt: 'Unreviewed instruction', transcript: 'Click the unsafe button.', reviewed: false, instructional: true }],
        }),
        document('service_it', 'svc-expired-001', {
          incident: { status: 'active', validUntil: new Date(fixture.now() - 1_000).toISOString() },
        }),
      ],
      intranet: [],
    });

    const visible = await fixture.repository.search(reader, { query: 'accessibility guide' });
    const result = visible.documents.find(({ id }) => id === 'svc-reviewed-001');
    expect(result?.images).toEqual([{
      id: 'fig-reviewed',
      alt: 'Fictional setup screen',
      transcript: 'Select network profile.',
      reviewed: true,
      instructional: true,
    }]);
    expect(result?.incident?.status).toBe('active');
    expect(visible.documents.some(({ id }) => id === 'svc-quarantined-001')).toBe(false);
    expect(visible.documents.some(({ id }) => id === 'svc-expired-001')).toBe(false);
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-expired-001' })).rejects.toMatchObject({ code: 'document_unavailable' });
    await expect(fixture.repository.getDocument(reader, { documentId: 'svc-quarantined-001' }))
      .rejects.toMatchObject({ code: 'document_unavailable' });
  });

  it('respects embedding data classes and fails closed if an approved query embedder fails', async () => {
    const fixture = repositoryFixture({ allowedDataClasses: [] });
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [document('service_it', 'svc-no-vector-001')],
      intranet: [],
    });
    await expect(fixture.repository.search(reader, { query: 'wireless access' }))
      .resolves.toMatchObject({ documents: [{ id: 'svc-no-vector-001' }] });
    expect(fixture.embeddingCalls()).toBe(0);

    const failing = repositoryFixture({ embedQuery: () => Promise.reject(new Error('provider details')) });
    await seedBoth(failing.repository, failing.now(), {
      service_it: [document('service_it', 'svc-provider-001')],
      intranet: [],
    });
    await expect(failing.repository.search(reader, { query: 'wireless access' }))
      .rejects.toMatchObject({
        code: 'embedding_unavailable',
        message: 'Knowledge search is temporarily unavailable.',
      });
  });

  it('publishes a strict v2 manifest and exposes an opaque app-only authority fence over signed MCP', async () => {
    const fixture = repositoryFixture();
    await seedBoth(fixture.repository, fixture.now(), {
      service_it: [document('service_it', 'svc-plugin-001')],
      intranet: [],
    });
    expect(institutionalKnowledgeManifest.manifestVersion).toBe(2);
    expect(institutionalKnowledgeManifest.version).toBe('0.2.0');
    const fenceTool = institutionalKnowledgeManifest.tools.find(({ name }) => name === 'knowledge.authority_fence');
    const searchTool = institutionalKnowledgeManifest.tools.find(({ name }) => name === 'knowledge.search');
    const getTool = institutionalKnowledgeManifest.tools.find(({ name }) => name === 'knowledge.get_document');
    expect(fenceTool?.visibility).toEqual(['app']);
    expect(fenceTool?.requiredPermissions).toEqual(['knowledge:read']);
    expect(institutionalKnowledgeManifest.identity?.claims).toContain('knowledge.demoAudience');
    expect(searchTool?.visibility).toEqual(['model']);
    expect(getTool?.visibility).toEqual(['app']);
    const plugin = createInstitutionalKnowledgePlugin({
      repository: fixture.repository,
      publicKey: pluginKeys.publicKey,
      serviceToken,
    });
    openPlugins.push(plugin);

    const search = await callPlugin(plugin, reader, 'knowledge.search', { query: 'wireless access', limit: 1 });
    expect(search.isError).not.toBe(true);
    expect((search.structuredContent as { documents: { synthetic: boolean }[] }).documents[0]?.synthetic).toBe(false);
    const fence = await callPlugin(plugin, reader, 'knowledge.authority_fence', {});
    expect(fence.structuredContent).toEqual({ fence: await fixture.repository.authorityFence(reader) });
    expect(Object.keys(fence.structuredContent ?? {})).toEqual(['fence']);

    const syntheticDocument: KnowledgeDocumentV2 = {
      id: 'svc-demo-001',
      citationId: 'knowledge:service_it:svc-demo-001:1',
      title: 'Synthetic demo guide',
      sourceSystem: 'service_it',
      language: 'de',
      revision: 1,
      synthetic: true,
      text: 'Synthetic fixture for the common knowledge contract.',
      updatedAt: '2026-10-18T09:30:00.000Z',
      fetchedAt: '2026-10-18T10:00:00.000Z',
      authorityRevision: digest({ authority: 'demo' }),
      corpusRevision: digest({ corpus: 'demo' }),
      dataClass: 'synthetic_demo',
      images: [],
    };
    const demoPlugin = createInstitutionalKnowledgePlugin({
      repository: {
        search: () => Promise.resolve({ documents: [syntheticDocument] }),
        getDocument: () => Promise.resolve({ document: syntheticDocument }),
        authorityFence: () => Promise.resolve(digest({ authority: 'demo' })),
      },
      publicKey: pluginKeys.publicKey,
      serviceToken,
    });
    openPlugins.push(demoPlugin);
    const demoSearch = await callPlugin(demoPlugin, reader, 'knowledge.search', { query: 'synthetic fixture' });
    expect(demoSearch.isError).not.toBe(true);
    expect((demoSearch.structuredContent as { documents: KnowledgeDocumentV2[] }).documents[0]).toEqual(syntheticDocument);
  });
});

const reader: ActorContext = {
  subject: 'actor-reader',
  permissions: ['knowledge:read'],
  claims: { 'hasi.groups': ['admins'] },
};

function sourceConfig(): InstitutionalKnowledgeSource[] {
  return [
    {
      sourceSystem: 'service_it',
      origin: 'https://service.example.edu/knowledge/it',
      publicKey: sourceKeys.service_it.publicKey,
      policyRevision: 'it-policy-7',
      maxAgeMs: 3_600_000,
    },
    {
      sourceSystem: 'intranet',
      origin: 'https://intranet.example.edu/knowledge',
      publicKey: sourceKeys.intranet.publicKey,
      policyRevision: 'intranet-policy-3',
      maxAgeMs: 3_600_000,
    },
  ];
}

function repositoryOptions(options: {
  allowedDataClasses?: readonly KnowledgeSourceClassification[];
  maxAgeMs?: number;
  embedQuery?: (text: string, signal: AbortSignal) => Promise<number[]>;
} = {}): InstitutionalKnowledgeRepositoryOptions & { clockNow: () => number; advanceClock: (milliseconds: number) => void; embeddingCalls: () => number } {
  const now = Date.parse('2026-10-18T10:00:00.000Z');
  const sources = sourceConfig().map((source) => ({
    ...source,
    maxAgeMs: options.maxAgeMs ?? source.maxAgeMs,
  }));
  let embeddingCalls = 0;
  const embedQuery = options.embedQuery ?? ((text: string, _signal: AbortSignal) => {
    embeddingCalls += 1;
    return Promise.resolve(/wlan|wireless|eduroam/iu.test(text) ? [1, 0, 0] : [0, 1, 0]);
  });
  let currentTime = now;
  const configuration: InstitutionalKnowledgeRepositoryOptions = {
    store: new MemoryJsonStore('institutional-clock-' + String(storeCounter)),
    scope: 'institutional-clock-scope',
    sources,
    embedding: {
      modelId: 'operator-approved-embedder-v1',
      dimensions: 3,
      allowedDataClasses: options.allowedDataClasses ?? ['public', 'internal'],
      embedQuery,
    },
    clock: () => currentTime,
  };
  storeCounter += 1;
  return {
    ...configuration,
    clockNow: () => currentTime,
    advanceClock: (milliseconds: number) => { currentTime += milliseconds; },
    embeddingCalls: () => embeddingCalls,
  };
}

function repositoryFixture(options: {
  allowedDataClasses?: readonly KnowledgeSourceClassification[];
  maxAgeMs?: number;
  embedQuery?: (text: string, signal: AbortSignal) => Promise<number[]>;
} = {}) {
  const configuration = repositoryOptions(options);
  const repository = new InstitutionalKnowledgeRepository(configuration);
  return {
    repository,
    now: configuration.clockNow,
    advance: configuration.advanceClock,
    embeddingCalls: configuration.embeddingCalls,
  };
}

function document(
  sourceSystem: KnowledgeSourceSystem,
  id: string,
  overrides: Partial<KnowledgeDocumentExport> = {},
): KnowledgeDocumentExport {
  const origin = sourceSystem === 'service_it'
    ? 'https://service.example.edu/knowledge/it/'
    : 'https://intranet.example.edu/knowledge/';
  const defaults: KnowledgeDocumentExport = {
    id,
    revision: 1,
    title: 'Wireless access guide',
    language: sourceSystem === 'service_it' ? 'de' : 'en',
    canonicalUrl: origin + id,
    classification: 'internal',
    updatedAt: '2026-10-18T09:30:00.000Z',
    acl: { groups: ['students'], subjects: [], authenticated: false },
    text: 'Fictional WLAN wireless access guide for campus testing.',
    vector: [1, 0, 0],
    images: [],
  };
  return { ...defaults, ...overrides };
}

function createSnapshot(
  sourceSystem: KnowledgeSourceSystem,
  sequence: number,
  documents: KnowledgeDocumentExport[],
  now: number,
  lifetimeMs = 600_000,
  retiredDocumentIds: string[] = [],
): KnowledgeSourceExport {
  return {
    version: 1,
    sourceSystem,
    sequence,
    policyRevision: sourceSystem === 'service_it' ? 'it-policy-7' : 'intranet-policy-3',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetimeMs).toISOString(),
    embeddingModelId: 'operator-approved-embedder-v1',
    dimensions: 3,
    subjects: [{ subject: 'actor-reader', groups: ['students'] }],
    documents,
    retiredDocumentIds,
  };
}

function signedExport(snapshot: KnowledgeSourceExport, privateKey: KeyObject): SignedKnowledgeExport {
  return { snapshot, signature: sign(null, Buffer.from(digest(snapshot), 'utf8'), privateKey).toString('base64url') };
}

async function seedBoth(
  repository: InstitutionalKnowledgeRepository,
  now: number,
  snapshots: Partial<Record<KnowledgeSourceSystem, KnowledgeDocumentExport[]>>,
  lifetimeMs = 600_000,
): Promise<void> {
  for (const sourceSystem of ['service_it', 'intranet'] as const) {
    const snapshot = createSnapshot(sourceSystem, 1, snapshots[sourceSystem] ?? [], now, lifetimeMs);
    await repository.ingest(sourceSystem, signedExport(snapshot, sourceKeys[sourceSystem].privateKey));
  }
}

async function callPlugin(
  plugin: ReturnType<typeof createInstitutionalKnowledgePlugin>,
  actor: ActorContext,
  tool: string,
  args: Record<string, unknown>,
) {
  const invocation = await createInvocationToken({
    context: { installationId: institutionalKnowledgeManifest.id, configurationRevision: 0, configuration: {} },
    actor,
    pluginId: institutionalKnowledgeManifest.id,
    pluginVersion: institutionalKnowledgeManifest.version,
    tool,
    args,
  }, pluginKeys.privateKey);
  const response = await plugin.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: 'Bearer ' + serviceToken,
      'x-hasi-invocation': invocation,
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.body.split('\n').find((line) => line.startsWith('data: '));
  const payload = body ? body.slice('data: '.length) : response.body;
  return (JSON.parse(payload) as {
    result: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown[] };
  }).result;
}
