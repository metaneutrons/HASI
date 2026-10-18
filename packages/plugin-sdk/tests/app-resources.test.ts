import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginServer, type PluginManifestV1, type PluginManifestV2 } from '../src/index.js';

const keys = generateKeyPairSync('ed25519');
const html = '<!doctype html><html><head><title>Example</title></head><body><p>Room list</p></body></html>';
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: 'room-app',
  name: 'Room App',
  description: 'An example room interface.',
  version: '2.0.0',
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  tools: [
    {
      name: 'list-rooms',
      title: 'List rooms',
      description: 'Find accessible rooms.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { rooms: { type: 'array', items: { type: 'string' } } }, required: ['rooms'], additionalProperties: false },
      effect: 'read',
      requiredPermissions: ['rooms:read'],
      visibility: ['model', 'app'],
      presentationId: 'room-list',
      resultSemantics: { kind: 'resources' },
    },
  ],
  presentations: [
    {
      id: 'room-list',
      resourceUri: 'ui://room-app/list.html',
      mimeType: 'text/html;profile=mcp-app',
      sha256: createHash('sha256').update(html).digest('hex'),
      csp: { connectDomains: [], resourceDomains: [] },
    },
  ],
};

const activeApps: ReturnType<typeof createPluginServer>[] = [];

afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
});

describe('MCP app resources', () => {
  it('rejects missing, unexpected, and hash-mismatched resources at startup', () => {
    expect(() => createServer({})).toThrow('appResources must match manifest presentations exactly');
    expect(() => createServer({ 'ui://room-app/list.html': html, 'ui://room-app/extra.html': html })).toThrow(
      'appResources must match manifest presentations exactly',
    );
    expect(() => createServer({ 'ui://room-app/list.html': `${html} ` })).toThrow(
      'does not match its manifest SHA-256',
    );
  });

  it('serves an authenticated, hash-pinned resource with official MCP Apps metadata', async () => {
    const app = createServer({ 'ui://room-app/list.html': html });
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: resourceReadPayload(),
    });
    expect(unauthorized.statusCode).toBe(401);

    const read = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: mcpHeaders,
      payload: resourceReadPayload(),
    });
    expect(read.statusCode).toBe(200);
    const readResult = responseResult(read.body) as {
      contents: { uri: string; mimeType: string; text: string; _meta?: { ui?: { csp?: Record<string, unknown> } } }[];
    };
    expect(readResult.contents).toHaveLength(1);
    expect(readResult.contents[0]).toMatchObject({
      uri: 'ui://room-app/list.html',
      mimeType: 'text/html;profile=mcp-app',
      text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    });

    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: mcpHeaders,
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect(tools.statusCode).toBe(200);
    const listed = responseResult(tools.body) as { tools: { name: string; _meta?: { ui?: Record<string, unknown> } }[] };
    expect(listed.tools[0]).toMatchObject({
      name: 'list-rooms',
      _meta: { ui: { resourceUri: 'ui://room-app/list.html', visibility: ['model', 'app'] } },
    });
  });

  it('does not change v1 resources or tool registration when no app resources are supplied', async () => {
    const v1: PluginManifestV1 = {
      manifestVersion: 1,
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: '1.0.0',
      apiVersion: '1.0.0',
      mcpVersion: '2026-07-28',
      tools: [{
        name: 'list-rooms',
        title: 'List rooms',
        description: 'Find accessible rooms.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { rooms: { type: 'array', items: { type: 'string' } } }, required: ['rooms'], additionalProperties: false },
        effect: 'read',
        requiredPermissions: ['rooms:read'],
      }],
    };
    const app = createPluginServer({
      manifest: v1,
      publicKey: keys.publicKey,
      serviceToken: 'service-secret',
      handlers: { 'list-rooms': listRooms },
    });
    activeApps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: mcpHeaders,
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(200);
    const listed = responseResult(response.body) as { tools: { _meta?: unknown }[] };
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?._meta).toBeUndefined();
  });
});

const mcpHeaders = {
  authorization: 'Bearer service-secret',
  accept: 'application/json, text/event-stream',
};

function createServer(appResources: Record<string, string>): ReturnType<typeof createPluginServer> {
  const app = createPluginServer({
    manifest,
    publicKey: keys.publicKey,
    serviceToken: 'service-secret',
    handlers: { 'list-rooms': listRooms },
    appResources,
  });
  activeApps.push(app);
  return app;
}

const listRooms = () => Promise.resolve({ rooms: [] });

function resourceReadPayload() {
  return { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://room-app/list.html' } };
}

function responseResult(body: string): unknown {
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  const rpc = JSON.parse(dataLine ? dataLine.slice('data: '.length) : body) as { result: unknown };
  return rpc.result;
}
