import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";

vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/demo-runtime", () => ({ canonicalDemoRequest: vi.fn(), getDemoRuntime: vi.fn() }));

import {
  chatRequestSchema,
  modelReplySchema,
  type ChatRequest,
} from "../src/lib/chat-contract";
import { loadModelConfiguration } from "../src/lib/server/model-config";
import { createRoutingPins } from "../src/lib/server/routing-pins";

import {
  listModelProfiles,
  ModelRouterError,
  runModelStep,
} from "../src/lib/server/model-router";

const NOW = new Date("2026-10-16T09:30:00.000Z");
const FAKE_KEY = "test-groq-key-only";
const GWDG_FAKE_KEY = "test-gwdg-key-only";
const CUSTOM_FAKE_KEY = "test-custom-key-only";

it("requires an explicit host-owned context policy in production before provider I/O", async () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const provider = vi.fn<typeof fetch>();
    await expect(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider })).rejects.toMatchObject({ code: "profile_not_approved" });
    expect(provider).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

const providerMessageSchema = z.object({
  role: z.string(),
  content: z.unknown().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    name: z.string().optional(),
    function: z.object({ name: z.string() }).loose().optional(),
  }).loose()).optional(),
}).loose();
const providerToolSchema = z.object({
  name: z.string().optional(),
  function: z.object({ name: z.string() }).loose().optional(),
}).loose();
const providerRequestSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  reasoning_effort: z.string().optional(),
  parallel_tool_calls: z.boolean().optional(),
  store: z.boolean().optional(),
  messages: z.array(providerMessageSchema).optional(),
  tools: z.array(providerToolSchema).optional(),
}).loose();
type ProviderRequest = z.infer<typeof providerRequestSchema>;
type RouterOptions = NonNullable<Parameters<typeof runModelStep>[1]>;
type RouterTelemetry = NonNullable<RouterOptions["telemetry"]>;

function telemetrySpy() {
  return vi.fn<RouterTelemetry>();
}

function providerBodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new TypeError("Expected a serialized provider request");
  return init.body;
}

function providerRequest(init: RequestInit | undefined): ProviderRequest {
  return providerRequestSchema.parse(JSON.parse(providerBodyText(init)) as unknown);
}

function requiredMessages(body: ProviderRequest) {
  if (!body.messages) throw new TypeError("Expected provider messages");
  return body.messages;
}

function messageContent(body: ProviderRequest, index: number): string {
  const message = requiredValue(requiredMessages(body)[index], `provider message ${String(index)}`);
  if (typeof message.content !== "string") throw new TypeError("Expected textual provider message content");
  return message.content;
}

function requiredTools(body: ProviderRequest) {
  if (!body.tools) throw new TypeError("Expected provider tools");
  return body.tools;
}

function providerToolNames(body: ProviderRequest): string[] {
  return requiredTools(body).map((tool) => {
    const name = tool.function?.name ?? tool.name;
    if (!name) throw new TypeError("Expected a named provider tool");
    return name;
  });
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`Expected ${label}`);
  return value;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const calendarCases = [
  { now: '2026-10-16T22:30:00Z', today: '2026-10-17', tomorrow: '2026-10-18', after: '2026-10-19' },
  { now: '2026-10-24T22:30:00Z', today: '2026-10-25', tomorrow: '2026-10-26', after: '2026-10-27' },
  { now: '2026-12-31T23:30:00Z', today: '2027-01-01', tomorrow: '2027-01-02', after: '2027-01-03' },
];

function request(profileId: ChatRequest["profileId"] = "groq-oss-120b"): ChatRequest {
  return {
    profileId,
    messages: [{ role: "user", content: "Hallo." }],
  };
}

function pluginDescriptor(overrides: Partial<{
  pluginId: string;
  name: string;
  modelName: string;
  inputSchema: Record<string, unknown>;
}> = {}) {
  const pluginId = overrides.pluginId ?? "example.status";
  const name = overrides.name ?? "status.read";
  return {
    pluginId,
    name,
    title: "Systemstatus",
    description: "Liest einen freigegebenen Systemstatus.",
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 40 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    effect: "read" as const,
    requiredPermissions: ["status:read"],
    modelName: overrides.modelName ?? `hasi_${createHash("sha256").update(pluginId).update("\u0000").update(name).digest("hex").slice(0, 24)}`,
  };
}

function completion(options: {
  content?: string | null;
  finishReason?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  usage?: { prompt_tokens?: number | null; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number | null } | null };
} = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_797_136_800,
    model: "openai/gpt-oss-120b",
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? (options.toolCalls ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: options.content ?? null,
          ...(options.toolCalls
            ? {
                tool_calls: options.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    usage: options.usage ?? { prompt_tokens: 12, completion_tokens: 5 },
  };
}

function fakeProvider(body: unknown, status = 200, responseHeaders: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
      : input instanceof URL
        ? input.href
        : input.url;
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...responseHeaders },
    }));
  };
  return { fetch, calls };
}

function validCustomEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    CUSTOM_API_KEY: CUSTOM_FAKE_KEY,
    CUSTOM_ENDPOINT: "https://custom.example.test/api/v2/",
    CUSTOM_MODEL_ID: "custom-model-id",
    ...overrides,
  };
}

describe('server-owned Berlin calendar context', () => {
  for (const profileId of ['groq-oss-120b', 'gwdg-qwen3-30b', 'custom-default'] as const) {
    it.each(calendarCases)(`anchors relative dates for ${profileId} at $now`, async ({ now, today, tomorrow, after }) => {
      const provider = fakeProvider(completion({ content: 'Hallo.' }));
      await runModelStep(request(profileId), {
        env: { ...validCustomEnvironment(), GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY },
        fetch: provider.fetch,
        now: new Date(now),
      });
      const sent = providerRequest(provider.calls[0]?.init);
      const system = requiredMessages(sent).find(message => message.role === 'system')?.content;
      expect(system).toContain(`heute=${today}, morgen=${tomorrow}, übermorgen=${after}`);
      expect(system).toContain('Europe/Berlin, nicht das UTC-Kalenderdatum');
      expect(system).toContain('ältere Nachricht');
    });
  }
});

describe("verified per-message time context", () => {
  it("keeps an earlier user's tomorrow anchored to that message across Berlin midnight", async () => {
    const provider = fakeProvider(completion({ content: "Datum geprüft." }));
    const input: ChatRequest = { profileId: "groq-oss-120b", messages: [
      { role: "user", content: "Morgen einen Arbeitsplatz" },
      { role: "assistant", content: "Welches Büro?" },
      { role: "user", content: "Amrum, wie oben gewünscht." },
    ] };
    await runModelStep(input, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: new Date("2026-10-16T22:30:00Z"), messageTimes: ["2026-10-16T21:30:00.000Z", null, "2026-10-16T22:29:00.000Z"] });
    const sent = providerRequest(provider.calls[0]?.init);
    const sentMessages = requiredMessages(sent);
    expect(sentMessages[0]?.content).toContain('"position":1,"role":"user","serverReceivedAt":"2026-10-16T21:30:00.000Z"');
    expect(sentMessages[0]?.content).toContain('"today":"2026-10-16","tomorrow":"2026-10-17"');
    expect(sentMessages[0]?.content).toContain('"today":"2026-10-17","tomorrow":"2026-10-18"');
    expect(sentMessages[0]?.content).not.toContain('"position":2');
    expect(sentMessages.slice(1).map(message => message.content)).toEqual(input.messages.map(message => message.content));
  });

  it("does not promote raw client timestamp claims or forward receipts to the model", async () => {
    const provider = fakeProvider(completion({ content: "Datum unbekannt." }));
    const input = request();
    input.messages[0] = { ...requiredValue(input.messages[0], "first request message"), id: "ae93bd5b-49b1-40a9-8250-370d6c355fa7", timestamp: { createdAt: "2000-01-01T00:00:00.000Z", receipt: "A".repeat(43) } };
    await runModelStep(input, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
    const body = providerRequest(provider.calls[0]?.init);
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("2000-01-01");
    expect(bodyText).not.toContain("A".repeat(43));
    expect(requiredMessages(body)[0]?.content).toContain('"serverReceivedAt":null');
  });
});

async function expectRouterError(
  promise: Promise<unknown>,
  code: string,
): Promise<ModelRouterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelRouterError);
    expect(error).toMatchObject({ code });
    return error as ModelRouterError;
  }
  throw new Error("Expected the model router to reject the request.");
}

