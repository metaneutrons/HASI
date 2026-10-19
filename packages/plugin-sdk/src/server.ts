import { createHash, timingSafeEqual, type KeyObject } from 'node:crypto';
import { Transform } from 'node:stream';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { canonicalJson, digest, parseJsonRecord } from './canonical-json.js';
import { verifyInvocationTokenClaims, type VerifiedInvocation, type InvocationContext } from './invocation.js';
import {
  parsePluginManifest,
  type ActorContext,
  type PluginManifest,
  type ToolDefinition,
  type ToolDefinitionV2,
} from './manifest.js';
import type { PluginPresentation } from './presentation.js';
import type { ExecutionJournal, ExecutionBinding } from './execution-journal.js';

const MAX_REQUEST_BYTES = 64 * 1_024;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_CONTENT_LENGTH = /^\d+$/;
const OUTPUT_SUMMARY = 'Tool result is available in structuredContent.';
const MAX_APP_RESOURCE_BYTES = 1_024 * 1_024;

export type PluginToolHandler = (
  args: Record<string, unknown>,
  actor: ActorContext,
  context?: InvocationContext,
) => Promise<Record<string, unknown>>;

export interface CreatePluginServerOptions {
  executionJournal?: ExecutionJournal;
  reconcileExecution?: (binding: Readonly<ExecutionBinding>, actor: ActorContext) => Promise<Record<string, unknown> | undefined>;
  manifest: PluginManifest;
  publicKey: KeyObject;
  serviceToken: string;
  handlers: Record<string, PluginToolHandler>;
  appResources?: Record<string, string>;
  acceptedInstallationIds?: readonly string[];
  allowedHosts?: string[];
  consumeInvocation?: (jti: string, expiresAt: number) => Promise<boolean>;
}

interface ToolCallBinding {
  tool: string;
  args: Record<string, unknown>;
}

interface PreparedTool {
  definition: ToolDefinition;
  handler: PluginToolHandler;
  inputSchema: ReturnType<typeof fromJsonSchema<Record<string, unknown>>>;
  outputSchema: ReturnType<typeof fromJsonSchema<Record<string, unknown>>>;
  validateOutput: ValidateFunction;
}

class InvocationReplayGuard {
  readonly #used = new Map<string, number>();

  consume(jti: string, expiresAt: number): boolean {
    const now = Math.floor(Date.now() / 1_000);
    for (const [usedJti, usedExpiry] of this.#used) {
      if (usedExpiry <= now) {
        this.#used.delete(usedJti);
      }
    }

    if (this.#used.has(jti)) {
      return false;
    }
    this.#used.set(jti, expiresAt);
    return true;
  }
}

