import { describe, expect, it } from "vitest";
import { parseGroqRateLimitDiagnostics } from "../src/lib/server/provider-rate-limits";

const NOW = new Date("2026-10-18T10:00:00.000Z");

describe("Groq rate-limit diagnostics", () => {
  it("parses bounded counters, a delta retry delay, and one fixed dimension", () => {
    const diagnostics = parseGroqRateLimitDiagnostics(
      new Headers({
        "x-ratelimit-limit-tokens": "12000",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": "999",
        "retry-after": "3",
        "x-provider-private-header": "must not escape",
      }),
      JSON.stringify({ error: { message: "Rate limit reached on tokens per minute (TPM)." } }),
      NOW,
    );

    expect(diagnostics).toEqual({
      tokenLimit: 12000,
      tokenRemaining: 0,
      requestLimit: 1000,
      requestRemaining: 999,
      retryAfterSeconds: 3,
      dimension: "TPM",
    });
  });

  it.each([
    ["tokens per minute", "TPM"],
    ["requests per minute (RPM)", "RPM"],
    ["tokens per day (TPD)", "TPD"],
    ["requests per day (RPD)", "RPD"],
  ] as const)("classifies the fixed %s phrase as %s", (message, dimension) => {
    expect(parseGroqRateLimitDiagnostics({}, JSON.stringify({ error: { message } }), NOW)).toEqual({ dimension });
  });

  it("keeps valid zero counters and rejects malformed, non-finite, negative, and over-bound counters", () => {
    const diagnostics = parseGroqRateLimitDiagnostics(new Headers({
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "01",
      "x-ratelimit-limit-requests": "-1",
      "x-ratelimit-remaining-requests": "1.5",
      "retry-after": "Infinity",
      "x-secret": "private-value",
    }), "not-json", NOW);

    expect(diagnostics).toEqual({ tokenLimit: 0 });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-value|Infinity|secret/u);
    expect(parseGroqRateLimitDiagnostics({ "x-ratelimit-limit-tokens": "1000000000001" }, undefined, NOW)).toEqual({});
  });

  it("clamps delta retry delays to one second through one day", () => {
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "0" }, undefined, NOW)).toEqual({ retryAfterSeconds: 1 });
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "86401" }, undefined, NOW)).toEqual({ retryAfterSeconds: 86400 });
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "1" }, undefined, NOW)).toEqual({ retryAfterSeconds: 1 });
  });

  it("parses canonical HTTP dates and clamps past and distant dates", () => {
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "Sun, 18 Oct 2026 10:00:11 GMT" }, undefined, NOW)).toEqual({ retryAfterSeconds: 11 });
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "Sun, 18 Oct 2026 09:59:59 GMT" }, undefined, NOW)).toEqual({ retryAfterSeconds: 1 });
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "Mon, 18 Oct 2026 10:00:11 GMT" }, undefined, NOW)).toEqual({});
    expect(parseGroqRateLimitDiagnostics({ "retry-after": "Mon, 18 Oct 2027 10:00:00 GMT" }, undefined, NOW)).toEqual({ retryAfterSeconds: 86400 });
  });

  it("drops ambiguous, malformed, oversized, and malicious error messages", () => {
    const maliciousBody = JSON.stringify({ error: { message: "Private token abc123; TPM and RPD both appear here." }, request_id: "private-id" });
    const ambiguous = parseGroqRateLimitDiagnostics({ "x-ratelimit-limit-tokens": "1", "x-secret": "secret-value" }, maliciousBody, NOW);
    const malformed = parseGroqRateLimitDiagnostics({}, JSON.stringify({ error: { message: { text: "TPM" } } }), NOW);
    const oversized = parseGroqRateLimitDiagnostics({}, JSON.stringify({ error: { message: `TPM ${"x".repeat(9_000)}` } }), NOW);

    expect(ambiguous).toEqual({ tokenLimit: 1 });
    expect(malformed).toEqual({});
    expect(oversized).toEqual({});
    expect(JSON.stringify({ ambiguous, malformed, oversized })).not.toMatch(/abc123|private-id|secret-value|TPM|RPD/u);
  });
});
