import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginServer, digest, type PluginManifest } from "@hasi/plugin-sdk";
import { MemoryJsonStore } from "@hasi/state";
import { createApi, PluginRegistry } from "../apps/api/src/index.js";

const PLUGIN_ID = "read-effect-fence";
const SERVICE_TOKEN = "read-effect-fence-test-token";
const apiHeaders = { host: "127.0.0.1", origin: "http://127.0.0.1:3000" };
const emptyObjectSchema = { type: "object", properties: {}, additionalProperties: false };
const readOutputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const prepareOutputSchema = {
  type: "object",
  properties: {
    draft: {
      type: "object",
      properties: {
        executionTool: { type: "string" },
        arguments: emptyObjectSchema,
        resourceName: { type: "string" },
      },
      required: ["executionTool", "arguments", "resourceName"],
      additionalProperties: false,
    },
  },
  required: ["draft"],
  additionalProperties: false,
};
const executeOutputSchema = {
  type: "object",
  properties: { executed: { type: "boolean" } },
  required: ["executed"],
  additionalProperties: false,
};

type TestApi = Awaited<ReturnType<typeof createApi>>;
type TestPlugin = ReturnType<typeof createPluginServer>;
const activeApis: TestApi[] = [];
const activePlugins: TestPlugin[] = [];

afterEach(async () => {
  await Promise.all(activeApis.splice(0).map(api => api.close()));
  await Promise.all(activePlugins.splice(0).map(plugin => plugin.close()));
});

describe("read-effect fence for tool calls", () => {
  it("allows reads and rejects prepare or execute through the API and registry guards", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const counts = { read: 0, prepare: 0, execute: 0 };
    const manifest: PluginManifest = {
      manifestVersion: 1,
      id: PLUGIN_ID,
      name: "Read effect fence fixture",
      description: "A plugin fixture for read-only tool call enforcement.",
      version: "1.0.0",
      apiVersion: "1.0.0",
      mcpVersion: "2026-07-28",
      tools: [
        {
          name: "fixture.read",
          title: "Read fixture",
          description: "Return a synthetic read result.",
          inputSchema: emptyObjectSchema,
          outputSchema: readOutputSchema,
          effect: "read",
          requiredPermissions: ["rooms:read"],
        },
        {
          name: "fixture.prepare",
          title: "Prepare fixture action",
          description: "Prepare a synthetic action.",
          inputSchema: emptyObjectSchema,
          outputSchema: prepareOutputSchema,
          effect: "prepare",
          requiredPermissions: ["rooms:read"],
        },
        {
          name: "fixture.execute",
          title: "Execute fixture action",
          description: "Execute a synthetic action.",
          inputSchema: emptyObjectSchema,
          outputSchema: executeOutputSchema,
          effect: "execute",
          requiredPermissions: ["rooms:read"],
        },
      ],
    };
    const plugin = createPluginServer({
      manifest,
      serviceToken: SERVICE_TOKEN,
      publicKey,
      handlers: {
        "fixture.read": () => { counts.read += 1; return Promise.resolve({ value: "read-result" }); },
        "fixture.prepare": () => {
          counts.prepare += 1;
          return Promise.resolve({ draft: { executionTool: "fixture.execute", arguments: {}, resourceName: "fixture" } });
        },
        "fixture.execute": () => { counts.execute += 1; return Promise.resolve({ executed: true }); },
      },
    });
    activePlugins.push(plugin);
    await plugin.listen({ host: "127.0.0.1", port: 0 });
    const address = plugin.server.address();
    if (!address || typeof address === "string") throw new Error("Fixture address missing");

    const store = new MemoryJsonStore(`read-effect-fence-${randomUUID()}`);
    const registry = new PluginRegistry(privateKey, {
      store,
      envelopeResults: true,
      defaultSourcePolicy: { sourceId: "read-effect-test", revision: "r1", dataClasses: ["synthetic_demo"] },
    });
    await registry.install({
      endpoint: `http://127.0.0.1:${String(address.port)}/mcp`,
      serviceToken: SERVICE_TOKEN,
      expectedManifestDigest: digest(manifest),
      allowLoopback: true,
    });
    const api = await createApi({ mode: "test", registry, store });
    activeApis.push(api);
    const login = await api.inject({ method: "POST", url: "/api/dev/login", headers: apiHeaders, payload: { personaId: "student" } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.map(item => `${item.name}=${item.value}`).join("; ");
    const invoke = vi.spyOn(registry, "invoke");

    const call = (name: string) => api.inject({
      method: "POST",
      url: "/api/tools/call",
      headers: { ...apiHeaders, cookie },
      payload: { pluginId: PLUGIN_ID, name, arguments: {}, requiredEffect: "read" },
    });

    const allowed = await call("fixture.read");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json<{ value: string }>().value).toBe("read-result");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[8]).toBe("read");
    expect(counts).toEqual({ read: 1, prepare: 0, execute: 0 });

    for (const name of ["fixture.prepare", "fixture.execute"]) {
      const denied = await call(name);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json<{ error: string }>().error).toBe("Dieser Aufruf darf nur lesen.");
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ read: 1, prepare: 0, execute: 0 });

    // Simulate a stale API-side registry projection that labels both tools as
    // reads. The registry must still reject their actual prepare/execute effects.
    const currentList = registry.list.bind(registry);
    vi.spyOn(registry, "list").mockImplementation(() => currentList().map(pluginView => ({
      ...pluginView,
      tools: pluginView.tools.map(tool => tool.name === "fixture.prepare" || tool.name === "fixture.execute"
        ? { ...tool, effect: "read" }
        : tool),
    })));
    for (const name of ["fixture.prepare", "fixture.execute"]) {
      const deniedByRegistry = await call(name);
      expect(deniedByRegistry.statusCode, deniedByRegistry.body).toBe(403);
      expect(deniedByRegistry.json<{ error: string }>().error).toBe("Dieser Aufruf darf nur lesen.");
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.slice(1).every(args => args[8] === "read")).toBe(true);
    expect(counts).toEqual({ read: 1, prepare: 0, execute: 0 });
  });
});
