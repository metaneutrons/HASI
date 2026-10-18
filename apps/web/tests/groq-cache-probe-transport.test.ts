import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createGroqCacheProbeTransport,
  GROQ_CACHE_PROBE_ENDPOINT,
} from "../scripts/groq-cache-probe-transport";
import { runModelStep } from "../src/lib/server/model-router";

function response(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function createTransport(responses: Response[] = [response({ usage: {} })]) {
  let nextResponse = 0;
  const upstream = vi.fn<typeof fetch>(() => Promise.resolve(responses[nextResponse++] ?? response({ usage: {} })));
  const log = vi.fn<(event: unknown) => void>();
  return { transport: createGroqCacheProbeTransport(upstream, log), upstream, log };
}

function probeFetch(transportFetch: typeof globalThis.fetch, body = "{}") {
  return transportFetch(GROQ_CACHE_PROBE_ENDPOINT, {
    method: "POST",
    headers: { authorization: "Bearer private-test-credential", "x-private-header": "private-header-value" },
    body,
  });
}

describe("operator Groq cache probe transport", () => {
  const approvedBody = JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'Synthetic probe.' }], max_tokens: 64 });

  it('reserves before a live probe request and settles only explicit bounded usage', async () => {
    const settle = vi.fn(() => Promise.resolve());
    const reserve = vi.fn(() => Promise.resolve({ settle }));
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(response({ usage: { prompt_tokens: 12, completion_tokens: 3 } })));
    const transport = createGroqCacheProbeTransport(upstream, () => undefined, { reserve });
    await probeFetch(transport.fetch, approvedBody);
    expect(reserve).toHaveBeenCalledWith({ profileId: 'groq-oss-120b', inputTokens: Buffer.byteLength(approvedBody) + 4096, outputTokens: 64 });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(upstream.mock.invocationCallOrder[0] ?? 0);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 3 });
  });

  it('denies exhausted admission and unapproved requests before provider IO', async () => {
    const reserve = vi.fn(() => Promise.reject(new Error('budget exhausted')));
    const upstream = vi.fn<typeof fetch>();
    const transport = createGroqCacheProbeTransport(upstream, () => undefined, { reserve });
    await expect(probeFetch(transport.fetch, approvedBody)).rejects.toThrow('budget exhausted');
    await expect(probeFetch(transport.fetch, JSON.stringify({ model: 'unapproved', max_tokens: 64 }))).rejects.toThrow('Unapproved');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("pairs production HASI routing with observational transport and admits each request once", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const admissions: { input: { profileId: string; inputTokens: number; outputTokens: number }; settle: ReturnType<typeof vi.fn> }[] = [];
      const reserve = vi.fn((input: { profileId: string; inputTokens: number; outputTokens: number }) => {
        const settle = vi.fn(() => Promise.resolve());
        admissions.push({ input, settle });
        return Promise.resolve({ settle });
      });
      let upstreamCalls = 0;
      const upstream = vi.fn<typeof fetch>(() => Promise.resolve(++upstreamCalls === 1
        ? response({ error: { message: "synthetic malformed tool call", code: "tool_use_failed" } }, 400)
        : response({
          id: "chatcmpl-probe-test",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-oss-120b",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Synthetische Antwort." } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        })));
      const transport = createGroqCacheProbeTransport(upstream, () => undefined);

      await runModelStep({ profileId: "groq-oss-120b", messages: [{ role: "user", content: "Hallo." }] }, {
        env: { GROQ_API_KEY: "probe-test-key" },
        context: { dataClasses: ["synthetic_demo"], toolsRequired: true },
        budgetAdmission: { reserve },
        fetch: transport.fetch,
      });

      expect(reserve).toHaveBeenCalledTimes(2);
      expect(admissions.map(admission => admission.input.profileId)).toEqual(["groq-oss-120b", "groq-oss-120b"]);
      expect(admissions.every(admission => admission.input.outputTokens === 1_536)).toBe(true);
      expect(admissions[0]?.settle).toHaveBeenCalledExactlyOnceWith();
      expect(admissions[1]?.settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 3 });
      expect(upstream).toHaveBeenCalledTimes(2);
      for (const call of upstream.mock.calls) {
        expect(call).toEqual([GROQ_CACHE_PROBE_ENDPOINT, expect.objectContaining({ redirect: "error" })]);
      }
      const reserveOrders = reserve.mock.invocationCallOrder;
      const upstreamOrders = upstream.mock.invocationCallOrder;
      expect(reserveOrders[0]).toBeLessThan(upstreamOrders[0] ?? 0);
      expect(reserveOrders[1]).toBeLessThan(upstreamOrders[1] ?? 0);
      expect(transport.calls()).toBe(2);
    } finally { vi.unstubAllEnvs(); }
  });

  it("denies a production HASI probe before transport or upstream IO when admission fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const reserve = vi.fn(() => Promise.reject(Object.assign(new Error("synthetic exhausted"), { code: "exhausted" })));
      const upstream = vi.fn<typeof fetch>();
      const transport = createGroqCacheProbeTransport(upstream, () => undefined);

      await expect(runModelStep({ profileId: "groq-oss-120b", messages: [{ role: "user", content: "Hallo." }] }, {
        env: { GROQ_API_KEY: "probe-test-key" },
        context: { dataClasses: ["synthetic_demo"], toolsRequired: true },
        budgetAdmission: { reserve },
        fetch: transport.fetch,
      })).rejects.toMatchObject({ code: "budget_exhausted" });

      expect(reserve).toHaveBeenCalledTimes(1);
      expect(transport.calls()).toBe(0);
      expect(upstream).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([{}, { prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: 12, completion_tokens: 65 }])('retains a full hold for unusable successful usage %j', async usage => {
    const settle = vi.fn(() => Promise.resolve());
    const transport = createGroqCacheProbeTransport(() => Promise.resolve(response({ usage })), () => undefined, { reserve: () => Promise.resolve({ settle }) });
    await expect(probeFetch(transport.fetch, approvedBody)).rejects.toThrow('Probe usage');
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('retains an unknown hold after transport failure', async () => {
    const settle = vi.fn(() => Promise.resolve());
    const transport = createGroqCacheProbeTransport(() => Promise.reject(new Error('synthetic transport loss')), () => undefined, { reserve: () => Promise.resolve({ settle }) });
    await expect(probeFetch(transport.fetch, approvedBody)).rejects.toThrow('synthetic transport loss');
    expect(settle).toHaveBeenCalledExactlyOnceWith();
  });

  it('keeps the two-call boundary while concurrent admissions are pending', async () => {
    let allowAdmission: () => void = () => { throw new Error('Gate not initialized'); };
    const gate = new Promise<void>(resolve => { allowAdmission = resolve; });
    const reserve = vi.fn(async () => { await gate; return { settle: () => Promise.resolve() }; });
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(response({ usage: { prompt_tokens: 12, completion_tokens: 3 } })));
    const transport = createGroqCacheProbeTransport(upstream, () => undefined, { reserve });
    const first = probeFetch(transport.fetch, approvedBody);
    const second = probeFetch(transport.fetch, approvedBody);
    await expect(probeFetch(transport.fetch, approvedBody)).rejects.toThrow('Probe transport boundary');
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(upstream).not.toHaveBeenCalled();
    allowAdmission();
    await Promise.all([first, second]);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("records selected raw usage counters, keeps the response readable, and omits request and response details from logs", async () => {
    const privateRequest = "private-request-body-marker";
    const privateText = "private-response-text-marker";
    const upstreamResponse = response({
      choices: [{ message: { content: privateText } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 84 },
        cached_tokens: 7,
      },
    }, 200, { "x-private-response-header": "private-response-header-value" });
    const { transport, upstream, log } = createTransport([upstreamResponse]);

    const observedResponse = await probeFetch(transport.fetch, privateRequest);

    expect(observedResponse).toBe(upstreamResponse);
    expect(await observedResponse.json()).toMatchObject({
      choices: [{ message: { content: privateText } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 84 },
        cached_tokens: 7,
      },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: "raw_usage_observation",
      call: 1,
      status: 200,
      promptTokens: { state: "reported", value: 120 },
      completionTokens: { state: "reported", value: 9 },
      documentedCacheTokens: { state: "reported", value: 84 },
      alternateCacheTokens: { state: "reported", value: 7 },
    });
    const serializedLogs = JSON.stringify(log.mock.calls);
    for (const marker of [
      privateRequest,
      privateText,
      "private-test-credential",
      "private-header-value",
      "private-response-header-value",
    ]) {
      expect(serializedLogs).not.toContain(marker);
    }
    expect(serializedLogs).not.toMatch(/authorization|headers|requestbody|response-text/i);
  });

  it.each([
    ["explicit zero", 0, { state: "reported", value: 0 }],
    ["missing", undefined, { state: "missing" }],
    ["null", null, { state: "null" }],
    ["invalid", "0", { state: "invalid" }],
  ] as const)("distinguishes documented cached_tokens when %s", async (_label, cachedTokens, expected) => {
    const { transport, log } = createTransport([
      response({ usage: { prompt_tokens_details: { ...(cachedTokens === undefined ? {} : { cached_tokens: cachedTokens }) } } }),
    ]);

    await probeFetch(transport.fetch);

    expect(log.mock.calls[0]?.[0]).toMatchObject({ documentedCacheTokens: expected });
  });

  it("rejects an unknown endpoint, a non-string body, and a third request before another upstream call", async () => {
    const { transport, upstream } = createTransport();

    await expect(transport.fetch("https://example.test/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow("Probe transport boundary.");
    await expect(transport.fetch(GROQ_CACHE_PROBE_ENDPOINT, { method: "POST", body: new Uint8Array([123, 125]) })).rejects.toThrow("Probe transport boundary.");
    expect(upstream).not.toHaveBeenCalled();

    await probeFetch(transport.fetch, "first request");
    await probeFetch(transport.fetch, "second request");
    await expect(probeFetch(transport.fetch, "third request")).rejects.toThrow("Probe transport boundary.");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(transport.calls()).toBe(2);
  });

  it("compares the exact request pair and detects a changed body", async () => {
    const same = createTransport();
    await probeFetch(same.transport.fetch, "{\"model\":\"same\"}");
    await probeFetch(same.transport.fetch, "{\"model\":\"same\"}");
    expect(same.transport.comparison()).toMatchObject({ event: "request_comparison", calls: 2, identical: true });

    const changed = createTransport();
    await probeFetch(changed.transport.fetch, "{\"model\":\"first\"}");
    await probeFetch(changed.transport.fetch, "{\"model\":\"second\"}");
    const comparison = changed.transport.comparison();
    expect(comparison).toMatchObject({ event: "request_comparison", calls: 2, identical: false });
    expect(comparison.requestBytes[0]).not.toBe(comparison.requestBytes[1]);
    expect(comparison.syntheticRequestHashes[0]).not.toBe(comparison.syntheticRequestHashes[1]);
  });

  it("bounds response observation and reports invalid JSON without logging payloads", async () => {
    const privateOversizedBody = `private-response-marker${"x".repeat(65_537)}`;
    const { transport, log } = createTransport([
      response(privateOversizedBody),
      response("private-invalid-json-marker{"),
    ]);

    const oversized = await probeFetch(transport.fetch);
    const invalidJson = await probeFetch(transport.fetch);

    expect(oversized.status).toBe(200);
    expect(await oversized.text()).toBe(privateOversizedBody);
    expect(invalidJson.status).toBe(200);
    expect(await invalidJson.text()).toBe("private-invalid-json-marker{");
    expect(log.mock.calls[0]?.[0]).toEqual({ event: "raw_usage_observation", call: 1, status: 200, observation: "body_limit" });
    expect(log.mock.calls[1]?.[0]).toEqual({ event: "raw_usage_observation", call: 2, status: 200, observation: "invalid_json" });
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain("private-response-marker");
    expect(serializedLogs).not.toContain("private-invalid-json-marker");
  });
});
