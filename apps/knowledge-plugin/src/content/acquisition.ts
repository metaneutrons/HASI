import { sign, type KeyObject } from 'node:crypto';
import { digest } from '@hasi/plugin-sdk';
import { z } from 'zod';
import { knowledgeDocumentExportSchema, knowledgeSourceExportSchema, signedKnowledgeExportSchema,
  knowledgeSourceSubjectSchema, type KnowledgeDocumentExport, type KnowledgeSourceExport,
  type KnowledgeSourceSystem, type SignedKnowledgeExport } from '../institutional-contracts.js';
import type { InstitutionalKnowledgeStore } from '../institutional-repository.js';
import { approvedContentUrl, ContentAcquisitionError, type AcquiredContent, type ContentAdapter } from './contracts.js';

export const contentInventoryPageSchema = z.strictObject({
  id: z.string().regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/u),
  url: z.url().max(2048), title: z.string().min(1).max(500).optional(),
  language: z.enum(['de', 'en']),
  classification: knowledgeDocumentExportSchema.shape.classification,
  acl: knowledgeDocumentExportSchema.shape.acl,
  /** Per-adapter approvals bind exact rendered output and its complete effective ACL. */
  reviews: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), z.strictObject({
    digest: z.string().regex(/^[a-f0-9]{64}$/u), images: knowledgeDocumentExportSchema.shape.images.optional(),
  })).refine(value => Object.keys(value).length <= 8, 'Too many adapter reviews.').optional(),
  incident: knowledgeDocumentExportSchema.shape.incident,
});
export const contentAcquisitionPolicySchema = z.strictObject({
  /** Explicit complete inventory of the approved subset, not a claim to crawl the entire wiki. */
  completeInventory: z.literal(true),
  validUntil: z.iso.datetime({ offset: true }),
  pages: z.array(contentInventoryPageSchema).max(1000),
  subjects: z.array(knowledgeSourceSubjectSchema).max(100_000),
}).superRefine((value, ctx) => {
  for (const field of ['id', 'url'] as const) if (new Set(value.pages.map(page => page[field])).size !== value.pages.length)
    ctx.addIssue({ code: 'custom', path: ['pages'], message: 'Inventory entries must be unique.' });
  if (new Set(value.subjects.map(subject => subject.subject)).size !== value.subjects.length)
    ctx.addIssue({ code: 'custom', path: ['subjects'], message: 'Source subjects must be unique.' });
  for (const [index, page] of value.pages.entries()) {
    if (!page.acl.authenticated && page.acl.groups.length === 0 && page.acl.subjects.length === 0)
      ctx.addIssue({ code: 'custom', path: ['pages', index, 'acl'], message: 'Explicit source ACL required.' });
  }
});
export type ContentAcquisitionPolicy = z.infer<typeof contentAcquisitionPolicySchema>;

const pageStateSchema = z.strictObject({ nextChunk: z.number().int().positive(), documentIds: z.array(z.string()).max(1000) });
const producerStateSchema = z.strictObject({ envelope: signedKnowledgeExportSchema,
  pages: z.record(z.string(), pageStateSchema) });

export interface ContentSnapshotProducerOptions {
  sourceSystem: KnowledgeSourceSystem;
  origin: string;
  scope: string;
  policyRevision: string;
  maxAgeMs: number;
  /** Must reflect current source rights; refresh/review this operator policy on rights changes. */
  policy: ContentAcquisitionPolicy;
  adapter: ContentAdapter;
  store: InstitutionalKnowledgeStore;
  embedding: { modelId: string; dimensions: number; allowedDataClasses: readonly string[];
    embedDocument(text: string, signal?: AbortSignal): Promise<number[]> };
  signSnapshot: (snapshot: KnowledgeSourceExport) => Promise<SignedKnowledgeExport>;
  clock?: () => Date;
}

export function signContentSnapshot(snapshot: KnowledgeSourceExport, privateKey: KeyObject): SignedKnowledgeExport {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('An Ed25519 ingestion key is required.');
  return { snapshot, signature: sign(null, Buffer.from(digest(snapshot), 'utf8'), privateKey).toString('base64url') };
}

/** Digest printed by an operator's private review workflow; no image bytes are fetched. */
export function contentReviewDigest(content: AcquiredContent,
  page: Pick<ContentAcquisitionPolicy['pages'][number], 'id' | 'url' | 'acl' | 'classification' | 'language'>,
  policyRevision: string,
  reviewedImages: KnowledgeDocumentExport['images'] = []): string {
  return digest({ adapter: content.adapter, canonicalUrl: content.canonicalUrl, revision: content.sourceRevision,
    title: content.title, text: content.text, images: content.images, sourceUpdatedAt: content.sourceUpdatedAt ?? null,
    ...(reviewedImages.length > 0 ? { reviewedImages } : {}),
    policyRevision, page: { id: page.id, url: page.url, acl: page.acl, classification: page.classification, language: page.language } });
}

