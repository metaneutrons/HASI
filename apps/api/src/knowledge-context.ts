import { createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, digest } from '@hasi/plugin-sdk';
import type { JsonStore } from '@hasi/state';

export type KnowledgeDataClass = 'synthetic_demo' | 'public' | 'internal' | 'confidential';
export type KnowledgeRevision = string | number;
export type KnowledgeDocument = Readonly<Record<string, unknown>>;

export interface KnowledgeDocumentReference {
  readonly documentId: string;
  readonly sourceSystem: string;
  readonly revision: KnowledgeRevision;
  readonly outputDigest: string;
  readonly classification: KnowledgeDataClass;
  readonly corpusRevision?: KnowledgeRevision;
  readonly authorityRevision?: KnowledgeRevision;
}

export interface KnowledgeContextReceipt {
  readonly version: 1;
  readonly scope: string;
  readonly contextId: string;
  readonly subject: string;
  readonly installationBinding: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly documents: readonly KnowledgeDocumentReference[];
  readonly authorityFence?: string;
}

export interface KnowledgeContextStoreOptions {
  readonly store: Pick<JsonStore, 'read' | 'compareAndSet'>;
  readonly scope: string;
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly privateKey?: KeyObject;
  readonly authorityFence?: (subject: string) => Promise<string>;
  readonly resolveDocument: (
    subject: string,
    reference: Pick<KnowledgeDocumentReference, 'documentId' | 'revision' | 'sourceSystem'>,
  ) => Promise<KnowledgeDocument | undefined>;
}

export type KnowledgeContextResolution =
  | { readonly status: 'valid'; readonly documents: readonly KnowledgeDocument[]; readonly dataClasses: readonly KnowledgeDataClass[] }
  | { readonly status: 'unavailable' };

const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = MAX_TTL_MS;
const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATA_CLASSES = new Set<KnowledgeDataClass>(['synthetic_demo', 'public', 'internal', 'confidential']);
const REVISION = (value: unknown): value is KnowledgeRevision => typeof value === 'string'
  ? value.length > 0 && value.length <= 256 && !value.includes('\0')
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const IDENTITY_FIELD = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && !value.includes('\0');

interface StoredEnvelope {
  readonly record: KnowledgeContextReceipt;
  readonly signature?: string;
}

function assertIdentity(value: string, label: string): void {
  if (!IDENTITY_FIELD(value)) throw new TypeError(`${label} must be a non-empty string of at most 256 characters`);
}

function isDataClass(value: unknown): value is KnowledgeDataClass {
  return typeof value === 'string' && DATA_CLASSES.has(value as KnowledgeDataClass);
}

function hasUnsafeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeKeys);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => key === '__proto__' || key === 'prototype' || key === 'constructor' || hasUnsafeKeys(child));
}

function normalizeDocument(value: unknown): KnowledgeDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Knowledge document must be a JSON object');
  const normalized: Record<string, unknown> = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  if (hasUnsafeKeys(normalized)) throw new TypeError('Knowledge documents cannot contain prototype keys');
  if (!IDENTITY_FIELD(normalized.id) || !IDENTITY_FIELD(normalized.sourceSystem) || !REVISION(normalized.revision)) {
    throw new TypeError('Knowledge documents require an id, sourceSystem and revision');
  }

  if (normalized.synthetic === true) {
    if (typeof normalized.title !== 'string' || normalized.title.length === 0 || typeof normalized.text !== 'string'
      || normalized.text.length === 0 || (normalized.dataClass !== undefined && normalized.dataClass !== 'synthetic_demo')) {
      throw new TypeError('Synthetic knowledge documents require a title, text and synthetic data class');
    }
  } else if (!isDataClass(normalized.dataClass)) {
    throw new TypeError('Knowledge documents require a recognized dataClass');
  }

  if (normalized.corpusRevision !== undefined && !REVISION(normalized.corpusRevision)) {
    throw new TypeError('Knowledge document corpusRevision is invalid');
  }
  if (normalized.authorityRevision !== undefined && !REVISION(normalized.authorityRevision)) {
    throw new TypeError('Knowledge document authorityRevision is invalid');
  }
  return normalized;
}

function documentClass(document: KnowledgeDocument): KnowledgeDataClass {
  if (document.synthetic === true) return 'synthetic_demo';
  if (!isDataClass(document.dataClass)) throw new TypeError('Knowledge document dataClass is invalid');
  return document.dataClass;
}

