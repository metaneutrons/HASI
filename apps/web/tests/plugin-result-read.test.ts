import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import { resultEnvelope } from "../../api/src/result-envelope";
import { canonicalJson, type ActorContext, type PluginManifest } from "@hasi/plugin-sdk";
import type { WireMessage } from "../src/lib/chat-contract";
import { boundedPluginToolResult, type PluginToolDescriptor } from "../src/lib/plugin-tools";
import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import { createKnowledgeEvidence } from "../src/lib/server/knowledge-evidence";
import { PluginResultContextStore } from "../src/lib/server/plugin-result-context";
import { handlePluginResultRead } from "../src/lib/server/plugin-result-read";

const OWNER = "user:fabian@example.invalid";
const SCOPE = `production:${OWNER}`;
const SECRET = "test-only-plugin-result-read-secret";
const AUTHORITY = "a".repeat(64);
const WITHDRAWN_AUTHORITY = "b".repeat(64);
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const ORIGIN = "https://hasi.example.test";
const PLUGIN_ID = "directory-live";
const PACKAGE_ID = "com.example.directory";
const TOOL_NAME = "directory.search";
const CALL_ID = "read-call-1";
const DEFAULT_ARGUMENTS = { query: "rooms" };

type AssistantMessage = Extract<WireMessage, { role: "assistant" }>;
interface ReadOptions {
  readonly tool?: PluginToolDescriptor;
  readonly allowedOrigins?: readonly string[];
  readonly dataClasses?: readonly string[];
  readonly authority?: () => Promise<string>;
  readonly invoke?: (tool: PluginToolDescriptor, arguments_: Record<string, unknown>) => Promise<Response>;
  readonly afterSave?: () => void;
}

function descriptor(overrides: Partial<PluginToolDescriptor> = {}): PluginToolDescriptor {
  const pluginId = overrides.pluginId ?? PLUGIN_ID;
  const name = overrides.name ?? TOOL_NAME;
  return {
    pluginId,
    name,
    title: "Search directory",
    description: "Read entries from an authorized directory.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    effect: "read",
    requiredPermissions: ["directory:read"],
    modelName: expectedModelToolName(pluginId, name),
    ...overrides,
  };
}

function signer(scope = SCOPE) {
  return createKnowledgeEvidence(SECRET, scope, () => NOW);
}

function signedCall(options: {
  readonly tool?: PluginToolDescriptor;
  readonly conversationId?: string;
  readonly signedConversationId?: string;
  readonly arguments?: Record<string, unknown>;
  readonly authorityDigest?: string;
  readonly signer?: ReturnType<typeof createKnowledgeEvidence>;
} = {}) {
  const tool = options.tool ?? descriptor();
  const conversationId = options.conversationId ?? randomUUID();
  const message: AssistantMessage = {
    id: randomUUID(),
    role: "assistant",
    content: "",
    toolCalls: [{
      id: CALL_ID,
      name: tool.modelName,
      arguments: options.arguments ?? DEFAULT_ARGUMENTS,
    }],
  };
  const evidenceSigner = options.signer ?? signer();
  message.evidence = evidenceSigner.stamp(
    options.signedConversationId ?? conversationId,
    message,
    [],
    options.authorityDigest ?? AUTHORITY,
  );
  return { conversationId, message };
}

function coreResult(
  tool: PluginToolDescriptor,
  output: Record<string, unknown> = { entries: [{ id: "entry-1", label: "Authorized entry" }] },
  dataClasses: ("synthetic_demo" | "public" | "internal" | "confidential")[] = ["public"],
) {
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: PACKAGE_ID,
    name: "Directory",
    description: "A synthetic directory plugin for tests.",
    version: "1.2.3",
    apiVersion: "1.0.0",
    mcpVersion: "2026-07-28",
    tools: [{
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      effect: tool.effect,
      requiredPermissions: [...tool.requiredPermissions],
    }],
  };
  const actor: ActorContext = { subject: OWNER, permissions: ["directory:read"] };
  return resultEnvelope({
    instanceId: tool.pluginId,
    manifest,
    configurationRevision: 7,
    actor,
    policy: { sourceId: "directory-api", revision: "policy-7", dataClasses },
    output,
    tool: tool.name,
  });
}

