import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createPluginServer, digest, type ActorContext, type CreatePluginServerOptions, type InvocationContext, type PluginToolHandler } from '@hasi/plugin-sdk';
import { createPluginFetch } from './network-policy.js';

export interface ReviewedMcpToolMapping {
  upstreamName: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  /** Trusted adapter code must derive upstream identity/scope, never accept it as model authority. */
  authorize(args: Readonly<Record<string, unknown>>, actor: ActorContext, context?: InvocationContext): Promise<Record<string, unknown>>;
}
export interface ReviewedPlainMcpOptions extends Omit<CreatePluginServerOptions, 'handlers'> {
  upstream: {
    endpoint: string;
    serverName: string;
    serverVersion: string;
    allowLoopback?: boolean;
    allowedPrivateCidrs?: readonly string[];
    /** Resolve a scoped/delegated credential only after the trusted authorization callback. */
    credential(actor: ActorContext): Promise<string>;
  };
  tools: Readonly<Record<string, ReviewedMcpToolMapping>>;
}

/** Explicit reviewed adapter, not automatic adoption of an arbitrary MCP server's declarations. */
export function createReviewedPlainMcpAdapter(options: ReviewedPlainMcpOptions) {
  const endpoint = new URL(options.upstream.endpoint);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(options.upstream.allowLoopback && loopback && endpoint.protocol === 'http:'))) throw new TypeError('Invalid reviewed MCP destination');
  if (Object.keys(options.tools).length !== options.manifest.tools.length || options.manifest.tools.some(tool => !Object.hasOwn(options.tools, tool.name))) throw new TypeError('Every approved tool requires an explicit adapter mapping');
  if (options.manifest.tools.some(tool => tool.effect === 'execute') && !options.executionJournal) throw new TypeError('Plain MCP writes require a durable execution journal');
  const safeFetch = createPluginFetch({ origins: [endpoint.origin], allowLoopback: options.upstream.allowLoopback ?? false, ...(options.upstream.allowedPrivateCidrs ? { allowedPrivateCidrs: options.upstream.allowedPrivateCidrs } : {}), maxResponseBytes: 128 * 1024 });
  const handlers: Record<string, PluginToolHandler> = {};
  for (const tool of options.manifest.tools) {
    const mapping = options.tools[tool.name];
    if (!mapping || !/^[a-f0-9]{64}$/.test(mapping.inputSchemaDigest) || !/^[a-f0-9]{64}$/.test(mapping.outputSchemaDigest) || !mapping.upstreamName.trim()) throw new TypeError('Invalid reviewed MCP tool pin');
    handlers[tool.name] = async (args, actor, context) => {
      const upstreamArgs = await mapping.authorize(args, actor, context);
      const credential = await options.upstream.credential(actor);
      if (!credential.trim()) throw new Error('Delegated MCP access unavailable');
      const client = new Client({ name: 'hasi-reviewed-adapter', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, listMaxPages: 1 });
      try {
        const signal = AbortSignal.timeout(10000);
        await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${credential}` }, redirect: 'error' }, fetch: safeFetch }), { signal, timeout: 10000 });
        const server = client.getServerVersion();
        if (server?.name !== options.upstream.serverName || server.version !== options.upstream.serverVersion) throw new Error('Unreviewed upstream MCP version');
        const catalogue = await client.listTools({ cursor: '' }, { signal, timeout: 10000, cacheMode: 'bypass' });
        const candidates = catalogue.tools.filter(candidate => candidate.name === mapping.upstreamName);
        const approved = candidates[0];
        if (catalogue.nextCursor || candidates.length !== 1 || !approved || digest(approved.inputSchema) !== mapping.inputSchemaDigest || digest(approved.outputSchema ?? null) !== mapping.outputSchemaDigest) throw new Error('Upstream MCP contract changed');
        const result = await client.callTool({ name: mapping.upstreamName, arguments: upstreamArgs }, { signal, timeout: 10000 });
        const output: unknown = result.structuredContent;
        if (result.isError || !output || typeof output !== 'object' || Array.isArray(output) || Buffer.byteLength(JSON.stringify(output)) > 60 * 1024) throw new Error('Invalid upstream MCP output');
        return output as Record<string, unknown>;
      } finally { await client.close(); }
    };
  }
  const app = createPluginServer({ ...options, handlers });
  app.addHook('onClose', async () => { await safeFetch.close(); });
  return app;
}
