import "server-only";

import { z } from "zod";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ID_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SECRET_REFERENCE_PATTERN = /^env:HASI_LLM_SECRET_[A-Z0-9_]{1,64}$/u;
const SECRET_REFERENCES = [
  "env:GROQ_API_KEY",
  "env:GWDG_API_KEY",
  "env:DEEPINFRA_API_KEY",
  "env:OPENAI_API_KEY",
  "env:ANTHROPIC_API_KEY",
  "env:CUSTOM_API_KEY",
] as const;

const idSchema = z.string().min(1).max(64).regex(ID_PATTERN).refine((id) => id !== "offline");
const labelSchema = z.string().refine((value) => !CONTROL_CHARACTERS.test(value)).trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u);
const modelIdSchema = z.string().refine((value) => !CONTROL_CHARACTERS.test(value)).trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const credentialRefSchema = z.union([
  z.enum(SECRET_REFERENCES),
  z.string().regex(SECRET_REFERENCE_PATTERN),
]);

const connectionFields = {
  id: idSchema,
  label: labelSchema,
  credentialRef: credentialRefSchema,
};

const groqConnectionSchema = z.strictObject({ ...connectionFields, provider: z.literal("groq") });
const gwdgConnectionSchema = z.strictObject({ ...connectionFields, provider: z.literal("gwdg") });
const deepinfraConnectionSchema = z.strictObject({ ...connectionFields, provider: z.literal("deepinfra") });
const openaiConnectionSchema = z.strictObject({
  ...connectionFields,
  provider: z.literal("openai"),
  api: z.enum(["responses", "chat-completions"]).optional(),
});
const anthropicConnectionSchema = z.strictObject({ ...connectionFields, provider: z.literal("anthropic") });
const customConnectionSchema = z.strictObject({
  ...connectionFields,
  provider: z.literal("custom"),
  endpoint: z.string().refine((value) => !CONTROL_CHARACTERS.test(value)).trim().min(1).max(2048).pipe(z.url().min(1).max(2048).regex(/^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/u)),
});

const connectionSchema = z.discriminatedUnion("provider", [
  groqConnectionSchema,
  gwdgConnectionSchema,
  deepinfraConnectionSchema,
  openaiConnectionSchema,
  anthropicConnectionSchema,
  customConnectionSchema,
]);

const dataClassSchema = z.enum(["synthetic_demo", "public", "internal", "confidential"]);
const profileSchema = z.strictObject({
  id: idSchema,
  label: labelSchema,
  connectionId: idSchema,
  modelId: modelIdSchema,
  capabilities: z.strictObject({ tools: z.boolean() }),
  allowedDataClasses: z.array(dataClassSchema).min(1).max(4),
  parameters: z.strictObject({
    temperature: z.number().min(0).max(2).nullable().default(0.2)
      .describe("Set to null to omit temperature for provider models that do not accept it; omitted values default to 0.2."),
    maxOutputTokens: z.number().int().min(1).max(1536).default(1536),
    timeoutMs: z.number().int().min(1000).max(45_000).default(20_000),
    reasoningEffort: z.enum(["low", "none"]).optional(),
  }),
});

const fallbackSchema = z.strictObject({
  from: idSchema,
  targets: z.array(idSchema).min(1).max(2),
  on: z.array(z.enum(["rate_limit", "server_error", "timeout"])).min(1).max(3),
});

const modelConfigurationBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  connections: z.array(connectionSchema).min(1).max(32),
  profiles: z.array(profileSchema).min(1).max(64),
  policy: z.strictObject({
    defaultProfileId: idSchema,
    userChoice: z.strictObject({
      enabled: z.boolean(),
      profileIds: z.array(idSchema).max(64),
    }),
    fallbacks: z.array(fallbackSchema).max(16),
    maxAttempts: z.number().int().min(1).max(3).default(2),
    totalTimeoutMs: z.number().int().min(1000).max(50_000).default(45_000),
  }),
});

function isValidCustomEndpoint(value: string): boolean {
  if (CONTROL_CHARACTERS.test(value) || value.includes("?") || value.includes("#")) return false;
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.hostname.length > 0 &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.search.length === 0 &&
      endpoint.hash.length === 0
    );
  } catch {
    return false;
  }
}

function addIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

export const modelConfigurationSchema = modelConfigurationBaseSchema.superRefine((configuration, context) => {
  const connectionIds = new Set<string>();
  const profileIds = new Set<string>();
  const connectionsById = new Map<string, (typeof configuration.connections)[number]>();
  const profilesById = new Map<string, (typeof configuration.profiles)[number]>();

  configuration.connections.forEach((connection, index) => {
    if (connectionIds.has(connection.id)) addIssue(context, ["connections", index, "id"], "Connection IDs must be unique.");
    connectionIds.add(connection.id);
    connectionsById.set(connection.id, connection);
    if (connection.provider === "custom" && !isValidCustomEndpoint(connection.endpoint)) {
      addIssue(context, ["connections", index, "endpoint"], "Custom endpoints must be HTTPS URLs without credentials, query, or fragment.");
    }
  });

  configuration.profiles.forEach((profile, index) => {
    if (profileIds.has(profile.id)) addIssue(context, ["profiles", index, "id"], "Profile IDs must be unique.");
    profileIds.add(profile.id);
    profilesById.set(profile.id, profile);
    const connection = connectionsById.get(profile.connectionId);
    if (!connection) {
      addIssue(context, ["profiles", index, "connectionId"], "Profile connection does not exist.");
    } else if (profile.parameters.reasoningEffort !== undefined && connection.provider !== "groq") {
      addIssue(context, ["profiles", index, "parameters", "reasoningEffort"], "reasoningEffort is supported only by Groq profiles.");
    }
    if (new Set(profile.allowedDataClasses).size !== profile.allowedDataClasses.length) {
      addIssue(context, ["profiles", index, "allowedDataClasses"], "Data classes must be unique.");
    }
  });

  const { policy } = configuration;
  if (!profilesById.has(policy.defaultProfileId)) {
    addIssue(context, ["policy", "defaultProfileId"], "Default profile does not exist.");
  }
  for (const [index, profileId] of policy.userChoice.profileIds.entries()) {
    if (!profilesById.has(profileId)) addIssue(context, ["policy", "userChoice", "profileIds", index], "Selectable profile does not exist.");
  }
  if (new Set(policy.userChoice.profileIds).size !== policy.userChoice.profileIds.length) {
    addIssue(context, ["policy", "userChoice", "profileIds"], "Selectable profile IDs must be unique.");
  }

  const fallbackSources = new Set<string>();
  const fallbackEdges = new Map<string, string[]>();
  policy.fallbacks.forEach((fallback, index) => {
    if (fallbackSources.has(fallback.from)) addIssue(context, ["policy", "fallbacks", index, "from"], "Only one fallback rule is allowed per source profile.");
    fallbackSources.add(fallback.from);
    if (!profilesById.has(fallback.from)) addIssue(context, ["policy", "fallbacks", index, "from"], "Fallback source profile does not exist.");
    if (new Set(fallback.targets).size !== fallback.targets.length) {
      addIssue(context, ["policy", "fallbacks", index, "targets"], "Fallback targets must be unique.");
    }
    if (new Set(fallback.on).size !== fallback.on.length) {
      addIssue(context, ["policy", "fallbacks", index, "on"], "Fallback failure kinds must be unique.");
    }
    for (const [targetIndex, target] of fallback.targets.entries()) {
      if (!profilesById.has(target)) addIssue(context, ["policy", "fallbacks", index, "targets", targetIndex], "Fallback target profile does not exist.");
      if (target === fallback.from) addIssue(context, ["policy", "fallbacks", index, "targets", targetIndex], "A profile cannot fall back to itself.");
    }
    fallbackEdges.set(fallback.from, fallback.targets);
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const depthMemo = new Map<string, number>();
  const visit = (profileId: string): { depth: number; hasCycle: boolean } => {
    if (visiting.has(profileId)) return { depth: 0, hasCycle: true };
    const knownDepth = depthMemo.get(profileId);
    if (knownDepth !== undefined) return { depth: knownDepth, hasCycle: false };
    if (visited.has(profileId)) return { depth: 0, hasCycle: false };
    visiting.add(profileId);
    let depth = 0;
    let hasCycle = false;
    for (const target of fallbackEdges.get(profileId) ?? []) {
      const result = visit(target);
      depth = Math.max(depth, 1 + result.depth);
      hasCycle = hasCycle || result.hasCycle;
    }
    visiting.delete(profileId);
    visited.add(profileId);
    depthMemo.set(profileId, depth);
    return { depth, hasCycle };
  };
  let hasCycle = false;
  for (const source of fallbackEdges.keys()) hasCycle = hasCycle || visit(source).hasCycle;
  if (hasCycle) addIssue(context, ["policy", "fallbacks"], "Fallback graph must be acyclic.");
  if (!hasCycle && [...depthMemo.values()].some((depth) => depth > policy.maxAttempts - 1)) {
    addIssue(context, ["policy", "fallbacks"], "Fallback depth cannot exceed the configured attempt limit.");
  }
});

export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export type ModelConnection = ModelConfiguration["connections"][number];
export interface ResolvedModelConnection {
  adapter: "groq" | "openai" | "anthropic" | "openai-compatible";
  baseURL: string;
  api: "responses" | "chat-completions";
}

export const modelConfigurationJsonSchema = {
  ...z.toJSONSchema(modelConfigurationBaseSchema),
  $comment: "JSON Schema covers field shapes and bounds. Runtime validation also rejects the reserved ID offline and checks uniqueness, cross references, provider-specific reasoning parameters, custom endpoint credentials/origins, and the acyclic bounded fallback graph.",
};

const DEFAULT_CONFIGURATION = {
  schemaVersion: 1,
  connections: [
    { id: "groq-demo", label: "GroqCloud demo", provider: "groq", credentialRef: "env:GROQ_API_KEY" },
    { id: "gwdg-demo", label: "GWDG SAIA demo", provider: "gwdg", credentialRef: "env:GWDG_API_KEY" },
    { id: "deepinfra-demo", label: "DeepInfra demo", provider: "deepinfra", credentialRef: "env:DEEPINFRA_API_KEY" },
  ],
  profiles: [
    {
      id: "groq-oss-120b",
      label: "Groq GPT-OSS 120B",
      connectionId: "groq-demo",
      modelId: "openai/gpt-oss-120b",
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "low" },
    },
    {
      id: "groq-oss-20b",
      label: "Groq GPT-OSS 20B",
      connectionId: "groq-demo",
      modelId: "openai/gpt-oss-20b",
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "low" },
    },
    {
      id: "groq-qwen-3.8-27b",
      label: "Groq Qwen3.8 27B · Preview",
      connectionId: "groq-demo",
      modelId: "qwen/qwen3.8-27b",
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000, reasoningEffort: "none" },
    },
    {
      id: "gwdg-qwen3-30b",
      label: "GWDG SAIA · Qwen3 30B A3B Instruct 2507 · Experimental",
      connectionId: "gwdg-demo",
      modelId: "qwen3-30b-a3b-instruct-2507",
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 45_000 },
    },
    {
      id: "deepinfra-deepseek-v4.1-flash",
      label: "DeepInfra · DeepSeek V4.1 Flash · Experimental",
      connectionId: "deepinfra-demo",
      modelId: "deepseek-ai/DeepSeek-V4.1-Flash",
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: 1, maxOutputTokens: 1536, timeoutMs: 45_000 },
    },
  ],
  policy: {
    defaultProfileId: "groq-oss-120b",
    userChoice: { enabled: true, profileIds: ["groq-oss-120b", "groq-oss-20b", "groq-qwen-3.8-27b", "gwdg-qwen3-30b", "deepinfra-deepseek-v4.1-flash"] },
    fallbacks: [],
    maxAttempts: 2,
    totalTimeoutMs: 45_000,
  },
} satisfies z.input<typeof modelConfigurationBaseSchema>;

