import { describe, expect, it } from 'vitest';
import {
  actorContextSchema,
  manifestSchema,
  parseActorContext,
  parseConfiguration,
  projectActorContext,
  validateConfiguration,
  type ActorContext,
  type PluginManifest,
  type ToolDefinitionV2,
} from '../src/index.js';

const configSchema = {
  type: 'object',
  properties: {
    campus: { type: 'string', minLength: 1, maxLength: 80 },
    pageSize: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['campus'],
  additionalProperties: false,
};

const presentation = {
  id: 'results',
  resourceUri: 'ui://catalog/results.html',
  mimeType: 'text/html;profile=mcp-app' as const,
  sha256: 'a'.repeat(64),
  csp: {
    connectDomains: ['catalog.example.edu'],
    resourceDomains: ['static.example.edu'],
  },
};

const tool: ToolDefinitionV2 = {
  name: 'catalog.search',
  title: 'Search catalog',
  description: 'Find entries in the catalog.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { results: { type: 'array', items: { type: 'string' }, maxItems: 20 } },
    required: ['results'],
    additionalProperties: false,
  },
  effect: 'read',
  requiredPermissions: ['catalog:read'],
  visibility: ['model', 'app'],
  presentationId: 'results',
  resultSemantics: { kind: 'knowledge' },
};

const manifestV2: PluginManifest = {
  manifestVersion: 2,
  id: 'de.example.catalog',
  name: 'Catalog',
  description: 'Search the university catalog.',
  version: '2.1.0',
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  tools: [tool],
  configuration: {
    schema: configSchema,
    fields: [
      { name: 'campus', label: 'Campus', help: 'Select the campus to search.', group: 'Connection' },
      { name: 'pageSize', label: 'Page size', group: 'Results' },
    ],
  },
  secrets: [{ name: 'apiToken', required: true }],
  identity: { claims: ['catalog.tenant', 'catalog.roles'] },
  presentations: [presentation],
};

describe('plugin manifest v2 contract', () => {
  it('accepts v2 declarations with bounded configuration, logical secrets, identity, tools and presentations', () => {
    expect(manifestSchema.safeParse(manifestV2).success).toBe(true);
  });

  it('requires exact manifest and API version matching while v1 rejects v2 fields', () => {
    expect(manifestSchema.safeParse({ ...manifestV2, apiVersion: '1.0.0' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, manifestVersion: 1 }).success).toBe(false);

    const legacyTool = {
      name: 'read',
      title: 'Read',
      description: '',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      effect: 'read',
      requiredPermissions: [],
    };
    const legacy = {
      manifestVersion: 1,
      id: 'legacy',
      name: 'Legacy',
      description: '',
      version: '1.0.0',
      apiVersion: '1.0.0',
      mcpVersion: '2026-07-28',
      tools: [legacyTool],
    };
    expect(manifestSchema.parse(legacy)).toEqual(legacy);
    const legacyWithV2ToolField = {
      ...legacy,
      tools: [{ ...legacyTool, visibility: ['model'] }],
    };
    expect(manifestSchema.safeParse(legacyWithV2ToolField).success).toBe(false);
  });

  it('rejects duplicate declarations, unresolved references and unsafe schema references', () => {
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [tool, tool] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, presentationId: 'missing' }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, secrets: [{ name: 'apiToken', required: true }, { name: 'apiToken', required: false }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, configuration: { schema: { ...configSchema, properties: { ...configSchema.properties, apiToken: { type: 'string' } } } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, inputSchema: { type: 'object', $ref: 'https://attacker.example/schema.json' } }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, inputSchema: { type: 'object', $ref: '#/$defs/missing' } }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, secrets: [{ name: 'apiToken', required: true, secretRef: 'vault/secret' }] }).success).toBe(false);
  });

  it('rejects oversized/deep schemas and prototype keys', () => {
    const deepSchema: Record<string, unknown> = { type: 'string' };
    let current = deepSchema;
    for (let depth = 0; depth < 22; depth += 1) {
      const child: Record<string, unknown> = {};
      current.items = child;
      current = child;
    }
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, inputSchema: deepSchema }] }).success).toBe(false);
    const prototypeSchema = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, inputSchema: prototypeSchema }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifestV2, tools: [{ ...tool, inputSchema: { type: 'string', pattern: 'a'.repeat(33_000) } }] }).success).toBe(false);
  });

  it('projects only relevant permissions and v2 claims declared by the plugin', () => {
    const actor: ActorContext = {
      subject: 'user-1',
      permissions: ['catalog:read', 'rooms:execute'],
      customerId: 'anny-customer',
      resourceIds: ['room-1'],
      claims: {
        'catalog.tenant': 'tenant-1',
        'catalog.roles': ['reader'],
        'anny.customer': 'unrelated',
      },
    };

    expect(projectActorContext(actor, manifestV2)).toEqual({
      subject: 'user-1',
      permissions: ['catalog:read'],
      claims: { 'catalog.tenant': 'tenant-1', 'catalog.roles': ['reader'] },
    });
  });

  it('keeps legacy anny claims for v1 anny while omitting them from other v1 plugins', () => {
    const actor: ActorContext = {
      subject: 'user-1',
      permissions: ['rooms:read', 'knowledge:read'],
      customerId: 'anny-customer',
      resourceIds: ['room-1'],
    };
    const legacyTool = {
      name: 'legacy.read',
      title: 'Read',
      description: '',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      effect: 'read' as const,
      requiredPermissions: ['rooms:read'],
    };
    const anny = {
      manifestVersion: 1,
      id: 'de.hsh.hasi.anny',
      name: 'anny',
      description: '',
      version: '1.0.0',
      apiVersion: '1.0.0',
      mcpVersion: '2026-07-28',
      tools: [legacyTool],
    } as unknown as PluginManifest;
    const knowledge = { ...anny, id: 'de.hsh.hasi.knowledge', tools: [{ ...legacyTool, requiredPermissions: ['knowledge:read'] }] } as PluginManifest;

    expect(projectActorContext(actor, anny)).toEqual({
      subject: 'user-1',
      permissions: ['rooms:read'],
      customerId: 'anny-customer',
      resourceIds: ['room-1'],
    });
    expect(projectActorContext(actor, knowledge)).toEqual({ subject: 'user-1', permissions: ['knowledge:read'] });
  });
});

