import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadModelConfiguration,
  modelConfigurationSchema,
  resolveModelConnection,
} from "../src/lib/server/model-config";
import { required } from "./test-utils";

function defaultConfig() {
  return loadModelConfiguration({});
}

function jsonConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    connections: [
      { id: "groq-demo", label: "Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY" },
      { id: "openai-demo", label: "OpenAI", provider: "openai", credentialRef: "env:OPENAI_API_KEY" },
    ],
    profiles: [
      {
        id: "groq-model",
        label: "Groq model",
        connectionId: "groq-demo",
        modelId: "groq/example-model",
        capabilities: { tools: true },
        allowedDataClasses: ["synthetic_demo"],
        parameters: {},
      },
      {
        id: "openai-model",
        label: "OpenAI model",
        connectionId: "openai-demo",
        modelId: "example-model-id",
        capabilities: { tools: false },
        allowedDataClasses: ["synthetic_demo"],
        parameters: {},
      },
    ],
    policy: {
      defaultProfileId: "groq-model",
      userChoice: { enabled: true, profileIds: ["groq-model", "openai-model"] },
      fallbacks: [],
    },
    ...overrides,
  };
}

function withPolicy(config: ReturnType<typeof jsonConfig>, policyOverrides: Record<string, unknown>) {
  return { ...config, policy: { ...config.policy, ...policyOverrides } };
}