describe("per-attempt model budget admission", () => {
  function runAnthropicUsageCase(usage: Record<string, unknown>, settlements: unknown[]) {
    const config = loadModelConfiguration({});
    config.connections.push({ id: "anthropic-budget", label: "Anthropic budget test", provider: "anthropic", credentialRef: "env:ANTHROPIC_API_KEY" });
    config.profiles.push({ id: "anthropic-budget-model", label: "Anthropic budget test", connectionId: "anthropic-budget", modelId: "operator-selected-model", capabilities: { tools: true }, allowedDataClasses: ["synthetic_demo"], parameters: { temperature: null, maxOutputTokens: 1536, timeoutMs: 20000 } });
    config.policy.userChoice.profileIds.push("anthropic-budget-model");
    const provider = fakeProvider({
      id: "msg_usage_test",
      type: "message",
      role: "assistant",
      model: "operator-selected-model",
      content: [{ type: "text", text: "Usage checked." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
    const budgetAdmission: NonNullable<RouterOptions["budgetAdmission"]> = {
      reserve: () => Promise.resolve({ settle: value => { settlements.push(value); return Promise.resolve(); } }),
    };
    return {
      provider,
      run: () => runModelStep(request("anthropic-budget-model"), {
        env: { ANTHROPIC_API_KEY: "fake-anthropic-key", HASI_LLM_CONFIG: JSON.stringify(config) },
        fetch: provider.fetch,
        now: NOW,
        budgetAdmission,
      }),
    };
  }

  it("fails closed before provider I/O when the shared budget rejects reservation", async () => {
    const provider = fakeProvider(completion({ content: "must not run" }));
    const config = loadModelConfiguration({});
    config.policy.fallbacks = [{ from: "groq-oss-120b", targets: ["gwdg-qwen3-30b"], on: ["server_error", "timeout", "rate_limit"] }];
    const env = { GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY, HASI_LLM_CONFIG: JSON.stringify(config) };
    const input: ChatRequest = { profileId: "groq-oss-120b", messages: [{ id: "ae93bd5b-49b1-40a9-8250-370d6c355fa7", role: "user", content: "must not run" }] };
    const routingPins = createRoutingPins("test-only-routing-secret", "workspace:student", () => NOW);
    let reservations = 0;
    await expectRouterError(runModelStep(input, {
      env,
      fetch: provider.fetch,
      now: NOW,
      routingPins,
      budgetAdmission: { reserve: () => { reservations += 1; return Promise.reject(Object.assign(new Error("private ledger detail"), { code: "exhausted" })); } },
    }), "budget_exhausted");
    expect(reservations).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("reserves and settles each Groq regeneration attempt independently", async () => {
    const failed = fakeProvider({ error: { message: "bad tool", code: "tool_use_failed" } }, 400);
    const success = fakeProvider(completion({ content: "Erneut geprüft.", usage: { prompt_tokens: 1400, completion_tokens: 30 } }));
    const reserveInputs: { profileId: string; inputTokens: number; outputTokens: number }[] = [];
    const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[][] = [];
    const budgetAdmission: NonNullable<RouterOptions["budgetAdmission"]> = {
      reserve: input => {
        reserveInputs.push(input);
        const settled: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
        settlements.push(settled);
        return Promise.resolve({ settle: usage => { settled.push(usage); return Promise.resolve(); } });
      },
    };
    let count = 0;
    await runModelStep({ ...request(), messages: [{ role: "user", content: "Ich brauche morgen einen Raum." }] }, {
      env: { GROQ_API_KEY: FAKE_KEY },
      now: NOW,
      budgetAdmission,
      fetch: (input, init) => ++count === 1 ? failed.fetch(input, init) : success.fetch(input, init),
    });

    expect(reserveInputs).toHaveLength(2);
    expect(reserveInputs.map(({ profileId }) => profileId)).toEqual(["groq-oss-120b", "groq-oss-120b"]);
    expect(reserveInputs.every(({ inputTokens, outputTokens }) => inputTokens >= 4_096 && outputTokens === 1_536)).toBe(true);
    expect(settlements).toEqual([[undefined], [{ inputTokens: 1_400, outputTokens: 30 }]]);
  });

  it("reserves the fallback profile separately after settling a failed provider attempt", async () => {
    const config = loadModelConfiguration({});
    config.policy.fallbacks = [{ from: "groq-oss-120b", targets: ["gwdg-qwen3-30b"], on: ["server_error"] }];
    const env = { GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY, HASI_LLM_CONFIG: JSON.stringify(config) };
    const turnId = "ae93bd5b-49b1-40a9-8250-370d6c355fa7";
    const turn: ChatRequest = { profileId: "groq-oss-120b", messages: [{ id: turnId, role: "user", content: "Hallo." }] };
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = (url) => {
      calls.push(requestUrl(url));
      return Promise.resolve(calls.length === 1
        ? new Response(JSON.stringify({ error: { message: "temporary failure" } }), { status: 503, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(completion({ content: "Weitergeleitet.", usage: { prompt_tokens: 20, completion_tokens: 4 } })), { headers: { "content-type": "application/json" } }));
    };
    const reserveInputs: { profileId: string; inputTokens: number; outputTokens: number }[] = [];
    const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[][] = [];
    const budgetAdmission: NonNullable<RouterOptions["budgetAdmission"]> = {
      reserve: input => {
        reserveInputs.push(input);
        const settled: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
        settlements.push(settled);
        return Promise.resolve({ settle: usage => { settled.push(usage); return Promise.resolve(); } });
      },
    };
    const reply = await runModelStep(turn, {
      env,
      fetch,
      now: NOW,
      routingPins: createRoutingPins("test-only-routing-secret", "workspace:student", () => NOW),
      budgetAdmission,
    });

    expect(reply.profile.id).toBe("gwdg-qwen3-30b");
    expect(reserveInputs.map(({ profileId }) => profileId)).toEqual(["groq-oss-120b", "gwdg-qwen3-30b"]);
    expect(settlements).toEqual([[undefined], [{ inputTokens: 20, outputTokens: 4 }]]);
  });

  it("holds the full reservation when provider usage is missing and does not fall back", async () => {
    const provider = fakeProvider({ ...completion({ content: "Antwort ohne belastbare Nutzung." }), usage: undefined });
    const settlements: unknown[] = [];
    await expectRouterError(runModelStep(request(), {
      env: { GROQ_API_KEY: FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
      budgetAdmission: { reserve: () => Promise.resolve({ settle: usage => { settlements.push(usage); return Promise.resolve(); } }) },
    }), "budget_usage_invalid");
    expect(provider.calls).toHaveLength(1);
    expect(settlements).toEqual([undefined]);
  });

  it("keeps the full reservation when a nonempty model response reports zero input usage", async () => {
    const provider = fakeProvider(completion({
      content: "Eine erzeugte Antwort.",
      usage: { prompt_tokens: 0, completion_tokens: 30 },
    }));
    const settlements: unknown[] = [];

    await expectRouterError(runModelStep(request(), {
      env: { GROQ_API_KEY: FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
      budgetAdmission: {
        reserve: () => Promise.resolve({
          settle: usage => { settlements.push(usage); return Promise.resolve(); },
        }),
      },
    }), "budget_usage_invalid");

    expect(provider.calls).toHaveLength(1);
    expect(settlements).toEqual([undefined]);
  });

  it("includes Anthropic cache input in the bound and holds the reservation when that total exceeds it", async () => {
    const settlements: unknown[] = [];
    const { provider, run } = runAnthropicUsageCase({
      input_tokens: 12,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    }, settlements);

    await expectRouterError(run(), "budget_usage_invalid");

    expect(provider.calls).toHaveLength(1);
    expect(settlements).toEqual([undefined]);
  });

  it("accepts an Anthropic response with zero uncached input and positive cache input", async () => {
    const settlements: unknown[] = [];
    const { provider, run } = runAnthropicUsageCase({
      input_tokens: 0,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 300,
      output_tokens: 4,
    }, settlements);

    await run();

    expect(provider.calls).toHaveLength(1);
    expect(settlements).toEqual([{ inputTokens: 800, outputTokens: 4 }]);
  });

  it("holds the full reservation for malformed Anthropic cache counts", async () => {
    const settlements: unknown[] = [];
    const { provider, run } = runAnthropicUsageCase({
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: -1,
      output_tokens: 4,
    }, settlements);

    await expectRouterError(run(), "budget_usage_invalid");

    expect(provider.calls).toHaveLength(1);
    expect(settlements).toEqual([undefined]);
  });
});

describe("model router", () => {
  it("reports approved profiles without exposing a credential value", () => {
    expect(listModelProfiles({ GROQ_API_KEY: FAKE_KEY })).toEqual({
      configured: true,
      profiles: [
        {
          id: "groq-oss-120b",
          label: "Groq GPT-OSS 120B",
          modelId: "openai/gpt-oss-120b",
          provider: "groq",
          configured: true,
        },
        {
          id: "groq-oss-20b",
          label: "Groq GPT-OSS 20B",
          modelId: "openai/gpt-oss-20b",
          provider: "groq",
          configured: true,
        },
        {
          id: "groq-qwen-3.8-27b",
          label: "Groq Qwen3.8 27B · Preview",
          modelId: "qwen/qwen3.8-27b",
          provider: "groq",
          configured: true,
        },
        {
          id: "gwdg-qwen3-30b",
          label: "GWDG SAIA · Qwen3 30B A3B Instruct 2507 · Experimental",
          modelId: "qwen3-30b-a3b-instruct-2507",
          provider: "gwdg",
          configured: false,
        },
      ],
      defaultProfileId: "groq-oss-120b",
      userChoiceEnabled: true,
    });
    expect(JSON.stringify(listModelProfiles({ GROQ_API_KEY: FAKE_KEY }))).not.toContain(FAKE_KEY);
    expect(listModelProfiles({}).configured).toBe(false);
    const gwdgProfiles = listModelProfiles({ GWDG_API_KEY: GWDG_FAKE_KEY });
    expect(gwdgProfiles.configured).toBe(true);
    expect(gwdgProfiles.profiles.filter(({ provider }) => provider === "gwdg").every(({ configured }) => configured)).toBe(true);
    expect(gwdgProfiles.profiles.filter(({ provider }) => provider === "groq").every(({ configured }) => !configured)).toBe(true);
    expect(JSON.stringify(gwdgProfiles)).not.toContain(GWDG_FAKE_KEY);
  });

  it("rejects missing credentials before attempting a provider request", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };

    await expectRouterError(
      runModelStep(request(), { env: {}, fetch, now: NOW }),
      "missing_credentials",
    );
    expect(fetchCalled).toBe(false);
  });

  it("rejects a missing GWDG key without borrowing Groq credentials", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };
    await expectRouterError(runModelStep(request("gwdg-qwen3-30b"), { env: { GROQ_API_KEY: FAKE_KEY }, fetch, now: NOW }), "missing_credentials");
    expect(fetchCalled).toBe(false);
  });

  it("rejects an unapproved profile before resolving credentials or calling Groq", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };

    await expectRouterError(
      runModelStep(
        { ...request(), profileId: "openai-gpt-4" },
        { env: { GROQ_API_KEY: FAKE_KEY }, fetch, now: NOW },
      ),
      "profile_not_approved",
    );
    expect(fetchCalled).toBe(false);
  });

  it("sends one bounded request to the fixed Groq endpoint and returns typed usage", async () => {
    const provider = fakeProvider(
      completion({ content: "Guten Tag.", usage: { prompt_tokens: 17, completion_tokens: 4 } }),
    );

    const reply = await runModelStep(request(), {
      env: { GROQ_API_KEY: FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(provider.calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(provider.calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${FAKE_KEY}`,
    );
    const sentBody = providerRequest(provider.calls[0]?.init);
    expect(sentBody.model).toBe("openai/gpt-oss-120b");
    expect(sentBody.max_tokens).toBe(1536);
    expect(sentBody.parallel_tool_calls).toBe(false);
    expect(requiredMessages(sentBody)[0]?.role).toBe("system");
    expect(requiredMessages(sentBody)[0]?.content).toContain("Europe/Berlin");
    expect(providerToolNames(sentBody)).toEqual([
      "knowledge_search",
      "anny_search_resources",
      "anny_get_availability",
      "anny_list_my_bookings",
      "anny_propose_cancellation",
      "anny_propose_booking",
    ]);
    expect(reply).toEqual({
      message: { role: "assistant", content: "Guten Tag." },
      profile: {
        id: "groq-oss-120b",
        label: "Groq GPT-OSS 120B",
        modelId: "openai/gpt-oss-120b",
        provider: "groq",
      },
      usage: { inputTokens: 17, outputTokens: 4 },
    });
    expect(modelReplySchema.safeParse(reply).success).toBe(true);
  });

  it("returns validated tool calls without executing them", async () => {
    const provider = fakeProvider(
      completion({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_bookings_1",
            name: "anny_list_my_bookings",
            arguments: "{}",
          },
        ],
      }),
    );

    const reply = await runModelStep(request(), {
      env: { GROQ_API_KEY: FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
    });

    expect(provider.calls).toHaveLength(1);
    expect(reply.message).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_bookings_1",
          name: "anny_list_my_bookings",
          arguments: {},
        },
      ],
    });
  });

  it("exposes only server-authorized dynamic tools and returns their hash-bound calls for host execution", async () => {
    const descriptor = pluginDescriptor();
    const provider = fakeProvider(completion({
      finishReason: "tool_calls",
      toolCalls: [{ id: "plugin-call-1", name: descriptor.modelName, arguments: '{"query":"health"}' }],
    }));
    const reply = await runModelStep(request(), {
      env: { GROQ_API_KEY: FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
      authorizedTools: [descriptor],
    });

    expect(providerToolNames(providerRequest(provider.calls[0]?.init))).toContain(descriptor.modelName);
    expect(reply.message.toolCalls).toEqual([{ id: "plugin-call-1", name: descriptor.modelName, arguments: { query: "health" } }]);
    expect(providerBodyText(provider.calls[0]?.init)).not.toContain("/api/tools/call");
  });

  it("rejects forged dynamic names and arguments outside the authorized schema", async () => {
    const descriptor = pluginDescriptor();
    const forged = fakeProvider(completion({ toolCalls: [{ id: "forged-call", name: "hasi_aaaaaaaaaaaaaaaaaaaaaaaa", arguments: '{"query":"health"}' }] }));
    await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: forged.fetch, now: NOW, authorizedTools: [descriptor] }), "invalid_model_response");
    expect(providerToolNames(providerRequest(forged.calls[0]?.init))).not.toContain("hasi_aaaaaaaaaaaaaaaaaaaaaaaa");

    const invalidArgs = fakeProvider(completion({ toolCalls: [{ id: "invalid-args", name: descriptor.modelName, arguments: '{"query":"health","admin":true}' }] }));
    await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: invalidArgs.fetch, now: NOW, authorizedTools: [descriptor] }), "invalid_model_response");
  });

  it("regenerates a rejected room-search call once on the same model without replaying failed output", async () => {
    const failed = fakeProvider({ error: {
      message: `private provider message ${FAKE_KEY}`,
      code: "tool_use_failed",
      failed_generation: '{"name":"anny_search_resources","parameters":{"capacity":4,"query":""}}',
    }, usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 500 } } }, 400);
    const success = fakeProvider(completion({ toolCalls: [{ id: "room-1", name: "anny_search_resources", arguments: '{"capacity":4}' }], usage: { prompt_tokens: 1400, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } } }));
    const telemetry = telemetrySpy();
    let count = 0;
    const reply = await runModelStep({ ...request(), messages: [{ role: "user", content: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde." }] }, {
      env: { GROQ_API_KEY: FAKE_KEY }, now: NOW, telemetry,
      fetch: (input, init) => ++count === 1 ? failed.fetch(input, init) : success.fetch(input, init),
    });
    expect(count).toBe(2);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, inputTokens: 1400, cache: { readTokens: 1024, uncachedTokens: 376, readRatio: 1024 / 1400 } }));
    const initial = providerRequest(failed.calls[0]?.init);
    const retry = providerRequest(success.calls[0]?.init);
    expect(initial.model).toBe(retry.model);
    expect(initial.temperature).toBe(0.2);
    expect(retry.temperature).toBe(0);
    const initialMessages = requiredMessages(initial);
    const retryMessages = requiredMessages(retry);
    expect(retryMessages.slice(1)).toEqual(initialMessages.slice(1));
    expect(retryMessages[0]?.content).toContain("Generierungsversuch");
    expect(JSON.stringify(retryMessages)).not.toMatch(/private provider|parameters/);
    expect(reply.message.toolCalls).toEqual([{ id: "room-1", name: "anny_search_resources", arguments: { capacity: 4 } }]);
  });

  it("bounds tool-generation retries and sanitizes the final error", async () => {
    const provider = fakeProvider({ error: { message: FAKE_KEY, code: "tool_use_failed" } }, 400);
    const error = await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW }), "provider_unavailable");
    expect(provider.calls).toHaveLength(2);
    expect(error.diagnostics?.providerCode).toBe("tool_use_failed");
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
  });

  it.each([400, 401, 429, 500])("does not regenerate for an unclassified HTTP %i failure", async (status) => {
    const provider = fakeProvider({ error: { message: "Do not retry me" } }, status);
    await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW }), status === 429 ? "provider_rate_limited" : "provider_unavailable");
    expect(provider.calls).toHaveLength(1);
  });

  it("uses Qwen-specific reasoning settings with the same tool contract", async () => {
    const provider = fakeProvider(completion({ toolCalls: [{ id: "qwen-room-1", name: "anny_search_resources", arguments: '{"capacity":4}' }] }));
    const reply = await runModelStep(request("groq-qwen-3.8-27b"), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
    const body = providerRequest(provider.calls[0]?.init);
    expect(body.model).toBe("qwen/qwen3.8-27b");
    expect(body.reasoning_effort).toBe("none");
    expect(requiredTools(body)).toHaveLength(6);
    expect(providerToolNames(body)).toContain("anny_propose_cancellation");
    expect(providerToolNames(body)).not.toContain("anny_execute_cancellation");
    expect(reply.profile.id).toBe("groq-qwen-3.8-27b");
  });

  it("uses the GWDG Qwen key and fixed SAIA endpoint without Groq request options", async () => {
    const provider = fakeProvider(completion({ content: "Antwort von SAIA." }));
    const reply = await runModelStep(request("gwdg-qwen3-30b"), {
      env: { GWDG_API_KEY: GWDG_FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://chat-ai.academiccloud.de/v1/chat/completions");
    expect(provider.calls[0]?.init?.redirect).toBe("error");
    const headers = new Headers(provider.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${GWDG_FAKE_KEY}`);
    expect(headers.get("authorization")).not.toContain(FAKE_KEY);
    const body = providerRequest(provider.calls[0]?.init);
    expect(body.model).toBe("qwen3-30b-a3b-instruct-2507");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(reply.profile).toMatchObject({ id: "gwdg-qwen3-30b", provider: "gwdg" });
    expect(reply.message.content).toBe("Antwort von SAIA.");
  });

  it("keeps GWDG bound to its own credential when Groq is also configured", async () => {
    const provider = fakeProvider(completion({ content: "GWDG only." }));
    await runModelStep(request("gwdg-qwen3-30b"), {
      env: { GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY },
      fetch: provider.fetch,
      now: NOW,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://chat-ai.academiccloud.de/v1/chat/completions");
    expect(new Headers(provider.calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${GWDG_FAKE_KEY}`);
  });

  it("round-trips GWDG knowledge and anny tool calls through the typed wire contract", async () => {
    const firstResponse = fakeProvider(completion({ toolCalls: [
      { id: "gwdg-knowledge-1", name: "knowledge_search", arguments: JSON.stringify({ query: "WLAN-Zugang Morgenstern-Lab" }) },
      { id: "gwdg-anny-1", name: "anny_search_resources", arguments: JSON.stringify({ capacity: 4 }) },
    ] }));
    const secondResponse = fakeProvider(completion({ content: "Beide Demoabfragen sind ausgewertet." }));
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    let count = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return (++count === 1 ? firstResponse : secondResponse).fetch(input, init);
    };

    const initial = await runModelStep(request("gwdg-qwen3-30b"), { env: { GWDG_API_KEY: GWDG_FAKE_KEY }, fetch, now: NOW });
    expect(initial.message.toolCalls).toEqual([
      { id: "gwdg-knowledge-1", name: "knowledge_search", arguments: { query: "WLAN-Zugang Morgenstern-Lab" } },
      { id: "gwdg-anny-1", name: "anny_search_resources", arguments: { capacity: 4 } },
    ]);
    const toolCalls = initial.message.toolCalls;
    if (!toolCalls) throw new Error("Expected GWDG tool calls.");
    const knowledgeCall = requiredValue(toolCalls[0], "knowledge search call");
    const resourceCall = requiredValue(toolCalls[1], "resource search call");
    const followUp = await runModelStep({
      profileId: "gwdg-qwen3-30b",
      messages: [
        { role: "user", content: "Suche Wissen und einen Raum." },
        initial.message,
        { role: "tool", toolCallId: knowledgeCall.id, name: knowledgeCall.name, content: JSON.stringify({ documents: [] }) },
        { role: "tool", toolCallId: resourceCall.id, name: resourceCall.name, content: JSON.stringify({ resources: [] }) },
        { role: "user", content: "Fasse die Ergebnisse zusammen." },
      ],
    }, { env: { GWDG_API_KEY: GWDG_FAKE_KEY }, fetch, now: NOW });

    const body = providerRequest(calls[1]?.init);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://chat-ai.academiccloud.de/v1/chat/completions",
      "https://chat-ai.academiccloud.de/v1/chat/completions",
    ]);
    expect(requiredMessages(body).find(({ role }) => role === "assistant")?.tool_calls?.map((call) => call.function?.name ?? call.name)).toEqual(["knowledge_search", "anny_search_resources"]);
    expect(requiredMessages(body).filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id)).toEqual(["gwdg-knowledge-1", "gwdg-anny-1"]);
    expect(requiredMessages(body).filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual(['{"documents":[]}', '{"resources":[],"requiresFreshRead":true}']);
    expect(followUp.message.content).toBe("Beide Demoabfragen sind ausgewertet.");
  });

  it("rejects GWDG redirects without following them and returns sanitized failures", async () => {
    const calls: { url: string; redirect?: RequestRedirect | undefined }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, redirect: init?.redirect });
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }));
    };
    const error = await expectRouterError(runModelStep(request("gwdg-qwen3-30b"), { env: { GWDG_API_KEY: GWDG_FAKE_KEY }, fetch, now: NOW }), "provider_unavailable");
    expect(error.message).toBe("The model service could not complete this request.");
    expect(JSON.stringify(error)).not.toContain(GWDG_FAKE_KEY);
    expect(calls).toEqual([{ url: "https://chat-ai.academiccloud.de/v1/chat/completions", redirect: "error" }]);

    const privatePayload = `Authorization: Bearer ${GWDG_FAKE_KEY}; provider response payload`;
    const failure = fakeProvider({ error: { message: privatePayload } }, 500);
    const httpError = await expectRouterError(runModelStep(request("gwdg-qwen3-30b"), {
      env: { GWDG_API_KEY: GWDG_FAKE_KEY },
      fetch: failure.fetch,
      now: NOW,
    }), "provider_unavailable");
    expect(httpError.message).toBe("The model service could not complete this request.");
    expect(JSON.stringify(httpError)).not.toContain(GWDG_FAKE_KEY);
    expect(JSON.stringify(httpError)).not.toContain("provider response payload");
  });

  it("does not allow client input to override profile connections or secret references", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };
    for (const profileId of ["groq-oss-120b", "gwdg-qwen3-30b", "custom-default"] as const) {
      for (const override of [
        { credentialRef: "env:GROQ_API_KEY" },
        { endpoint: "https://attacker.example/v1" },
        { baseURL: "https://attacker.example/v1" },
        { providerOrigin: "https://attacker.example" },
      ]) {
        await expectRouterError(runModelStep({
          ...request(profileId),
          ...override,
        }, {
          env: {
            GWDG_API_KEY: GWDG_FAKE_KEY,
            GROQ_API_KEY: FAKE_KEY,
            CUSTOM_API_KEY: CUSTOM_FAKE_KEY,
            CUSTOM_ENDPOINT: "https://custom.example.test/v1",
            CUSTOM_MODEL_ID: "custom-model",
          },
          fetch,
          now: NOW,
        }), "invalid_request");
      }
    }
    expect(fetchCalled).toBe(false);
  });

  it("exposes custom readiness without returning its endpoint or key", () => {
    const partial = listModelProfiles({
      CUSTOM_ENDPOINT: "https://custom.example.test/v1",
      CUSTOM_MODEL_ID: "custom-model-id",
    });
    expect(partial.configured).toBe(false);
    expect(partial.profiles.some((profile) => profile.id === "custom-default")).toBe(true);
    expect(partial.profiles.find((profile) => profile.id === "custom-default")).toMatchObject({
      label: "Custom · custom-model-id",
      modelId: "custom-model-id",
      provider: "custom",
      configured: false,
    });
    const configured = listModelProfiles(validCustomEnvironment());
    expect(configured.configured).toBe(true);
    expect(configured.profiles.find((profile) => profile.id === "custom-default")?.configured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(CUSTOM_FAKE_KEY);
    expect(JSON.stringify(configured)).not.toContain("custom.example.test");
  });

  it("uses only the custom key and pins the endpoint host and base path", async () => {
    const provider = fakeProvider(completion({ content: "Custom model response." }));
    const reply = await runModelStep(request("custom-default"), {
      env: validCustomEnvironment({
        GROQ_API_KEY: FAKE_KEY,
        GWDG_API_KEY: GWDG_FAKE_KEY,
        CUSTOM_ENDPOINT: "https://custom.example.test/api/v2///",
      }),
      fetch: provider.fetch,
      now: NOW,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://custom.example.test/api/v2/chat/completions");
    expect(provider.calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(provider.calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${CUSTOM_FAKE_KEY}`);
    expect(new Headers(provider.calls[0]?.init?.headers).get("authorization")).not.toContain(FAKE_KEY);
    expect(new Headers(provider.calls[0]?.init?.headers).get("authorization")).not.toContain(GWDG_FAKE_KEY);
    const body = providerRequest(provider.calls[0]?.init);
    expect(body.model).toBe("custom-model-id");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(reply.profile).toMatchObject({ id: "custom-default", modelId: "custom-model-id", provider: "custom" });
    expect(reply.message.content).toBe("Custom model response.");
  });

  it("does not borrow configured Groq or GWDG keys when custom credentials are missing", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };
    const env = validCustomEnvironment({ CUSTOM_API_KEY: undefined, GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY });
    const profiles = listModelProfiles(env);
    expect(profiles.configured).toBe(true);
    expect(profiles.profiles.find((profile) => profile.id === "custom-default")?.configured).toBe(false);
    await expectRouterError(runModelStep(request("custom-default"), { env, fetch, now: NOW }), "missing_credentials");
    expect(fetchCalled).toBe(false);
  });

  it("accepts the maximum custom model ID while keeping its display label bounded", async () => {
    const modelId = "m".repeat(128);
    const env = validCustomEnvironment({ CUSTOM_MODEL_ID: modelId });
    const profile = listModelProfiles(env).profiles.find((entry) => entry.id === "custom-default");
    expect(profile?.modelId).toBe(modelId);
    expect(profile?.label.length).toBeLessThanOrEqual(82);
    const provider = fakeProvider(completion({ content: "Ready." }));
    const reply = await runModelStep(request("custom-default"), { env, fetch: provider.fetch, now: NOW });
    expect(providerRequest(provider.calls[0]?.init).model).toBe(modelId);
    expect(reply.profile.label.length).toBeLessThanOrEqual(82);
  });

  it.each([
    "http://custom.example.test/v1",
    "https://user:password@custom.example.test/v1",
    "https://custom.example.test/v1?token=x",
    "https://custom.example.test/v1#fragment",
    "https://custom.example.test/v1?",
    "https://custom.example.test/v1#",
    "not a URL",
  ])("does not expose or call a custom connection with invalid endpoint %s", async (endpoint) => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };
    const env = validCustomEnvironment({ CUSTOM_ENDPOINT: endpoint });
    expect(listModelProfiles(env).profiles.some((profile) => profile.id === "custom-default")).toBe(false);
    await expectRouterError(runModelStep(request("custom-default"), { env, fetch, now: NOW }), "profile_not_approved");
    expect(fetchCalled).toBe(false);
  });

  it.each(["", "\ncustom-model", "x".repeat(129)])("does not expose or call a custom connection with invalid model ID %j", async (modelId) => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.reject(new Error("Network should not be called."));
    };
    const env = validCustomEnvironment({ CUSTOM_MODEL_ID: modelId });
    expect(listModelProfiles(env).profiles.some((profile) => profile.id === "custom-default")).toBe(false);
    await expectRouterError(runModelStep(request("custom-default"), { env, fetch, now: NOW }), "profile_not_approved");
    expect(fetchCalled).toBe(false);
  });

  it("round-trips custom knowledge and anny tool calls through the same validated contract", async () => {
    const firstResponse = fakeProvider(completion({ toolCalls: [
      { id: "custom-knowledge-1", name: "knowledge_search", arguments: JSON.stringify({ query: "WLAN-Zugang Morgenstern-Lab" }) },
      { id: "custom-anny-1", name: "anny_search_resources", arguments: JSON.stringify({ capacity: 4 }) },
    ] }));
    const secondResponse = fakeProvider(completion({ content: "Die custom tool responses wurden verarbeitet." }));
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    let count = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return (++count === 1 ? firstResponse : secondResponse).fetch(input, init);
    };
    const env = validCustomEnvironment();
    const initial = await runModelStep(request("custom-default"), { env, fetch, now: NOW });
    const toolCalls = initial.message.toolCalls;
    expect(toolCalls?.map(({ name }) => name)).toEqual(["knowledge_search", "anny_search_resources"]);
    if (!toolCalls) throw new Error("Expected custom tool calls.");
    const knowledgeCall = requiredValue(toolCalls[0], "knowledge search call");
    const resourceCall = requiredValue(toolCalls[1], "resource search call");
    const followUp = await runModelStep({
      profileId: "custom-default",
      messages: [
        { role: "user", content: "Suche Wissen und einen Raum." },
        initial.message,
        { role: "tool", toolCallId: knowledgeCall.id, name: knowledgeCall.name, content: JSON.stringify({ documents: [] }) },
        { role: "tool", toolCallId: resourceCall.id, name: resourceCall.name, content: JSON.stringify({ resources: [] }) },
        { role: "user", content: "Fasse die Ergebnisse zusammen." },
      ],
    }, { env, fetch, now: NOW });
    const body = providerRequest(calls[1]?.init);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://custom.example.test/api/v2/chat/completions",
      "https://custom.example.test/api/v2/chat/completions",
    ]);
    expect(requiredMessages(body).find(({ role }) => role === "assistant")?.tool_calls?.map((call) => call.function?.name ?? call.name)).toEqual(["knowledge_search", "anny_search_resources"]);
    expect(requiredMessages(body).filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id)).toEqual(["custom-knowledge-1", "custom-anny-1"]);
    expect(requiredMessages(body).filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual(['{"documents":[]}', '{"resources":[],"requiresFreshRead":true}']);
    expect(followUp.message.content).toBe("Die custom tool responses wurden verarbeitet.");
  });

  it("rejects custom redirects and sanitizes custom provider HTTP errors", async () => {
    const redirect = await expectRouterError(runModelStep(request("custom-default"), {
      env: validCustomEnvironment(),
      fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } })),
      now: NOW,
    }), "provider_unavailable");
    expect(redirect.message).toBe("The model service could not complete this request.");

    const privatePayload = `Authorization: Bearer ${CUSTOM_FAKE_KEY}; private server payload`;
    const failure = fakeProvider({ error: { message: privatePayload } }, 500);
    const error = await expectRouterError(runModelStep(request("custom-default"), { env: validCustomEnvironment(), fetch: failure.fetch, now: NOW }), "provider_unavailable");
    expect(error.message).toBe("The model service could not complete this request.");
    expect(JSON.stringify(error)).not.toContain(CUSTOM_FAKE_KEY);
    expect(JSON.stringify(error)).not.toContain("private server payload");
  });

  it("rejects model tool arguments that fail the strict schema", async () => {
    const provider = fakeProvider(
      completion({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_bad_search",
            name: "anny_search_resources",
            arguments: JSON.stringify({ capacity: 0, ignored: "extra" }),
          },
        ],
      }),
    );

    await expectRouterError(
      runModelStep(request(), {
        env: { GROQ_API_KEY: FAKE_KEY },
        fetch: provider.fetch,
        now: NOW,
      }),
      "invalid_model_response",
    );
  });

  it("rejects a redirect without following it", async () => {
    const calls: { url: string; redirect?: RequestRedirect | undefined }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, redirect: init?.redirect });
      return Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: "https://other.example/collect" },
      }));
    };

    const error = await expectRouterError(
      runModelStep(request(), {
        env: { GROQ_API_KEY: FAKE_KEY },
        fetch,
        now: NOW,
      }),
      "provider_unavailable",
    );
    expect(error.message).toBe("The model service could not complete this request.");
    expect(calls).toEqual([
      {
        url: "https://api.groq.com/openai/v1/chat/completions",
        redirect: "error",
      },
    ]);
  });

  it("sanitizes provider errors and never returns provider response details", async () => {
    const providerFailure = "provider stack includes secret test-groq-key-only";
    const provider = fakeProvider({ error: { message: providerFailure } }, 500);

    const error = await expectRouterError(
      runModelStep(request(), {
        env: { GROQ_API_KEY: FAKE_KEY },
        fetch: provider.fetch,
        now: NOW,
      }),
      "provider_unavailable",
    );
    expect(error.message).toBe("The model service could not complete this request.");
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain(providerFailure);
  });

  it("classifies Groq rate limits without retaining provider payloads", async () => {
    const provider = fakeProvider({ error: { message: `private quota payload ${FAKE_KEY}` } }, 429);
    const error = await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW }), "provider_rate_limited");
    expect(error.providerStatus).toBe(429);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects orphan, duplicate, mismatched, and incomplete tool-result sequences", () => {
    const call = {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: "anny_list_my_bookings" as const,
          arguments: {},
        },
      ],
    };

    expect(
      chatRequestSchema.safeParse({
        ...request(),
        messages: [...request().messages, { role: "tool", toolCallId: "orphan", name: "anny_list_my_bookings", content: "[]" }],
      }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({ ...request(), messages: [...request().messages, call] }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        ...request(),
        messages: [
          ...request().messages,
          call,
          {
            role: "tool",
            toolCallId: "call_1",
            name: "anny_search_resources",
            content: "[]",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        ...request(),
        messages: [
          ...request().messages,
          call,
          {
            role: "tool",
            toolCallId: "call_1",
            name: "anny_list_my_bookings",
            content: "[]",
          },
          {
            role: "tool",
            toolCallId: "call_1",
            name: "anny_list_my_bookings",
            content: "[]",
          },
        ],
      }).success,
    ).toBe(false);
  });
});


