import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { digest, type ActorContext } from '@hasi/plugin-sdk';
import { createInstitutionalKnowledgePlugin } from './institutional-plugin.js';
import type { KnowledgeDocumentV2 } from './institutional-contracts.js';
import { createDemoContentAcquirer, type DemoAcquiredBody, type DemoContentCapability } from './demo-content.js';
import { knowledgeDocuments, knowledgeCreatedAt } from '@hasi/demo-fixtures/knowledge-catalog';

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
  /** Explicit host-owned transport capability for the synthetic ServiceIT demo only. */
  demoContent?: DemoContentCapability;
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

const documents: readonly KnowledgeDocument[] = knowledgeDocuments;
const corpusRevision = digest(documents);
const snapshotTime = `${knowledgeCreatedAt}T00:00:00Z`;

const stopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'with',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'do', 'does', 'did', 'please', 'help',
  'aber', 'alle', 'als', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der',
  'des', 'die', 'ein', 'eine', 'einer', 'eines', 'für', 'im', 'in', 'ist', 'mit', 'oder', 'und',
  'von', 'vom', 'was', 'wie', 'zu', 'zum', 'zur',
  'ich', 'du', 'dich', 'dir', 'mich', 'mir', 'mein', 'meine', 'meinem', 'meinen', 'meiner', 'meines',
  'wir', 'uns', 'unser', 'unsere', 'unserem', 'unseren', 'unserer', 'unseres',
  'bitte', 'kann', 'kannst', 'können', 'könnt', 'helfen', 'hilfe',
  'beispiel', 'demo', 'example', 'fictitious', 'fiktiv', 'fictional', 'sample', 'synthetic',
  'synthetisch',
].map(normalize));
const contextTerms = new Set([
  'not', 'no', 'work', 'works', 'working', 'broken', 'problem', 'problems', 'issue', 'issues', 'error', 'errors', 'failed', 'failure',
  'nicht', 'kein', 'keine', 'keinem', 'keinen', 'keiner', 'keines', 'funktioniere', 'funktionieren', 'funktioniert', 'funktionierst',
  'geht', 'gehen', 'ging', 'gegangen', 'klappt', 'klappen', 'fehler', 'fehlerbild', 'fehlersuche', 'probleme', 'störung', 'störungen',
  'kaputt', 'defekt',
].map(normalize));

/** Demo fixtures use the current MCP contract; only the source adapter differs. */
export function createKnowledgePlugin(options: KnowledgePluginOptions): FastifyInstance {
  const { demoContent: demoContentCapability, ...pluginOptions } = options;
  const demoContent = demoContentCapability ? createDemoContentAcquirer(demoContentCapability) : undefined;
  return createInstitutionalKnowledgePlugin({
    ...pluginOptions,
    repository: {
      search: async (actor, rawArgs) => {
        const args = searchArguments.parse(rawArgs);
        const visible = visibleDocuments(actor).filter(document =>
          args.sourceSystem === undefined || document.sourceSystem === args.sourceSystem);
        const queryTokens = [...new Set(tokenize(args.query))];
        const topicTokens = queryTokens.filter(token => !stopWords.has(token) && !contextTerms.has(token));
        const contextTokens = queryTokens.filter(token => contextTerms.has(token));
        const ranked = visible
          .map((document, index) => ({
            document,
            index,
            topicScore: scoreDocument(document, topicTokens),
            contextScore: scoreDocument(document, contextTokens, []),
          }))
          .filter(candidate => candidate.topicScore > 0)
          .sort((left, right) => right.topicScore - left.topicScore
            || right.contextScore - left.contextScore
            || left.index - right.index)
          .slice(0, args.limit ?? 5);
        const acquired = await acquireRankedServiceIt(ranked.map(({ document }) => document), demoContent);
        return { documents: ranked.map(({ document }) => toResult(document, actor, acquired.get(document.id))) };
      },
      getDocument: async (actor, rawArgs) => {
        const args = getDocumentArguments.parse(rawArgs);
        const document = visibleDocuments(actor).find(candidate => candidate.id === args.documentId
          && (args.revision === undefined || candidate.revision === args.revision));
        if (!document) throw new Error('Document unavailable.');
        const acquired = document.sourceSystem === 'service_it' && demoContent
          ? await demoContent.read(document.id) : undefined;
        return { document: toResult(document, actor, acquired) };
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

async function acquireRankedServiceIt(documents: readonly KnowledgeDocument[], acquirer: ReturnType<typeof createDemoContentAcquirer> | undefined) {
  const acquired = new Map<string, DemoAcquiredBody>();
  if (!acquirer) return acquired;
  const serviceDocuments = documents.filter(document => document.sourceSystem === 'service_it');
  const bodies = await Promise.all(serviceDocuments.map(async document => [document.id, await acquirer.read(document.id)] as const));
  for (const [id, body] of bodies) acquired.set(id, body);
  return acquired;
}

function authorityRevision(actor: ActorContext) {
  return digest({ subject: actor.subject, audience: actor.claims?.['knowledge.demoAudience'] ?? null,
    allowed: actor.permissions.includes('knowledge:read') });
}

function toResult(document: KnowledgeDocument, actor: ActorContext, acquired?: DemoAcquiredBody): KnowledgeDocumentV2 {
  if (!document.synthetic) throw new Error('Document is not synthetic.');
  return {
    id: document.id, citationId: `knowledge:${document.sourceSystem}:${document.id}:${String(document.revision)}`,
    title: document.title, sourceSystem: document.sourceSystem, language: document.language,
    revision: document.revision, synthetic: true, text: acquired?.text ?? document.text,
    updatedAt: snapshotTime, fetchedAt: acquired?.acquiredAt ?? snapshotTime,
    ...(acquired ? { acquisition: { adapter: 'web', sourceRevision: acquired.sourceRevision } } : {}),
    authorityRevision: authorityRevision(actor),
    corpusRevision, dataClass: 'synthetic_demo', images: [],
  };
}

function scoreDocument(document: KnowledgeDocument, queryTokens: string[], phraseTokens = queryTokens): number {
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
  if (phraseTokens.length > 0) {
    if (containsTokenSequence(titleTokens, phraseTokens)) score += 6;
    else if (containsTokenSequence(bodyTokens, phraseTokens)) score += 2;
  }
  return score;
}

function containsTokenSequence(fieldTokens: string[], queryTokens: string[]): boolean {
  return queryTokens.length > 0 && fieldTokens.some((_, start) =>
    queryTokens.every((token, offset) => fieldTokens[start + offset] === token));
}

function fieldScore(fieldTokens: string[], queryToken: string, exact: number, prefix: number): number {
  let score = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === queryToken) score = Math.max(score, exact);
    else if (queryToken.length >= 3 && fieldToken.length >= 3
      && (fieldToken.startsWith(queryToken) || queryToken.startsWith(fieldToken))) score = Math.max(score, prefix);
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

export * from './content/contracts.js';
export * from './content/adapters.js';
export * from './content/acquisition.js';
export { createDemoContentAcquirer, SERVICE_IT_DEMO_ORIGIN } from './demo-content.js';
export type { DemoAcquiredBody, DemoContentAcquirer, DemoContentCapability } from './demo-content.js';
