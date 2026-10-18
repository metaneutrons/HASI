import { MemoryJsonStore } from '@hasi/state';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInvocationToken,
  createPluginServer,
  digest,
  manifestSchema,
  verifyInvocationToken,
  type ActorContext,
  type PluginManifest,
  type PluginToolHandler,
} from '../src/index.js';

const actor: ActorContext = {
  subject: 'user-123',
  customerId: 'customer-456',
  resourceIds: ['resource-1'],
  permissions: ['records:execute'],
};

const manifest: PluginManifest = {
  manifestVersion: 1,
  id: 'records-plugin',
  name: 'Records',
  description: 'Record lookup and update.',
  version: '1.2.3',
  apiVersion: '1.0.0',
  mcpVersion: '2026-07-28',
  tools: [
    {
      name: 'update-record',
      title: 'Update record',
      description: 'Update one record.',
      inputSchema: {
        type: 'object',
        properties: { recordId: { type: 'string' }, value: { type: 'string' } },
        required: ['recordId', 'value'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { updated: { type: 'boolean' } },
        required: ['updated'],
        additionalProperties: false,
      },
      effect: 'execute',
      requiredPermissions: ['records:execute'],
    },
  ],
};

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const activeApps: ReturnType<typeof createPluginServer>[] = [];

afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('production replay boundary', () => {
  it('rejects execute-capable production servers without durable replay protection', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createPluginServer({ manifest, publicKey: keys.publicKey, serviceToken: 'fixture-only-service-token', handlers: { 'update-record': () => Promise.resolve({ updated: true }) } })).toThrow('shared durable invocation replay guard');
  });
});

describe('canonical digest', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(digest({ z: 1, a: { y: 2, x: 3 } })).toBe(digest({ a: { x: 3, y: 2 }, z: 1 }));
    expect(digest({ values: [1, 2] })).not.toBe(digest({ values: [2, 1] }));
  });
});

describe('manifest schema', () => {
  it('accepts the supported manifest and rejects incompatible or extra fields', () => {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, apiVersion: '2.0.0' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...manifest,
        tools: [{ ...manifest.tools[0], unexpected: true }],
      }).success,
    ).toBe(false);
  });
});

describe('signed invocation tokens', () => {
  const binding = {
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    tool: 'update-record',
    args: { recordId: 'r-1', value: 'new value' },
  };

  it('returns the signed actor context for a valid invocation', async () => {
    const token = await createInvocationToken({ ...binding, actor }, keys.privateKey);
    await expect(verifyInvocationToken(token, binding, keys.publicKey)).resolves.toEqual(actor);
  });

  it('rejects a token signed by another key', async () => {
    const token = await createInvocationToken({ ...binding, actor }, otherKeys.privateKey);
    await expect(verifyInvocationToken(token, binding, keys.publicKey)).rejects.toThrow('Invalid invocation token');
  });

  it('binds the token to the exact arguments, plugin version, audience, and actor identity', async () => {
    const token = await createInvocationToken({ ...binding, actor }, keys.privateKey);
    await expect(
      verifyInvocationToken(token, { ...binding, args: { ...binding.args, value: 'tampered' } }, keys.publicKey),
    ).rejects.toThrow('Invalid invocation token');
    await expect(
      verifyInvocationToken(token, { ...binding, pluginVersion: '1.2.4' }, keys.publicKey),
    ).rejects.toThrow('Invalid invocation token');
    await expect(
      verifyInvocationToken(token, { ...binding, pluginId: 'another-plugin' }, keys.publicKey),
    ).rejects.toThrow('Invalid invocation token');

    const mismatchedSubjectToken = await signClaims({
      ...binding,
      actor,
      subject: 'different-user',
    });
    await expect(verifyInvocationToken(mismatchedSubjectToken, binding, keys.publicKey)).rejects.toThrow(
      'Invalid invocation token',
    );
  });

  it('rejects expired invocation tokens', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      actor,
      pluginVersion: binding.pluginVersion,
      tool: binding.tool,
      argsHash: digest(binding.args),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer('hasi-core')
      .setAudience(binding.pluginId)
      .setSubject(actor.subject)
      .setIssuedAt(now - 70)
      .setExpirationTime(now - 10)
      .setJti(randomUUID())
      .sign(keys.privateKey);

    await expect(verifyInvocationToken(token, binding, keys.publicKey)).rejects.toThrow('Invalid invocation token');
  });
});