function validLegacyCustomConnection(environment: Readonly<Record<string, string | undefined>>) {
  const rawEndpoint = environment.CUSTOM_ENDPOINT;
  const rawModelId = environment.CUSTOM_MODEL_ID;
  if (typeof rawEndpoint !== "string" || typeof rawModelId !== "string") return undefined;
  if (CONTROL_CHARACTERS.test(rawEndpoint) || CONTROL_CHARACTERS.test(rawModelId)) return undefined;
  const endpoint = rawEndpoint.trim();
  const modelId = rawModelId.trim();
  if (!modelId || modelId.length > 128 || !isValidCustomEndpoint(endpoint)) return undefined;

  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  const normalizedEndpoint = url.toString().replace(/\/+$/u, "");
  const displayModelId = modelId.length > 72 ? `${modelId.slice(0, 71)}…` : modelId;
  return {
    connection: {
      id: "custom-demo",
      label: "Legacy Custom",
      provider: "custom" as const,
      credentialRef: "env:CUSTOM_API_KEY",
      endpoint: normalizedEndpoint,
    },
    profile: {
      id: "custom-default",
      label: `Custom · ${displayModelId}`,
      connectionId: "custom-demo",
      modelId,
      capabilities: { tools: true },
      allowedDataClasses: ["synthetic_demo" as const],
      parameters: { temperature: 0.2, maxOutputTokens: 1536, timeoutMs: 20_000 },
    },
  };
}

