import type { KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  createPluginServer,
  type ActorContext,
  type PluginManifestV2,
  type ToolDefinitionV2,
} from '@hasi/plugin-sdk';
import type { KnowledgeDocumentV2 } from './institutional-contracts.js';

const stringSchema = { type: 'string' };
const sourceSystemSchema = { type: 'string', enum: ['service_it', 'intranet'] };
const documentIdSchema = { type: 'string', pattern: '^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$' };
const timestampSchema = { type: 'string', format: 'date-time' };
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const imageSchema = objectSchema({
  id: stringSchema,
  alt: { type: 'string', maxLength: 500 },
  transcript: { type: 'string', maxLength: 1_000 },
  reviewed: { type: 'boolean', const: true },
  instructional: { type: 'boolean' },
});

const incidentSchema = objectSchema({
  status: { type: 'string', enum: ['active', 'resolved'] },
  validUntil: timestampSchema,
});

const documentSchema = {
  ...objectSchema({
  id: documentIdSchema,
  citationId: { type: 'string', maxLength: 300, pattern: '^knowledge:[A-Za-z0-9._~:_-]{1,288}$' },
  title: { type: 'string', maxLength: 200 },
  sourceSystem: sourceSystemSchema,
  language: { type: 'string', enum: ['de', 'en'] },
  revision: { type: 'integer', minimum: 1 },
  synthetic: { type: 'boolean' },
  text: { type: 'string', maxLength: 4_000 },
  canonicalUrl: { type: 'string', maxLength: 2_048 },
  updatedAt: timestampSchema,
  fetchedAt: timestampSchema,
  authorityRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  corpusRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  dataClass: { type: 'string', enum: ['synthetic_demo', 'public', 'internal', 'confidential'] },
  images: { type: 'array', maxItems: 4, items: imageSchema },
  incident: incidentSchema,
}, [
  'id', 'citationId', 'title', 'sourceSystem', 'language', 'revision', 'synthetic', 'text',
  'updatedAt', 'fetchedAt', 'authorityRevision', 'corpusRevision', 'dataClass', 'images',
  ]),
  oneOf: [
    {
      type: 'object',
      properties: {
        synthetic: { const: true },
        canonicalUrl: { type: 'null' },
        dataClass: { const: 'synthetic_demo' },
      },
    },
    {
      type: 'object',
      properties: {
        synthetic: { const: false },
        canonicalUrl: { type: 'string', maxLength: 2_048 },
        dataClass: { enum: ['public', 'internal', 'confidential'] },
      },
      required: ['canonicalUrl'],
    },
  ],
};

const searchTool: ToolDefinitionV2 = {
  name: 'knowledge.search',
  title: 'Wissenssuche',
  description: 'Search current institutional knowledge after source ACL, publication and freshness checks.',
  effect: 'read',
  requiredPermissions: ['knowledge:read'],
  visibility: ['model'],
  resultSemantics: { kind: 'knowledge' },
  inputSchema: objectSchema({
    query: { type: 'string', minLength: 2, maxLength: 500 },
    sourceSystem: sourceSystemSchema,
    limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
  }, ['query']),
  outputSchema: objectSchema({
    documents: { type: 'array', maxItems: 5, items: documentSchema },
  }),
};

const getDocumentTool: ToolDefinitionV2 = {
  name: 'knowledge.get_document',
  title: 'Wissensdokument abrufen',
  description: 'Read the current authorized revision of an institutional knowledge document.',
  effect: 'read',
  requiredPermissions: ['knowledge:read'],
  visibility: ['app'],
  resultSemantics: { kind: 'knowledge' },
  inputSchema: objectSchema({
    documentId: documentIdSchema,
    revision: { type: 'integer', minimum: 1 },
  }, ['documentId']),
  outputSchema: objectSchema({ document: documentSchema }),
};

const authorityFenceTool: ToolDefinitionV2 = {
  name: 'knowledge.authority_fence',
  title: 'Wissensberechtigung prüfen',
  description: 'Return an opaque current authority and corpus fence for permission revalidation.',
  effect: 'read',
  requiredPermissions: ['knowledge:read'],
  visibility: ['app'],
  resultSemantics: { kind: 'knowledge' },
  inputSchema: objectSchema({}),
  outputSchema: objectSchema({
    fence: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  }),
};

export const institutionalKnowledgeManifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: 'de.hsh.hasi.knowledge',
  name: 'Wissensdienst',
  description: 'Permission-aware institutional Service-IT and intranet knowledge.',
  version: '0.2.0',
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  identity: { claims: ['knowledge.demoAudience'] },
  tools: [searchTool, getDocumentTool, authorityFenceTool],
};

export interface InstitutionalKnowledgePluginOptions {
  repository: InstitutionalKnowledgeRepositoryPort;
  publicKey: KeyObject;
  serviceToken: string;
  allowedHosts?: string[];
  consumeInvocation?: (jti: string, expiresAt: number) => Promise<boolean>;
}

export interface InstitutionalKnowledgeRepositoryPort {
  search(actor: ActorContext, args: unknown): Promise<{ documents: KnowledgeDocumentV2[] }>;
  getDocument(actor: ActorContext, args: unknown): Promise<{ document: KnowledgeDocumentV2 }>;
  authorityFence(actor: ActorContext): Promise<string>;
}

export function createInstitutionalKnowledgePlugin(options: InstitutionalKnowledgePluginOptions): FastifyInstance {
  return createPluginServer({
    manifest: institutionalKnowledgeManifest,
    publicKey: options.publicKey,
    serviceToken: options.serviceToken,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.consumeInvocation ? { consumeInvocation: options.consumeInvocation } : {}),
    handlers: {
      'knowledge.search': (args, actor: ActorContext) => options.repository.search(actor, args),
      'knowledge.get_document': (args, actor: ActorContext) => options.repository.getDocument(actor, args),
      'knowledge.authority_fence': async (_args, actor: ActorContext) => ({
        fence: await options.repository.authorityFence(actor),
      }),
    },
  });
}
