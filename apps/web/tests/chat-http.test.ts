import { describe, expect, it, vi } from "vitest";
import { handleChatPost } from "../src/lib/server/chat-http";
import type { ModelReply } from "../src/lib/chat-contract";
import { ModelRouterError } from "../src/lib/server/model-router-error";

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
    expect(warning).toHaveBeenCalledWith("HASI model request failed", { code: "provider_rate_limited", providerStatus: 429 });
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
