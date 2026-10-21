import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { digest, type PluginManifest } from '@hasi/plugin-sdk';
import { TEST_PLUGIN_PROVENANCE } from './plugin-release-fixtures.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pluginReleaseSigningBytes,
  verifyPluginRelease,
  type PublisherApproval,
  type UnsignedPluginRelease,
} from '../apps/api/src/plugin-artifacts.js';
import { createManagedPluginPreflight } from '../apps/api/src/managed-plugin-preflight.js';
import type { ManagedPluginInstallerOptions } from '../apps/api/src/managed-plugin-installer.js';
import type { DockerPluginActiveEndpoint } from '../apps/api/src/docker-plugin-driver.js';
import type { PluginDeploymentSnapshot } from '../apps/api/src/plugin-artifacts.js';

const credential = 'synthetic-service-credential';
const operationId = 'candidate-stage-7';
const configurationRevision = 'configuration-7';
const manifest: PluginManifest = {
  manifestVersion: 2,
  id: 'reference',
  name: 'Synthetic reference',
  description: 'A synthetic test plugin.',
  version: '1.0.0',
  apiVersion: '2.0.0',
  mcpVersion: '2026-07-28',
  tools: [{
    name: 'reference.read', title: 'Read reference', description: 'Synthetic read operation.',
    effect: 'read', requiredPermissions: ['reference:read'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  }],
};

const publisherKeys = generateKeyPairSync('ed25519');
const publisher: PublisherApproval = {
  publisherId: 'synthetic-publisher', publicKey: publisherKeys.publicKey,
  sourceRegistryPrefix: 'registry.example.test/hasi', allowedPluginIds: ['reference'],
};
const unsignedRelease: UnsignedPluginRelease = {
  schemaVersion: 2,
  pluginId: manifest.id,
  version: manifest.version,
  manifestDigest: digest(manifest),
  image: `registry.example.test/hasi/reference@sha256:${'a'.repeat(64)}`,
  publisherId: publisher.publisherId,
  configSchemaVersion: 1,
  stateMigration: 'none',
  provenance: TEST_PLUGIN_PROVENANCE,
};
const release = verifyPluginRelease({
  ...unsignedRelease,
  signature: sign(null, pluginReleaseSigningBytes(unsignedRelease), publisherKeys.privateKey).toString('base64url'),
}, publisherId => publisherId === publisher.publisherId ? publisher : undefined);

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
}

async function withManifestServer<T>(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server = createServer(respond);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(port);
  } finally {
    const index = openServers.indexOf(server);
    if (index >= 0) openServers.splice(index, 1);
    await closeServer(server);
  }
}

