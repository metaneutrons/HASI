import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { createInstitutionalKnowledgePlugin } from './institutional-plugin.js';
import type { KnowledgeDocumentV2 } from './institutional-contracts.js';
import knowledgeSeed from '@hasi/demo-fixtures/knowledge-demo-v1.json' with { type: 'json' };

export { knowledgeManifest } from './manifest.js';
export { createInstitutionalKnowledgePlugin, institutionalKnowledgeManifest } from './institutional-plugin.js';
export { InstitutionalKnowledgeRepository } from './institutional-repository.js';
export * from './institutional-contracts.js';

type SourceSystem = 'service_it' | 'intranet';
type Audience = 'student' | 'employee' | 'admin';

interface KnowledgeDocument {
  id: string;
  sourceSystem: SourceSystem;
  synthetic: boolean;
  language: 'de' | 'en';
  title: string;
  revision: number;
  demoAudience: Audience[];
  tags: string[];
  text: string;
  citationId: string;
}

export interface KnowledgePluginOptions {
  publicKey: KeyObject;
  serviceToken: string;
  allowedHosts?: string[];
  consumeInvocation?: (jti: string, expiresAt: number) => Promise<boolean>;
}

const searchArguments = z.strictObject({
  query: z.string().min(2).max(500),
  sourceSystem: z.enum(['service_it', 'intranet']).optional(),
  limit: z.number().int().min(1).max(5).optional(),
});
const getDocumentArguments = z.strictObject({
  documentId: z.string().regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/),
  revision: z.number().int().positive().optional(),
});

const documents = (knowledgeSeed as { documents: KnowledgeDocument[] }).documents;
const corpusRevision = digest(documents);
const snapshotTime = `${knowledgeSeed.createdAt}T00:00:00Z`;

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'with',
  'aber', 'alle', 'als', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der',
  'des', 'die', 'ein', 'eine', 'einer', 'eines', 'für', 'im', 'in', 'ist', 'mit', 'oder', 'und',
  'von', 'vom', 'was', 'wie', 'zu', 'zum', 'zur',
  'beispiel', 'demo', 'example', 'fictitious', 'fiktiv', 'fictional', 'sample', 'synthetic',
  'synthetisch',
]);

/** Demo fixtures use the current MCP contract; only the source adapter differs. */
export function createKnowledgePlugin(options: KnowledgePluginOptions): FastifyInstance {
  return createInstitutionalKnowledgePlugin({
    ...options,
    repository: {
      search: (actor, rawArgs) => {
        const args = searchArguments.parse(rawArgs);
        const visible = visibleDocuments(actor).filter(document =>
          args.sourceSystem === undefined || document.sourceSystem === args.sourceSystem);
        const queryTokens = tokenize(args.query).filter(token => !stopWords.has(token));
        return Promise.resolve({ documents: visible
          .map((document, index) => ({ document, index, score: scoreDocument(document, queryTokens, args.query) }))
          .filter(candidate => candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .slice(0, args.limit ?? 5).map(({ document }) => toResult(document, actor)) });
      },
      getDocument: (actor, rawArgs) => {
        const args = getDocumentArguments.parse(rawArgs);
        const document = visibleDocuments(actor).find(candidate => candidate.id === args.documentId
          && (args.revision === undefined || candidate.revision === args.revision));
        if (!document) throw new Error('Document unavailable.');
        return Promise.resolve({ document: toResult(document, actor) });
      },
      authorityFence: actor => Promise.resolve(digest({ corpusRevision, authority: authorityRevision(actor) })),
    },
  });
}

function visibleDocuments(actor: ActorContext): KnowledgeDocument[] {
  if (!actor.permissions.includes('knowledge:read')) return [];
  const audience = actor.claims?.['knowledge.demoAudience'];
  return documents.filter(document => typeof audience === 'string'
    && document.demoAudience.includes(audience as Audience));
}

function authorityRevision(actor: ActorContext) {
  return digest({ subject: actor.subject, audience: actor.claims?.['knowledge.demoAudience'] ?? null,
    allowed: actor.permissions.includes('knowledge:read') });
}

function toResult(document: KnowledgeDocument, actor: ActorContext): KnowledgeDocumentV2 {
  if (!document.synthetic) throw new Error('Document is not synthetic.');
  return {
    id: document.id, citationId: `knowledge:${document.sourceSystem}:${document.id}:${String(document.revision)}`,
    title: document.title, sourceSystem: document.sourceSystem, language: document.language,
    revision: document.revision, synthetic: true, text: document.text,
    updatedAt: snapshotTime, fetchedAt: snapshotTime, authorityRevision: authorityRevision(actor),
    corpusRevision, dataClass: 'synthetic_demo', images: [],
  };
}

function scoreDocument(document: KnowledgeDocument, queryTokens: string[], rawQuery: string): number {
  if (queryTokens.length === 0) return 0;
  const titleTokens = tokenize(document.title);
  const tagTokens = document.tags
    .filter((tag) => !tag.startsWith('conflict-group:'))
    .flatMap(tokenize);
  const bodyTokens = tokenize(document.text);
  let score = 0;
  let matchedTerms = 0;

  for (const queryToken of queryTokens) {
    const titleScore = fieldScore(titleTokens, queryToken, 8, 3);
    const tagScore = fieldScore(tagTokens, queryToken, 5, 2);
    const bodyScore = fieldScore(bodyTokens, queryToken, 1, 0.5);
    const bestScore = Math.max(titleScore, tagScore, bodyScore);
    if (bestScore > 0) matchedTerms += 1;
    score += titleScore + tagScore + bodyScore;
  }

  if (matchedTerms > 1) score += matchedTerms;
  const normalizedQuery = normalize(rawQuery).trim();
  if (normalizedQuery.length >= 3) {
    const normalizedTitle = normalize(document.title);
    const normalizedText = normalize(document.text);
    if (normalizedTitle.includes(normalizedQuery)) score += 6;
    else if (normalizedText.includes(normalizedQuery)) score += 2;
  }
  return score;
}

function fieldScore(fieldTokens: string[], queryToken: string, exact: number, prefix: number): number {
  let score = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === queryToken) score = Math.max(score, exact);
    else if (fieldToken.startsWith(queryToken) || queryToken.startsWith(fieldToken)) score = Math.max(score, prefix);
  }
  return score;
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[a-z0-9]+/g) ?? [];
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/ß/g, 'ss');
}
