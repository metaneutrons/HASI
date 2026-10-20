import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInvocationToken,
  createPluginServer,
  digest,
  type ActorContext,
  type PluginManifestV2,
  type ToolDefinitionV2,
} from '../src/index.js';
import { createManagedStateClient } from '../src/managed-state-client.js';
import {
  MANAGED_STATE_METHODS,
  MANAGED_STATE_MCP_VERSION,
  managedStateActionStatusResult,
  managedStateCasParams,
  managedStateCasResult,
  managedStateConsumeParams,
  managedStateConsumeResult,
  managedStateReadParams,
  managedStateReadResult,
} from '../src/managed-state-contract.js';
import { verifyInvocationTokenClaims } from '../src/invocation.js';

const keys = generateKeyPairSync('ed25519');
const serviceToken = 'sdk-managed-state-fixture';
const activeApps: ReturnType<typeof createPluginServer>[] = [];
const activeClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(activeClients.splice(0).map(client => client.close()));
  await Promise.allSettled(activeApps.splice(0).map(app => app.close()));
});

const inspectTool: ToolDefinitionV2 = {
  name: 'profile.read',
  title: 'Read profile',
  description: 'Read one application value.',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { subject: { type: 'string' }, value: { type: 'string' } },
    required: ['subject', 'value'],
    additionalProperties: false,
  },
  effect: 'read',
  requiredPermissions: ['profile:read'],
};

const executeTool: ToolDefinitionV2 = {
  name: 'profile.write',
  title: 'Write profile',
  description: 'Write one application value.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { saved: { type: 'boolean' } },
    required: ['saved'],
    additionalProperties: false,
  },
  effect: 'execute',
  requiredPermissions: ['profile:write'],
};

function managedManifest(tools: ToolDefinitionV2[]): PluginManifestV2 {
  return {
    manifestVersion: 2,
    id: 'state-fixture',
    name: 'State fixture',
    description: 'SDK state protocol integration fixture.',
    version: '1.0.0',
    apiVersion: '2.0.0',
    mcpVersion: MANAGED_STATE_MCP_VERSION,
    tools,
    managedState: {
      schemaVersion: 1,
      accountIdentity: { kind: 'subject' },
      applicationSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

function actor(subject: string, permission: string): ActorContext {
  return { subject, permissions: [permission] };
}

interface TestClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  setProof(token: string | undefined): void;
}

function createClient(origin: string, pinned = true): TestClient {
  let proof: string | undefined;
  const client = new Client(
    { name: 'managed-state-sdk-test', version: '1.0.0' },
    pinned ? { versionNegotiation: { mode: 'legacy' } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: {
      headers: { authorization: `Bearer ${serviceToken}` },
      redirect: 'error',
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (proof) headers.set('x-hasi-invocation', proof);
      else headers.delete('x-hasi-invocation');
      return globalThis.fetch(input, { ...init, headers });
    },
  });
  const testClient = {
    client,
    transport,
    setProof(token: string | undefined) {
      // The mutable test seam represents a host attaching the current invocation
      // proof to each request. The SDK server never stores it in its session.
      proof = token;
    },
  };
  activeClients.push(client);
  return testClient;
}

interface HostState {
  records: Map<string, { revision: string; value: unknown }>;
  consumed: Set<string>;
  operations: { method: string; invocationId: string; area?: string; key?: string }[];
}

function installHostState(client: Client, host: HostState, events: string[] = []): void {
  client.setRequestHandler(MANAGED_STATE_METHODS.consumeInvocation, {
    params: managedStateConsumeParams,
    result: managedStateConsumeResult,
  }, params => {
    host.operations.push({ method: 'consume', invocationId: params.invocationId });
    events.push(`consume:${params.invocationId}`);
    if (host.consumed.has(params.invocationId)) return { consumed: false };
    host.consumed.add(params.invocationId);
    return { consumed: true };
  });
  client.setRequestHandler(MANAGED_STATE_METHODS.read, {
    params: managedStateReadParams,
    result: managedStateReadResult,
  }, params => {
    host.operations.push({ method: 'read', invocationId: params.invocationId, area: params.area, key: params.key });
    events.push(`read:${params.invocationId}`);
    return { entry: host.records.get(`${params.area}:${params.key}`) ?? null };
  });
  client.setRequestHandler(MANAGED_STATE_METHODS.compareAndSet, {
    params: managedStateCasParams,
    result: managedStateCasResult,
  }, params => {
    host.operations.push({ method: 'cas', invocationId: params.invocationId, area: params.area, key: params.key });
    const address = `${params.area}:${params.key}`;
    const current = host.records.get(address);
    const matches = params.revision === null ? current === undefined : current?.revision === params.revision;
    if (!matches) return { updated: false };
    host.records.set(address, { revision: randomUUID(), value: params.value });
    return { updated: true };
  });
}

async function startServer(options: Parameters<typeof createPluginServer>[0]): Promise<{ app: ReturnType<typeof createPluginServer>; origin: string }> {
  const app = createPluginServer(options);
  activeApps.push(app);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin };
}

function invocation(
  tool: string,
  args: Record<string, unknown>,
  currentActor: ActorContext,
  executionId = randomUUID(),
): Promise<string> {
  return createInvocationToken({
    pluginId: 'state-fixture',
    pluginVersion: '1.0.0',
    tool,
    args,
    actor: currentActor,
    context: { installationId: currentActor.subject === 'alice' ? 'install-a' : 'install-b', configurationRevision: 3, configuration: {}, executionId },
  }, keys.privateKey);
}

describe('managed state client', () => {
  it('binds every operation to the verified nonce, validates replies, and rejects caller expiry', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const client = createManagedStateClient((method, params) => {
      requests.push({ method, params });
      if (method === MANAGED_STATE_METHODS.read) return Promise.resolve({ entry: null });
      if (method === MANAGED_STATE_METHODS.compareAndSet) return Promise.resolve({ updated: true });
      return Promise.resolve({ consumed: true });
    }, randomUUID());
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.applicationStore)).toBe(true);
    await expect(client.applicationStore.read('profile')).resolves.toBeUndefined();
    await expect(client.journalStore.compareAndSet('receipt', null, { status: 'executing' })).resolves.toBe(true);
    await expect(client.applicationStore.compareAndSet('profile', null, {}, Date.now() + 60_000)).rejects.toThrow('expiry is controlled by the host');
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.params.invocationId === requests[0]?.params.invocationId)).toBe(true);
    expect(requests.map(request => request.method)).toEqual([
      MANAGED_STATE_METHODS.read,
      MANAGED_STATE_METHODS.compareAndSet,
    ]);
  });
});

