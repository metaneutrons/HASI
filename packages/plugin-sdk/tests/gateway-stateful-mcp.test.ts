import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { createPluginDeploymentGateway } from '../../../apps/api/src/plugin-deployment-proxy.js';

// Transport-only fixture: no invocation proof, real user, model or state service.
// It deliberately selects the SDK's existing sessionful MCP protocol mode.
it('completes an actual MCP server-to-client request through the bounded gateway', async () => {
  const cleanup: (() => Promise<void>)[] = [];
  let callbacks = 0;
  try {
    const app = Fastify({ logger: false });
    cleanup.push(() => app.close());
    const server = new McpServer({ name: 'gateway-state-probe', version: '1.0.0' });
    cleanup.push(() => server.close());
    server.registerTool('probe', { inputSchema: z.strictObject({}) }, async (_args, context) => {
      const result = await context.mcpReq.send({ method: 'hasi/test-state/read', params: { key: 'synthetic' } },
        z.strictObject({ value: z.string() }), { timeout: 2500 });
      return { content: [{ type: 'text', text: result.value }] };
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => 'synthetic-test-session' });
    await server.connect(transport);
    app.all('/mcp', (request, reply) => {
      reply.hijack();
      return transport.handleRequest(request.raw, reply.raw, request.body);
    });
    const source = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const gateway = await createPluginDeploymentGateway({ port: 0, requestTimeoutMs: 4000,
      endpointResolver: {
        resolveActiveEndpoint: () => Promise.resolve({ deploymentId: 'synthetic-deployment', relayDeploymentId: 'd'.repeat(64),
          releaseDigest: 'a'.repeat(64), deploymentRevision: 'approved-revision', host: '127.0.0.1', port: Number(source.port), containerPort: 3000 }),
        assertActiveEndpoint: () => Promise.resolve(true),
      },
      authorize: ({ installationId, authorization }) => installationId === 'synthetic-installation' && authorization === 'Bearer synthetic-test-only',
    });
    cleanup.push(() => gateway.close());
    const client = new Client({ name: 'gateway-state-host', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    cleanup.push(() => client.close());
    client.setRequestHandler('hasi/test-state/read', {
      params: z.strictObject({ key: z.literal('synthetic') }), result: z.strictObject({ value: z.string() }),
    }, () => { callbacks++; return { value: 'synthetic-state' }; });
    const clientTransport = new StreamableHTTPClientTransport(new URL('/api/plugin-deployments/synthetic-installation/mcp', gateway.origin), {
      requestInit: { headers: { authorization: 'Bearer synthetic-test-only', 'x-hasi-deployment-revision': 'approved-revision' }, redirect: 'error' },
    });
    await client.connect(clientTransport, { timeout: 3000 });
    expect(clientTransport.protocolVersion).toBe('2025-11-25');
    const result = await client.callTool({ name: 'probe', arguments: {} }, { timeout: 5000 });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'synthetic-state' }]);
    expect(callbacks).toBe(1);
  } finally {
    const results = await Promise.allSettled(cleanup.reverse().map(close => close()));
    expect(results.every(result => result.status === 'fulfilled'), 'MCP transport fixture cleanup').toBe(true);
  }
});