describe("operator routing policy", () => {
  const turnId = "ae93bd5b-49b1-40a9-8250-370d6c355fa7";
  const pins = () => createRoutingPins("test-only-routing-secret", "workspace:student", () => NOW);
  const input = (): ChatRequest => ({ profileId: "groq-oss-120b", messages: [{ id: turnId, role: "user", content: "Suche einen Besprechungsraum" }] });
  function environment(change: (config: ReturnType<typeof loadModelConfiguration>) => void) {
    const config = loadModelConfiguration({});
    config.policy.fallbacks = [{ from: "groq-oss-120b", targets: ["gwdg-qwen3-30b"], on: ["rate_limit", "server_error", "timeout"] }];
    change(config);
    return { GROQ_API_KEY: FAKE_KEY, GWDG_API_KEY: GWDG_FAKE_KEY, HASI_LLM_CONFIG: JSON.stringify(config) };
  }

  it("enforces disabled end-user choice even with a configured alternate key", async () => {
    const env = environment(config => { config.policy.userChoice.enabled = false; });
    const provider = fakeProvider(completion({ content: "unused" }));
    expect(listModelProfiles(env).profiles.map(profile => profile.id)).toEqual(["groq-oss-120b"]);
    expect(listModelProfiles(env).userChoiceEnabled).toBe(false);
    await expectRouterError(runModelStep({ ...input(), profileId: "gwdg-qwen3-30b" }, { env, fetch: provider.fetch, now: NOW }), "profile_not_approved");
    expect(provider.calls).toHaveLength(0);
  });

  it.each([429, 503])("falls back after HTTP %i and pins the actual model through a tool turn", async status => {
    const env = environment(config => { config.policy.userChoice.profileIds = ["groq-oss-120b"]; });
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = (url) => {
      calls.push(requestUrl(url));
      return Promise.resolve(calls.length === 1 ? new Response(JSON.stringify({ error: { message: "transient private detail" } }), { status, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(completion({ toolCalls: [{ id: "fallback-search", name: "anny_search_resources", arguments: '{"kind":"meeting_room"}' }] })), { headers: { "content-type": "application/json" } }));
    };
    const routingPins = pins();
    const telemetry = telemetrySpy();
    const first = await runModelStep(input(), { env, fetch, now: NOW, routingPins, telemetry });
    expect(telemetry.mock.calls.map(call => [call[0].outcome, call[0].profileId])).toEqual([["failure", "groq-oss-120b"], ["success", "gwdg-qwen3-30b"]]);
    expect(telemetry.mock.calls[0]?.[0].inputTokens).toBeUndefined();
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("transient private detail");
    expect(first.profile.id).toBe("gwdg-qwen3-30b");
    expect(first.routingToken).toBeTruthy();
    expect(calls).toEqual(["https://api.groq.com/openai/v1/chat/completions", "https://chat-ai.academiccloud.de/v1/chat/completions"]);
    const next: ChatRequest = { ...input(), routingToken: first.routingToken, messages: [...input().messages, first.message, { role: "tool", name: "anny_search_resources", toolCallId: "fallback-search", content: '{"resources":[]}' }] };
    const subsequent = fakeProvider(completion({ content: "Keine passenden Räume." }));
    const reply = await runModelStep(next, { env, fetch: subsequent.fetch, now: NOW, routingPins });
    expect(reply.profile.id).toBe("gwdg-qwen3-30b");
    expect(subsequent.calls.map(call => call.url)).toEqual(["https://chat-ai.academiccloud.de/v1/chat/completions"]);
    expect(providerBodyText(subsequent.calls[0]?.init)).not.toContain(first.routingToken);
    await expectRouterError(runModelStep({ ...next, messages: [{ ...requiredValue(input().messages[0], "first request message"), content: "changed task" }] }, { env, fetch: subsequent.fetch, now: NOW, routingPins }), "profile_not_approved");
    expect(subsequent.calls).toHaveLength(1);
  });

  it("skips an ineligible sibling and follows the eligible nested fallback within the attempt budget", async () => {
    const env = environment(config => {
      config.policy.userChoice.profileIds = ["groq-oss-120b"];
      config.policy.maxAttempts = 3;
      const ineligible = config.profiles.find(profile => profile.id === "groq-qwen-3.8-27b");
      if (!ineligible) throw new Error("Expected the Qwen sibling profile");
      ineligible.capabilities.tools = false;
      config.policy.fallbacks = [
        {
          from: "groq-oss-120b",
          targets: ["gwdg-qwen3-30b", "groq-qwen-3.8-27b"],
          on: ["rate_limit", "server_error"],
        },
        { from: "gwdg-qwen3-30b", targets: ["groq-oss-20b"], on: ["server_error"] },
      ];
    });
    const calls: { url: string; model: string }[] = [];
    const fetch: typeof globalThis.fetch = (url, init) => {
      const body = providerRequest(init);
      calls.push({ url: requestUrl(url), model: requiredValue(body.model, "provider model") });
      if (calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "transient A failure" } }), { status: 429, headers: { "content-type": "application/json" } }));
      }
      if (calls.length === 2) {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "transient B failure" } }), { status: 503, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify(completion({ content: "D succeeded." })), { headers: { "content-type": "application/json" } }));
    };
    const routingPins = pins();
    const turn = input();
    const reply = await runModelStep(turn, { env, fetch, now: NOW, routingPins });

    expect(reply.profile.id).toBe("groq-oss-20b");
    expect(calls).toEqual([
      { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
      { url: "https://chat-ai.academiccloud.de/v1/chat/completions", model: "qwen3-30b-a3b-instruct-2507" },
      { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-20b" },
    ]);
    const user = turn.messages.find(message => message.role === "user");
    if (!user) throw new Error("Expected a user message in the test turn");
    const config = loadModelConfiguration(env);
    const routingToken = reply.routingToken;
    if (!routingToken) throw new Error("Expected a routing token from fallback");
    expect(routingPins.verify(routingToken, {
      turnId,
      turnHash: createHash("sha256").update(JSON.stringify([turnId, user.content])).digest("hex"),
      revision: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      requestedProfileId: "groq-oss-120b",
    })).toMatchObject({
      actualProfileId: "groq-oss-20b",
      attemptedProfileIds: ["groq-oss-120b", "gwdg-qwen3-30b", "groq-oss-20b"],
    });
  });

  it.each([400, 401, 403])("never falls back for HTTP %i or reruns an external action", async status => {
    const env = environment(() => undefined);
    const provider = fakeProvider({ error: { message: "private authentication detail" } }, status);
    await expectRouterError(runModelStep(input(), { env, fetch: provider.fetch, now: NOW, routingPins: pins() }), "provider_unavailable");
    expect(provider.calls).toHaveLength(1);
  });

  it.each(["missing-key", "data-policy", "tool-capability", "no-rule"] as const)("does not contact an ineligible fallback: %s", async reason => {
    const env = environment(config => {
      const target = config.profiles.find(profile => profile.id === "gwdg-qwen3-30b");
      if (!target) throw new Error("Expected the GWDG profile");
      if (reason === "data-policy") target.allowedDataClasses = ["internal"];
      if (reason === "tool-capability") target.capabilities.tools = false;
      if (reason === "no-rule") config.policy.fallbacks = [];
    });
    if (reason === "missing-key") env.GWDG_API_KEY = "";
    const provider = fakeProvider({ error: { message: "rate limited" } }, 429);
    await expectRouterError(runModelStep(input(), { env, fetch: provider.fetch, now: NOW, routingPins: pins() }), "provider_rate_limited");
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects disallowed classes across the full outgoing context before any provider fetch", async () => {
    const env = environment(() => undefined);
    const provider = fakeProvider(completion({ content: "unused" }));
    await expectRouterError(runModelStep(input(), {
      env,
      fetch: provider.fetch,
      now: NOW,
      context: { dataClasses: ["synthetic_demo", "confidential"], toolsRequired: true },
    }), "profile_not_approved");
    expect(provider.calls).toHaveLength(0);
  });

  it("counts Groq regeneration against the same budget before considering fallback", async () => {
    const env = environment(() => undefined);
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = url => {
      calls.push(requestUrl(url));
      const first = calls.length === 1;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "failed", ...(first ? { code: "tool_use_failed" } : {}) } }), { status: first ? 400 : 429, headers: { "content-type": "application/json" } }));
    };
    await expectRouterError(runModelStep(input(), { env, fetch, now: NOW, routingPins: pins() }), "provider_rate_limited");
    expect(calls).toHaveLength(2);
    expect(calls.every(url => url.startsWith("https://api.groq.com/"))).toBe(true);
  });

  it("falls back for an explicit transport timeout, with no external tool execution", async () => {
    const env = environment(() => undefined);
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = url => {
      calls.push(requestUrl(url));
      if (calls.length === 1) return Promise.reject(new DOMException("test timeout", "TimeoutError"));
      return Promise.resolve(new Response(JSON.stringify(completion({ content: "Anfrage übernommen." })), { headers: { "content-type": "application/json" } }));
    };
    const reply = await runModelStep(input(), { env, fetch, now: NOW, routingPins: pins() });
    expect(reply.profile.id).toBe("gwdg-qwen3-30b");
    expect(calls).toHaveLength(2);
  });

  it("fails closed for invalid explicit configuration and forged routing tokens", async () => {
    const provider = fakeProvider(completion({ content: "unused" }));
    await expectRouterError(runModelStep(input(), { env: { GROQ_API_KEY: FAKE_KEY, HASI_LLM_CONFIG: '{"unsafe":"configuration"}' }, fetch: provider.fetch }), "configuration_invalid");
    await expectRouterError(runModelStep({ ...input(), routingToken: "forged" }, { env: environment(() => undefined), fetch: provider.fetch, routingPins: pins() }), "profile_not_approved");
    expect(provider.calls).toHaveLength(0);
  });
});


