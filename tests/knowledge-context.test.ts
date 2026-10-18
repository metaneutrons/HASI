import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryJsonStore, type JsonStore } from '@hasi/state';
import { KnowledgeContextStore, type KnowledgeDocument, type KnowledgeContextStoreOptions } from '../apps/api/src/knowledge-context.js';

const { privateKey } = generateKeyPairSync('ed25519');

function makeStore(clock: () => number = Date.now) {
  return new MemoryJsonStore(`knowledge-context-${randomUUID()}`, { clock });
}

function syntheticDocument(overrides: Record<string, unknown> = {}): KnowledgeDocument {
  return {
    id: 'svc-001', sourceSystem: 'service_it', revision: 1,
    title: 'Demo VPN', text: 'Ein vollständig synthetischer Beispieldatensatz.', synthetic: true,
    ...overrides,
  };
}

function v2Document(overrides: Record<string, unknown> = {}): KnowledgeDocument {
  return {
    id: 'kb-003', sourceSystem: 'university-kb', revision: 'r7', dataClass: 'internal',
    corpusRevision: 'c12', authorityRevision: 4, title: 'VPN access', text: 'Current approved guidance.',
    ...overrides,
  };
}

function createService(options: Partial<KnowledgeContextStoreOptions> & Pick<KnowledgeContextStoreOptions, 'store' | 'resolveDocument'>) {
  return new KnowledgeContextStore({ scope: 'test-scope', privateKey, ...options });
}