function chunkText(text: string): string[] {
  if (text.trim().length === 0 || text.length > 200_000) throw new ContentAcquisitionError('invalid_content');
  const points = Array.from(text);
  const chunks: string[] = [];
  // Bound UTF-16 code units too, matching the signed document schema without splitting surrogate pairs.
  let chunk = '';
  for (const point of points) {
    if (chunk.length + point.length > 3500) { if (chunk.trim()) chunks.push(chunk.trim()); chunk = ''; }
    chunk += point;
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks;
}

/** Produces the same signed snapshot for any reviewed adapter; never grants rights from source HTML. */
export class ContentSnapshotProducer {
  private readonly policy: ContentAcquisitionPolicy;
  private readonly origin: string;
  private active: Promise<SignedKnowledgeExport> | undefined;
  constructor(private readonly options: ContentSnapshotProducerOptions) {
    this.policy = contentAcquisitionPolicySchema.parse(options.policy);
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' || origin.origin !== options.origin || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(options.scope)
      || options.maxAgeMs < 1000 || options.maxAgeMs > 86_400_000 || !Number.isSafeInteger(options.maxAgeMs))
      throw new TypeError('Invalid content producer configuration.');
    this.origin = origin.origin;
    const prefix = options.sourceSystem === 'service_it' ? 'svc-' : 'int-';
    for (const page of this.policy.pages) {
      approvedContentUrl(page.url, this.origin);
      if (!page.id.startsWith(prefix) || !options.embedding.allowedDataClasses.includes(page.classification))
        throw new TypeError('Source inventory is outside the approved contract.');
    }
  }
  async acquire(signal: AbortSignal): Promise<SignedKnowledgeExport> {
    // Single producer per scope; parallel calls do not multiply paid embeddings.
    if (this.active) return this.active;
    const active = this.produce(signal);
    this.active = active;
    try { return await active; } finally { if (this.active === active) this.active = undefined; }
  }
  private async produce(signal: AbortSignal): Promise<SignedKnowledgeExport> {
    const aborted = () => signal.aborted;
    const key = `content-producer:${this.options.scope}:${this.options.sourceSystem}`;
    const stored = await this.options.store.read(key);
    const previous = stored ? producerStateSchema.parse(stored.value) : undefined;
    if (previous && (previous.envelope.snapshot.sourceSystem !== this.options.sourceSystem
      || previous.envelope.snapshot.embeddingModelId !== this.options.embedding.modelId
      || previous.envelope.snapshot.dimensions !== this.options.embedding.dimensions)) throw new ContentAcquisitionError('conflict');
    const policyDeadline = Date.parse(this.policy.validUntil);
    const startedAt = (this.options.clock?.() ?? new Date()).getTime();
    if (policyDeadline <= startedAt || policyDeadline > startedAt + 86_400_000) throw new ContentAcquisitionError('review_required');
    let freshnessDeadline = policyDeadline;
    const previousDocuments = new Map(previous?.envelope.snapshot.documents.map(document => [document.id, document]) ?? []);
    const retired = new Set(previous?.envelope.snapshot.retiredDocumentIds ?? []);
    const pages = structuredClone(previous?.pages ?? {});
    const documents: KnowledgeDocumentExport[] = [];
    const prepared: { page: ContentAcquisitionPolicy['pages'][number]; acquired: AcquiredContent;
      images: KnowledgeDocumentExport['images']; chunks: string[]; now: Date }[] = [];
    let chunkCount = 0;
    for (const page of this.policy.pages) {
      if (aborted()) throw new ContentAcquisitionError('unavailable');
      // Any failed/denied/missing read aborts the complete source, leaving the old snapshot untouched.
      const acquired = await this.options.adapter.read({ url: page.url, ...(page.title ? { title: page.title } : {}) }, signal);
      if (acquired.canonicalUrl !== page.url || !acquired.sourceRevision || acquired.title.length > 200
        || (acquired.language && acquired.language !== page.language)) throw new ContentAcquisitionError('invalid_content');
      const review = page.reviews?.[acquired.adapter];
      const reviewDigest = contentReviewDigest(acquired, page, this.options.policyRevision, review?.images ?? []);
      if (acquired.requiresContentReview && review?.digest !== reviewDigest)
        throw new ContentAcquisitionError('review_required');
      const acquiredAt = new Date(acquired.acquiredAt);
      const now = this.options.clock?.() ?? new Date();
      if (!Number.isFinite(acquiredAt.getTime()) || acquiredAt.getTime() > now.getTime() + 30_000
        || now.getTime() - acquiredAt.getTime() > this.options.maxAgeMs) throw new ContentAcquisitionError('invalid_content');
      freshnessDeadline = Math.min(freshnessDeadline, acquiredAt.getTime() + this.options.maxAgeMs);
      const sourceDate = acquired.sourceUpdatedAt;
      if (sourceDate && (!Number.isFinite(Date.parse(sourceDate)) || Date.parse(sourceDate) > now.getTime() + 30_000))
        throw new ContentAcquisitionError('invalid_content');
      let images: KnowledgeDocumentExport['images'] = [];
      if (acquired.images.length > 0) {
        if (review?.digest !== reviewDigest || review.images?.length !== acquired.images.length || review.images.some(image => !image.reviewed))
          throw new ContentAcquisitionError('review_required');
        images = review.images;
      } else if (review?.images?.length) throw new ContentAcquisitionError('review_required');
      const chunks = chunkText(acquired.text);
      chunkCount += chunks.length;
      if (chunkCount > 1000) throw new ContentAcquisitionError('invalid_content');
      prepared.push({ page, acquired, images, chunks, now });
    }
    for (const { page, acquired, images, chunks, now } of prepared) {
      if (aborted()) throw new ContentAcquisitionError('unavailable');
      const sourceDate = acquired.sourceUpdatedAt;
      const state = pages[page.id] ?? { nextChunk: 1, documentIds: [] };
      const ids: string[] = [];
      for (const [index, text] of chunks.entries()) {
        if (documents.length >= 1000) throw new ContentAcquisitionError('invalid_content');
        const existingId = state.documentIds[index];
        const old = existingId ? previousDocuments.get(existingId) : undefined;
        const id = old?.id ?? `${page.id}-c${String(state.nextChunk++)}`;
        if (retired.has(id)) throw new ContentAcquisitionError('conflict');
        const body = { id, title: acquired.title, language: page.language, canonicalUrl: page.url,
          classification: page.classification, acl: page.acl, text,
          // Replicate reviewed image guidance per chunk so a textual hit never loses it.
          images,
          acquisition: { adapter: acquired.adapter, sourceRevision: acquired.sourceRevision,
            ...(sourceDate ? { sourceUpdatedAt: sourceDate } : {}) }, ...(page.incident ? { incident: page.incident } : {}) };
        const oldBody = old ? (({ revision: _revision, updatedAt: _updatedAt, vector: _vector, ...rest }) => rest)(old) : undefined;
        const unchanged = old && digest(oldBody) === digest(body);
        const vector = old?.text === text ? old.vector : await this.options.embedding.embedDocument(text, signal);
        documents.push(knowledgeDocumentExportSchema.parse({ ...body, vector,
          revision: unchanged ? old.revision : (old?.revision ?? 0) + 1,
          updatedAt: unchanged ? old.updatedAt : now.toISOString() }));
        ids.push(id);
      }
      pages[page.id] = { nextChunk: state.nextChunk, documentIds: ids };
    }
    const current = new Set(documents.map(document => document.id));
    for (const id of previousDocuments.keys()) if (!current.has(id)) retired.add(id);
    if (aborted()) throw new ContentAcquisitionError('unavailable');
    const now = this.options.clock?.() ?? new Date();
    if (freshnessDeadline <= now.getTime()) throw new ContentAcquisitionError('review_required');
    const snapshot = knowledgeSourceExportSchema.parse({ version: 1, sourceSystem: this.options.sourceSystem,
      sequence: (previous?.envelope.snapshot.sequence ?? 0) + 1, policyRevision: this.options.policyRevision,
      issuedAt: now.toISOString(), expiresAt: new Date(Math.min(freshnessDeadline, now.getTime() + this.options.maxAgeMs)).toISOString(),
      embeddingModelId: this.options.embedding.modelId, dimensions: this.options.embedding.dimensions,
      subjects: this.policy.subjects, documents, retiredDocumentIds: [...retired].sort() });
    const envelope = signedKnowledgeExportSchema.parse(await this.options.signSnapshot(snapshot));
    if (Buffer.byteLength(JSON.stringify(envelope)) > 16 * 1024 * 1024) throw new ContentAcquisitionError('invalid_content');
    if (digest(envelope.snapshot) !== digest(snapshot) || aborted()) throw new ContentAcquisitionError('invalid_content');
    if (!await this.options.store.compareAndSet(key, stored?.revision ?? null, { envelope, pages })) throw new ContentAcquisitionError('conflict');
    return envelope;
  }
}
