import { verify, randomUUID, type KeyObject } from 'node:crypto';
import { canonicalJson, digest, parseActorContext, type ActorContext } from '@hasi/plugin-sdk';
import { z } from 'zod';
import {
  KNOWLEDGE_SOURCE_SYSTEMS,
  knowledgeSourceClassificationSchema,
  signedKnowledgeExportSchema,
  type KnowledgeDocumentExport,
  type KnowledgeDocumentV2,
  type KnowledgeSourceClassification,
  type KnowledgeSourceExport,
  type KnowledgeSourceSystem,
  type SignedKnowledgeExport,
} from './institutional-contracts.js';
import { knowledgeDocumentV2Schema } from './institutional-contracts.js';

const MAX_EXPORT_BYTES = 16 * 1_024 * 1_024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 30_000;
const EMBEDDING_TIMEOUT_MS = 2_000;
const MAX_CAS_ATTEMPTS = 12;
const RRF_K = 60;
const sourceOrder: readonly KnowledgeSourceSystem[] = ['service_it', 'intranet'];

const searchArgumentsSchema = z.strictObject({
  query: z.string().trim().min(2).max(500),
  sourceSystem: z.enum(KNOWLEDGE_SOURCE_SYSTEMS).optional(),
  limit: z.number().int().min(1).max(5).optional(),
});
const getDocumentArgumentsSchema = z.strictObject({
  documentId: z.string().regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

export interface InstitutionalKnowledgeStore {
  read(key: string): Promise<{ revision: string; value: unknown } | undefined>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<boolean>;
}

export interface InstitutionalKnowledgeSource {
  sourceSystem: KnowledgeSourceSystem;
  /** Canonical HTTPS source root, optionally including a path prefix. */
  origin: string;
  publicKey: KeyObject;
  policyRevision: string;
  maxAgeMs: number;
}

export interface InstitutionalKnowledgeEmbedding {
  modelId: string;
  dimensions: number;
  allowedDataClasses: readonly KnowledgeSourceClassification[];
  embedQuery(text: string, signal: AbortSignal): Promise<number[]>;
}

export interface InstitutionalKnowledgeRepositoryOptions {
  store: InstitutionalKnowledgeStore;
  scope: string;
  sources: readonly InstitutionalKnowledgeSource[];
  embedding: InstitutionalKnowledgeEmbedding;
  clock?: () => number;
}

export type InstitutionalKnowledgeErrorCode =
  | 'invalid_export'
  | 'source_unavailable'
  | 'forbidden'
  | 'document_unavailable'
  | 'embedding_unavailable'
  | 'source_changed'
  | 'store_conflict';

const safeErrorMessages: Record<InstitutionalKnowledgeErrorCode, string> = {
  invalid_export: 'Knowledge export is invalid or not approved.',
  source_unavailable: 'Knowledge source is unavailable.',
  forbidden: 'Knowledge access is denied.',
  document_unavailable: 'Document is unavailable or not authorized.',
  embedding_unavailable: 'Knowledge search is temporarily unavailable.',
  source_changed: 'Knowledge source changed during the request. Retry it.',
  store_conflict: 'Knowledge source could not be updated. Retry ingestion.',
};

export class InstitutionalKnowledgeError extends Error {
  constructor(readonly code: InstitutionalKnowledgeErrorCode) {
    super(safeErrorMessages[code]);
    this.name = 'InstitutionalKnowledgeError';
  }
}

interface NormalizedSource extends InstitutionalKnowledgeSource {
  readonly basePath: string;
  readonly publicKeyFingerprint: string;
}

interface StoredExport {
  readonly snapshot: KnowledgeSourceExport;
  readonly signature: string;
}

export interface KnowledgeSourceRefreshFence { revision: string | null; epoch: string; snapshotRevision: string | null }
const availabilitySchema = z.strictObject({ blocked: z.boolean(), epoch: z.string().min(1).max(128) });

interface CurrentSource {
  readonly availabilityEpoch: string;
  readonly config: NormalizedSource;
  readonly stored: StoredExport;
}

interface RankedDocument {
  readonly source: CurrentSource;
  readonly document: KnowledgeDocumentExport;
  readonly searchableText: string;
}

function invalidExport(): never {
  throw new InstitutionalKnowledgeError('invalid_export');
}

function sourceUnavailable(): never {
  throw new InstitutionalKnowledgeError('source_unavailable');
}

function documentUnavailable(): never {
  throw new InstitutionalKnowledgeError('document_unavailable');
}

function normalizeSourceOrigin(value: string): { origin: string; basePath: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Institutional source origin must be a canonical HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.href !== value
  ) {
    throw new TypeError('Institutional source origin must be a canonical HTTPS URL without credentials or query data.');
  }
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/u, '');
  return {
    origin: url.origin,
    basePath: path === '/' ? '/' : path + '/',
  };
}