function createHarness(options: ReadOptions = {}) {
  const tool = options.tool ?? descriptor();
  const contextStore = new PluginResultContextStore({
    store: new MemoryJsonStore(`plugin-result-read-${randomUUID()}`, { clock: () => NOW }),
    ownerId: OWNER,
    scope: SCOPE,
    secret: SECRET,
    clock: () => NOW,
  });
  const contexts = {
    create: vi.fn(async (input: Parameters<PluginResultContextStore["create"]>[0]) => {
      const created = await contextStore.create(input);
      createdContextIds.push(created.contextId);
      options.afterSave?.();
      return created;
    }),
  };
  const createdContextIds: string[] = [];
  const invoke = vi.fn(options.invoke ?? ((invokedTool: PluginToolDescriptor) => Promise.resolve(Response.json(coreResult(invokedTool)))));
  const dependencies: Parameters<typeof handlePluginResultRead>[1] = {
    allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    dataClasses: options.dataClasses ?? ["public"],
    signer: signer(),
    contexts,
    authority: options.authority ?? (() => Promise.resolve(AUTHORITY)),
    tools: () => Promise.resolve([tool]),
    invoke,
  };
  return { dependencies, contextStore, contexts, createdContextIds, invoke, tool };
}

function post(
  dependencies: Parameters<typeof handlePluginResultRead>[1],
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return handlePluginResultRead(new Request(`${ORIGIN}/api/chat/plugin-read`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(payload),
  }), dependencies);
}

