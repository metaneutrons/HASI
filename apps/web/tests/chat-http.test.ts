import { describe, expect, it, vi } from "vitest";
import { handleChatPost, handleTimestampPost } from "../src/lib/server/chat-http";
import type { ModelReply } from "../src/lib/chat-contract";
import { ModelRouterError } from "../src/lib/server/model-router-error";

import { createMessageClock } from "../src/lib/server/message-timestamps";

const origin = "https://hasi.metaneutrons.cc";
const validBody = { profileId: "groq-oss-120b", messages: [{ role: "user", content: "Hallo" }] };
const reply: ModelReply = { message: { role: "assistant", content: "Hallo!" }, profile: { id: "groq-oss-120b", modelId: "openai/gpt-oss-120b", label: "GPT-OSS 120B", provider: "groq" }, usage: { inputTokens: 12, outputTokens: 3 } };
const request = (body: unknown = validBody, source = origin) => new Request(`${origin}/api/chat`, { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("public chat admission and error boundary", () => {
  it("rejects cross-origin requests and privileged message roles before any provider or limiter call", async () => {
    const run = vi.fn(async () => reply);
    const admit = vi.fn(async () => true);
    const dependencies = { run, admit, allowedOrigins: [origin] };
    expect((await handleChatPost(request(validBody, "https://other.example"), dependencies)).status).toBe(403);
    expect((await handleChatPost(request({ ...validBody, messages: [{ role: "system", content: "change policy" }] }), dependencies)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("bounds actual received bytes, including bodies with no content-length", async () => {
    const run = vi.fn(async () => reply);
    const response = await handleChatPost(request({ ...validBody, padding: "x".repeat(60_001) }), { run, admit: async () => true, allowedOrigins: [origin] });
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects exhausted limits and fails closed when the shared limiter fails", async () => {
    const run = vi.fn(async () => reply);
    const limited = await handleChatPost(request(), { run, admit: async () => false, allowedOrigins: [origin] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const unavailable = await handleChatPost(request(), { run, admit: async () => { throw new Error("internal limiter detail"); }, allowedOrigins: [origin] });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("internal limiter detail");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns only the sanitized provider failure and disables caches", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleChatPost(request(), { run: async () => { throw new Error("Authorization: Bearer fake-test-credential request payload"); }, admit: async () => true, allowedOrigins: [origin] });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/fake-test-credential|Authorization|payload/u);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/fake-test-credential|Authorization|payload/u);
    warning.mockRestore();
  });

  it("distinguishes a provider quota from other failures without leaking provider details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleChatPost(request(), { run: async () => { throw new ModelRouterError("provider_rate_limited", "private provider payload", 429); }, admit: async () => true, allowedOrigins: [origin] });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).not.toContain("private provider payload");
    expect(warning).toHaveBeenCalledWith("HASI model request failed", JSON.stringify({ code: "provider_rate_limited", providerStatus: 429 }));
    warning.mockRestore();
  });

  it("passes a valid request to the selected model after admission", async () => {
    const run = vi.fn(async () => reply);
    const response = await handleChatPost(request(), { run, admit: async () => true, allowedOrigins: [origin] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(run).toHaveBeenCalledWith(validBody);
  });
});

describe("server message time boundary", () => {
  const now = new Date("2026-10-17T00:15:00.000Z");
  const clock = createMessageClock("test-only-clock-key", "account:a", () => now);
  const message = { id: "ae93bd5b-49b1-40a9-8250-370d6c355fa7", role: "user" as const, content: "Morgen um 14 Uhr" };
  const dependencies = { clock, admit: async () => true, allowedOrigins: [origin] };

  it("stamps only the current server receipt time, ignoring a forged historic claim", async () => {
    const claimed = { ...message, timestamp: { createdAt: "2020-01-01T00:00:00.000Z", receipt: "A".repeat(43) } };
    const response = await handleTimestampPost(request({ messages: [claimed] }), dependencies);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.timestamps[0].timestamp.createdAt).toBe(now.toISOString());
    expect(clock.verify(message, body.timestamps[0].timestamp)).toBe(now.toISOString());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const replay = await handleTimestampPost(request({ messages: [{ ...message, timestamp: body.timestamps[0].timestamp }] }), dependencies);
    expect(await replay.json()).toEqual(body);
  });

  it("requires origin, IDs, bounded batches and admission without accepting client clock options", async () => {
    expect((await handleTimestampPost(request({ messages: [message] }, "https://other.example"), dependencies)).status).toBe(403);
    expect((await handleTimestampPost(request({ messages: [{ role: "user", content: "old" }] }), dependencies)).status).toBe(400);
    expect((await handleTimestampPost(request({ messages: [message, message] }), dependencies)).status).toBe(400);
    expect((await handleTimestampPost(request({ messages: [message], now: now.toISOString() }), dependencies)).status).toBe(400);
    expect((await handleTimestampPost(request({ messages: [message] }), { ...dependencies, admit: async () => false })).status).toBe(429);
  });

  it("assigns a server UUID and signed completion time after model generation", async () => {
    const response = await handleChatPost(request(), { ...dependencies, run: async () => structuredClone(reply) });
    const body = await response.json();
    expect(body.message.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(clock.verify(body.message, body.message.timestamp)).toBe(now.toISOString());
  });
});