function assertCanonicalDocumentUrl(value: string, source: NormalizedSource): void {
  if (/[?#\\]/u.test(value) || /%(?:2f|5c|2e)/iu.test(value)) invalidExport();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidExport();
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.href !== value ||
    url.origin !== source.origin ||
    !(source.basePath === '/' || url.pathname === source.basePath.slice(0, -1) || url.pathname.startsWith(source.basePath))
  ) {
    invalidExport();
  }
}

function parseSignedExport(value: unknown): SignedKnowledgeExport {
  const parsed = signedKnowledgeExportSchema.safeParse(value);
  if (!parsed.success) invalidExport();
  const canonicalBytes = Buffer.from(parsed.data.signature, 'base64url');
  if (canonicalBytes.length !== 64 || canonicalBytes.toString('base64url') !== parsed.data.signature) invalidExport();
  if (Buffer.byteLength(canonicalJson(parsed.data.snapshot), 'utf8') > MAX_EXPORT_BYTES) invalidExport();
  return parsed.data;
}

function verifySignedExport(
  value: unknown,
  config: NormalizedSource,
  embedding: InstitutionalKnowledgeEmbedding,
  now: number,
  requireCurrentPolicy: boolean,
): StoredExport {
  const signed = parseSignedExport(value);
  const snapshot = signed.snapshot;
  if (
    snapshot.sourceSystem !== config.sourceSystem ||
    (requireCurrentPolicy && snapshot.policyRevision !== config.policyRevision) ||
    snapshot.embeddingModelId !== embedding.modelId ||
    snapshot.dimensions !== embedding.dimensions ||
    !verify(null, Buffer.from(digest(snapshot), 'utf8'), config.publicKey, Buffer.from(signed.signature, 'base64url'))
  ) {
    invalidExport();
  }
  for (const document of snapshot.documents) assertCanonicalDocumentUrl(document.canonicalUrl, config);
  const issuedAt = Date.parse(snapshot.issuedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (expiresAt <= issuedAt || (requireCurrentPolicy && expiresAt - issuedAt > config.maxAgeMs)) invalidExport();
  if (issuedAt > now + CLOCK_SKEW_MS) sourceUnavailable();
  if (requireCurrentPolicy && (expiresAt <= now || now - issuedAt > config.maxAgeMs)) sourceUnavailable();
  return { snapshot, signature: signed.signature };
}

function requireCurrentPermission(actorInput: ActorContext): ActorContext {
  let actor: ActorContext;
  try {
    actor = parseActorContext(actorInput);
  } catch {
    throw new InstitutionalKnowledgeError('forbidden');
  }
  if (!actor.permissions.includes('knowledge:read')) throw new InstitutionalKnowledgeError('forbidden');
  return actor;
}

function documentIdSource(documentId: string): KnowledgeSourceSystem | undefined {
  if (documentId.startsWith('svc-')) return 'service_it';
  if (documentId.startsWith('int-')) return 'intranet';
  return undefined;
}

function subjectGroups(snapshot: KnowledgeSourceExport, subject: string): readonly string[] {
  return snapshot.subjects.find((entry) => entry.subject === subject)?.groups ?? [];
}

function isAuthorized(document: KnowledgeDocumentExport, source: CurrentSource, subject: string): boolean {
  const grant = source.stored.snapshot.subjects.find((entry) => entry.subject === subject);
  if (!grant) return false;
  if (document.acl.authenticated || document.acl.subjects.includes(subject)) return true;
  const groups = new Set(grant.groups);
  return document.acl.groups.some((group) => groups.has(group));
}

function isQuarantined(document: KnowledgeDocumentExport, now: number): boolean {
  return (document.incident !== undefined && Date.parse(document.incident.validUntil) <= now)
    || document.images.some((image) => image.instructional && !image.reviewed);
}

function visibleImageText(document: KnowledgeDocumentExport): string {
  return document.images
    .filter((image) => image.reviewed && image.instructional)
    .map((image) => image.transcript)
    .join(' ');
}

function tokenize(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/gu, 'ss')
    .match(/[a-z0-9]+/gu) ?? [];
}

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'with',
  'aber', 'alle', 'als', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der',
  'des', 'die', 'ein', 'eine', 'einer', 'eines', 'für', 'im', 'in', 'ist', 'mit', 'oder',
  'und', 'von', 'vom', 'was', 'wie', 'zu', 'zum', 'zur',
]);

