import type { PluginManifest, ToolDefinition } from '@hasi/plugin-sdk';

const stringSchema = { type: 'string' };
const sourceSystemSchema = { type: 'string', enum: ['service_it', 'intranet'] };
const documentIdSchema = { type: 'string', pattern: '^(svc|int)-[0-9]{3}$' };
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const documentSchema = objectSchema({
  id: documentIdSchema,
  citationId: stringSchema,
  title: stringSchema,
  sourceSystem: sourceSystemSchema,
  language: { type: 'string', enum: ['de', 'en'] },
  revision: { type: 'integer', minimum: 1 },
  synthetic: { type: 'boolean', const: true },
  text: { type: 'string', maxLength: 2_000 },
});

const tools: ToolDefinition[] = [
  {
    name: 'knowledge.search',
    title: 'Wissenssuche',
    description: 'Search synthetic demo documents filtered by the signed demo audience permission.',
    effect: 'read',
    requiredPermissions: ['knowledge:read'],
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 2, maxLength: 500 },
        sourceSystem: sourceSystemSchema,
        limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
      },
      ['query'],
    ),
    outputSchema: objectSchema({
      documents: { type: 'array', maxItems: 5, items: documentSchema },
    }),
  },
  {
    name: 'knowledge.get_document',
    title: 'Wissensdokument abrufen',
    description: 'Read one synthetic demo document filtered by the signed demo audience permission.',
    effect: 'read',
    requiredPermissions: ['knowledge:read'],
    inputSchema: objectSchema({ documentId: documentIdSchema }),
    outputSchema: objectSchema({ document: documentSchema }),
  },
];

export const knowledgeManifest: PluginManifest = {
  manifestVersion: 1,
  id: 'de.hsh.hasi.knowledge',
  name: 'Wissensdienst',
  description: 'Service-IT- und Intranet-Demoquellen mit Freigaben für die Testkonten.',
  version: '0.1.0',
  apiVersion: '1.0.0',
  mcpVersion: '2026-07-28',
  tools,
};
