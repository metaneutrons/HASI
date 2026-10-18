import { z } from 'zod';

export const KNOWLEDGE_SOURCE_SYSTEMS = ['service_it', 'intranet'] as const;
export const KNOWLEDGE_DATA_CLASSES = ['synthetic_demo', 'public', 'internal', 'confidential'] as const;
export const KNOWLEDGE_SOURCE_CLASSIFICATIONS = ['public', 'internal', 'confidential'] as const;

export const knowledgeSourceSystemSchema = z.enum(KNOWLEDGE_SOURCE_SYSTEMS);
export const knowledgeDataClassSchema = z.enum(KNOWLEDGE_DATA_CLASSES);
export const knowledgeSourceClassificationSchema = z.enum(KNOWLEDGE_SOURCE_CLASSIFICATIONS);

const opaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u);
const documentIdSchema = z.string().min(5).max(132).regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime({ offset: true });
const nonEmptyBoundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const knowledgeImageExportSchema = z.strictObject({
  id: opaqueIdSchema,
  alt: nonEmptyBoundedText(500),
  transcript: z.string().max(1_000),
  reviewed: z.boolean(),
  instructional: z.boolean(),
}).superRefine((image, context) => {
  if (image.reviewed && image.transcript.trim().length === 0) {
    context.addIssue({ code: 'custom', path: ['transcript'], message: 'Reviewed images require a transcription.' });
  }
});

export const knowledgeAcquisitionSchema = z.strictObject({
  adapter: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  sourceRevision: nonEmptyBoundedText(256),
  sourceUpdatedAt: timestampSchema.optional(),
});

export const knowledgeDocumentExportSchema = z.strictObject({
  id: documentIdSchema,
  revision: revisionSchema,
  title: nonEmptyBoundedText(200),
  language: z.enum(['de', 'en']),
  canonicalUrl: z.url().max(2_048),
  classification: knowledgeSourceClassificationSchema,
  updatedAt: timestampSchema,
  acquisition: knowledgeAcquisitionSchema.optional(),
  acl: z.strictObject({
    groups: z.array(nonEmptyBoundedText(128)).max(256),
    subjects: z.array(nonEmptyBoundedText(256)).max(10_000),
    authenticated: z.boolean(),
  }),
  text: nonEmptyBoundedText(4_000),
  vector: z.array(z.number().min(-1_000_000).max(1_000_000)).max(2_048),
  images: z.array(knowledgeImageExportSchema).max(4),
  incident: z.strictObject({
    status: z.enum(['active', 'resolved']),
    validUntil: timestampSchema,
  }).optional(),
}).superRefine((document, context) => {
  if (!document.acl.authenticated && document.acl.groups.length === 0 && document.acl.subjects.length === 0) {
    context.addIssue({ code: 'custom', path: ['acl'], message: 'An explicit non-empty ACL is required.' });
  }
  if (new Set(document.acl.groups).size !== document.acl.groups.length) {
    context.addIssue({ code: 'custom', path: ['acl', 'groups'], message: 'ACL groups must be unique.' });
  }
  if (new Set(document.acl.subjects).size !== document.acl.subjects.length) {
    context.addIssue({ code: 'custom', path: ['acl', 'subjects'], message: 'ACL subjects must be unique.' });
  }
  if (new Set(document.images.map(({ id }) => id)).size !== document.images.length) {
    context.addIssue({ code: 'custom', path: ['images'], message: 'Image identifiers must be unique within a document.' });
  }
});

export const knowledgeSourceSubjectSchema = z.strictObject({
  subject: nonEmptyBoundedText(256),
  groups: z.array(nonEmptyBoundedText(128)).max(256),
}).superRefine((entry, context) => {
  if (new Set(entry.groups).size !== entry.groups.length) {
    context.addIssue({ code: 'custom', path: ['groups'], message: 'Subject groups must be unique.' });
  }
});