function queryTerms(query: string): string[] {
  return tokenize(query).filter((token) => !stopWords.has(token));
}

function rankedBm25(documents: readonly RankedDocument[], terms: readonly string[]): string[] {
  if (documents.length === 0 || terms.length === 0) return [];
  const prepared = documents.map((entry) => {
    const titleTokens = tokenize(entry.document.title);
    const bodyTokens = tokenize(entry.searchableText);
    const frequencies = new Map<string, number>();
    for (const token of bodyTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const token of titleTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 2);
    return { entry, frequencies, length: bodyTokens.length + titleTokens.length * 2 };
  });
  const averageLength = prepared.reduce((total, item) => total + item.length, 0) / prepared.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(terms)) {
    documentFrequency.set(term, prepared.filter((item) => item.frequencies.has(term)).length);
  }
  const scores = prepared.map((item) => {
    let score = 0;
    for (const term of terms) {
      const frequency = item.frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const frequencyOfTerm = documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log(1 + (prepared.length - frequencyOfTerm + 0.5) / (frequencyOfTerm + 0.5));
      const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * item.length / averageLength);
      score += inverseFrequency * (frequency * (1.2 + 1)) / denominator;
    }
    return { id: item.entry.document.id, score };
  });
  return scores
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map(({ id }) => id);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function rankedCosine(documents: readonly RankedDocument[], queryVector: readonly number[]): string[] {
  return documents
    .map(({ document }) => ({ id: document.id, score: cosine(document.vector, queryVector) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map(({ id }) => id);
}

function reciprocalRankFusion(candidates: readonly RankedDocument[], bm25: readonly string[], vector: readonly string[]): RankedDocument[] {
  const scores = new Map<string, number>();
  for (const [rank, id] of bm25.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  for (const [rank, id] of vector.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  return [...candidates].sort((left, right) => {
    const scoreDelta = (scores.get(right.document.id) ?? 0) - (scores.get(left.document.id) ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    const sourceDelta = left.source.config.sourceSystem.localeCompare(right.source.config.sourceSystem);
    return sourceDelta || left.document.id.localeCompare(right.document.id);
  });
}

function validateVector(vector: unknown, dimensions: number): vector is number[] {
  return Array.isArray(vector) && vector.length === dimensions && vector.some(value => value !== 0) && vector.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000);
}

export class InstitutionalKnowledgeRepository {
  private readonly store: InstitutionalKnowledgeStore;
  private readonly scope: string;
  private readonly sources: ReadonlyMap<KnowledgeSourceSystem, NormalizedSource>;
  private readonly embedding: InstitutionalKnowledgeEmbedding;
  private readonly allowedDataClasses: ReadonlySet<KnowledgeSourceClassification>;
  private readonly clock: () => number;
  private readonly locallySuspended = new Set<KnowledgeSourceSystem>();

  constructor(options: InstitutionalKnowledgeRepositoryOptions) {
    const storeCandidate: unknown = options.store;
    if (
      storeCandidate === null ||
      typeof storeCandidate !== 'object' ||
      !('read' in storeCandidate) ||
      typeof storeCandidate.read !== 'function' ||
      !('compareAndSet' in storeCandidate) ||
      typeof storeCandidate.compareAndSet !== 'function'
    ) {
      throw new TypeError('A structural JSON store is required.');
    }
    if (typeof options.scope !== 'string' || options.scope.trim().length === 0 || options.scope.length > 128 || options.scope.includes('\0')) {
      throw new TypeError('Institutional knowledge scope is invalid.');
    }
    if (options.sources.length !== KNOWLEDGE_SOURCE_SYSTEMS.length) {
      throw new TypeError('Both institutional knowledge sources are required.');
    }
    const sourceMap = new Map<KnowledgeSourceSystem, NormalizedSource>();
    for (const source of options.sources) {
      if (!KNOWLEDGE_SOURCE_SYSTEMS.includes(source.sourceSystem) || sourceMap.has(source.sourceSystem)) {
        throw new TypeError('Institutional knowledge sources must be unique.');
      }
      if (source.publicKey.type !== 'public' || source.publicKey.asymmetricKeyType !== 'ed25519') {
        throw new TypeError('Source export keys must be Ed25519 public keys.');
      }
      if (typeof source.policyRevision !== 'string' || source.policyRevision.trim().length === 0 || source.policyRevision.length > 128) {
        throw new TypeError('Source policy revision is invalid.');
      }
      if (!Number.isSafeInteger(source.maxAgeMs) || source.maxAgeMs <= 0 || source.maxAgeMs > MAX_AGE_MS) {
        throw new TypeError('Source maximum age is invalid.');
      }
      const pinned = normalizeSourceOrigin(source.origin);
      sourceMap.set(source.sourceSystem, {
        ...source,
        origin: pinned.origin,
        basePath: pinned.basePath,
        publicKeyFingerprint: digest(source.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')),
      });
    }
    if (KNOWLEDGE_SOURCE_SYSTEMS.some((sourceSystem) => !sourceMap.has(sourceSystem))) {
      throw new TypeError('Both institutional knowledge sources are required.');
    }
    if (
      typeof options.embedding.modelId !== 'string' ||
      options.embedding.modelId.trim().length === 0 ||
      options.embedding.modelId.length > 128 ||
      !Number.isSafeInteger(options.embedding.dimensions) ||
      options.embedding.dimensions <= 0 ||
      options.embedding.dimensions > 2_048 ||
      typeof options.embedding.embedQuery !== 'function'
    ) {
      throw new TypeError('Institutional knowledge embedding configuration is invalid.');
    }
    const allowedDataClasses = new Set<KnowledgeSourceClassification>();
    for (const dataClass of options.embedding.allowedDataClasses) {
      const parsed = knowledgeSourceClassificationSchema.safeParse(dataClass);
      if (!parsed.success || allowedDataClasses.has(parsed.data)) throw new TypeError('Embedding data policy is invalid.');
      allowedDataClasses.add(parsed.data);
    }
    this.store = storeCandidate as InstitutionalKnowledgeStore;
    this.scope = options.scope;
    this.sources = sourceMap;
    this.embedding = options.embedding;
    this.allowedDataClasses = allowedDataClasses;
    this.clock = options.clock ?? Date.now;
  }

  /** Trusted worker fencing; never exposed as a model tool or browser capability. */
  async beginSourceRefresh(sourceSystem: KnowledgeSourceSystem): Promise<KnowledgeSourceRefreshFence> {
    if (!this.sources.has(sourceSystem)) sourceUnavailable();
    const current = await this.store.read(this.availabilityKey(sourceSystem));
    const availability = current ? availabilitySchema.parse(current.value) : undefined;
    const snapshot = await this.store.read(this.storeKey(sourceSystem));
    return { revision: current?.revision ?? null, epoch: availability?.epoch ?? 'initial', snapshotRevision: snapshot?.revision ?? null };
  }

  /** An observed failed refresh immediately denies reads, without deleting signed revision history. */
  async suspendSource(sourceSystem: KnowledgeSourceSystem): Promise<void> {
    if (!this.sources.has(sourceSystem)) sourceUnavailable();
    this.locallySuspended.add(sourceSystem);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.store.read(this.availabilityKey(sourceSystem));
      if (await this.store.compareAndSet(this.availabilityKey(sourceSystem), current?.revision ?? null,
        { blocked: true, epoch: randomUUID() })) return;
    }
    throw new InstitutionalKnowledgeError('store_conflict');
  }

  /** Only a complete refresh begun at the current availability epoch may reopen a source. */
  async finishSourceRefresh(sourceSystem: KnowledgeSourceSystem, fence: KnowledgeSourceRefreshFence): Promise<void> {
    if (!this.sources.has(sourceSystem)) sourceUnavailable();
    const current = await this.store.read(this.availabilityKey(sourceSystem));
    if ((current?.revision ?? null) !== fence.revision) throw new InstitutionalKnowledgeError('source_changed');
    const snapshot = await this.store.read(this.storeKey(sourceSystem));
    if (!snapshot || snapshot.revision === fence.snapshotRevision) throw new InstitutionalKnowledgeError('source_changed');
    const source = this.sources.get(sourceSystem);
    if (!source) sourceUnavailable();
    verifySignedExport(snapshot.value, source, this.embedding, this.currentTime(), true);
    const epoch = current ? availabilitySchema.parse(current.value).epoch : 'initial';
    if (epoch !== fence.epoch || !await this.store.compareAndSet(this.availabilityKey(sourceSystem), fence.revision,
      { blocked: false, epoch })) throw new InstitutionalKnowledgeError('source_changed');
    this.locallySuspended.delete(sourceSystem);
  }

  async ingest(sourceSystem: KnowledgeSourceSystem, signedExport: unknown): Promise<void> {
    const config = this.sources.get(sourceSystem);
    if (!config) invalidExport();
    const now = this.currentTime();
    const incoming = verifySignedExport(signedExport, config, this.embedding, now, true);
    const key = this.storeKey(sourceSystem);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.store.read(key);
      let currentSnapshot: StoredExport | undefined;
      if (current) currentSnapshot = verifySignedExport(current.value, config, this.embedding, this.currentTime(), false);
      if (currentSnapshot) {
        if (incoming.snapshot.sequence <= currentSnapshot.snapshot.sequence) invalidExport();
        this.assertRevisionProgress(currentSnapshot.snapshot, incoming.snapshot);
      }
      const committed = await this.store.compareAndSet(key, current?.revision ?? null, incoming);
      if (committed) return;
    }
    throw new InstitutionalKnowledgeError('store_conflict');
  }

  async search(actorInput: ActorContext, rawArguments: unknown): Promise<{ documents: KnowledgeDocumentV2[] }> {
    const actor = requireCurrentPermission(actorInput);
    const parsed = searchArgumentsSchema.safeParse(rawArguments);
    if (!parsed.success) throw new InstitutionalKnowledgeError('document_unavailable');
    const args = parsed.data;
    const limit = args.limit ?? 5;
    const snapshots = await this.currentSnapshots();
    const authorityRevision = this.fenceFor(actor, snapshots);
    const allEligible: RankedDocument[] = [];
    for (const sourceSystem of sourceOrder) {
      if (args.sourceSystem && sourceSystem !== args.sourceSystem) continue;
      const source = snapshots.get(sourceSystem);
      if (!source) sourceUnavailable();
      for (const document of source.stored.snapshot.documents) {
        if (isQuarantined(document, this.currentTime()) || !isAuthorized(document, source, actor.subject)) continue;
        const searchableText = [document.text, visibleImageText(document)].filter(Boolean).join(' ');
        allEligible.push({ source, document, searchableText });
      }
    }
    const terms = queryTerms(args.query);
    if (terms.length === 0 || allEligible.length === 0) {
      await this.assertUnchanged(actor, authorityRevision);
      return { documents: [] };
    }
    const bm25Ids = rankedBm25(allEligible, terms);
    const embeddingCandidates = allEligible.filter(({ document }) => this.allowedDataClasses.has(document.classification));
    let vectorIds: string[] = [];
    if (embeddingCandidates.length > 0) {
      const queryVector = await this.embed(args.query);
      vectorIds = rankedCosine(embeddingCandidates, queryVector);
    }
    const ranked = reciprocalRankFusion(allEligible, bm25Ids, vectorIds).slice(0, limit);
    await this.assertUnchanged(actor, authorityRevision);
    const documents = ranked.map(({ source, document }) => this.projectDocument(source, document, authorityRevision));
    return { documents };
  }

  async getDocument(actorInput: ActorContext, rawArguments: unknown): Promise<{ document: KnowledgeDocumentV2 }> {
    const actor = requireCurrentPermission(actorInput);
    const parsed = getDocumentArgumentsSchema.safeParse(rawArguments);
    if (!parsed.success) documentUnavailable();
    const args = parsed.data;
    const snapshots = await this.currentSnapshots();
    const authorityRevision = this.fenceFor(actor, snapshots);
    const sourceSystem = documentIdSource(args.documentId);
    const source = sourceSystem ? snapshots.get(sourceSystem) : undefined;
    const document = source?.stored.snapshot.documents.find((candidate) => candidate.id === args.documentId);
    if (
      !source ||
      !document ||
      (args.revision !== undefined && args.revision !== document.revision) ||
      isQuarantined(document, this.currentTime()) ||
      !isAuthorized(document, source, actor.subject)
    ) {
      documentUnavailable();
    }
    await this.assertUnchanged(actor, authorityRevision);
    return { document: this.projectDocument(source, document, authorityRevision) };
  }

  async authorityFence(actorInput: ActorContext): Promise<string> {
    const actor = requireCurrentPermission(actorInput);
    const snapshots = await this.currentSnapshots();
    return this.fenceFor(actor, snapshots);
  }

  private currentTime(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Institutional knowledge clock returned an invalid timestamp.');
    return now;
  }

  private storeKey(sourceSystem: KnowledgeSourceSystem): string {
    return 'institutional-knowledge:v1:' + digest({ scope: this.scope, sourceSystem });
  }

  private availabilityKey(sourceSystem: KnowledgeSourceSystem): string {
    return this.storeKey(sourceSystem) + ':availability';
  }

  private async currentSnapshots(): Promise<Map<KnowledgeSourceSystem, CurrentSource>> {
    const now = this.currentTime();
    const result = new Map<KnowledgeSourceSystem, CurrentSource>();
    for (const sourceSystem of sourceOrder) {
      const config = this.sources.get(sourceSystem);
      if (!config) sourceUnavailable();
      if (this.locallySuspended.has(sourceSystem)) sourceUnavailable();
      const before = await this.store.read(this.availabilityKey(sourceSystem));
      const available = before ? availabilitySchema.parse(before.value) : undefined;
      if (available?.blocked) sourceUnavailable();
      const stored = await this.store.read(this.storeKey(sourceSystem));
      if (!stored) sourceUnavailable();
      const decoded = verifySignedExport(stored.value, config, this.embedding, now, true);
      const after = await this.store.read(this.availabilityKey(sourceSystem));
      const stillAvailable = after ? availabilitySchema.parse(after.value) : undefined;
      if (this.locallySuspended.has(sourceSystem) || stillAvailable?.blocked || (available?.epoch ?? 'initial') !== (stillAvailable?.epoch ?? 'initial')) sourceUnavailable();
      result.set(sourceSystem, { config, stored: decoded, availabilityEpoch: available?.epoch ?? 'initial' });
    }
    return result;
  }

  private fenceFor(actor: ActorContext, snapshots: ReadonlyMap<KnowledgeSourceSystem, CurrentSource>): string {
    const sources = sourceOrder.map((sourceSystem) => {
      const source = snapshots.get(sourceSystem);
      if (!source) sourceUnavailable();
      return {
        sourceSystem,
        availabilityEpoch: source.availabilityEpoch,
        policyRevision: source.stored.snapshot.policyRevision,
        sourceKeyFingerprint: source.config.publicKeyFingerprint,
        // Freshness is checked on every read. Identical signed heartbeat renewals
        // do not invalidate an otherwise unchanged conversation.
        corpusRevision: digest(source.stored.snapshot.documents),
        granted: source.stored.snapshot.subjects.some(entry => entry.subject === actor.subject),
        groups: [...subjectGroups(source.stored.snapshot, actor.subject)].sort(),
      };
    });
    return digest({ scope: this.scope, subject: actor.subject, permission: 'knowledge:read', sources });
  }

  private async assertUnchanged(actor: ActorContext, expectedFence: string): Promise<void> {
    const current = await this.currentSnapshots();
    if (this.fenceFor(actor, current) !== expectedFence) throw new InstitutionalKnowledgeError('source_changed');
  }

  private projectDocument(
    source: CurrentSource,
    document: KnowledgeDocumentExport,
    authorityRevision: string,
  ): KnowledgeDocumentV2 {
    const sourceSystem = source.config.sourceSystem;
    const fetchedAt = source.stored.snapshot.issuedAt;
    const incident = document.incident && Date.parse(document.incident.validUntil) > this.currentTime()
      ? document.incident
      : undefined;
    const projected = knowledgeDocumentV2Schema.parse({
      id: document.id,
      citationId: 'knowledge:' + sourceSystem + ':' + document.id + ':' + String(document.revision),
      title: document.title,
      sourceSystem,
      language: document.language,
      revision: document.revision,
      synthetic: false,
      text: document.text,
      canonicalUrl: document.canonicalUrl,
      updatedAt: document.updatedAt,
      ...(document.acquisition ? { acquisition: document.acquisition } : {}),
      fetchedAt,
      authorityRevision,
      corpusRevision: digest({ sourceSystem, documents: source.stored.snapshot.documents }),
      dataClass: document.classification,
      images: document.images
        .filter((image) => image.reviewed && image.instructional)
        .map((image) => ({
          id: image.id,
          alt: image.alt,
          transcript: image.transcript,
          reviewed: true,
          instructional: image.instructional,
        })),
      ...(incident ? { incident } : {}),
    });
    return projected;
  }

  private async embed(query: string): Promise<number[]> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new InstitutionalKnowledgeError('embedding_unavailable'));
      }, EMBEDDING_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        this.embedding.embedQuery(query, controller.signal),
        timedOut,
      ]);
      if (!validateVector(result, this.embedding.dimensions)) throw new InstitutionalKnowledgeError('embedding_unavailable');
      return result;
    } catch {
      controller.abort();
      throw new InstitutionalKnowledgeError('embedding_unavailable');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }

  private assertRevisionProgress(previous: KnowledgeSourceExport, next: KnowledgeSourceExport): void {
    const previousById = new Map(previous.documents.map((document) => [document.id, document]));
    const previousRetiredIds = new Set(previous.retiredDocumentIds);
    const nextRetiredIds = new Set(next.retiredDocumentIds);
    for (const id of previousRetiredIds) {
      if (!nextRetiredIds.has(id)) invalidExport();
    }
    for (const document of next.documents) {
      if (previousRetiredIds.has(document.id)) invalidExport();
    }
    for (const document of next.documents) {
      const old = previousById.get(document.id);
      if (!old) continue;
      if (document.revision < old.revision) invalidExport();
      if (document.revision === old.revision && digest(document) !== digest(old)) invalidExport();
    }
    for (const document of previous.documents) {
      if (!nextRetiredIds.has(document.id) && !next.documents.some(candidate => candidate.id === document.id)) invalidExport();
    }
  }
}

export type InstitutionalKnowledgeSearchArguments = z.infer<typeof searchArgumentsSchema>;
export type InstitutionalKnowledgeGetDocumentArguments = z.infer<typeof getDocumentArgumentsSchema>;
