import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  chatRequestSchema,
  modelReplySchema,
  type ChatRequest,
} from "../src/lib/chat-contract";
import {
  listModelProfiles,
  ModelRouterError,
  runModelStep,
} from "../src/lib/server/model-router";

const NOW = new Date("2026-10-16T09:30:00.000Z");
const FAKE_KEY = "test-groq-key-only";
const GWDG_FAKE_KEY = "test-gwdg-key-only";
const CUSTOM_FAKE_KEY = "test-custom-key-only";

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

function completion(options: {
  content?: string | null;
  finishReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
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

function fakeProvider(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
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
      const sent = JSON.parse(String(provider.calls[0]?.init?.body)) as { messages: { role: string; content: string }[] };
      const system = sent.messages.find(message => message.role === 'system')?.content;
      expect(system).toContain(`heute=${today}, morgen=${tomorrow}, übermorgen=${after}`);
      expect(system).toContain('Europe/Berlin, nicht das UTC-Kalenderdatum');
      expect(system).toContain('ältere Nachricht');
    });
  }
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
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
    };

    await expectRouterError(
      runModelStep(request(), { env: {}, fetch, now: NOW }),
      "missing_credentials",
    );
    expect(fetchCalled).toBe(false);
  });

  it("rejects a missing GWDG key without borrowing Groq credentials", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
    };
    await expectRouterError(runModelStep(request("gwdg-qwen3-30b"), { env: { GROQ_API_KEY: FAKE_KEY }, fetch, now: NOW }), "missing_credentials");
    expect(fetchCalled).toBe(false);
  });

  it("rejects an unapproved profile before resolving credentials or calling Groq", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
    };

    await expectRouterError(
      runModelStep(
        { ...request(), profileId: "openai-gpt-4" } as unknown as ChatRequest,
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
    const sentBody = JSON.parse(String(provider.calls[0]?.init?.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
      parallel_tool_calls: boolean;
    };
    expect(sentBody.model).toBe("openai/gpt-oss-120b");
    expect(sentBody.max_tokens).toBe(1536);
    expect(sentBody.parallel_tool_calls).toBe(false);
    expect(sentBody.messages[0]?.role).toBe("system");
    expect(sentBody.messages[0]?.content).toContain("Europe/Berlin");
    expect(sentBody.tools.map(({ function: definition }) => definition.name)).toEqual([
      "knowledge_search",
      "anny_search_resources",
      "anny_get_availability",
      "anny_list_my_bookings",
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

  it("regenerates a rejected room-search call once on the same model without replaying failed output", async () => {
    const failed = fakeProvider({ error: {
      message: `private provider message ${FAKE_KEY}`,
      code: "tool_use_failed",
      failed_generation: '{"name":"anny_search_resources","parameters":{"capacity":4,"query":""}}',
    } }, 400);
    const success = fakeProvider(completion({ toolCalls: [{ id: "room-1", name: "anny_search_resources", arguments: '{"capacity":4}' }] }));
    let count = 0;
    const reply = await runModelStep({ ...request(), messages: [{ role: "user", content: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde." }] }, {
      env: { GROQ_API_KEY: FAKE_KEY }, now: NOW,
      fetch: async (input, init) => ++count === 1 ? failed.fetch(input, init) : success.fetch(input, init),
    });
    expect(count).toBe(2);
    const initial = JSON.parse(String(failed.calls[0]?.init?.body));
    const retry = JSON.parse(String(success.calls[0]?.init?.body));
    expect(initial.model).toBe(retry.model);
    expect(initial.temperature).toBe(0.2);
    expect(retry.temperature).toBe(0);
    expect(retry.messages.slice(1)).toEqual(initial.messages.slice(1));
    expect(retry.messages[0].content).toContain("Generierungsversuch");
    expect(JSON.stringify(retry.messages)).not.toMatch(/private provider|parameters/);
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
    const body = JSON.parse(String(provider.calls[0]?.init?.body));
    expect(body.model).toBe("qwen/qwen3.8-27b");
    expect(body.reasoning_effort).toBe("none");
    expect(body.tools).toHaveLength(5);
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
    const body = JSON.parse(String(provider.calls[0]?.init?.body));
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
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let count = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
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
    const followUp = await runModelStep({
      profileId: "gwdg-qwen3-30b",
      messages: [
        { role: "user", content: "Suche Wissen und einen Raum." },
        initial.message,
        { role: "tool", toolCallId: toolCalls[0]!.id, name: toolCalls[0]!.name, content: JSON.stringify({ documents: [] }) },
        { role: "tool", toolCallId: toolCalls[1]!.id, name: toolCalls[1]!.name, content: JSON.stringify({ resources: [] }) },
        { role: "user", content: "Fasse die Ergebnisse zusammen." },
      ],
    }, { env: { GWDG_API_KEY: GWDG_FAKE_KEY }, fetch, now: NOW });

    const body = JSON.parse(String(calls[1]?.init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; content?: string; tool_calls?: Array<{ function: { name: string } }> }> };
    expect(calls.map(({ url }) => url)).toEqual([
      "https://chat-ai.academiccloud.de/v1/chat/completions",
      "https://chat-ai.academiccloud.de/v1/chat/completions",
    ]);
    expect(body.messages.find(({ role }) => role === "assistant")?.tool_calls?.map(({ function: definition }) => definition.name)).toEqual(["knowledge_search", "anny_search_resources"]);
    expect(body.messages.filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id)).toEqual(["gwdg-knowledge-1", "gwdg-anny-1"]);
    expect(body.messages.filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual(['{"documents":[]}', '{"resources":[]}']);
    expect(followUp.message.content).toBe("Beide Demoabfragen sind ausgewertet.");
  });

  it("rejects GWDG redirects without following them and returns sanitized failures", async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
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
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
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
        } as unknown as ChatRequest, {
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
    const body = JSON.parse(String(provider.calls[0]?.init?.body));
    expect(body.model).toBe("custom-model-id");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(reply.profile).toMatchObject({ id: "custom-default", modelId: "custom-model-id", provider: "custom" });
    expect(reply.message.content).toBe("Custom model response.");
  });

  it("does not borrow configured Groq or GWDG keys when custom credentials are missing", async () => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
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
    expect(JSON.parse(String(provider.calls[0]?.init?.body)).model).toBe(modelId);
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
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
    };
    const env = validCustomEnvironment({ CUSTOM_ENDPOINT: endpoint });
    expect(listModelProfiles(env).profiles.some((profile) => profile.id === "custom-default")).toBe(false);
    await expectRouterError(runModelStep(request("custom-default"), { env, fetch, now: NOW }), "profile_not_approved");
    expect(fetchCalled).toBe(false);
  });

  it.each(["", "\ncustom-model", "x".repeat(129)])("does not expose or call a custom connection with invalid model ID %j", async (modelId) => {
    let fetchCalled = false;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("Network should not be called.");
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
    const calls: Array<{ url: string; init?: RequestInit }> = [];
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
    const followUp = await runModelStep({
      profileId: "custom-default",
      messages: [
        { role: "user", content: "Suche Wissen und einen Raum." },
        initial.message,
        { role: "tool", toolCallId: toolCalls[0]!.id, name: toolCalls[0]!.name, content: JSON.stringify({ documents: [] }) },
        { role: "tool", toolCallId: toolCalls[1]!.id, name: toolCalls[1]!.name, content: JSON.stringify({ resources: [] }) },
        { role: "user", content: "Fasse die Ergebnisse zusammen." },
      ],
    }, { env, fetch, now: NOW });
    const body = JSON.parse(String(calls[1]?.init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; content?: string; tool_calls?: Array<{ function: { name: string } }> }> };
    expect(calls.map(({ url }) => url)).toEqual([
      "https://custom.example.test/api/v2/chat/completions",
      "https://custom.example.test/api/v2/chat/completions",
    ]);
    expect(body.messages.find(({ role }) => role === "assistant")?.tool_calls?.map(({ function: definition }) => definition.name)).toEqual(["knowledge_search", "anny_search_resources"]);
    expect(body.messages.filter(({ role }) => role === "tool").map(({ tool_call_id }) => tool_call_id)).toEqual(["custom-knowledge-1", "custom-anny-1"]);
    expect(body.messages.filter(({ role }) => role === "tool").map(({ content }) => content)).toEqual(['{"documents":[]}', '{"resources":[]}']);
    expect(followUp.message.content).toBe("Die custom tool responses wurden verarbeitet.");
  });

  it("rejects custom redirects and sanitizes custom provider HTTP errors", async () => {
    const redirect = await expectRouterError(runModelStep(request("custom-default"), {
      env: validCustomEnvironment(),
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } }),
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
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, redirect: init?.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example/collect" },
      });
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