describe('managed state HTTP/MCP serving', () => {
  it('uses the current tool request proof on one pinned session and denies missing, malformed, expired and spoofed-session proofs before state access', async () => {
    const host: HostState = { records: new Map(), consumed: new Set(), operations: [] };
    host.records.set('application:profile', { revision: randomUUID(), value: { value: 'stored' } });
    const events: string[] = [];
    const handled: string[] = [];
    const { origin } = await startServer({
      manifest: managedManifest([inspectTool]),
      publicKey: keys.publicKey,
      serviceToken,
      acceptedInstallationIds: ['install-a', 'install-b'],
      handlers: {
        'profile.read': async (args, currentActor, _context, services) => {
          events.push(`handler:${currentActor.subject}`);
          handled.push(currentActor.subject);
          const entry = await services?.state.read(String(args.key));
          return {
            subject: currentActor.subject,
            value: typeof (entry?.value as { value?: unknown } | undefined)?.value === 'string'
              ? (entry?.value as { value: string }).value
              : 'empty',
          };
        },
      },
    });
    const testClient = createClient(origin);
    installHostState(testClient.client, host, events);
    await testClient.client.connect(testClient.transport);
    expect(testClient.transport.protocolVersion).toBe(MANAGED_STATE_MCP_VERSION);

    const readArgs = { key: 'profile' };
    const alice = actor('alice', 'profile:read');
    const bob = actor('bob', 'profile:read');
    const aliceToken = await invocation('profile.read', readArgs, alice);
    const aliceJti = (await verifyInvocationTokenClaims(aliceToken, {
      pluginId: 'state-fixture', pluginVersion: '1.0.0', tool: 'profile.read', args: readArgs,
    }, keys.publicKey)).jti;
    testClient.setProof(aliceToken);
    const aliceResult = await testClient.client.callTool({ name: 'profile.read', arguments: readArgs });
    expect(aliceResult.isError).not.toBe(true);
    expect(aliceResult.structuredContent).toEqual({ subject: 'alice', value: 'stored' });

    const bobToken = await invocation('profile.read', readArgs, bob);
    const bobJti = (await verifyInvocationTokenClaims(bobToken, {
      pluginId: 'state-fixture', pluginVersion: '1.0.0', tool: 'profile.read', args: readArgs,
    }, keys.publicKey)).jti;
    testClient.setProof(bobToken);
    const bobResult = await testClient.client.callTool({ name: 'profile.read', arguments: readArgs });
    expect(bobResult.isError).not.toBe(true);
    expect(bobResult.structuredContent).toEqual({ subject: 'bob', value: 'stored' });
    expect(handled).toEqual(['alice', 'bob']);
    expect(events.slice(0, 3)).toEqual([`consume:${aliceJti}`, 'handler:alice', `read:${aliceJti}`]);
    expect(events.slice(3)).toEqual([`consume:${bobJti}`, 'handler:bob', `read:${bobJti}`]);
    expect(host.operations.map(operation => operation.invocationId)).toEqual([aliceJti, aliceJti, bobJti, bobJti]);

    const sessionHeaders = {
      authorization: `Bearer ${serviceToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': MANAGED_STATE_MCP_VERSION,
    };
    const spoofedSession = await globalThis.fetch(new URL('/mcp', origin), {
      method: 'POST',
      headers: { ...sessionHeaders, 'mcp-session-id': randomUUID() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });
    expect(spoofedSession.status).toBe(404);

    const batchResponse = await globalThis.fetch(new URL('/mcp', origin), {
      method: 'POST',
      headers: { ...sessionHeaders, 'mcp-session-id': testClient.transport.sessionId! },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
      ]),
    });
    expect(batchResponse.status).toBe(400);

    const validOperations = host.operations.length;
    testClient.setProof(undefined);
    await expect(testClient.client.callTool({ name: 'profile.read', arguments: readArgs })).rejects.toThrow();
    testClient.setProof('malformed-proof');
    await expect(testClient.client.callTool({ name: 'profile.read', arguments: readArgs })).rejects.toThrow();
    testClient.setProof(await expiredInvocation('profile.read', readArgs, alice));
    await expect(testClient.client.callTool({ name: 'profile.read', arguments: readArgs })).rejects.toThrow();
    expect(handled).toEqual(['alice', 'bob']);
    expect(host.operations).toHaveLength(validOperations);
  });

  it('uses the scoped reverse channel for invocation consumption and execution status without rerunning the business handler', async () => {
    const host: HostState = { records: new Map(), consumed: new Set(), operations: [] };
    const handlerCalls: string[] = [];
    const { origin } = await startServer({
      manifest: managedManifest([executeTool]),
      publicKey: keys.publicKey,
      serviceToken,
      acceptedInstallationIds: ['install-a'],
      handlers: {
        'profile.write': async (args, currentActor, _context, services) => {
          handlerCalls.push(currentActor.subject);
          const current = await services!.state.read('profile');
          const saved = await services!.state.compareAndSet('profile', current?.revision ?? null, { value: args.value });
          return { saved };
        },
      },
      reconcileExecution: async (_binding, _currentActor, services) => {
        await services?.state.read('profile');
        return undefined;
      },
    });
    const testClient = createClient(origin);
    installHostState(testClient.client, host);
    await testClient.client.connect(testClient.transport);

    const executionId = randomUUID();
    const args = { value: 'updated' };
    const toolToken = await invocation('profile.write', args, actor('alice', 'profile:write'), executionId);
    const toolJti = (await verifyInvocationTokenClaims(toolToken, {
      pluginId: 'state-fixture', pluginVersion: '1.0.0', tool: 'profile.write', args,
    }, keys.publicKey)).jti;
    testClient.setProof(toolToken);
    const executionResult = await testClient.client.callTool({ name: 'profile.write', arguments: args });
    expect(executionResult.isError).not.toBe(true);
    expect(executionResult.structuredContent).toEqual({ saved: true });
    expect(handlerCalls).toEqual(['alice']);

    const statusParams = {
      executionId,
      tool: 'profile.write',
      argsHash: digest(args),
    };
    const statusToken = await invocation('__hasi.action_status', statusParams, actor('alice', 'profile:write'), executionId);
    const statusJti = (await verifyInvocationTokenClaims(statusToken, {
      pluginId: 'state-fixture', pluginVersion: '1.0.0', tool: '__hasi.action_status', args: statusParams,
    }, keys.publicKey)).jti;
    testClient.setProof(statusToken);
    const status = await testClient.client.request({
      method: MANAGED_STATE_METHODS.actionStatus,
      params: statusParams,
    }, managedStateActionStatusResult, { timeout: 5_000 });
    expect(status).toEqual({ status: 'confirmed', result: { saved: true } });
    expect(handlerCalls).toEqual(['alice']);

    const statusConsumeIndex = host.operations.findIndex(operation => operation.method === 'consume' && operation.invocationId === statusJti);
    const statusJournalReadIndex = host.operations.findIndex((operation, index) => index > statusConsumeIndex
      && operation.method === 'read' && operation.area === 'journal' && operation.invocationId === statusJti);
    expect(statusConsumeIndex).toBeGreaterThan(-1);
    expect(statusJournalReadIndex).toBeGreaterThan(statusConsumeIndex);
    expect(host.operations.filter(operation => operation.invocationId === toolJti).every(operation => operation.method === 'consume' || operation.area === 'journal' || operation.area === 'application')).toBe(true);

    const disabledHttpStatus = await globalThis.fetch(new URL('/hasi/actions/status', origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(statusParams),
    });
    expect(disabledHttpStatus.status).toBe(404);
  });

  it('does not expose adapter error details from action status or rerun the business handler', async () => {
    const host: HostState = { records: new Map(), consumed: new Set(), operations: [] };
    let executions = 0;
    const { origin } = await startServer({
      manifest: managedManifest([executeTool]), publicKey: keys.publicKey, serviceToken, acceptedInstallationIds: ['install-a'],
      handlers: { 'profile.write': () => { executions++; return Promise.reject(new Error('synthetic-private-source-detail')); } },
      reconcileExecution: () => Promise.reject(new Error('synthetic-private-source-detail')),
    });
    const testClient = createClient(origin); installHostState(testClient.client, host);
    await testClient.client.connect(testClient.transport);
    const executionId = randomUUID(); const args = { value: 'updated' };
    testClient.setProof(await invocation('profile.write', args, actor('alice', 'profile:write'), executionId));
    const failed = await testClient.client.callTool({ name: 'profile.write', arguments: args });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-source-detail');
    const params = { executionId, tool: 'profile.write', argsHash: digest(args) };
    testClient.setProof(await invocation('__hasi.action_status', params, actor('alice', 'profile:write'), executionId));
    await expect(testClient.client.request({ method: MANAGED_STATE_METHODS.actionStatus, params }, managedStateActionStatusResult, { timeout: 5000 }))
      .rejects.toThrow('Action status unavailable');
    expect(executions).toBe(1);
  });

  it('keeps the existing modern stateless serving default for plugins without managed state', async () => {
    const modernTool: ToolDefinitionV2 = {
      ...inspectTool,
      name: 'profile.echo',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    };
    const manifest: PluginManifestV2 = { ...managedManifest([modernTool]), mcpVersion: '2026-07-28' };
    delete manifest.managedState;
    const { origin } = await startServer({
      manifest,
      publicKey: keys.publicKey,
      serviceToken,
      acceptedInstallationIds: ['install-a'],
      handlers: { 'profile.echo': args => Promise.resolve({ value: args.value as string }) },
    });
    const testClient = createClient(origin, false);
    await testClient.client.connect(testClient.transport);
    const args = { value: 'modern' };
    testClient.setProof(await invocation('profile.echo', args, actor('alice', 'profile:read')));
    const result = await testClient.client.callTool({ name: 'profile.echo', arguments: args });
    expect(testClient.transport.protocolVersion).toBeDefined();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ value: 'modern' });
  });

  it('closes active managed sessions during server shutdown', async () => {
    const { app, origin } = await startServer({
      manifest: managedManifest([inspectTool]),
      publicKey: keys.publicKey,
      serviceToken,
      handlers: { 'profile.read': () => Promise.resolve({ subject: 'alice', value: 'stored' }) },
    });
    const testClient = createClient(origin);
    await testClient.client.connect(testClient.transport);
    expect(testClient.transport.sessionId).toBeTruthy();

    // Leave the MCP client connected so Fastify's close hook must dispose its
    // server-side session rather than relying on a client DELETE first.
    const appIndex = activeApps.indexOf(app);
    if (appIndex >= 0) activeApps.splice(appIndex, 1);
    await app.close();
    expect(app.server.listening).toBe(false);
  });
});

async function expiredInvocation(tool: string, args: Record<string, unknown>, currentActor: ActorContext): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const context = {
    installationId: currentActor.subject === 'alice' ? 'install-a' : 'install-b',
    configurationRevision: 3,
    configuration: {},
    executionId: randomUUID(),
  };
  return new SignJWT({
    actor: currentActor,
    context,
    pluginVersion: '1.0.0',
    tool,
    argsHash: digest(args),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer('hasi-core')
    .setAudience('state-fixture')
    .setSubject(currentActor.subject)
    .setIssuedAt(now - 70)
    .setExpirationTime(now - 10)
    .setJti(randomUUID())
    .sign(keys.privateKey);
}
