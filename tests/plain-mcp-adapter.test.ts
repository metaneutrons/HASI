import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInvocationToken, createPluginServer, digest, type PluginManifestV2 } from '@hasi/plugin-sdk';
import { createReviewedPlainMcpAdapter } from '../apps/api/src/plain-mcp-adapter.js';
import { PluginRegistry } from '../apps/api/src/registry.js';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const empty = object({});
const person = object({ person: { type: 'string' } });

describe('reviewed plain MCP adaptation', () => {
  it.each([true, false])('enforces upstream contract pins (%s) and projects host identity before a tool call', async validPin => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest: PluginManifestV2 = { manifestVersion: 2, id: 'fixture.upstream', name: 'Fixture', description: '', version: '1.0.0', apiVersion: '2.0.0', mcpVersion: '2026-07-28', tools: [{ name: 'upstream.read', title: 'Read', description: '', effect: 'read', requiredPermissions: ['rooms:read'], inputSchema: person, outputSchema: person }] };
    let calls = 0;
    const upstream = createPluginServer({ manifest, publicKey, serviceToken: 'synthetic-upstream', handlers: { 'upstream.read': args => { calls++; return Promise.resolve(args); } } });
    // Synthetic upstream compatibility shim: plain MCP callers have a delegated bearer,
    // while this test reuses the SDK's real MCP transport and output validation.
    upstream.addHook('preValidation', async request => {
      const body = request.body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | undefined;
      if (request.headers.authorization !== 'Bearer synthetic-upstream' || body?.method !== 'tools/call') return;
      request.headers['x-hasi-invocation'] = await createInvocationToken({ pluginId: manifest.id, pluginVersion: manifest.version, tool: body.params?.name ?? '', args: body.params?.arguments ?? {}, actor: { subject: 'delegated-fixture', permissions: ['rooms:read'] }, context: { installationId: manifest.id, configurationRevision: 0, configuration: {} } }, privateKey);
    });
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const upstreamAddress = upstream.server.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing fixture address');
    const adapted: PluginManifestV2 = { ...manifest, id: 'fixture.adapter', tools: [{ ...manifest.tools[0]!, name: 'adapter.read', inputSchema: empty }] };
    const adapter = createReviewedPlainMcpAdapter({ manifest: adapted, publicKey, serviceToken: 'synthetic-adapter', upstream: { endpoint: `http://127.0.0.1:${String(upstreamAddress.port)}/mcp`, serverName: manifest.id, serverVersion: manifest.version, allowLoopback: true, credential: () => Promise.resolve('synthetic-upstream') }, tools: { 'adapter.read': { upstreamName: 'upstream.read', inputSchemaDigest: validPin ? digest(person) : '0'.repeat(64), outputSchemaDigest: digest(person), authorize: (_args, actor) => Promise.resolve({ person: actor.subject }) } } });
    await adapter.listen({ host: '127.0.0.1', port: 0 });
    const address = adapter.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing adapter address');
    const registry = new PluginRegistry(privateKey);
    try {
      await registry.install({ endpoint: `http://127.0.0.1:${String(address.port)}/mcp`, allowLoopback: true, serviceToken: 'synthetic-adapter', expectedManifestDigest: digest(adapted) });
      const result = registry.invoke(adapted.id, 'adapter.read', {}, { subject: 'authenticated-person', permissions: ['rooms:read'] });
      if (validPin) await expect(result).resolves.toEqual({ person: 'authenticated-person' });
      else await expect(result).rejects.toThrow();
      expect(calls).toBe(validPin ? 1 : 0);
      await expect(registry.invoke(adapted.id, 'adapter.read', { person: 'foreign-person' }, { subject: 'authenticated-person', permissions: ['rooms:read'] })).rejects.toThrow('Argumente');
    } finally { await registry.close(); await adapter.close(); await upstream.close(); }
  });
});