describe("standard provider adapters", () => {
  it.each(["openai-responses", "openai-chat", "anthropic"] as const)("validates native tool calls with %s", async adapter => {
    const config = loadModelConfiguration({});
    const provider = adapter === "anthropic" ? "anthropic" : "openai";
    const credentialRef = provider === "anthropic" ? "env:ANTHROPIC_API_KEY" : "env:OPENAI_API_KEY";
    config.connections.push({ id: "standard-test", label: "Standard test", provider, credentialRef, ...(provider === "openai" ? { api: adapter === "openai-chat" ? "chat-completions" as const : "responses" as const } : {}) });
    config.profiles.push({ id: "standard-model", label: "Operator model", connectionId: "standard-test", modelId: "operator-selected-model", capabilities: { tools: true }, allowedDataClasses: ["synthetic_demo"], parameters: { temperature: null, maxOutputTokens: 1536, timeoutMs: 20000 } });
    config.policy.userChoice.profileIds.push("standard-model");
    const output = adapter === "anthropic" ? { id: "msg_test", type: "message", role: "assistant", model: "operator-selected-model", content: [{ type: "tool_use", id: "toolu_test", name: "anny_search_resources", input: { kind: "meeting_room" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } }
      : adapter === "openai-chat" ? completion({ toolCalls: [{ id: "call_test", name: "anny_search_resources", arguments: '{"kind":"meeting_room"}' }] })
      : { id: "resp_test", object: "response", created_at: 1792188900, status: "completed", model: "operator-selected-model", output: [{ type: "function_call", id: "fc_test", call_id: "call_test", name: "anny_search_resources", arguments: '{"kind":"meeting_room"}', status: "completed" }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, error: null, incomplete_details: null };
    const upstream = fakeProvider(output);
    const reply = await runModelStep(request("standard-model"), { env: { OPENAI_API_KEY: "fake-openai-key", ANTHROPIC_API_KEY: "fake-anthropic-key", HASI_LLM_CONFIG: JSON.stringify(config) }, fetch: upstream.fetch, now: NOW });
    expect(reply.profile.provider).toBe(provider);
    expect(reply.message.toolCalls?.[0]).toMatchObject({ name: "anny_search_resources", arguments: { kind: "meeting_room" } });
    const expectedPath = adapter === "anthropic" ? "https://api.anthropic.com/v1/messages" : adapter === "openai-chat" ? "https://api.openai.com/v1/chat/completions" : "https://api.openai.com/v1/responses";
    expect(upstream.calls[0]?.url).toBe(expectedPath);
    const sent = providerRequest(upstream.calls[0]?.init);
    expect(sent.temperature).toBeUndefined();
    if (provider === "openai") expect(sent.store).toBe(false);
    expect(upstream.calls[0]?.init?.redirect).toBe("error");
    expect(JSON.stringify(sent)).not.toMatch(/fake-openai-key|fake-anthropic-key/);
    expect(JSON.stringify(sent)).toContain("Servergeprüfte Zeitmetadaten");
  });
});


describe("bounded provider context and usage", () => {
  it.each([0, 1024])("records Groq's explicit cache-read counter %s while preserving the existing chat reply contract", async (cachedTokens) => {
    const provider = fakeProvider(completion({ content: "Private answer.", usage: { prompt_tokens: 1400, completion_tokens: 30, prompt_tokens_details: { cached_tokens: cachedTokens } } }));
    const telemetry = telemetrySpy();
    const reply = await runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW, telemetry });
    const cache = { readTokens: cachedTokens, uncachedTokens: 1400 - cachedTokens, readRatio: cachedTokens / 1400 };
    expect(reply.usage).toEqual({ inputTokens: 1400, outputTokens: 30 });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1400, cache, attempts: 1 }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/Private answer|test-groq-key-only|prompt_tokens_details|authorization/iu);
  });
  it.each([
    { prompt_tokens: 1400, completion_tokens: 1 },
    { prompt_tokens: 1400, completion_tokens: 1, prompt_tokens_details: null },
    { prompt_tokens: 1400, completion_tokens: 1, prompt_tokens_details: { cached_tokens: null } },
    { completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 1400, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1401 } },
  ])("omits unreported or inconsistent Groq cache counters rather than inventing savings: %j", async (usage) => {
    const provider = fakeProvider(completion({ content: "Hallo.", usage }));
    const telemetry = telemetrySpy();
    const reply = await runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW, telemetry });
    expect(reply.usage).not.toHaveProperty("cache");
    expect(telemetry.mock.calls[0]?.[0].cache).toBeUndefined();
  });
  it("does not assume cache semantics for unqualified compatible adapters", async () => {
    const provider = fakeProvider(completion({ content: "Hallo.", usage: { prompt_tokens: 1400, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } } }));
    const telemetry = telemetrySpy();
    const reply = await runModelStep(request("custom-default"), { env: validCustomEnvironment(), fetch: provider.fetch, now: NOW, telemetry });
    expect(reply.usage).not.toHaveProperty("cache");
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry.mock.calls[0]?.[0].cache).toBeUndefined();
  });
  it("records only counts and allowlisted quota metadata while keeping the request bounded", async () => {
    const provider = fakeProvider(completion({ content: "Hallo.", usage: { prompt_tokens: 1400, completion_tokens: 30 } }), 200, { "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "6600", "x-private": FAKE_KEY });
    const telemetry = telemetrySpy();
    await runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW, telemetry });
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ profileId: "groq-oss-120b", attempts: 1, inputTokens: 1400, outputTokens: 30, rateLimits: { tokenLimit: 8000, tokenRemaining: 6600 } }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/test-groq-key-only|Hallo|authorization|x-private/iu);
    expect(new TextEncoder().encode(providerBodyText(provider.calls[0]?.init)).byteLength).toBeLessThan(12_500);
  });
  it("retains the upstream quota dimension and bounded wait without exposing provider text", async () => {
    const provider = fakeProvider({ error: { message: `Private ${FAKE_KEY} tokens per minute (TPM)`, code: "rate_limit_exceeded" } }, 429, { "retry-after": "7", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "0", "x-private": FAKE_KEY });
    const error = await expectRouterError(runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW }), "provider_rate_limited");
    expect(error.rateLimits).toEqual({ retryAfterSeconds: 7, tokenLimit: 8000, tokenRemaining: 0, dimension: "TPM" });
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(provider.calls).toHaveLength(1);
  });
  it("keeps the instruction prefix stable and user constraints intact across calendar changes", async () => {
    const first = fakeProvider(completion({ content: "Hallo." }));
    const second = fakeProvider(completion({ content: "Hallo." }));
    await runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: first.fetch, now: NOW });
    await runModelStep(request(), { env: { GROQ_API_KEY: FAKE_KEY }, fetch: second.fetch, now: new Date("2026-10-18T10:00:00Z") });
    const a = providerRequest(first.calls[0]?.init);
    const b = providerRequest(second.calls[0]?.init);
    expect(messageContent(a, 0).split("Die aktuelle Zeit ist")[0]).toBe(messageContent(b, 0).split("Die aktuelle Zeit ist")[0]);
    expect(requiredMessages(a)[1]?.content).toBe("Hallo.");
    expect(requiredMessages(b)[1]?.content).toBe("Hallo.");
  });
});


