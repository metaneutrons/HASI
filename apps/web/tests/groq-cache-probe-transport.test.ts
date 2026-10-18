import { describe, expect, it, vi } from "vitest";
import {
  createGroqCacheProbeTransport,
  GROQ_CACHE_PROBE_ENDPOINT,
} from "../scripts/groq-cache-probe-transport";

function response(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function createTransport(responses: Response[] = [response({ usage: {} })]) {
  let nextResponse = 0;
  const upstream = vi.fn<typeof fetch>(async () => responses[nextResponse++] ?? response({ usage: {} }));
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
