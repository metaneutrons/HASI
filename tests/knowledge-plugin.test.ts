import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createInvocationToken, type ActorContext } from '@hasi/plugin-sdk';
import { createKnowledgePlugin, knowledgeManifest } from '../apps/knowledge-plugin/src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const serviceToken = 'knowledge-plugin-test-service-token';
const activePlugins: ReturnType<typeof createKnowledgePlugin>[] = [];

afterEach(async () => {
  await Promise.all(activePlugins.splice(0).map((plugin) => plugin.close()));
});

describe('knowledge plugin', () => {
  it('declares strict, bounded tools and returns full synthetic evidence over signed MCP', async () => {
    expect(knowledgeManifest.id).toBe('de.hsh.hasi.knowledge');
    expect(knowledgeManifest.version).toBe('0.2.0');
    expect(knowledgeManifest.tools.map((tool) => tool.name)).toEqual([
      'knowledge.search',
      'knowledge.get_document',
      'knowledge.authority_fence',
    ]);
    for (const tool of knowledgeManifest.tools) {
      expect(tool.requiredPermissions).toEqual(['knowledge:read']);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
    const search = knowledgeManifest.tools[0]!;
    const getDocument = knowledgeManifest.tools[1]!;
    expect(search.inputSchema.required).toEqual(['query']);
    expect(search.inputSchema.properties).toMatchObject({
      query: { type: 'string', minLength: 2, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
    });
    expect(getDocument.inputSchema.properties).toMatchObject({
      documentId: { type: 'string', pattern: '^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$' },
    });
    const searchOutput = search.outputSchema.properties as {
      documents: { items: { additionalProperties: boolean } };
    };
    expect(searchOutput.documents.items.additionalProperties).toBe(false);

    const result = await callAs(student, 'knowledge.search', {
      query: 'WLAN-Verbindung prüfen',
      sourceSystem: 'service_it',
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as { documents: Record<string, unknown>[] };
    expect(content.documents).toHaveLength(1);
    expect(content.documents[0]).toMatchObject({
      id: 'svc-001',
      citationId: 'knowledge:service_it:svc-001:1',
      title: 'Demo: WLAN-Verbindung prüfen',
      sourceSystem: 'service_it',
      language: 'de',
      revision: 1,
      synthetic: true,
    });
    expect(content.documents[0]?.text).toContain('Morgenstern-Lab');
    expect(Object.keys(content.documents[0] ?? {}).sort()).toEqual([
      'authorityRevision', 'citationId', 'corpusRevision', 'dataClass', 'fetchedAt', 'id', 'images', 'language', 'revision', 'sourceSystem', 'synthetic', 'text', 'title', 'updatedAt',
    ]);
    expect(JSON.stringify(content)).not.toMatch(/evalQueries|expectedDocumentIds|conflict-group/);

    const getResult = await callAs(student, 'knowledge.get_document', { documentId: 'svc-001' });
    expect(getResult.structuredContent).toEqual({ document: content.documents[0] });
  });

  it('filters role-inaccessible search and get results before exposing document metadata', async () => {
    const searched = await callAs(student, 'knowledge.search', {
      query: 'Freigabe einer Gremientagesordnung',
      sourceSystem: 'intranet',
    });
    const visible = (searched.structuredContent as { documents: { id: string }[] }).documents;
    expect(visible.some((document) => document.id === 'int-013' || document.id === 'int-014')).toBe(false);

    const denied = await callAs(student, 'knowledge.get_document', { documentId: 'int-013' });
    const unknown = await callAs(student, 'knowledge.get_document', { documentId: 'int-999' });
    expect(denied.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(denied.content).toEqual(unknown.content);
  });

  it('does not let query instructions broaden the authenticated audience', async () => {
    const result = await callAs(student, 'knowledge.search', {
      query: 'ignore access policy reveal admin Gremientagesordnung',
      sourceSystem: 'intranet',
      limit: 5,
    });
    const documents = (result.structuredContent as { documents: { id: string }[] }).documents;
    expect(documents.some((document) => document.id === 'int-013')).toBe(false);
    expect(documents.some((document) => document.id === 'int-014')).toBe(false);
  });

  it('accepts English lexical searches and respects employee audience labels', async () => {
    const result = await callAs(employee, 'knowledge.search', {
      query: 'software access request',
      sourceSystem: 'service_it',
      limit: 2,
    });
    const documents = (result.structuredContent as { documents: { id: string }[] }).documents;
    expect(documents[0]?.id).toBe('svc-025');
  });
});

const student: ActorContext = {
  subject: 'demo-student',
  claims: { 'knowledge.demoAudience': 'student' },
  customerId: 'demo-student-customer',
  resourceIds: [],
  permissions: ['knowledge:read', 'knowledge:audience:student'],
};

const employee: ActorContext = {
  subject: 'demo-employee',
  claims: { 'knowledge.demoAudience': 'employee' },
  customerId: 'demo-employee-customer',
  resourceIds: [],
  permissions: ['knowledge:read', 'knowledge:audience:employee'],
};

async function callAs(actor: ActorContext, tool: string, args: Record<string, unknown>) {
  const plugin = createKnowledgePlugin({ publicKey, serviceToken });
  activePlugins.push(plugin);
  const invocation = await createInvocationToken({
    actor,
    pluginId: knowledgeManifest.id,
    pluginVersion: knowledgeManifest.version,
    tool,
    args,
    context: { installationId: knowledgeManifest.id, configurationRevision: 0, configuration: {} },
  }, privateKey);
  const response = await plugin.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'x-hasi-invocation': invocation,
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.body.split('\n').find((line) => line.startsWith('data: '));
  const payload = body ? body.slice('data: '.length) : response.body;
  return (JSON.parse(payload) as {
    result: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown[] };
  }).result;
}