it.each([
  ["Ich suche einen Arbeitsplatz in Gebäude 1J.", ["anny_search_resources", "anny_get_availability", "anny_propose_booking"]],
  ["Zeige mir meine Buchungen", ["anny_list_my_bookings", "anny_propose_cancellation"]],
  ["Wie funktioniert WLAN?", ["knowledge_search"]],
  ["Suche Wissen und einen Raum", ["knowledge_search", "anny_search_resources", "anny_get_availability", "anny_list_my_bookings", "anny_propose_cancellation", "anny_propose_booking"]],
  ["Meine Reservierungen und VPN", ["knowledge_search", "anny_search_resources", "anny_get_availability", "anny_list_my_bookings", "anny_propose_cancellation", "anny_propose_booking"]],
])("advertises only needed tools for a clear task and preserves mixed tasks: %s", async (text, names) => {
  const provider = fakeProvider(completion({ content: "Bereit." }));
  await runModelStep({ ...request(), messages: [{ role: "user", content: text }] }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
  const body = providerRequest(provider.calls[0]?.init);
  expect(providerToolNames(body)).toEqual(names);
  if (text.startsWith("Ich suche")) expect(new TextEncoder().encode(providerBodyText(provider.calls[0]?.init)).byteLength).toBeLessThan(10_000);
});

it("rejects an unadvertised tool without invoking any action", async () => {
  const provider = fakeProvider(completion({ toolCalls: [{ id: "unadvertised", name: "anny_propose_cancellation", arguments: '{"bookingId":"b1"}' }] }));
  await expectRouterError(runModelStep({ ...request(), messages: [{ role: "user", content: "Wie funktioniert WLAN?" }] }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW }), "invalid_model_response");
  expect(provider.calls).toHaveLength(1);
});


