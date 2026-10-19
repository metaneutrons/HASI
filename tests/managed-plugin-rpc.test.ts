import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { MemoryJsonStore } from '@hasi/state';
import { digest } from '@hasi/plugin-sdk';
import type { ManagedPluginCommand, ManagedPluginView } from '@hasi/plugin-sdk/deployment-admin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedPluginInstaller } from '../apps/api/src/managed-plugin-installer.js';
import { createManagedPluginContractClient, createManagedPluginRpcClient, createManagedPluginRpcServer } from '../apps/api/src/managed-plugin-rpc.js';
import type { ManagedPluginAdmin } from '../apps/api/src/managed-plugin-admin.js';
import type { ManagedPluginRuntimeContract } from '../apps/api/src/managed-plugin-contract.js';

const issuer = 'hasi-managed-plugin-api-v1';
const audience = 'hasi-managed-plugin-installer-v1';
const path = '/installer/v1/rpc';
const subject = 'synthetic-admin';
const commandId = 'd70a51c8-632b-48be-92e8-066ea455e21b';
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const stateToken = 'a'.repeat(64);

const view: ManagedPluginView = {
  id: 'de.example.calendar', label: 'Synthetic calendar', stateToken, status: 'active',
  configurationRevision: 'configuration-1', configurationReady: true,
  current: null, previous: null, candidate: null, releases: [],
};

const command: ManagedPluginCommand = {
  commandId, expectedState: stateToken, operation: 'stage', releaseId: 'calendar-1.0.0',
};
const contractManifest = { manifestVersion: 2 as const, id: 'de.example.calendar', version: '1.0.0', name: 'Synthetic calendar', description: 'Read-only contract', apiVersion: '2.0.0' as const, mcpVersion: '2026-07-28' as const, secrets: [{ name: 'calendarApi', required: true }], tools: [] };
const runtimeContract: ManagedPluginRuntimeContract = {
  installationId: view.id, manifest: contractManifest, manifestDigest: digest(contractManifest), configurationRevision: 3,
  deploymentRevision: 'a'.repeat(64), transportCredentialRevision: 'transport-2',
  secretStatuses: [{ name: 'calendarApi', configured: true, revision: 'calendar-4' }], enabled: true,
};

const servers: Awaited<ReturnType<typeof createManagedPluginRpcServer>>[] = [];
const httpServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(httpServers.splice(0).map(server => closeServer(server)));
});

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
}

async function startRpc(service: ManagedPluginAdmin = {
  list: () => Promise.resolve({ installations: [view] }),
  command: (_id, requested, _subject) => Promise.resolve({ commandId: requested.commandId, status: 'completed', view }),
  commandStatus: (_id, requestedId) => Promise.resolve({ commandId: requestedId, status: 'uncertain', view }),
}, readRuntimeContract?: (installationId: string) => Promise<ManagedPluginRuntimeContract | null>) {
  const server = await createManagedPluginRpcServer({ service, ...(readRuntimeContract ? { runtimeContract: readRuntimeContract } : {}), publicKey: keys.publicKey, privateKey: keys.privateKey, scope: 'synthetic-scope', port: 0 });
  servers.push(server);
  return server;
}

async function signedToken(input: unknown, options: {
  scope?: string; key?: typeof keys.privateKey; tokenSubject?: string; issuedAt?: number; expiresAt?: number;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ scope: options.scope ?? 'synthetic-scope', requestDigest: digest(input) })
    .setProtectedHeader({ alg: 'EdDSA' }).setSubject(options.tokenSubject ?? subject).setIssuer(issuer).setAudience(audience)
    .setJti(randomUUID()).setIssuedAt(options.issuedAt ?? now).setExpirationTime(options.expiresAt ?? now + 60);
  return jwt.sign(options.key ?? keys.privateKey);
}

