import { describe, expect, it } from "vitest";
import { groqErrorDiagnostics } from "../src/lib/server/groq-error-diagnostics";

describe("safe Groq error diagnostics", () => {
  it("identifies invalid native tool arguments without returning their values or provider messages", () => {
    const body = JSON.stringify({ error: { code: "tool_use_failed", message: "Authorization: Bearer fake-private-value", failed_generation: '<function=anny_search_resources>{"capacity":4,"query":"","date":"private-date-value"}</function>' } });
    const result = groqErrorDiagnostics(body);
    expect(result).toMatchObject({ providerCode: "tool_use_failed", tool: "anny_search_resources", format: "tagged", argumentIssues: [{ code: "too_small", fields: ["query"] }, { code: "unrecognized_keys", fields: ["date"] }] });
    expect(JSON.stringify(result)).not.toMatch(/private|Authorization|Bearer|capacity.:4/);
  });
  it("does not echo unknown codes, tool names, malformed JSON or oversized payloads", () => {
    expect(groqErrorDiagnostics('{"error":{"code":"private-secret","failed_generation":"private-secret"}}')).toEqual({ format: "unknown" });
    expect(groqErrorDiagnostics("private-secret")).toEqual({});
    expect(groqErrorDiagnostics("x".repeat(64_001))).toEqual({});
  });
});
