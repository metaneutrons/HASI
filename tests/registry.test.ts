import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginServer, digest, type ActorContext, type PluginManifest } from '@hasi/plugin-sdk';
import { PluginRegistry, RequestError } from '../apps/api/src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pluginId = 'records-plugin';
const serviceToken = 'registry-test-service-token';
const actor: ActorContext = {
  subject: 'staff-123',
  customerId: 'customer-456',
  resourceIds: [],
  permissions: ['records:read'],
};
const inputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
const outputSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};
const baseTool = {
  name: 'records.read',
  title: 'Read records',
  description: 'Read a record summary.',
  inputSchema,
  outputSchema,
  effect: 'read' as const,
  requiredPermissions: ['records:read'],
};
const activeServers: ReturnType<typeof createPluginServer>[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe('plugin registry runtime updates', () => {
  it('invokes a compatible replacement without restarting the registry and blocks permission changes', async () => {
    const v010 = manifest('0.1.0');
    const server010 = createServer(v010);
    const endpoint = await listenOnEphemeralPort(server010);
    const registry = new PluginRegistry(privateKey);

    await registry.install({ endpoint, serviceToken, expectedManifestDigest: digest(v010), allowLoopback: true });
    await expect(registry.invoke(pluginId, 'records.read', {}, actor)).resolves.toEqual({ value: 'served-0.1.0' });

    await server010.close();
    const v011 = manifest('0.1.1');
    const server011 = createServer(v011);
    await server011.listen({ host: '127.0.0.1', port: getPort(endpoint) });

    await expect(registry.invoke(pluginId, 'records.read', {}, actor)).rejects.toMatchObject({ status: 409 });
    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'available' });
    registry.activateUpdate(pluginId);
    expect(registry.version(pluginId)).toBe('0.1.1');
    await expect(registry.invoke(pluginId, 'records.read', {}, actor)).resolves.toEqual({ value: 'served-0.1.1' });

    await server011.close();
    const v012 = manifest('0.1.2', ['records:read', 'records:admin']);
    const server012 = createServer(v012);
    await server012.listen({ host: '127.0.0.1', port: getPort(endpoint) });

    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'blocked' });
    expect(() => { registry.activateUpdate(pluginId); }).toThrow(RequestError);
    expect(registry.version(pluginId)).toBe('0.1.1');
  });

  it('does not activate a stale compatible candidate after the live manifest becomes incompatible', async () => {
    const v010 = manifest('0.1.0');
    const server010 = createServer(v010);
    const endpoint = await listenOnEphemeralPort(server010);
    const registry = new PluginRegistry(privateKey);

    await registry.install({ endpoint, serviceToken, expectedManifestDigest: digest(v010), allowLoopback: true });

    await server010.close();
    const v011 = manifest('0.1.1');
    const server011 = createServer(v011);
    await server011.listen({ host: '127.0.0.1', port: getPort(endpoint) });
    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'available' });

    await server011.close();
    const incompatible = manifest('0.1.2', ['records:read', 'records:admin']);
    const server012 = createServer(incompatible);
    await server012.listen({ host: '127.0.0.1', port: getPort(endpoint) });
    await expect(registry.checkUpdate(pluginId)).resolves.toMatchObject({ status: 'blocked' });

    expect(() => { registry.activateUpdate(pluginId); }).toThrow(RequestError);
    expect(registry.version(pluginId)).toBe('0.1.0');
  });
});

function manifest(version: string, requiredPermissions = ['records:read']): PluginManifest {
  return {
    manifestVersion: 1,
    id: pluginId,
    name: 'Records',
    description: 'Record lookup service.',
    version,
    apiVersion: '1.0.0',
    mcpVersion: '2026-07-28',
    tools: [{ ...baseTool, requiredPermissions }],
  };
}

function createServer(pluginManifest: PluginManifest): ReturnType<typeof createPluginServer> {
  const server = createPluginServer({
    manifest: pluginManifest,
    publicKey,
    serviceToken,
    handlers: {
      'records.read': () => Promise.resolve({ value: `served-${pluginManifest.version}` }),
    },
  });
  // Keep the test's HTTP connections short-lived so a closed server does not
  // leave an idle keep-alive socket in Node's fetch pool for the next version.
  server.server.keepAliveTimeout = 1;
  activeServers.push(server);
  return server;
}

async function listenOnEphemeralPort(server: ReturnType<typeof createPluginServer>): Promise<string> {
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Plugin server did not bind a TCP port');
  }
  return `http://127.0.0.1:${String(address.port)}/mcp`;
}

function getPort(endpoint: string): number {
  const port = Number(new URL(endpoint).port);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error('Plugin endpoint has no TCP port');
  }
  return port;
}
