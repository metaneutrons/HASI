import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPluginServer, type ActorContext } from '@hasi/plugin-sdk';
import knowledgeSeed from '@hasi/demo-fixtures/knowledge-demo-v1.json' with { type: 'json' };
import { knowledgeManifest } from './manifest.js';

export { knowledgeManifest } from './manifest.js';

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

interface KnowledgeDocumentResult {
  id: string;
  citationId: string;
  title: string;
  sourceSystem: SourceSystem;
  language: 'de' | 'en';
  revision: number;
  synthetic: true;
  text: string;
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
  documentId: z.string().regex(/^(svc|int)-[0-9]{3}$/),
});

const documents = (knowledgeSeed as { documents: KnowledgeDocument[] }).documents;
// These fixture labels only filter synthetic examples; real authorization belongs to the host.
const audiencePermissions: Record<Audience, string> = {
  student: 'knowledge:audience:student',
  employee: 'knowledge:audience:employee',
  admin: 'knowledge:audience:admin',
};

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'with',
  'aber', 'alle', 'als', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der',
  'des', 'die', 'ein', 'eine', 'einer', 'eines', 'für', 'im', 'in', 'ist', 'mit', 'oder', 'und',
  'von', 'vom', 'was', 'wie', 'zu', 'zum', 'zur',
  'beispiel', 'demo', 'example', 'fictitious', 'fiktiv', 'fictional', 'sample', 'synthetic',
  'synthetisch',
]);

export function createKnowledgePlugin(options: KnowledgePluginOptions): FastifyInstance {
  const manifest = knowledgeManifest;
  return createPluginServer({
    manifest,
    publicKey: options.publicKey,
    serviceToken: options.serviceToken,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.consumeInvocation ? { consumeInvocation: options.consumeInvocation } : {}),
    handlers: {
      'knowledge.search': (rawArgs, actor) => {
        const args = searchArguments.parse(rawArgs);
        const visible = visibleDocuments(actor).filter((document) =>
          args.sourceSystem === undefined || document.sourceSystem === args.sourceSystem,
        );
        const queryTokens = tokenize(args.query).filter((token) => !stopWords.has(token));
        const ranked = visible
          .map((document, index) => ({ document, index, score: scoreDocument(document, queryTokens, args.query) }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .slice(0, args.limit ?? 5);
        return Promise.resolve({ documents: ranked.map(({ document }) => toResult(document)) });
      },
      'knowledge.get_document': (rawArgs, actor) => {
        const args = getDocumentArguments.parse(rawArgs);
        const document = visibleDocuments(actor).find((candidate) => candidate.id === args.documentId);
        if (!document) return Promise.reject(new Error('Document not found.'));
        return Promise.resolve({ document: toResult(document) });
      },
    },
  });
}

function visibleDocuments(actor: ActorContext): KnowledgeDocument[] {
  const permissions = new Set(actor.permissions);
  const audiences = (Object.keys(audiencePermissions) as Audience[]).filter((audience) =>
    permissions.has(audiencePermissions[audience]),
  );
  return documents.filter((document) =>
    document.demoAudience.some((audience) => audiences.includes(audience)),
  );
}

function toResult(document: KnowledgeDocument): KnowledgeDocumentResult {
  if (!document.synthetic) throw new Error('Document is not synthetic.');
  return {
    id: document.id,
    citationId: document.citationId,
    title: document.title,
    sourceSystem: document.sourceSystem,
    language: document.language,
    revision: document.revision,
    synthetic: true,
    text: document.text,
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