it("keeps room tools for a contextual availability/WLAN follow-up", async () => {
  const provider = fakeProvider(completion({ content: "Verfügbarkeit wird geprüft." }));
  const messages: ChatRequest["messages"] = [
    { role: "user", content: "Suche einen Arbeitsplatz in 1J" },
    { role: "assistant", content: "", toolCalls: [{ id: "room-context", name: "anny_search_resources", arguments: { kind: "workplace", location: "1J" } }] },
    { role: "tool", toolCallId: "room-context", name: "anny_search_resources", content: '{"resources":[]}' },
    { role: "user", content: "Ist es morgen frei und gibt es WLAN?" },
  ];
  await runModelStep({ ...request(), messages }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
  const sent = providerRequest(provider.calls[0]?.init);
  expect(providerToolNames(sent)).toContain("anny_get_availability");
  expect(providerToolNames(sent)).toContain("knowledge_search");
});

it("synthesizes a combined knowledge/room batch without advertising further tools", async () => {
  const provider = fakeProvider(completion({ content: "Belegte Demoantwort [demo:knowledge:service-it:001]." }));
  const messages: ChatRequest["messages"] = [
    { role: "user", content: "Suche Wissen und einen Raum" },
    { role: "assistant", content: "", toolCalls: [{ id: "k", name: "knowledge_search", arguments: { query: "WLAN" } }, { id: "r", name: "anny_search_resources", arguments: { capacity: 4 } }] },
    { role: "tool", toolCallId: "k", name: "knowledge_search", content: '{"documents":[{"citationId":"demo:knowledge:service-it:001","text":"Fiktive WLAN-Anleitung"}]}' },
    { role: "tool", toolCallId: "r", name: "anny_search_resources", content: '{"resources":[]}' },
  ];
  await runModelStep({ ...request(), messages }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
  const sent = providerRequest(provider.calls[0]?.init);
  expect(sent.tools ?? []).toEqual([]);
  expect(JSON.stringify(requiredMessages(sent))).toContain("Fiktive WLAN-Anleitung");
  expect(requiredMessages(sent)[0]?.content).toContain("Keine weiteren Tool-Aufrufe");
});


it.each([true, false])("preserves a sequential mixed task and stops repeated retrieval (knowledge first: %s)", async knowledgeFirst => {
  const firstName = knowledgeFirst ? "knowledge_search" as const : "anny_search_resources" as const;
  const secondName = knowledgeFirst ? "anny_search_resources" as const : "knowledge_search" as const;
  const firstArgs = knowledgeFirst ? { query: "WLAN" } : { capacity: 4 };
  const secondArgs = knowledgeFirst ? { capacity: 4 } : { query: "WLAN" };
  const messages: ChatRequest["messages"] = [
    { role: "user", content: "Suche Wissen und einen Raum" },
    { role: "assistant", content: "", toolCalls: [{ id: "first-goal", name: firstName, arguments: firstArgs }] },
    { role: "tool", toolCallId: "first-goal", name: firstName, content: JSON.stringify(knowledgeFirst ? { documents: [] } : { resources: [] }) },
  ];
  const secondProvider = fakeProvider(completion({ toolCalls: [{ id: "second-goal", name: secondName, arguments: JSON.stringify(secondArgs) }] }));
  const planned = await runModelStep({ ...request(), messages }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: secondProvider.fetch, now: NOW });
  const sent = providerRequest(secondProvider.calls[0]?.init);
  const names = providerToolNames(sent);
  expect(names).toContain(secondName);
  expect(names).not.toContain(firstName);
  messages.push(planned.message, { role: "tool", toolCallId: "second-goal", name: secondName, content: JSON.stringify(knowledgeFirst ? { resources: [] } : { documents: [] }) });
  const finalProvider = fakeProvider(completion({ content: "Die Wissenssuche liefert keine Belege; Raumkarten stehen bereit." }));
  await runModelStep({ ...request(), messages }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: finalProvider.fetch, now: NOW });
  expect(providerRequest(finalProvider.calls[0]?.init).tools ?? []).toEqual([]);
});


it("does not carry unrelated Anny schemas into a new clear knowledge question", async () => {
  const provider = fakeProvider(completion({ content: "Ich suche in der Wissensbasis." }));
  await runModelStep({ ...request(), messages: [
    { role: "user", content: "Suche einen Raum" },
    { role: "assistant", content: "", toolCalls: [{ id: "old-room", name: "anny_search_resources", arguments: {} }] },
    { role: "tool", toolCallId: "old-room", name: "anny_search_resources", content: '{"resources":[]}' },
    { role: "user", content: "Wie funktioniert VPN?" },
  ] }, { env: { GROQ_API_KEY: FAKE_KEY }, fetch: provider.fetch, now: NOW });
  const sent = providerRequest(provider.calls[0]?.init);
  expect(providerToolNames(sent)).toEqual(["knowledge_search"]);
});