function optionalRevision(document: KnowledgeDocument, name: 'corpusRevision' | 'authorityRevision'): KnowledgeRevision | undefined {
  const value = document[name];
  return value === undefined ? undefined : value as KnowledgeRevision;
}

/** Acquisition time may advance on an identical signed source heartbeat. */
function evidenceDigest(document: KnowledgeDocument) {
  return digest(Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'fetchedAt')));
}

function makeReference(document: KnowledgeDocument): KnowledgeDocumentReference {
  const corpusRevision = optionalRevision(document, 'corpusRevision');
  const authorityRevision = optionalRevision(document, 'authorityRevision');
  const ref: KnowledgeDocumentReference = {
    documentId: document.id as string,
    sourceSystem: document.sourceSystem as string,
    revision: document.revision as KnowledgeRevision,
    outputDigest: evidenceDigest(document),
    classification: documentClass(document),
    ...(corpusRevision === undefined ? {} : { corpusRevision }),
    ...(authorityRevision === undefined ? {} : { authorityRevision }),
  };
  return ref;
}

function isReference(value: unknown): value is KnowledgeDocumentReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return IDENTITY_FIELD(ref.documentId) && IDENTITY_FIELD(ref.sourceSystem) && REVISION(ref.revision)
    && typeof ref.outputDigest === 'string' && /^[0-9a-f]{64}$/u.test(ref.outputDigest)
    && isDataClass(ref.classification)
    && (ref.corpusRevision === undefined || REVISION(ref.corpusRevision))
    && (ref.authorityRevision === undefined || REVISION(ref.authorityRevision));
}

function isReceipt(value: unknown): value is KnowledgeContextReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && IDENTITY_FIELD(record.scope) && typeof record.contextId === 'string' && CONTEXT_ID.test(record.contextId)
    && IDENTITY_FIELD(record.subject) && IDENTITY_FIELD(record.installationBinding)
    && typeof record.issuedAt === 'number' && Number.isSafeInteger(record.issuedAt) && record.issuedAt >= 0
    && typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.issuedAt
    && Array.isArray(record.documents) && record.documents.length <= MAX_DOCUMENTS && record.documents.every(isReference)
    && (record.authorityFence === undefined || (typeof record.authorityFence === 'string' && record.authorityFence.length > 0 && record.authorityFence.length <= 512));
}

function isEnvelope(value: unknown): value is StoredEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return isReceipt(envelope.record)
    && (envelope.signature === undefined || (typeof envelope.signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)));
}