export function loadModelConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): ModelConfiguration {
  if (env.HASI_LLM_CONFIG !== undefined) {
    const configured = env.HASI_LLM_CONFIG;
    if (new TextEncoder().encode(configured).byteLength > 65_536) throw new Error("Invalid HASI_LLM_CONFIG.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(configured);
    } catch {
      throw new Error("Invalid HASI_LLM_CONFIG.");
    }
    const result = modelConfigurationSchema.safeParse(parsed);
    if (!result.success) throw new Error("Invalid HASI_LLM_CONFIG.");
    return result.data;
  }

  const legacyCustom = validLegacyCustomConnection(env);
  if (!legacyCustom) return modelConfigurationSchema.parse(DEFAULT_CONFIGURATION);

  const withCustom = {
    ...DEFAULT_CONFIGURATION,
    connections: [...DEFAULT_CONFIGURATION.connections, legacyCustom.connection],
    profiles: [...DEFAULT_CONFIGURATION.profiles, legacyCustom.profile],
    policy: {
      ...DEFAULT_CONFIGURATION.policy,
      userChoice: {
        ...DEFAULT_CONFIGURATION.policy.userChoice,
        profileIds: [...DEFAULT_CONFIGURATION.policy.userChoice.profileIds, legacyCustom.profile.id],
      },
    },
  } satisfies z.input<typeof modelConfigurationBaseSchema>;
  return modelConfigurationSchema.parse(withCustom);
}

const BUILTIN_BASE_URLS = {
  groq: "https://api.groq.com/openai/v1",
  gwdg: "https://chat-ai.academiccloud.de/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;

export function resolveModelConnection(connection: ModelConnection): ResolvedModelConnection {
  switch (connection.provider) {
    case "groq":
      return { adapter: "groq", baseURL: BUILTIN_BASE_URLS.groq, api: "chat-completions" };
    case "gwdg":
      return { adapter: "openai-compatible", baseURL: BUILTIN_BASE_URLS.gwdg, api: "chat-completions" };
    case "deepinfra":
      return { adapter: "openai-compatible", baseURL: BUILTIN_BASE_URLS.deepinfra, api: "chat-completions" };
    case "openai":
      return { adapter: "openai", baseURL: BUILTIN_BASE_URLS.openai, api: connection.api ?? "responses" };
    case "anthropic":
      return { adapter: "anthropic", baseURL: BUILTIN_BASE_URLS.anthropic, api: "chat-completions" };
    case "custom":
      if (!isValidCustomEndpoint(connection.endpoint)) throw new Error("Invalid custom provider endpoint.");
      return {
        adapter: "openai-compatible",
        baseURL: connection.endpoint.replace(/\/+$/u, ""),
        api: "chat-completions",
      };
  }
}
