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

describe("Groq model router", () => {
  it("reports approved profiles without exposing a credential value", () => {
    expect(listModelProfiles({ GROQ_API_KEY: FAKE_KEY })).toEqual({
      configured: true,
      profiles: [
        {
          id: "groq-oss-120b",
          label: "Groq GPT-OSS 120B",
          modelId: "openai/gpt-oss-120b",
          provider: "groq",
        },
        {
          id: "groq-oss-20b",
          label: "Groq GPT-OSS 20B",
          modelId: "openai/gpt-oss-20b",
          provider: "groq",
        },
      ],
      defaultProfileId: "groq-oss-120b",
    });
    expect(JSON.stringify(listModelProfiles({ GROQ_API_KEY: FAKE_KEY }))).not.toContain(FAKE_KEY);
    expect(listModelProfiles({}).configured).toBe(false);
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
