import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginServer, digest, type PluginManifest } from '@hasi/plugin-sdk';
import { createPluginDeploymentGateway, type PluginDeploymentGateway } from '../apps/api/src/plugin-deployment-proxy.js';
import { PluginRegistry } from '../apps/api/src/registry.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const serviceToken = 'managed-gateway-test-service-token';
const manifest: PluginManifest = {
  manifestVersion: 1,
  id: 'managed.gateway.fixture',
  name: 'Managed gateway fixture',
  description: 'Validates the exact operator gateway origin in production mode.',
  version: '1.0.0',
  apiVersion: '1.0.0',
  mcpVersion: '2026-07-28',
  tools: [{
    name: 'gateway.read',
    title: 'Read fixture',
    description: 'Returns a synthetic value.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    effect: 'read',
    requiredPermissions: ['gateway:read'],
  }],
};

type PluginServer = ReturnType<typeof createPluginServer>;
const activeServers: PluginServer[] = [];
const activeGateways: PluginDeploymentGateway[] = [];
const activeRegistries: PluginRegistry[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(activeRegistries.splice(0).map(registry => registry.close()));
  await Promise.all(activeGateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(activeServers.splice(0).map(server => server.close()));
});

describe('production managed plugin gateway composition', () => {
  it('connects only through the exact operator-created gateway origin without enabling registration loopback', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const server = createPluginServer({
      manifest,
      publicKey,
      serviceToken,
      handlers: { 'gateway.read': () => Promise.resolve({ value: 'synthetic' }) },
    });
    server.server.keepAliveTimeout = 1;
    activeServers.push(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('Plugin fixture did not bind a TCP port.');

    const gateway = await createPluginDeploymentGateway({
      port: 0,
      endpointResolver: {
        resolveActiveEndpoint: () => Promise.resolve({
          deploymentId: 'fixture-deployment-1',
          releaseDigest: 'a'.repeat(64),
          host: '127.0.0.1',
          port: address.port,
          containerPort: 3000,
        }),
        assertActiveEndpoint: () => Promise.resolve(true),
      },
      authorize: ({ installationId, authorization }) => installationId === manifest.id && authorization === `Bearer ${serviceToken}`,
    });
    activeGateways.push(gateway);

    const registry = new PluginRegistry(privateKey, { operatorManagedLoopbackOrigin: gateway.origin });
    activeRegistries.push(registry);
    await registry.install({
      instanceId: manifest.id,
      endpoint: `${gateway.origin}/api/plugin-deployments/${manifest.id}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(manifest),
      allowLoopback: false,
    });
    expect(registry.version(manifest.id)).toBe('1.0.0');

    const wrongOriginRegistry = new PluginRegistry(privateKey, { operatorManagedLoopbackOrigin: gateway.origin });
    activeRegistries.push(wrongOriginRegistry);
    await expect(wrongOriginRegistry.install({
      instanceId: manifest.id,
      endpoint: `${gateway.origin.replace('127.0.0.1', 'localhost')}/api/plugin-deployments/${manifest.id}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(manifest),
      allowLoopback: false,
    })).rejects.toMatchObject({ status: 400 });

    const broadLoopbackRegistry = new PluginRegistry(privateKey, { operatorManagedLoopbackOrigin: gateway.origin });
    activeRegistries.push(broadLoopbackRegistry);
    await expect(broadLoopbackRegistry.install({
      instanceId: manifest.id,
      endpoint: `${gateway.origin}/api/plugin-deployments/${manifest.id}/mcp`,
      serviceToken,
      expectedManifestDigest: digest(manifest),
      allowLoopback: true,
    })).rejects.toThrow('Loopback plugin access is unavailable in production.');
  });
});