export const knowledgeSourceExportSchema = z.strictObject({
  version: z.literal(1),
  sourceSystem: knowledgeSourceSystemSchema,
  sequence: revisionSchema,
  policyRevision: nonEmptyBoundedText(128),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  embeddingModelId: nonEmptyBoundedText(128),
  dimensions: z.number().int().min(1).max(2_048),
  subjects: z.array(knowledgeSourceSubjectSchema).max(100_000),
  documents: z.array(knowledgeDocumentExportSchema).max(1_000),
  retiredDocumentIds: z.array(documentIdSchema).max(100_000),
}).superRefine((snapshot, context) => {
  if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.issuedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'The export must expire after issuance.' });
  }
  if (new Set(snapshot.subjects.map(({ subject }) => subject)).size !== snapshot.subjects.length) {
    context.addIssue({ code: 'custom', path: ['subjects'], message: 'Source subjects must be unique.' });
  }
  if (new Set(snapshot.documents.map(({ id }) => id)).size !== snapshot.documents.length) {
    context.addIssue({ code: 'custom', path: ['documents'], message: 'Document identifiers must be unique.' });
  }
  if (new Set(snapshot.retiredDocumentIds).size !== snapshot.retiredDocumentIds.length) {
    context.addIssue({ code: 'custom', path: ['retiredDocumentIds'], message: 'Retired document identifiers must be unique.' });
  }
  const retiredDocumentIds = new Set(snapshot.retiredDocumentIds);
  for (const [index, id] of snapshot.retiredDocumentIds.entries()) {
    const requiredPrefix = snapshot.sourceSystem === 'service_it' ? 'svc-' : 'int-';
    if (!id.startsWith(requiredPrefix)) {
      context.addIssue({ code: 'custom', path: ['retiredDocumentIds', index], message: 'Retired document identifier does not match its source.' });
    }
  }
  for (const [index, document] of snapshot.documents.entries()) {
    const requiredPrefix = snapshot.sourceSystem === 'service_it' ? 'svc-' : 'int-';
    if (!document.id.startsWith(requiredPrefix)) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'id'], message: 'Document identifier does not match its source.' });
    }
    if (retiredDocumentIds.has(document.id)) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'id'], message: 'Retired documents cannot be present in the export.' });
    }
    if (!document.vector.some(value => value !== 0)) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'vector'], message: 'Document vectors must have a non-zero norm.' });
    }
    if (document.vector.length !== snapshot.dimensions) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'vector'], message: 'Document vector dimensions do not match the export.' });
    }
    if (document.acquisition?.sourceUpdatedAt && Date.parse(document.acquisition.sourceUpdatedAt) > Date.parse(snapshot.issuedAt) + 30_000) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'acquisition'], message: 'Source update time is after export issuance.' });
    }
    if (Date.parse(document.updatedAt) > Date.parse(snapshot.issuedAt) + 30_000) {
      context.addIssue({ code: 'custom', path: ['documents', index, 'updatedAt'], message: 'Document update time is after export issuance.' });
    }
  }
});

export const signedKnowledgeExportSchema = z.strictObject({
  snapshot: knowledgeSourceExportSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});

export const knowledgeDocumentV2Schema = z.strictObject({
  id: documentIdSchema,
  citationId: z.string().min(1).max(300).regex(/^knowledge:(service_it|intranet):(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}:[1-9][0-9]*$/u),
  title: nonEmptyBoundedText(200),
  sourceSystem: knowledgeSourceSystemSchema,
  language: z.enum(['de', 'en']),
  revision: revisionSchema,
  synthetic: z.boolean(),
  text: nonEmptyBoundedText(4_000),
  canonicalUrl: z.url().max(2_048).optional(),
  updatedAt: timestampSchema,
  acquisition: knowledgeAcquisitionSchema.optional(),
  fetchedAt: timestampSchema,
  authorityRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  corpusRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  dataClass: knowledgeDataClassSchema,
  images: z.array(z.strictObject({
    id: opaqueIdSchema,
    alt: nonEmptyBoundedText(500),
    transcript: nonEmptyBoundedText(1_000),
    reviewed: z.literal(true),
    instructional: z.boolean(),
  })).max(4),
  incident: z.strictObject({
    status: z.enum(['active', 'resolved']),
    validUntil: timestampSchema,
  }).optional(),
}).superRefine((document, context) => {
  const expectedPrefix = document.sourceSystem === 'service_it' ? 'svc-' : 'int-';
  const expectedCitation = 'knowledge:' + document.sourceSystem + ':' + document.id + ':' + String(document.revision);
  if (!document.id.startsWith(expectedPrefix)) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Document identifier does not match its source.' });
  }
  if (document.citationId !== expectedCitation) {
    context.addIssue({ code: 'custom', path: ['citationId'], message: 'Citation identifier does not match the document revision.' });
  }
  if (document.synthetic && (document.canonicalUrl !== undefined || document.dataClass !== 'synthetic_demo')) {
    context.addIssue({ code: 'custom', path: ['canonicalUrl'], message: 'Synthetic documents use demo data classification and have no original URL.' });
  }
  if (!document.synthetic && (!document.canonicalUrl || document.dataClass === 'synthetic_demo')) {
    context.addIssue({ code: 'custom', path: ['canonicalUrl'], message: 'Institutional documents require an approved canonical URL and source data class.' });
  }
  if (document.incident && Date.parse(document.incident.validUntil) <= Date.parse(document.fetchedAt)) {
    context.addIssue({ code: 'custom', path: ['incident'], message: 'Expired incidents must not be returned.' });
  }
});

export type KnowledgeSourceSystem = z.infer<typeof knowledgeSourceSystemSchema>;
export type KnowledgeDataClass = z.infer<typeof knowledgeDataClassSchema>;
export type KnowledgeSourceClassification = z.infer<typeof knowledgeSourceClassificationSchema>;
export type KnowledgeImageExport = z.infer<typeof knowledgeImageExportSchema>;
export type KnowledgeDocumentExport = z.infer<typeof knowledgeDocumentExportSchema>;
export type KnowledgeSourceSubject = z.infer<typeof knowledgeSourceSubjectSchema>;
export type KnowledgeSourceExport = z.infer<typeof knowledgeSourceExportSchema>;
export type SignedKnowledgeExport = z.infer<typeof signedKnowledgeExportSchema>;
export type KnowledgeDocumentV2 = z.infer<typeof knowledgeDocumentV2Schema>;