describe('KnowledgeContextStore', () => {
  it('issues an opaque receipt and returns fresh authoritative synthetic and v2 documents', async () => {
    const docs = [syntheticDocument(), v2Document()];
    const service = createService({ store: makeStore(), resolveDocument: (_subject, ref) => Promise.resolve(docs.find((doc) => doc.id === ref.documentId)) });
    const { contextId } = await service.issue('person-1', 'installation-v3', docs);

    expect(contextId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({
      status: 'valid', documents: docs, dataClasses: ['internal', 'synthetic_demo'],
    });
  });

  it('accepts a fresh acquisition timestamp without weakening revision, content or grant checks', async () => {
    let current = v2Document({ fetchedAt: '2026-10-18T10:00:00Z' });
    const service = createService({ store: makeStore(), resolveDocument: () => Promise.resolve(current) });
    const { contextId } = await service.issue('person-1', 'installation-v3', [current]);
    current = { ...current, fetchedAt: '2026-10-18T10:01:00Z' };
    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toMatchObject({ status: 'valid', documents: [current] });
    current = { ...current, title: 'Changed protected title' };
    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it.each([
    ['changed body', (document: KnowledgeDocument) => ({ ...document, text: 'Altered content' })],
    ['changed document revision', (document: KnowledgeDocument) => ({ ...document, revision: 2 })],
    ['changed corpus revision', (document: KnowledgeDocument) => ({ ...document, corpusRevision: 'c13' })],
    ['changed authority revision', (document: KnowledgeDocument) => ({ ...document, authorityRevision: 5 })],
    ['changed classification', (document: KnowledgeDocument) => ({ ...document, dataClass: 'public' })],
  ])('withholds the complete context on %s', async (_label, alter) => {
    const original = v2Document();
    let current: KnowledgeDocument | undefined = original;
    const service = createService({ store: makeStore(), resolveDocument: () => Promise.resolve(current) });
    const { contextId } = await service.issue('person-1', 'installation-v3', [original]);
    current = alter(original);

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it('withholds the complete context when current source access is revoked', async () => {
    const document = syntheticDocument();
    let allowed = true;
    const service = createService({
      store: makeStore(),
      resolveDocument: () => Promise.resolve(allowed ? document : undefined),
    });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);
    allowed = false;

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it('revalidates every referenced document even when one is unavailable', async () => {
    const docs = [syntheticDocument(), syntheticDocument({ id: 'svc-002' })];
    const requested = new Set<string>();
    const service = createService({
      store: makeStore(),
      resolveDocument: (_subject, reference) => {
        requested.add(reference.documentId);
        return Promise.resolve(reference.documentId === 'svc-001' ? undefined : docs[1]);
      },
    });
    const { contextId } = await service.issue('person-1', 'installation-v3', docs);
    requested.clear();

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
    expect(requested).toEqual(new Set(['svc-001', 'svc-002']));
  });

  it('detects revocation during resolution with a final authority fence check', async () => {
    const document = syntheticDocument();
    let fence = 'authority-7';
    const service = createService({
      store: makeStore(),
      authorityFence: () => Promise.resolve(fence),
      resolveDocument: () => { fence = 'authority-8'; return Promise.resolve(document); },
    });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it('detects a revocation between document reads when no authority fence is configured', async () => {
    const document = syntheticDocument();
    let reads = 0;
    const service = createService({
      store: makeStore(),
      resolveDocument: () => { reads += 1; return Promise.resolve(reads === 1 ? document : undefined); },
    });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
    expect(reads).toBe(2);
  });

  it('returns the same unavailable result for a different subject or installation binding', async () => {
    const document = syntheticDocument();
    const service = createService({ store: makeStore(), resolveDocument: () => Promise.resolve(document) });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);

    await expect(service.resolve('person-2', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
    await expect(service.resolve('person-1', contextId, 'installation-v4')).resolves.toEqual({ status: 'unavailable' });
  });

  it('returns unavailable for deleted and expired receipts', async () => {
    let now = 1_800_000_000_000;
    const baseStore = makeStore(() => now);
    let issuedKey: string | undefined;
    const trackedStore: Pick<JsonStore, 'read' | 'compareAndSet'> = {
      read: (key) => baseStore.read(key),
      compareAndSet: (key, revision, value, expiresAt) => {
        issuedKey = key;
        return baseStore.compareAndSet(key, revision, value, expiresAt);
      },
    };
    const document = syntheticDocument();
    const service = createService({ store: trackedStore, clock: () => now, ttlMs: 1000, resolveDocument: () => Promise.resolve(document) });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);
    expect(issuedKey).toBeDefined();
    if (!issuedKey) throw new Error('Receipt key was not captured');
    await baseStore.delete(issuedKey);
    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });

    now += 1;
    const secondStore = makeStore(() => now);
    const secondService = createService({ store: secondStore, clock: () => now, ttlMs: 1000, resolveDocument: () => Promise.resolve(document) });
    const secondReceipt = await secondService.issue('person-1', 'installation-v3', [document]);
    now += 1001;
    await expect(secondService.resolve('person-1', secondReceipt.contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects a modified signed receipt', async () => {
    const inner = makeStore();
    const store: Pick<JsonStore, 'read' | 'compareAndSet'> = {
      read: async (key) => {
        const entry = await inner.read(key);
        if (!entry) return undefined;
        const envelope = entry.value as { record: unknown; signature: string };
        return { ...entry, value: { ...envelope, signature: 'A'.repeat(86) } };
      },
      compareAndSet: (key, revision, value, expiresAt) => inner.compareAndSet(key, revision, value, expiresAt),
    };
    const document = syntheticDocument();
    const service = createService({ store, resolveDocument: () => Promise.resolve(document) });
    const { contextId } = await service.issue('person-1', 'installation-v3', [document]);

    await expect(service.resolve('person-1', contextId, 'installation-v3')).resolves.toEqual({ status: 'unavailable' });
  });

  it('enforces receipt and document bounds and rejects unrecognized data classes', async () => {
    const service = createService({ store: makeStore(), resolveDocument: () => Promise.resolve(undefined) });
    await expect(service.issue('person-1', 'installation-v3', Array.from({ length: 6 }, (_, id) => syntheticDocument({ id: `svc-${String(id)}` })))).rejects.toThrow(/at most 5/u);
    await expect(service.issue('person-1', 'installation-v3', [syntheticDocument({ text: 'x'.repeat(65 * 1024) })])).rejects.toThrow(/exceed/u);
    await expect(service.issue('person-1', 'installation-v3', [v2Document({ dataClass: 'restricted' })])).rejects.toThrow(/recognized dataClass/u);
    expect(() => new KnowledgeContextStore({ store: makeStore(), scope: 'test', ttlMs: 30 * 24 * 60 * 60 * 1000 + 1, resolveDocument: () => Promise.resolve(undefined) })).toThrow(/ttlMs/u);
  });
});