describe('generic actor and public configuration contracts', () => {
  it('accepts bounded scalar and string-array claims and rejects nested or prototype data', () => {
    expect(parseActorContext({
      subject: 'user-1',
      permissions: ['catalog:read'],
      claims: { 'catalog.tenant': 'tenant-1', 'catalog.roles': ['reader', 'editor'], active: true, level: 3 },
    })).toEqual({
      subject: 'user-1',
      permissions: ['catalog:read'],
      claims: { 'catalog.tenant': 'tenant-1', 'catalog.roles': ['reader', 'editor'], active: true, level: 3 },
    });
    expect(actorContextSchema.safeParse({ subject: 'u', permissions: [], claims: { nested: { value: 'no' } } }).success).toBe(false);
    expect(actorContextSchema.safeParse(JSON.parse('{"subject":"u","permissions":[],"claims":{"constructor":"blocked"}}')).success).toBe(false);
    expect(actorContextSchema.safeParse({ subject: 'u', permissions: ['read', 'read'] }).success).toBe(false);
  });

  it('validates configuration with Ajv and returns safe field diagnostics', () => {
    expect(parseConfiguration(configSchema, { campus: 'Linden', pageSize: 10 })).toEqual({ campus: 'Linden', pageSize: 10 });

    const invalid = validateConfiguration(configSchema, { campus: 'Linden', pageSize: 100, apiToken: 'do-not-report-this' });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.diagnostics.some((diagnostic) => diagnostic.path === '/pageSize')).toBe(true);
      expect(JSON.stringify(invalid.diagnostics)).not.toContain('do-not-report-this');
    }
  });

  it('rejects public secret references, explicit secret schema fields and remote references', () => {
    expect(validateConfiguration(configSchema, { campus: 'secret://vault/ref' }).valid).toBe(false);
    expect(validateConfiguration(configSchema, { campus: 'Linden', secretRef: 'vault/ref' }).valid).toBe(false);

    const secretFieldSchema = {
      type: 'object',
      properties: { password: { type: 'string', writeOnly: true } },
      additionalProperties: false,
    };
    expect(validateConfiguration(secretFieldSchema, { password: 'value' }).valid).toBe(false);
    expect(validateConfiguration({ type: 'object', properties: {}, additionalProperties: false, $ref: 'https://example.test/config' }, {}).valid).toBe(false);

    const nestedOpenObjectSchema = {
      type: 'object',
      properties: { connection: { type: 'object', properties: { host: { type: 'string' } } } },
      additionalProperties: false,
    };
    expect(validateConfiguration(nestedOpenObjectSchema, { connection: { host: 'example.edu', password: 'value' } }).valid).toBe(false);
  });

  it('supports only local references that resolve within the bounded schema', () => {
    const localSchema = {
      type: 'object',
      properties: { campus: { $ref: '#/$defs/campus' } },
      $defs: { campus: { type: 'string', minLength: 1 } },
      required: ['campus'],
      additionalProperties: false,
    };
    expect(validateConfiguration(localSchema, { campus: 'Linden' }).valid).toBe(true);
    expect(validateConfiguration(localSchema, { campus: '' }).valid).toBe(false);
  });
});