function postRaw(origin: string, input: unknown, token: string, headers: Record<string, string> = {}, suffix = '') {
  return fetch(`${origin}${path}${suffix}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
    redirect: 'manual',
  });
}

async function startHttp(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

it('rejects a loopback impersonator replaying a signed response from another request', async () => {
  const server = await startRpc();
  const input = { method: 'list', subject };
  const original = await postRaw(server.origin, input, await signedToken(input));
  expect(original.status).toBe(200);
  const body = await original.text();
  const proof = original.headers.get('x-hasi-installer-proof');
  expect(proof).toBeTruthy();
  if (!proof) throw new Error('Expected signed response proof');
  const fakeOrigin = await startHttp((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'x-hasi-installer-proof': proof });
    response.end(body);
  });
  const client = createManagedPluginRpcClient({ origin: fakeOrigin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
  await expect(client.list(subject)).rejects.toThrow('Installer response authentication failed');
});

it('reads the active runtime contract over a separate fixed-subject RPC without invoking administrator service methods', async () => {
  const list = vi.fn(() => Promise.reject(new Error('admin list must not run')));
  const commandCall = vi.fn(() => Promise.reject(new Error('admin command must not run')));
  const commandStatus = vi.fn(() => Promise.reject(new Error('admin status must not run')));
  const service: ManagedPluginAdmin = {
    list,
    command: commandCall,
    commandStatus,
  };
  const read = vi.fn((_installationId: string) => Promise.resolve(runtimeContract));
  const server = await startRpc(service, read);
  const client = createManagedPluginContractClient({ origin: server.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });

  await expect(client.read(view.id)).resolves.toEqual(runtimeContract);
  expect(read).toHaveBeenCalledWith(view.id);
  expect(list).not.toHaveBeenCalled();
  expect(commandCall).not.toHaveBeenCalled();
  expect(commandStatus).not.toHaveBeenCalled();
});

it('returns authenticated null for inactive state and fails closed for a missing or mismatched runtime reader', async () => {
  const inactive = await startRpc(undefined, () => Promise.resolve(null));
  const client = createManagedPluginContractClient({ origin: inactive.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
  await expect(client.read(view.id)).resolves.toBeNull();

  const missingReader = await startRpc();
  const unavailableClient = createManagedPluginContractClient({ origin: missingReader.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
  await expect(unavailableClient.read(view.id)).rejects.toThrow('Installer request unavailable');

  const wrongInstallation = await startRpc(undefined, () => Promise.resolve({ ...runtimeContract, installationId: 'other-installation' }));
  const wrongClient = createManagedPluginContractClient({ origin: wrongInstallation.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
  await expect(wrongClient.read(view.id)).rejects.toThrow('Installer request unavailable');
});

it('keeps runtime-contract requests out of admin authority and pins their host subject', async () => {
  const read = vi.fn(() => Promise.resolve(runtimeContract));
  const list = vi.fn(() => Promise.resolve({ installations: [view] }));
  const service = { list } as unknown as ManagedPluginAdmin;
  const server = await startRpc(service, read);
  const wrongSubject = { method: 'runtimeContract', subject, installationId: view.id };
  const wrongSubjectResponse = await postRaw(server.origin, wrongSubject, await signedToken(wrongSubject));
  expect(wrongSubjectResponse.status).toBe(401);
  await wrongSubjectResponse.body?.cancel();

  const adminWithHostSubject = { method: 'list', subject: 'hasi:runtime-contract' };
  const hostAdminResponse = await postRaw(server.origin, adminWithHostSubject, await signedToken(adminWithHostSubject, { tokenSubject: 'hasi:runtime-contract' }));
  expect(hostAdminResponse.status).toBe(403);
  await hostAdminResponse.body?.cancel();
  expect(read).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it('roundtrips a permitted multi-installation catalogue larger than the former response cap', async () => {
  const installations = Array.from({ length: 32 }, (_unused, index) => ({ ...view, id: `instance-${String(index)}`, tools: Array.from({ length: 64 }, (_tool, toolIndex) => ({ name: `tool-${String(toolIndex)}`, title: 'Synthetische Konfigurationsbezeichnung '.repeat(6), effect: 'read' as const })) }));
  expect(Buffer.byteLength(JSON.stringify({ installations }))).toBeGreaterThan(256 * 1024);
  const server = await startRpc({ list: () => Promise.resolve({ installations }), command: () => Promise.reject(new Error('unused')), commandStatus: () => Promise.reject(new Error('unused')) });
  const client = createManagedPluginRpcClient({ origin: server.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
  expect((await client.list(subject)).installations).toHaveLength(32);
});

describe('managed plugin private RPC', () => {
  it('performs a real signed loopback roundtrip and binds the service calls to the signed subject', async () => {
    const calls: string[] = [];
    const service: ManagedPluginAdmin = {
      list: caller => { calls.push(`list:${caller}`); return Promise.resolve({ installations: [view] }); },
      command: (installationId, requested, caller) => {
        calls.push(`command:${installationId}:${caller}`);
        return Promise.resolve({ commandId: requested.commandId, status: 'completed', view });
      },
      commandStatus: (installationId, requestedId, caller) => {
        calls.push(`status:${installationId}:${requestedId}:${caller}`);
        return Promise.resolve({ commandId: requestedId, status: 'uncertain', view });
      },
    };
    const server = await startRpc(service);
    const client = createManagedPluginRpcClient({ origin: server.origin, privateKey: keys.privateKey, scope: 'synthetic-scope' });

    expect(await client.list(subject)).toEqual({ installations: [view] });
    expect(await client.command(view.id, command, subject)).toMatchObject({ commandId, status: 'completed', view });
    expect(await client.commandStatus(view.id, commandId, subject)).toMatchObject({ commandId, status: 'uncertain', view });
    expect(calls).toEqual([
      `list:${subject}`,
      `command:${view.id}:${subject}`,
      `status:${view.id}:${commandId}:${subject}`,
    ]);
  });

  it('rejects a wrong scope, signing key, or expired token', async () => {
    const server = await startRpc();
    const input = { method: 'list', subject };
    const now = Math.floor(Date.now() / 1000);

    const wrongScope = await postRaw(server.origin, input, await signedToken(input, { scope: 'other-scope' }));
    expect(wrongScope.status).toBe(401);
    await wrongScope.body?.cancel();

    const wrongKey = await postRaw(server.origin, input, await signedToken(input, { key: otherKeys.privateKey }));
    expect(wrongKey.status).toBe(401);
    await wrongKey.body?.cancel();

    const expired = await postRaw(server.origin, input, await signedToken(input, { issuedAt: now - 120, expiresAt: now - 60 }));
    expect(expired.status).toBe(401);
    await expired.body?.cancel();
  });

  it('rejects changed request method, body, and subject bindings', async () => {
    const server = await startRpc();
    const original = { method: 'list', subject };
    const token = await signedToken(original);
    const changedMethod = await postRaw(server.origin, { method: 'command', subject, installationId: view.id, command }, token);
    expect(changedMethod.status).toBe(401);
    await changedMethod.body?.cancel();

    const changedBody = await postRaw(server.origin, { method: 'list', subject, extra: true }, token);
    expect(changedBody.status).toBe(400);
    await changedBody.body?.cancel();

    const changedSubject = await postRaw(server.origin, { method: 'list', subject: 'different-admin' }, token);
    expect(changedSubject.status).toBe(401);
    await changedSubject.body?.cancel();
  });

  it('rejects cookie, Origin, query and non-POST traffic', async () => {
    const server = await startRpc();
    const input = { method: 'list', subject };
    const token = await signedToken(input);

    const cookie = await postRaw(server.origin, input, token, { cookie: 'session=synthetic' });
    expect(cookie.status).toBe(400);
    await cookie.body?.cancel();

    const origin = await postRaw(server.origin, input, token, { origin: 'http://127.0.0.1:3000' });
    expect(origin.status).toBe(400);
    await origin.body?.cancel();

    const query = await postRaw(server.origin, input, token, {}, '?unexpected=1');
    expect(query.status).toBe(400);
    await query.body?.cancel();

    const get = await fetch(`${server.origin}${path}`, { method: 'GET', redirect: 'manual' });
    expect(get.status).toBe(404);
    await get.body?.cancel();
  });

  it('rejects service authority denial after successful transport authentication', async () => {
    const authority = vi.fn(() => Promise.resolve(false));
    const installer = new ManagedPluginInstaller({
      store: new MemoryJsonStore('managed-rpc-denial'), scope: 'synthetic-scope', privateKey: keys.privateKey,
      driver: {} as never, readCatalog: () => Promise.resolve([]), resolvePublisher: () => undefined,
      authorizeAdmin: authority, secretsAuthorized: () => Promise.resolve(true), secretReady: () => true,
      preflight: () => Promise.resolve(true), synchronizeRoute: () => Promise.resolve(),
    });
    const server = await startRpc(installer);
    const token = await signedToken({ method: 'list', subject });
    const response = await postRaw(server.origin, { method: 'list', subject }, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Installer state must be checked.' });
    expect(authority).toHaveBeenCalledWith(subject);
  });

  it('rejects invalid JSON and responses over the client byte limit', async () => {
    const invalidJsonOrigin = await startHttp((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
    });
    const invalidJsonClient = createManagedPluginRpcClient({ origin: invalidJsonOrigin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
    await expect(invalidJsonClient.list(subject)).rejects.toThrow();

    const largeBody = JSON.stringify({ installations: [], filler: 'x'.repeat(16 * 1024 * 1024) });
    const oversizedOrigin = await startHttp((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(largeBody)) });
      response.end(largeBody);
    });
    const oversizedClient = createManagedPluginRpcClient({ origin: oversizedOrigin, privateKey: keys.privateKey, scope: 'synthetic-scope' });
    await expect(oversizedClient.list(subject)).rejects.toThrow('Installer response too large');
  });
});