export function createPluginServer(options: CreatePluginServerOptions): FastifyInstance {
  if (!options.serviceToken.trim()) {
    throw new TypeError('serviceToken must not be empty');
  }

  const manifestJson = canonicalJson(options.manifest);
  const manifest = parsePluginManifest(JSON.parse(manifestJson) as unknown);
  if (process.env.NODE_ENV === 'production' && manifest.tools.some(tool => tool.effect === 'execute') && !options.consumeInvocation) {
    throw new Error('Production execution requires a shared durable invocation replay guard.');
  }
  if (process.env.NODE_ENV === 'production' && manifest.tools.some(tool => tool.effect === 'execute') && !options.executionJournal) {
    throw new Error('Production execution requires a shared durable execution journal.');
  }
  const appResources = validateAppResources(manifest, options.appResources);
  const handlers = { ...options.handlers };
  const expectedHandlerNames = new Set(manifest.tools.map((tool) => tool.name));
  const actualHandlerNames = Object.keys(handlers);
  if (
    actualHandlerNames.length !== expectedHandlerNames.size ||
    actualHandlerNames.some((name) => !expectedHandlerNames.has(name))
  ) {
    throw new TypeError('Plugin handlers must match manifest tools exactly');
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats.default(ajv);
  const validators = new WeakMap<object, ValidateFunction>();
  const schemaValidatorProvider: jsonSchemaValidator = {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const validator = compileSchema(schema);
      return (input: unknown) => {
        if (validator(input)) {
          const data: T = input as T;
          return { valid: true, data, errorMessage: undefined };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: ajv.errorsText(validator.errors),
        };
      };
    },
  };

  function compileSchema(schema: Record<string, unknown>): ValidateFunction {
    const cached = validators.get(schema);
    if (cached) {
      return cached;
    }
    const compiled = ajv.compile(schema as AnySchema);
    validators.set(schema, compiled);
    return compiled;
  }

  const preparedTools = new Map<string, PreparedTool>();
  for (const definition of manifest.tools) {
    assertObjectSchema(definition.inputSchema, `${definition.name}.inputSchema`);
    assertObjectSchema(definition.outputSchema, `${definition.name}.outputSchema`);
    compileSchema(definition.inputSchema);
    const validateOutput = compileSchema(definition.outputSchema);
    const handler = handlers[definition.name];
    if (!handler) {
      throw new TypeError(`Missing handler for tool ${definition.name}`);
    }
    preparedTools.set(definition.name, {
      definition,
      handler,
      inputSchema: fromJsonSchema<Record<string, unknown>>(
        definition.inputSchema,
        schemaValidatorProvider,
      ),
      outputSchema: fromJsonSchema<Record<string, unknown>>(
        definition.outputSchema,
        schemaValidatorProvider,
      ),
      validateOutput,
    });
  }

  const replayGuard = new InvocationReplayGuard();
  const app = createMcpFastifyApp(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {});
  app.setErrorHandler((error, _request, reply) => {
    const errorStatus = getStatusCode(error);
    const statusCode = errorStatus === 413 ? 413 : errorStatus && errorStatus < 500 ? errorStatus : 500;
    const message = statusCode === 413 ? 'Request too large' : 'Request failed';
    return reply.code(statusCode).send({ error: message });
  });

  app.addHook('onRequest', async (request, reply) => {
    const contentLength = request.headers['content-length'];
    if (typeof contentLength === 'string' && MAX_CONTENT_LENGTH.test(contentLength)) {
      if (Number(contentLength) > MAX_REQUEST_BYTES) {
        await reply.code(413).send({ error: 'Request too large' });
      }
    }
  });
  app.addHook('preParsing', async (_request, _reply, payload) => {
    let receivedBytes = 0;
    const limitedPayload = new Transform({
      transform(chunk, _encoding, callback) {
        const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), _encoding);
        receivedBytes += byteLength;
        limitedPayload.receivedEncodedLength = receivedBytes;
        if (receivedBytes > MAX_REQUEST_BYTES) {
          const error = Object.assign(new Error('Request too large'), { statusCode: 413 });
          callback(error);
          return;
        }
        callback(null, chunk);
      },
    }) as Transform & { receivedEncodedLength: number };
    limitedPayload.receivedEncodedLength = 0;
    return payload.pipe(limitedPayload);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (request.body === undefined) {
      return;
    }
    const size = Buffer.byteLength(JSON.stringify(request.body), 'utf8');
    if (size > MAX_REQUEST_BYTES) {
      await reply.code(413).send({ error: 'Request too large' });
    }
  });

  app.get('/.well-known/hasi-plugin.json', async (_request, reply) => reply.send(manifest));
  app.get('/health', () => ({ status: 'ok' }));

  // This host-only status endpoint never invokes an execution handler.
  app.post('/hasi/actions/status', async (request, reply) => {
    if (!options.executionJournal || !hasServiceBearer(request.headers.authorization, options.serviceToken)) return reply.code(401).send({ error: 'Unauthorized' });
    try {
      const body = parseJsonRecord(request.body);
      if (Object.keys(body).sort().join(',') !== 'argsHash,executionId,tool' || typeof body.tool !== 'string' || typeof body.executionId !== 'string' || typeof body.argsHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.argsHash)) throw new Error('Invalid status request');
      const token = request.headers['x-hasi-invocation'];
      if (typeof token !== 'string') throw new Error('Invalid status request');
      const invocation = await verifyInvocationTokenClaims(token, { pluginId: manifest.id, pluginVersion: manifest.version, tool: '__hasi.action_status', args: body }, options.publicKey);
      const context = invocation.context;
      const tool = preparedTools.get(body.tool);
      if (!context || !tool) throw new Error('Invalid status authority');
      if (!(options.acceptedInstallationIds ?? [manifest.id]).includes(context.installationId) || context.executionId !== body.executionId || tool.definition.effect !== 'execute' || !hasRequiredPermissions(invocation.actor, tool.definition)) throw new Error('Invalid status authority');
      const binding: ExecutionBinding = { subject: invocation.actor.subject, installationId: context.installationId, executionId: body.executionId, tool: body.tool, argsHash: body.argsHash, configurationRevision: context.configurationRevision };
      const reconcileExecution = options.reconcileExecution;
      const result = reconcileExecution
        ? await options.executionJournal.reconcile(binding, async () => {
          const candidate = await reconcileExecution(Object.freeze(binding), invocation.actor);
          if (candidate !== undefined && !tool.validateOutput(candidate)) throw new Error('Invalid reconciliation output');
          return candidate;
        })
        : await options.executionJournal.status(binding);
      if (result.status === 'confirmed' && !tool.validateOutput(result.result)) throw new Error('Invalid receipt');
      return result;
    } catch { return reply.code(409).send({ error: 'Status could not be established' }); }
  });

  app.all('/mcp', async (request, reply) => {
    if (!hasServiceBearer(request.headers.authorization, options.serviceToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    let callBinding: ToolCallBinding | undefined;
    let invocation: VerifiedInvocation | undefined;
    if (request.method === 'POST') {
      const extracted = extractToolCall(request.body);
      if (extracted === false) {
        return reply.code(400).send({ error: 'Invalid tool request' });
      }
      callBinding = extracted;
      if (callBinding) {
        const invocationHeader = request.headers['x-hasi-invocation'];
        if (typeof invocationHeader !== 'string' || invocationHeader.length === 0) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        try {
          invocation = await verifyInvocationTokenClaims(
            invocationHeader,
            {
              pluginId: manifest.id,
              pluginVersion: manifest.version,
              tool: callBinding.tool,
              args: callBinding.args,
            },
            options.publicKey,
          );
        } catch {
          return reply.code(401).send({ error: 'Unauthorized' });
        }

        if (manifest.manifestVersion === 2 && (!invocation.context || !(options.acceptedInstallationIds ?? [manifest.id]).includes(invocation.context.installationId))) return reply.code(401).send({ error: 'Unauthorized' });

        const preparedTool = preparedTools.get(callBinding.tool);
        if (preparedTool && !hasRequiredPermissions(invocation.actor, preparedTool.definition)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
      }
    }

    const handler = createMcpHandler(() => buildMcpServer(invocation, callBinding));
    const nodeHandler = toNodeHandler(handler);
    // Fastify's raw Node request has a wider optional `method` type than the
    // MCP adapter accepts, so set the known method at this boundary.
    const rawRequest = Object.assign(request.raw, { method: request.method }) as unknown as Parameters<typeof nodeHandler>[0];
    return nodeHandler(rawRequest, reply.raw, request.body);
  });

  return app;

  function buildMcpServer(
    verifiedInvocation: VerifiedInvocation | undefined,
    call: ToolCallBinding | undefined,
  ): McpServer {
    const server = new McpServer({ name: manifest.id, version: manifest.version });
    if (manifest.manifestVersion === 2) {
      for (const presentation of manifest.presentations ?? []) {
        const html = appResources.get(presentation.resourceUri);
        if (html === undefined) {
          throw new Error(`Missing app resource for ${presentation.resourceUri}`);
        }
        registerPresentationResource(server, presentation, html);
      }
    }
    for (const preparedTool of preparedTools.values()) {
      const { definition, handler } = preparedTool;
      const config = {
        title: definition.title,
        description: definition.description,
        inputSchema: preparedTool.inputSchema,
        outputSchema: preparedTool.outputSchema,
        annotations: {
          readOnlyHint: definition.effect === 'read',
          destructiveHint: definition.effect === 'execute',
          idempotentHint: definition.effect === 'read',
        },
      };
      const callback = async (args: Record<string, unknown>) => {
        if (
          !verifiedInvocation ||
          call?.tool !== definition.name ||
          digest(args) !== verifiedInvocation.argsHash
        ) {
          throw new Error('Invalid invocation');
        }
        if (!hasRequiredPermissions(verifiedInvocation.actor, definition)) {
          throw new Error('Forbidden');
        }
        if (!await (options.consumeInvocation ? options.consumeInvocation(verifiedInvocation.jti, verifiedInvocation.expiresAt) : replayGuard.consume(verifiedInvocation.jti, verifiedInvocation.expiresAt))) {
          throw new Error('Invocation already used');
        }

        try {
          const invoke = async () => {
            const value = await handler(args, verifiedInvocation.actor, verifiedInvocation.context);
            if (!preparedTool.validateOutput(value)) throw new Error('Invalid execution output');
            return value;
          };
          let output: Record<string, unknown>;
          if (definition.effect === 'execute' && options.executionJournal) {
            const context = verifiedInvocation.context;
            if (!context?.executionId) throw new Error('Missing execution identity');
            const binding: ExecutionBinding = { subject: verifiedInvocation.actor.subject, installationId: context.installationId, executionId: context.executionId, tool: definition.name, argsHash: verifiedInvocation.argsHash, configurationRevision: context.configurationRevision };
            output = await options.executionJournal.execute(binding, invoke);
          } else output = await invoke();
          const outputJson = canonicalJson(output);
          const normalizedOutput = parseJsonRecord(JSON.parse(outputJson) as unknown, 'handler output');
          if (!preparedTool.validateOutput(normalizedOutput)) {
            throw new Error('Handler output does not match outputSchema');
          }
          const structuredContent = normalizedOutput;
          const responseData = {
            content: [{ type: 'text' as const, text: OUTPUT_SUMMARY }],
            structuredContent,
          };
          if (Buffer.byteLength(canonicalJson(responseData), 'utf8') > MAX_OUTPUT_BYTES) {
            throw new Error('Handler output exceeds the response limit');
          }
          return responseData;
        } catch {
          throw new Error('Tool execution failed');
        }
      };
      if (manifest.manifestVersion === 2) {
        const v2Definition = definition as ToolDefinitionV2;
        if (v2Definition.visibility || v2Definition.presentationId) {
          const presentation = v2Definition.presentationId
            ? (manifest.presentations ?? []).find((item) => item.id === v2Definition.presentationId)
            : undefined;
          registerAppTool(server, definition.name, {
            ...config,
            _meta: {
              ui: {
                ...(presentation ? { resourceUri: presentation.resourceUri } : {}),
                ...(v2Definition.visibility ? { visibility: v2Definition.visibility } : {}),
              },
            },
          }, callback);
          continue;
        }
      }
      server.registerTool(definition.name, config, callback);
    }
    return server;
  }
}

function validateAppResources(
  manifest: PluginManifest,
  candidate: Record<string, string> | undefined,
): Map<string, string> {
  if (manifest.manifestVersion !== 2) {
    if (candidate !== undefined && Object.keys(candidate).length > 0) {
      throw new TypeError('App resources require a v2 plugin manifest');
    }
    return new Map();
  }

  if (candidate !== undefined && !isRecord(candidate)) {
    throw new TypeError('appResources must be a record of UI resource HTML');
  }
  const resources = candidate ?? {};
  const presentations = manifest.presentations ?? [];
  const presentationByUri = new Map(presentations.map((presentation) => [presentation.resourceUri, presentation]));
  const resourceUris = Object.keys(resources);
  if (
    resourceUris.length !== presentationByUri.size ||
    resourceUris.some((uri) => !presentationByUri.has(uri))
  ) {
    throw new TypeError('appResources must match manifest presentations exactly');
  }

  const validated = new Map<string, string>();
  for (const [uri, html] of Object.entries(resources)) {
    const presentation = presentationByUri.get(uri);
    if (!presentation) {
      throw new TypeError(`App resource ${uri} has no matching manifest presentation`);
    }
    if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') === 0 || Buffer.byteLength(html, 'utf8') > MAX_APP_RESOURCE_BYTES) {
      throw new TypeError(`App resource ${uri} must be non-empty HTML under 1 MiB`);
    }
    const hash = createHash('sha256').update(html, 'utf8').digest('hex');
    if (hash !== presentation.sha256.toLowerCase()) {
      throw new TypeError(`App resource ${uri} does not match its manifest SHA-256`);
    }
    validated.set(uri, html);
  }
  return validated;
}

function registerPresentationResource(
  server: McpServer,
  presentation: PluginPresentation,
  html: string,
): void {
  const csp = {
    connectDomains: presentation.csp.connectDomains.map((domain) => `https://${domain}`),
    resourceDomains: presentation.csp.resourceDomains.map((domain) => `https://${domain}`),
  };
  const metadata = { ui: { csp, prefersBorder: true } };
  registerAppResource(
    server,
    presentation.id,
    presentation.resourceUri,
    {
      description: `Interactive view for ${presentation.id}`,
      _meta: metadata,
    },
    () => ({
      contents: [
        {
          uri: presentation.resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: metadata,
        },
      ],
    }),
  );
}

function assertObjectSchema(schema: Record<string, unknown>, label: string): void {
  if (schema.type !== 'object') {
    throw new TypeError(`${label} must be an object JSON Schema`);
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
}

function hasServiceBearer(authorization: string | undefined, serviceToken: string): boolean {
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }
  const suppliedToken = authorization.slice('Bearer '.length);
  const suppliedBytes = Buffer.from(suppliedToken, 'utf8');
  const expectedBytes = Buffer.from(serviceToken, 'utf8');
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function extractToolCall(body: unknown): ToolCallBinding | undefined | false {
  if (Array.isArray(body)) {
    return false;
  }
  if (!isRecord(body) || body.method !== 'tools/call') {
    return undefined;
  }
  if (!isRecord(body.params) || typeof body.params.name !== 'string' || body.params.name.length === 0) {
    return false;
  }
  const rawArgs = body.params.arguments === undefined ? {} : body.params.arguments;
  try {
    return {
      tool: body.params.name,
      args: parseJsonRecord(rawArgs, 'arguments'),
    };
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRequiredPermissions(actor: ActorContext, definition: ToolDefinition): boolean {
  const permissions = new Set(actor.permissions);
  return definition.requiredPermissions.every((requiredPermission) => permissions.has(requiredPermission));
}