function requestBody(conversationId: string, assistantMessage: AssistantMessage, extra: Record<string, unknown> = {}) {
  return { conversationId, assistantMessage, toolCallId: CALL_ID, ...extra };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("authorized plugin result reads", () => {
  it("stores the actual core envelope output under a verified context signature and returns its canonical result", async () => {
    const tool = descriptor();
    const expected = { entries: [{ id: "entry-1", label: "Authorized entry" }], total: 1 };
    const h = createHarness({ invoke: () => Promise.resolve(Response.json(coreResult(tool, expected))) });
    const call = signedCall({ tool });

    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body.result).toEqual(boundedPluginToolResult(expected));
    expect(JSON.stringify(body.result)).toBe(canonicalJson(boundedPluginToolResult(expected)));
    expect(body.result).not.toHaveProperty("_hasi");
    expect(h.invoke).toHaveBeenCalledWith(tool, DEFAULT_ARGUMENTS);
    expect(h.contexts.create).toHaveBeenCalledOnce();
    const storedInput = h.contexts.create.mock.calls[0]?.[0];
    expect(storedInput).toMatchObject({
      conversationId: call.conversationId,
      callId: CALL_ID,
      pluginId: tool.pluginId,
      toolName: tool.name,
      arguments: DEFAULT_ARGUMENTS,
      result: boundedPluginToolResult(expected),
      authorityDigest: AUTHORITY,
      dataClasses: ["public"],
    });

    const contextId = body.contextId;
    expect(typeof contextId).toBe("string");
    const resolved = await h.contextStore.resolve(call.conversationId, [contextId as string], AUTHORITY);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ status: "valid", context: { result: boundedPluginToolResult(expected) } });
    expect(await h.contextStore.resolve(call.conversationId, [contextId as string], WITHDRAWN_AUTHORITY)).toEqual([
      { contextId, status: "unavailable" },
    ]);
  });

  it("rejects browser supplied result data through the strict request schema", async () => {
    const h = createHarness();
    const call = signedCall({ tool: h.tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message, {
      result: { injected: "BROWSER_RESULT_MUST_NOT_BE_STORED" },
    }));

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({ error: "Ungültige Werkzeuganfrage." });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it.each([
    ["altered call arguments", (tool: PluginToolDescriptor) => {
      const call = signedCall({ tool });
      const toolCall = call.message.toolCalls?.[0];
      if (!toolCall) throw new Error("Signed tool call is missing.");
      toolCall.arguments = { query: "changed after signing" };
      return { conversationId: call.conversationId, message: call.message };
    }],
    ["a different owner", (tool: PluginToolDescriptor) => {
      const call = signedCall({ tool, signer: signer("production:someone-else") });
      return { conversationId: call.conversationId, message: call.message };
    }],
    ["a different conversation", (tool: PluginToolDescriptor) => {
      const call = signedCall({ tool, signedConversationId: randomUUID() });
      return { conversationId: call.conversationId, message: call.message };
    }],
    ["a different current authority", (tool: PluginToolDescriptor) => {
      const call = signedCall({ tool, authorityDigest: WITHDRAWN_AUTHORITY });
      return { conversationId: call.conversationId, message: call.message };
    }],
    ["a forged signature", (tool: PluginToolDescriptor) => {
      const call = signedCall({ tool });
      const evidence = call.message.evidence;
      if (!evidence) throw new Error("Signed evidence is missing.");
      evidence.receipt = "x".repeat(43);
      return { conversationId: call.conversationId, message: call.message };
    }],
  ])("denies %s before invoking or storing", async (_label, makeCall) => {
    const h = createHarness();
    const call = makeCall(h.tool);
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toEqual({ error: "Der Werkzeugaufruf ist nicht mehr freigegeben. Bitte stelle die Anfrage erneut." });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it.each([
    ["preparation tools", descriptor({ name: "directory.prepare", effect: "prepare" })],
    ["native alias tools", descriptor({
      pluginId: "de.hsh.hasi.anny",
      name: "anny.search_resources",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })],
  ])("does not invoke or store %s", async (_label, tool) => {
    const h = createHarness({ tool });
    const call = signedCall({ tool, arguments: tool.name === "anny.search_resources" ? {} : DEFAULT_ARGUMENTS });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({ error: "Dieses Lesewerkzeug ist derzeit nicht freigegeben." });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it("rejects tool arguments that do not satisfy the authorized descriptor", async () => {
    const h = createHarness();
    const call = signedCall({ tool: h.tool, arguments: { query: 123 } as unknown as Record<string, unknown> });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));

    expect(response.status).toBe(403);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing core provenance", (_tool: PluginToolDescriptor) => ({ entries: [{ label: "SECRET_PROVIDER_RESULT" }] }), 503],
    ["forged core provenance", (tool: PluginToolDescriptor) => {
      const result = coreResult(tool);
      result._hasi.provenance.manifestDigest = "forged";
      return result;
    }, 503],
    ["another installation's provenance", (tool: PluginToolDescriptor) => {
      const result = coreResult(tool);
      result._hasi.provenance.installationId = "another-installation";
      return result;
    }, 409],
    ["an unapproved classification", (tool: PluginToolDescriptor) => coreResult(tool, { marker: "SECRET_CONFIDENTIAL_RESULT" }, ["confidential"]), 409],
  ])("rejects %s with a static error and no stored result", async (_label, makeResult, status) => {
    const tool = descriptor();
    const h = createHarness({ invoke: () => Promise.resolve(Response.json(makeResult(tool))) });
    const call = signedCall({ tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));
    const body = await responseJson(response);

    expect(response.status).toBe(status);
    expect(body).toEqual({ error: status === 409
      ? "Die Ergebnisfreigabe konnte nicht geprüft werden."
      : "Das Werkzeugergebnis konnte nicht sicher geprüft werden. Bitte versuche es erneut." });
    expect(JSON.stringify(body)).not.toMatch(/SECRET_PROVIDER_RESULT|SECRET_CONFIDENTIAL_RESULT|forged/u);
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it("returns 409 without invoking when authority is withdrawn before invocation", async () => {
    let calls = 0;
    const h = createHarness({ authority: () => Promise.resolve(++calls < 2 ? AUTHORITY : WITHDRAWN_AUTHORITY) });
    const call = signedCall({ tool: h.tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));

    expect(response.status).toBe(409);
    expect(await responseJson(response)).not.toHaveProperty("result");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it("returns 409 without storing when authority changes during invocation", async () => {
    let authority = AUTHORITY;
    const tool = descriptor();
    const h = createHarness({
      authority: () => Promise.resolve(authority),
      invoke: () => {
        authority = WITHDRAWN_AUTHORITY;
        return Promise.resolve(Response.json(coreResult(tool)));
      },
    });
    const call = signedCall({ tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));

    expect(response.status).toBe(409);
    expect(await responseJson(response)).not.toHaveProperty("result");
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.contexts.create).not.toHaveBeenCalled();
  });

  it("returns no result when authority changes while the context is being saved", async () => {
    let authority = AUTHORITY;
    const tool = descriptor();
    const h = createHarness({
      authority: () => Promise.resolve(authority),
      afterSave: () => { authority = WITHDRAWN_AUTHORITY; },
      invoke: () => Promise.resolve(Response.json(coreResult(tool))),
    });
    const call = signedCall({ tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));
    const body = await responseJson(response);

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "Die Dienstfreigabe hat sich geändert. Bitte erneut versuchen." });
    expect(body).not.toHaveProperty("result");
    expect(body).not.toHaveProperty("contextId");
    expect(h.contexts.create).toHaveBeenCalledOnce();
    const [storedContextId] = h.createdContextIds;
    if (!storedContextId) throw new Error("Saved result context ID is missing.");
    expect(await h.contextStore.resolve(call.conversationId, [storedContextId], WITHDRAWN_AUTHORITY)).toEqual([
      { contextId: storedContextId, status: "unavailable" },
    ]);
  });

  it("enforces request origin, JSON content type, and bounded request and service response sizes", async () => {
    const h = createHarness();
    const call = signedCall({ tool: h.tool });
    const payload = requestBody(call.conversationId, call.message);

    const foreignOrigin = await post(h.dependencies, payload, { origin: "https://attacker.example" });
    expect(foreignOrigin.status).toBe(403);
    expect(await responseJson(foreignOrigin)).toEqual({ error: "Unzulässiger Anfrageursprung." });

    const crossSite = await post(h.dependencies, payload, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);

    const nonJson = await post(h.dependencies, payload, { "content-type": "text/plain" });
    expect(nonJson.status).toBe(415);
    expect(await responseJson(nonJson)).toEqual({ error: "Die Anfrage muss JSON enthalten." });

    const oversizedInput = await post(h.dependencies, { ...payload, padding: "x".repeat(61_000) });
    expect(oversizedInput.status).toBe(400);
    expect(h.invoke).not.toHaveBeenCalled();

    const largeToolResponse = createHarness({
      invoke: () => Promise.resolve(new Response(JSON.stringify({ ...coreResult(h.tool), padding: "x".repeat(100 * 1024) }), {
        headers: { "content-type": "application/json" },
      })),
    });
    const largeResponseCall = signedCall({ tool: largeToolResponse.tool });
    const tooLarge = await post(largeToolResponse.dependencies, requestBody(largeResponseCall.conversationId, largeResponseCall.message));
    expect(tooLarge.status).toBe(503);
    expect(await responseJson(tooLarge)).toEqual({ error: "Das Werkzeugergebnis konnte nicht sicher geprüft werden. Bitte versuche es erneut." });
    expect(largeToolResponse.contexts.create).not.toHaveBeenCalled();
  });

  it.each([
    [403, 403],
    [500, 503],
  ])("redacts service failure bodies with HTTP %i", async (serviceStatus, expectedStatus) => {
    const h = createHarness({
      invoke: () => Promise.resolve(new Response(JSON.stringify({ error: "SECRET_UPSTREAM_TOKEN_41c8" }), {
        status: serviceStatus,
        headers: { "content-type": "application/json" },
      })),
    });
    const call = signedCall({ tool: h.tool });
    const response = await post(h.dependencies, requestBody(call.conversationId, call.message));
    const body = await responseJson(response);

    expect(response.status).toBe(expectedStatus);
    expect(body).toEqual({ error: "Die Dienstabfrage ist derzeit nicht möglich. Prüfe die Verbindung unter „Verbundene Dienste“." });
    expect(JSON.stringify(body)).not.toContain("SECRET_UPSTREAM_TOKEN_41c8");
    expect(h.contexts.create).not.toHaveBeenCalled();
  });
});