describe("server model configuration", () => {
  it("keeps the shipped provider profile IDs, labels, models, and policy", () => {
    const config = defaultConfig();
    expect(config.profiles.map(({ id, label, modelId }) => ({ id, label, modelId }))).toEqual([
      { id: "groq-oss-120b", label: "Groq GPT-OSS 120B", modelId: "openai/gpt-oss-120b" },
      { id: "groq-oss-20b", label: "Groq GPT-OSS 20B", modelId: "openai/gpt-oss-20b" },
      { id: "groq-qwen-3.8-27b", label: "Groq Qwen3.8 27B · Preview", modelId: "qwen/qwen3.8-27b" },
      {
        id: "gwdg-qwen3-30b",
        label: "GWDG SAIA · Qwen3 30B A3B Instruct 2507 · Experimental",
        modelId: "qwen3-30b-a3b-instruct-2507",
      },
      { id: "deepinfra-deepseek-v4.1-flash", label: "DeepInfra · DeepSeek V4.1 Flash · Experimental", modelId: "deepseek-ai/DeepSeek-V4.1-Flash" },
    ]);
    expect(config.profiles.map(({ parameters }) => parameters)).toEqual([
      { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "low" },
      { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "low" },
      { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "none" },
      { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 45_000 },
      { temperature: 1, maxOutputTokens: 1536, timeoutMs: 45_000 },
    ]);
    expect(config.policy).toEqual({
      defaultProfileId: "groq-oss-120b",
      userChoice: {
        enabled: true,
        profileIds: ["groq-oss-120b", "groq-oss-20b", "groq-qwen-3.8-27b", "gwdg-qwen3-30b", "deepinfra-deepseek-v4.1-flash"],
      },
      fallbacks: [],
      maxAttempts: 2,
      totalTimeoutMs: 45_000,
    });
    expect(config.profiles.every((profile) => profile.allowedDataClasses.includes("synthetic_demo"))).toBe(true);
  });

  it("resolves fixed origins and provider APIs without accepting endpoint overrides", () => {
    const config = defaultConfig();
    expect(resolveModelConnection(required(config.connections[0]))).toEqual({
      adapter: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      api: "chat-completions",
    });
    expect(resolveModelConnection(required(config.connections[1]))).toEqual({
      adapter: "openai-compatible",
      baseURL: "https://chat-ai.academiccloud.de/v1",
      api: "chat-completions",
    });

    expect(resolveModelConnection(required(config.connections[2]))).toEqual({
      adapter: "openai-compatible",
      baseURL: "https://api.deepinfra.com/v1/openai",
      api: "chat-completions",
    });
    const deepinfra = required(config.connections[2]);
    for (const override of [{ endpoint: "https://attacker.example/v1" }, { credentialRef: "env:UNKNOWN_KEY" }]) {
      expect(modelConfigurationSchema.safeParse({ ...config, connections: [...config.connections.slice(0, 2), { ...deepinfra, ...override }] }).success).toBe(false);
    }

    const openai = required(jsonConfig().connections[1]);
    expect(resolveModelConnection(required(modelConfigurationSchema.parse({
      ...jsonConfig(),
      connections: [jsonConfig().connections[0], openai],
    }).connections[1]))).toEqual({
      adapter: "openai",
      baseURL: "https://api.openai.com/v1",
      api: "responses",
    });
    const explicitChat = modelConfigurationSchema.parse({
      ...jsonConfig(),
      connections: [jsonConfig().connections[0], { ...openai, api: "chat-completions" }],
    });
    expect(resolveModelConnection(required(explicitChat.connections[1]))).toMatchObject({ api: "chat-completions" });
  });

  it("rejects provider origins and credential references that are not server-owned", () => {
    const invalidConnections = [
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:CUSTOM_API_KEY", endpoint: "http://custom.example.test" },
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:CUSTOM_API_KEY", endpoint: "\nhttps://custom.example.test" },
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:CUSTOM_API_KEY", endpoint: "https://user:pass@custom.example.test" },
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:CUSTOM_API_KEY", endpoint: "https://custom.example.test?token=x" },
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:CUSTOM_API_KEY", endpoint: "https://custom.example.test/#fragment" },
      { id: "custom-a", label: "Custom", provider: "custom", credentialRef: "env:UNKNOWN_KEY", endpoint: "https://custom.example.test" },
    ];
    for (const connection of invalidConnections) {
      const config = jsonConfig({
        connections: [connection],
        profiles: [
          {
            id: "custom-model",
            label: "Custom model",
            connectionId: "custom-a",
            modelId: "example-model-id",
            capabilities: { tools: false },
            allowedDataClasses: ["synthetic_demo"],
          },
        ],
        policy: {
          defaultProfileId: "custom-model",
          userChoice: { enabled: true, profileIds: ["custom-model"] },
          fallbacks: [],
        },
      });
      expect(modelConfigurationSchema.safeParse(config).success).toBe(false);
    }

    const plaintextCredential = jsonConfig({ connections: [{
      id: "groq-demo", label: "Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY", apiKey: "never-allowed",
    }] });
    expect(modelConfigurationSchema.safeParse(plaintextCredential).success).toBe(false);
    expect(modelConfigurationSchema.safeParse(jsonConfig({
      connections: [{ id: "groq-demo", label: "Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY", api: "responses" }],
    })).success).toBe(false);
    expect(modelConfigurationSchema.safeParse(jsonConfig({
      profiles: [{
        id: "groq-model", label: "\nGroq model", connectionId: "groq-demo", modelId: "groq/model",
        capabilities: { tools: true }, allowedDataClasses: ["synthetic_demo"], parameters: {},
      }, jsonConfig().profiles[1]],
    })).success).toBe(false);
    expect(modelConfigurationSchema.safeParse(jsonConfig({
      connections: [{ id: "offline", label: "Offline", provider: "openai", credentialRef: "env:OPENAI_API_KEY" }],
    })).success).toBe(false);
  });

  it("checks references, duplicate IDs, and bounded acyclic fallback policies", () => {
    const duplicatedConnection = jsonConfig({
      connections: [
        { id: "groq-demo", label: "Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY" },
        { id: "groq-demo", label: "Other Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY" },
      ],
    });
    expect(modelConfigurationSchema.safeParse(duplicatedConnection).success).toBe(false);

    const danglingProfile = jsonConfig({ profiles: [{
      id: "dangling", label: "Dangling", connectionId: "missing", modelId: "example-model-id",
      capabilities: { tools: false }, allowedDataClasses: ["synthetic_demo"],
    }] });
    expect(modelConfigurationSchema.safeParse(danglingProfile).success).toBe(false);

    const danglingFallback = withPolicy(jsonConfig(), {
      fallbacks: [{ from: "groq-model", targets: ["missing"], on: ["timeout"] }],
    });
    expect(modelConfigurationSchema.safeParse(danglingFallback).success).toBe(false);

    const cycle = withPolicy(jsonConfig(), {
      maxAttempts: 3,
      fallbacks: [
        { from: "groq-model", targets: ["openai-model"], on: ["timeout"] },
        { from: "openai-model", targets: ["groq-model"], on: ["server_error"] },
      ],
    });
    expect(modelConfigurationSchema.safeParse(cycle).success).toBe(false);

    const tooDeep = withPolicy(jsonConfig(), {
      maxAttempts: 2,
      fallbacks: [
        { from: "groq-model", targets: ["openai-model"], on: ["timeout"] },
        { from: "openai-model", targets: ["groq-model"], on: ["rate_limit"] },
      ],
    });
    expect(modelConfigurationSchema.safeParse(tooDeep).success).toBe(false);
  });

  it("keeps user choice explicitly allowlisted and permits disabling it", () => {
    const config = jsonConfig();
    expect(modelConfigurationSchema.safeParse(withPolicy(config, {
      userChoice: { enabled: false, profileIds: [] },
    })).success).toBe(true);
    expect(modelConfigurationSchema.safeParse(withPolicy(config, {
      userChoice: { enabled: true, profileIds: ["openai-model"] },
    })).success).toBe(true);
    expect(modelConfigurationSchema.safeParse(withPolicy(config, {
      userChoice: { enabled: true, profileIds: ["unknown"] },
    })).success).toBe(false);
  });

  it("defaults temperature to 0.2 and preserves null to omit it", () => {
    const config = jsonConfig();
    const defaulted = modelConfigurationSchema.parse(config);
    expect(required(defaulted.profiles[0]).parameters.temperature).toBe(0.2);

    const omitted = modelConfigurationSchema.parse({
      ...config,
      profiles: [
        { ...config.profiles[0], parameters: { temperature: null } },
        config.profiles[1],
      ],
    });
    expect(required(omitted.profiles[0]).parameters.temperature).toBeNull();
  });

  it("supports multiple custom connections with separate approved secret references", () => {
    const config = jsonConfig({
      connections: [
        { id: "groq-demo", label: "Groq", provider: "groq", credentialRef: "env:GROQ_API_KEY" },
        { id: "custom-a", label: "Custom A", provider: "custom", credentialRef: "env:HASI_LLM_SECRET_CUSTOM_A", endpoint: "https://one.example.test/v1" },
        { id: "custom-b", label: "Custom B", provider: "custom", credentialRef: "env:HASI_LLM_SECRET_CUSTOM_B", endpoint: "https://two.example.test/v1" },
      ],
      profiles: [
        jsonConfig().profiles[0],
        { id: "custom-a-model", label: "A", connectionId: "custom-a", modelId: "example-a", capabilities: { tools: false }, allowedDataClasses: ["synthetic_demo"], parameters: {} },
        { id: "custom-b-model", label: "B", connectionId: "custom-b", modelId: "example-b", capabilities: { tools: false }, allowedDataClasses: ["synthetic_demo"], parameters: {} },
      ],
      policy: {
        defaultProfileId: "groq-model",
        userChoice: { enabled: true, profileIds: ["groq-model", "custom-a-model", "custom-b-model"] },
        fallbacks: [],
      },
    });
    const parsed = modelConfigurationSchema.parse(config);
    expect(parsed.connections.filter(({ provider }) => provider === "custom")).toHaveLength(2);
    expect(resolveModelConnection(required(parsed.connections[1]))).toEqual({
      adapter: "openai-compatible",
      baseURL: "https://one.example.test/v1",
      api: "chat-completions",
    });
  });

  it("adds a valid legacy Custom profile even before its key is configured", () => {
    const absent = defaultConfig();
    expect(absent.profiles.some(({ id }) => id === "custom-default")).toBe(false);
    const configured = loadModelConfiguration({
      CUSTOM_ENDPOINT: "https://custom.example.test/api/v2/",
      CUSTOM_MODEL_ID: "custom-model-id",
    });
    expect(configured.profiles.at(-1)).toMatchObject({
      id: "custom-default",
      modelId: "custom-model-id",
      connectionId: "custom-demo",
      capabilities: { tools: true },
    });
    expect(configured.policy.userChoice.profileIds).toContain("custom-default");
    expect(resolveModelConnection(required(configured.connections.at(-1)))).toEqual({
      adapter: "openai-compatible",
      baseURL: "https://custom.example.test/api/v2",
      api: "chat-completions",
    });
    expect(loadModelConfiguration({
      CUSTOM_API_KEY: "test-key",
      CUSTOM_ENDPOINT: "http://custom.example.test",
      CUSTOM_MODEL_ID: "custom-model-id",
    }).profiles.some(({ id }) => id === "custom-default")).toBe(false);
    expect(loadModelConfiguration({
      CUSTOM_API_KEY: "test-key",
      CUSTOM_ENDPOINT: "https://custom.example.test",
      CUSTOM_MODEL_ID: "\ncustom-model",
    }).profiles.some(({ id }) => id === "custom-default")).toBe(false);
  });

  it("fails closed on invalid explicit configuration without leaking or using legacy values", () => {
    const secretLike = "do-not-return-this-config-or-secret";
    const invalidConfig = JSON.stringify({
      ...jsonConfig(),
      unexpected: secretLike,
    });
    try {
      loadModelConfiguration({
        HASI_LLM_CONFIG: invalidConfig,
        CUSTOM_API_KEY: "legacy-key-must-not-change-the-result",
        CUSTOM_ENDPOINT: "https://legacy.example.test",
        CUSTOM_MODEL_ID: "legacy-model",
      });
      throw new Error("Expected invalid explicit configuration to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid HASI_LLM_CONFIG.");
      expect((error as Error).message).not.toContain(secretLike);
    }
    expect(() => loadModelConfiguration({ HASI_LLM_CONFIG: "x".repeat(65_537) })).toThrow("Invalid HASI_LLM_CONFIG.");
  });
});