function sendManifest(response: ServerResponse, body: string, options: { status?: number; contentType?: string; location?: string } = {}) {
  response.writeHead(options.status ?? 200, {
    'content-type': options.contentType ?? 'application/json; charset=utf-8',
    ...(options.location ? { location: options.location } : {}),
    'content-length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function endpoint(port: number): DockerPluginActiveEndpoint {
  return {
    deploymentId: 'candidate-deployment-7', relayDeploymentId: 'relay-deployment-7',
    releaseDigest: release.releaseDigest, host: '127.0.0.1', port, containerPort: 3000,
  };
}

function preflightInput(): Parameters<ManagedPluginInstallerOptions['preflight']>[0] {
  return {
    installationId: 'installation-7', release, manifest,
    snapshot: {
      configurationRevision,
      candidate: { stagingOperationId: operationId, staged: true, releaseDigest: release.releaseDigest },
    } as PluginDeploymentSnapshot,
  };
}

function makePreflight(initialEndpoint: DockerPluginActiveEndpoint, credentialValue = credential) {
  const resolveCandidateEndpoint = vi.fn(() => Promise.resolve(initialEndpoint));
  const credentialCalls: { installationId: string; hasOperation: boolean }[] = [];
  const useServiceCredential = async <T>(installationId: string, operation: (value: string) => Promise<T>): Promise<T> => {
    credentialCalls.push({ installationId, hasOperation: typeof operation === 'function' });
    return operation(credentialValue);
  };
  const preflight = createManagedPluginPreflight({
    driver: { resolveCandidateEndpoint }, useServiceCredential,
  });
  return { preflight, resolveCandidateEndpoint, credentialCalls };
}

describe('managed plugin manifest preflight', () => {
  it('fetches only the exact pinned staged candidate over loopback with the synthetic service credential', async () => {
    const requested: { path: string; authorization: string | undefined; accept: string | undefined }[] = [];
    await withManifestServer((request, response) => {
      requested.push({ path: request.url ?? '', authorization: request.headers.authorization, accept: request.headers.accept });
      sendManifest(response, JSON.stringify(manifest));
    }, async port => {
      const fixture = makePreflight(endpoint(port));
      expect(await fixture.preflight(preflightInput())).toBe(true);
      expect(fixture.resolveCandidateEndpoint).toHaveBeenCalledTimes(2);
      expect(fixture.resolveCandidateEndpoint).toHaveBeenNthCalledWith(1, {
        installationId: 'installation-7', operationId, imageDigest: release.imageDigest,
        releaseDigest: release.releaseDigest, configurationRevision,
      });
      expect(fixture.resolveCandidateEndpoint).toHaveBeenNthCalledWith(2, {
        installationId: 'installation-7', operationId, imageDigest: release.imageDigest,
        releaseDigest: release.releaseDigest, configurationRevision,
      });
      expect(fixture.credentialCalls).toEqual([{ installationId: 'installation-7', hasOperation: true }]);
      expect(requested).toEqual([{
        path: '/.well-known/hasi-plugin.json',
        authorization: `Bearer ${credential}`,
        accept: 'application/json',
      }]);
    });
  });

  it('refuses a changed endpoint after fetching and does not reuse the first endpoint result', async () => {
    await withManifestServer((_request, response) => { sendManifest(response, JSON.stringify(manifest)); }, async port => {
      const fixture = makePreflight(endpoint(port));
      fixture.resolveCandidateEndpoint
        .mockResolvedValueOnce(endpoint(port))
        .mockResolvedValueOnce(endpoint(port + 1));

      expect(await fixture.preflight(preflightInput())).toBe(false);
      expect(fixture.resolveCandidateEndpoint).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects a different manifest even when the HTTP response is otherwise valid', async () => {
    const changedManifest = { ...manifest, version: '9.9.9' };
    await withManifestServer((_request, response) => { sendManifest(response, JSON.stringify(changedManifest)); }, async port => {
      const fixture = makePreflight(endpoint(port));
      expect(await fixture.preflight(preflightInput())).toBe(false);
    });
  });

  it('rejects HTML, redirects, unauthenticated responses, and invalid credentials without following or leaking them', async () => {
    await withManifestServer((_request, response) => { sendManifest(response, '<html>no</html>', { contentType: 'text/html' }); }, async port => {
      expect(await makePreflight(endpoint(port)).preflight(preflightInput())).toBe(false);
    });
    const redirectRequests = { count: 0 };
    await withManifestServer((_request, response) => {
      sendManifest(response, JSON.stringify(manifest), { status: 302, location: '/elsewhere' });
      redirectRequests.count += 1;
    }, async port => {
      const fixture = makePreflight(endpoint(port));
      expect(await fixture.preflight(preflightInput())).toBe(false);
      expect(fixture.resolveCandidateEndpoint).toHaveBeenCalledTimes(1);
      expect(redirectRequests.count).toBe(1);
    });
    await withManifestServer((_request, response) => { sendManifest(response, 'denied', { status: 401 }); }, async port => {
      expect(await makePreflight(endpoint(port)).preflight(preflightInput())).toBe(false);
    });
    const invalidCredentialRequests = { count: 0 };
    await withManifestServer((_request, response) => {
      invalidCredentialRequests.count += 1;
      sendManifest(response, JSON.stringify(manifest));
    }, async port => {
      const fixture = makePreflight(endpoint(port), 'synthetic\r\ncredential');
      expect(await fixture.preflight(preflightInput())).toBe(false);
      expect(invalidCredentialRequests.count).toBe(0);
    });
  });

  it('rejects oversized manifest responses and incomplete staging pins before network access', async () => {
    const largeBody = `{"manifest":"${'x'.repeat(256 * 1024)}"}`;
    await withManifestServer((_request, response) => { sendManifest(response, largeBody); }, async port => {
      expect(await makePreflight(endpoint(port)).preflight(preflightInput())).toBe(false);
    });

    const fixture = makePreflight(endpoint(1));
    const input = preflightInput();
    input.snapshot = {
      configurationRevision,
      candidate: { stagingOperationId: null, staged: false, releaseDigest: release.releaseDigest },
    } as PluginDeploymentSnapshot;
    expect(await fixture.preflight(input)).toBe(false);
    expect(fixture.resolveCandidateEndpoint).not.toHaveBeenCalled();
    expect(fixture.credentialCalls).toEqual([]);
  });
});