describe('plugin server', () => {
  it('requires the service bearer and enforces actor permissions before handler execution', async () => {
    const handler = vi.fn(() => Promise.resolve({ updated: true }));
    const app = createServer(handler);
    const args = { recordId: 'r-1', value: 'new value' };
    const token = await createInvocationToken(
      { actor: { ...actor, permissions: [] }, pluginId: manifest.id, pluginVersion: manifest.version, tool: 'update-record', args },
      keys.privateKey,
    );
    const payload = toolCallPayload(args);

    const noServiceToken = await app.inject({ method: 'POST', url: '/mcp', payload });
    expect(noServiceToken.statusCode).toBe(401);

    const missingPermission = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer service-secret',
        'x-hasi-invocation': token,
      },
      payload,
    });
    expect(missingPermission.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('consumes an invocation jti before execution and rejects replay', async () => {
    const handler = vi.fn(() => Promise.resolve({ updated: true }));
    const app = createServer(handler);
    const args = { recordId: 'r-1', value: 'new value' };
    const token = await createInvocationToken(
      { actor, pluginId: manifest.id, pluginVersion: manifest.version, tool: 'update-record', args },
      keys.privateKey,
    );
    const headers = {
      authorization: 'Bearer service-secret',
      'x-hasi-invocation': token,
      accept: 'application/json, text/event-stream',
    };

    const first = await app.inject({ method: 'POST', url: '/mcp', headers, payload: toolCallPayload(args) });
    expect(first.statusCode).toBe(200);
    expect(getRpcResponse(first.body).result.structuredContent).toEqual({ updated: true });

    const second = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: toolCallPayload(args, 2),
    });
    expect(second.statusCode).toBe(200);
    expect(getRpcResponse(second.body).result.isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects invocation replay across independent plugin instances', async () => {
    const store = new MemoryJsonStore('shared-invocations');
    const consume = (jti: string, expiresAt: number) => store.compareAndSet(jti, null, true, expiresAt * 1000);
    const handler = vi.fn(() => Promise.resolve({ updated: true }));
    const first = createServer(handler, consume);
    const second = createServer(handler, consume);
    const args = { recordId: 'r-1', value: 'new value' };
    const token = await createInvocationToken({ actor, pluginId: manifest.id, pluginVersion: manifest.version, tool: 'update-record', args }, keys.privateKey);
    const headers = { authorization: 'Bearer service-secret', 'x-hasi-invocation': token, accept: 'application/json, text/event-stream' };
    const accepted = await first.inject({ method: 'POST', url: '/mcp', headers, payload: toolCallPayload(args) });
    expect(getRpcResponse(accepted.body).result.structuredContent).toEqual({ updated: true });
    const replay = await second.inject({ method: 'POST', url: '/mcp', headers, payload: toolCallPayload(args, 2) });
    expect(getRpcResponse(replay.body).result.isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects incompatible JSON Schemas when creating the server', () => {
    const incompatibleManifest = {
      ...manifest,
      tools: [{ ...manifest.tools[0], inputSchema: { type: 'string' } }],
    } as unknown as PluginManifest;
    expect(() =>
      createPluginServer({
        manifest: incompatibleManifest,
        publicKey: keys.publicKey,
        serviceToken: 'service-secret',
        handlers: { 'update-record': () => Promise.resolve({ updated: true }) },
      }),
    ).toThrow('inputSchema must be an object JSON Schema');
  });
});

function createServer(handler: PluginToolHandler, consumeInvocation?: (jti: string, expiresAt: number) => Promise<boolean>): ReturnType<typeof createPluginServer> {
  const app = createPluginServer({
    manifest,
    publicKey: keys.publicKey,
    serviceToken: 'service-secret',
    handlers: { 'update-record': handler },
    ...(consumeInvocation ? { consumeInvocation } : {}),
  });
  activeApps.push(app);
  return app;
}

function toolCallPayload(args: Record<string, unknown>, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'update-record', arguments: args },
  };
}

function getRpcResponse(body: string): {
  result: { structuredContent?: Record<string, unknown>; isError?: boolean };
} {
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    return JSON.parse(body) as {
      result: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
  }
  return JSON.parse(dataLine.slice('data: '.length)) as {
    result: { structuredContent?: Record<string, unknown>; isError?: boolean };
  };
}

async function signClaims(input: {
  actor: ActorContext;
  pluginId: string;
  pluginVersion: string;
  tool: string;
  args: Record<string, unknown>;
  subject: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    actor: input.actor,
    pluginVersion: input.pluginVersion,
    tool: input.tool,
    argsHash: digest(input.args),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer('hasi-core')
    .setAudience(input.pluginId)
    .setSubject(input.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID())
    .sign(keys.privateKey);
}