function safeDocuments(documents: readonly unknown[]): KnowledgeDocument[] {
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) throw new RangeError(`A knowledge context can contain at most ${String(MAX_DOCUMENTS)} documents`);
  const normalized = documents.map(normalizeDocument);
  const keys = normalized.map((doc) => `${doc.sourceSystem as string}\0${doc.id as string}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('Knowledge context documents must be unique by source and id');
  if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RangeError(`Knowledge context documents exceed ${String(MAX_DOCUMENT_BYTES)} bytes`);
  }
  return normalized;
}

function sameRevision(left: KnowledgeRevision | undefined, right: KnowledgeRevision | undefined): boolean {
  return left === right;
}

export class KnowledgeContextStore {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly publicKey?: KeyObject;

  constructor(private readonly options: KnowledgeContextStoreOptions) {
    assertIdentity(options.scope, 'scope');
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > MAX_TTL_MS) {
      throw new RangeError(`ttlMs must be between 1 and ${String(MAX_TTL_MS)}`);
    }
    if (options.privateKey) {
      if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519') {
        throw new TypeError('Knowledge context signing requires an Ed25519 private KeyObject');
      }
      this.publicKey = createPublicKey(options.privateKey);
    }
  }

  async issue(subject: string, installationBinding: string, documents: readonly KnowledgeDocument[]): Promise<{ contextId: string }> {
    assertIdentity(subject, 'subject');
    assertIdentity(installationBinding, 'installationBinding');
    const normalized = safeDocuments(documents);
    const issuedAt = this.clock();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt + this.ttlMs > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Knowledge context clock must return a valid millisecond timestamp');
    }
    const authorityFence = this.options.authorityFence ? await this.readFence(subject) : undefined;
    const contextId = randomUUID();
    const record: KnowledgeContextReceipt = {
      version: 1,
      scope: this.options.scope,
      contextId,
      subject,
      installationBinding,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      documents: normalized.map(makeReference),
      ...(authorityFence === undefined ? {} : { authorityFence }),
    };
    const envelope = this.envelope(record);
    const stored = await this.options.store.compareAndSet(this.key(contextId), null, envelope, record.expiresAt);
    if (!stored) throw new Error('Unable to store knowledge context receipt');
    return { contextId };
  }

  async resolve(subject: string, contextId: string, currentInstallationBinding: string): Promise<KnowledgeContextResolution> {
    try {
      if (!IDENTITY_FIELD(subject) || !CONTEXT_ID.test(contextId) || !IDENTITY_FIELD(currentInstallationBinding)) return { status: 'unavailable' };
      const stored = await this.options.store.read(this.key(contextId));
      if (!stored) return { status: 'unavailable' };
      const envelopeValue: unknown = JSON.parse(canonicalJson(stored.value)) as unknown;
      if (!isEnvelope(envelopeValue)) return { status: 'unavailable' };
      const envelope = envelopeValue;
      const record = envelope.record;
      const now = this.clock();
      if (record.scope !== this.options.scope || record.contextId !== contextId || record.subject !== subject
        || record.installationBinding !== currentInstallationBinding || !Number.isSafeInteger(now) || now < record.issuedAt || record.expiresAt <= now
        || record.expiresAt - record.issuedAt > this.ttlMs) return { status: 'unavailable' };
      if (!this.verifyEnvelope(envelope)) return { status: 'unavailable' };

      const fenceBefore = this.options.authorityFence ? await this.readFence(subject) : undefined;
      if (record.authorityFence !== fenceBefore) return { status: 'unavailable' };
      const firstPass = await this.resolvePass(subject, record.documents);
      if (!firstPass) return { status: 'unavailable' };

      let finalDocuments = firstPass;
      if (this.options.authorityFence) {
        if (await this.readFence(subject) !== fenceBefore) return { status: 'unavailable' };
      } else {
        const secondPass = await this.resolvePass(subject, record.documents);
        if (!secondPass || secondPass.some((document, index) => { const previous = firstPass[index]; return !previous || evidenceDigest(document) !== evidenceDigest(previous); })) return { status: 'unavailable' };
        finalDocuments = secondPass;
      }

      const dataClasses = [...new Set(finalDocuments.map(documentClass))].sort();
      return { status: 'valid', documents: finalDocuments, dataClasses };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private key(contextId: string): string {
    return `knowledge-context:v1:${digest({ scope: this.options.scope, contextId })}`;
  }

  private envelope(record: KnowledgeContextReceipt): StoredEnvelope {
    if (!this.options.privateKey) return { record };
    const signature = sign(null, Buffer.from(`hasi-knowledge-context-v1\0${digest(record)}`), this.options.privateKey).toString('base64url');
    return { record, signature };
  }

  private verifyEnvelope(envelope: StoredEnvelope): boolean {
    if (!this.publicKey) return envelope.signature === undefined;
    if (!envelope.signature) return false;
    try {
      return verify(null, Buffer.from(`hasi-knowledge-context-v1\0${digest(envelope.record)}`), this.publicKey, Buffer.from(envelope.signature, 'base64url'));
    } catch {
      return false;
    }
  }

  private async readFence(subject: string): Promise<string> {
    const fence = await this.options.authorityFence?.(subject);
    if (typeof fence !== 'string' || fence.length === 0 || fence.length > 512) throw new TypeError('Knowledge authority fence is invalid');
    return fence;
  }

  private async resolvePass(subject: string, references: readonly KnowledgeDocumentReference[]): Promise<KnowledgeDocument[] | undefined> {
    const outcomes = await Promise.allSettled(references.map(async (reference) => {
      const result = await this.options.resolveDocument(subject, {
        documentId: reference.documentId,
        revision: reference.revision,
        sourceSystem: reference.sourceSystem,
      });
      if (result === undefined) return undefined;
      const document = normalizeDocument(result);
      const currentReference = makeReference(document);
      if (currentReference.documentId !== reference.documentId || currentReference.sourceSystem !== reference.sourceSystem
        || !sameRevision(currentReference.revision, reference.revision) || currentReference.outputDigest !== reference.outputDigest
        || !sameRevision(currentReference.corpusRevision, reference.corpusRevision)
        || !sameRevision(currentReference.authorityRevision, reference.authorityRevision)
        || currentReference.classification !== reference.classification) return undefined;
      return document;
    }));
    const documents: KnowledgeDocument[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected' || outcome.value === undefined) return undefined;
      documents.push(outcome.value);
    }
    if (Buffer.byteLength(canonicalJson(documents), 'utf8') > MAX_DOCUMENT_BYTES) return undefined;
    return documents;
  }
}
