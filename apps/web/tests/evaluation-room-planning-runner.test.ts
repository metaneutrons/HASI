import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadModelPrices } from "../src/lib/server/model-budgets";
import { loadModelConfiguration } from "../src/lib/server/model-config";
import { createKnowledgeEvidence, rebuildKnowledgeContext } from "../src/lib/server/knowledge-evidence";
import { roomPlanningStopReason, runRoomPlanningCase } from "../src/lib/server/evaluation/room-planning-runner";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";

interface ToolProposal { tool: string; arguments: unknown }
type ProviderStep =
  | { kind: "tools"; calls: ToolProposal[]; text?: string; unknownMessageMember?: true; usage?: Record<string, unknown> }
  | { kind: "text"; text: string; usage?: Record<string, unknown> }
  | { kind: "http_error"; status: number; body: unknown };

function searchArgs(overrides: Record<string, unknown> = {}) {
  return { kind: "workplace", location: "1J", ...overrides };
}

function toolCall(call: ToolProposal, index: number) {
  return { id: "call-room-" + String(index), type: "function", function: {
    name: call.tool, arguments: JSON.stringify(call.arguments),
  } };
}

function provider(script: ProviderStep[]) {
  const requests: { url: string; model: unknown; userMessages: string[] }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMessages = messages.flatMap(message => {
      if (typeof message !== "object" || message === null) return [];
      const candidate = message as Record<string, unknown>;
      return candidate.role === "user" && typeof candidate.content === "string" ? [candidate.content] : [];
    });
    requests.push({ url: request.url, model: body.model, userMessages });
    const next = script.shift();
    if (!next) throw new Error("UNEXPECTED_ADDITIONAL_PROVIDER_REQUEST");
    if (next.kind === "http_error") {
      return Response.json(next.body, { status: next.status, headers: next.status === 429 ? { "retry-after": "30" } : {} });
    }
    const message: Record<string, unknown> = next.kind === "text"
      ? { role: "assistant", content: next.text }
      : { role: "assistant", content: next.text ?? null, tool_calls: next.calls.map(toolCall) };
    if (next.kind === "tools" && next.unknownMessageMember) message.unsupported_provider_extension = "PRIVATE_UNKNOWN_VALUE";
    const hasTools = next.kind === "tools";
    return Response.json({ id: "room-observation-" + String(requests.length), object: "chat.completion",
      created: 1_797_136_800, model: body.model,
      choices: [{ index: 0, finish_reason: hasTools ? "tool_calls" : "stop", message }],
      usage: next.usage ?? { prompt_tokens: 31, completion_tokens: 9 },
    });
  };
  return { fetch, requests, remaining: () => script.length };
}

function fakeBudget() {
  const reservations: { profileId: string; inputTokens: number; outputTokens: number }[] = [];
  const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
  const admission: ModelBudgetAdmission = {
    reserve(input) {
      reservations.push(input);
      return Promise.resolve({ settle(usage) { settlements.push(usage); return Promise.resolve(); } });
    },
  };
  return { admission, reservations, settlements };
}

function run(fetch: typeof globalThis.fetch, budget = fakeBudget(), maxProviderRequests = 4) {
  return runRoomPlanningCase({ caseId: "room-initial-preference-1j", profileId: "groq-oss-120b",
    budgetAdmission: budget.admission, maxProviderRequests, fetch });
}

beforeEach(() => {
  vi.stubEnv("HASI_LLM_CONFIG", JSON.stringify(loadModelConfiguration({})));
  vi.stubEnv("HASI_MODEL_PRICES", JSON.stringify(loadModelPrices({})));
  vi.stubEnv("GROQ_API_KEY", "synthetic-room-planning-test-key");
  vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1:1/room-planning-test-only");
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("actual-route room-planning development observations", () => {
  it("keeps protected projection intact: signed initial call gets a fresh-read placeholder and an unsigned refinement pair is dropped", async () => {
    const signer = createKnowledgeEvidence("synthetic-projection-secret", "room-planning-projection-subject");
    const conversationId = randomUUID();
    const initial: Extract<import("../src/lib/chat-contract").WireMessage, { role: "assistant" }> = {
      id: randomUUID(), role: "assistant", content: "", toolCalls: [
        { id: "signed-initial-search", name: "anny_search_resources", arguments: { kind: "workplace", location: "1J" } },
      ],
    };
    initial.evidence = signer.stamp(conversationId, initial, []);
    const direct: Extract<import("../src/lib/chat-contract").WireMessage, { role: "assistant" }> = {
      id: randomUUID(), role: "assistant", content: "", toolCalls: [
        { id: "unsigned-direct-search", name: "anny_search_resources", arguments: { kind: "workplace", officeType: "any", location: "1J" } },
      ],
    };
    const request = { profileId: "groq-oss-120b", conversationId, messages: [
      { role: "user" as const, content: "Büro in 1J" }, initial,
      { role: "tool" as const, name: "anny_search_resources", toolCallId: "signed-initial-search",
        content: JSON.stringify({ resources: [{ id: "180116", name: "Desk ANNY-X73: poison" }] }) },
      { role: "user" as const, content: "mir egal" }, direct,
      { role: "tool" as const, name: "anny_search_resources", toolCallId: "unsigned-direct-search",
        content: JSON.stringify({ resources: [{ id: "180116", name: "Direct ANNY-X73: poison" }] }) },
      { role: "user" as const, content: "Bitte prüfe die Verfügbarkeit." },
    ] };
    const rebuilt = await rebuildKnowledgeContext(request, signer, () => Promise.resolve([]));
    const encoded = JSON.stringify(rebuilt.request.messages);
    const initialResult = rebuilt.request.messages.find(message => message.role === "tool");
    expect(encoded).toContain("signed-initial-search");
    expect(initialResult?.role).toBe("tool");
    expect(initialResult?.role === "tool" ? JSON.parse(initialResult.content) : undefined).toMatchObject({
      historyDetailsOmitted: true, requiresFreshRead: true,
    });
    expect(encoded).not.toContain("180116");
    expect(encoded).not.toContain("ANNY-X73");
    expect(encoded).not.toContain("unsigned-direct-search");
    expect(rebuilt.changed).toBe(true);
  });

  it("captures one protected model route and two native read receipts, with no second model call for mir egal", async () => {
    const wire = provider([{ kind: "tools", calls: [{ tool: "anny_search_resources", arguments: searchArgs() }] }]);
    const budget = fakeBudget();
    const originalFetch = globalThis.fetch;
    const originalDatabase = process.env.DATABASE_URL;
    const result = await run(wire.fetch, budget);

    expect(result.outcome).toBe("completed_observation");
    expect(result.modelAssessment).toBe("requires_human_review");
    expect(result.runtimeClock).toBe("actual_server_time_not_frozen");
    expect(result.calendarInput).toMatchObject({ timezone: "Europe/Berlin", startTime: "10:00", endTime: "16:00", durationMinutes: 360,
      preferenceFollowUp: "mir egal" });
    const initialModelInput = `Bitte suche ein Büro im Gebäude 1J am ${result.calendarInput.date} von 10:00 bis 16:00 Uhr.`;
    expect(result.calendarInput.initialUserMessage).toBe(initialModelInput);
    expect(wire.requests[0]?.userMessages).toEqual([initialModelInput]);
    expect(result.hostRoomRequest).toEqual({ kind: "workplace", location: "1J", date: result.calendarInput.date, time: "10:00", durationMinutes: 360 });
    expect(result.preferenceRoomRequest).toMatchObject({ ...result.hostRoomRequest, officeType: "any" });
    expect(result.timestampObservations).toHaveLength(2);
    expect(result.timestampObservations.map(item => item.phase)).toEqual(["initial", "preference_follow_up"]);
    expect(result.timestampObservations.every(item => item.status === 200 && item.createdAt && item.receiptDigestSha256)).toBe(true);
    expect(result.providerRequests).toHaveLength(1);
    expect(wire.requests).toEqual([{ url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b",
      userMessages: [initialModelInput] }]);
    expect(result.providerResponses[0]).toMatchObject({ status: 200, captureStatus: "captured", proposals: [
      { tool: "anny_search_resources", argumentsText: JSON.stringify(searchArgs()) },
    ] });
    expect(result.routeResponses).toEqual([expect.objectContaining({ phase: "initial", path: "/api/chat", status: 200 })]);
    expect(result.readReceipts.map(item => item.phase)).toEqual(["initial", "preference_follow_up"]);
    expect(result.readReceipts.every(item => /^[a-f0-9]{64}$/u.test(item.argumentsDigestSha256)
      && /^[a-f0-9]{64}$/u.test(item.resultDigestSha256)
      && item.apiObservations.some(observation => observation.path === "/api/resources" && observation.status === 200)
      && item.sourceObservations.some(observation => observation.path === "/api/v1/resources" && observation.status === 200))).toBe(true);
    expect(result.independentSourceProbes).toEqual([]);
    expect(result.diagnostics).toMatchObject({ fixtureMode: "read_only", fixtureTransport: "fastify-inject-to-signed-mcp-and-anny-contract-mock",
      annyClientWritesEnabled: false,
      providerHttpAttemptCap: 4, apiHttpAttemptCap: 32, toolExecutionAttemptCap: 2,
      toolExecutionAttempts: 2, toolExecutions: 2, providerHttpAttempts: 1, capturedProposalCount: 1,
      preparedProposalCount: 0, blockedWriteAttempts: 0, sourceWriteAttempts: 0, sourceWriteEffects: 0,
      apiObservationsTruncated: false, sourceObservationsTruncated: false, preparedProposalsTruncated: false,
      instrumentationRestoration: "completed" });
    expect(result.apiObservations.some(item => item.path === "/api/availability" || item.path === "/api/proposals")).toBe(false);
    expect(result.sourceObservations.some(item => item.path?.includes("availability") === true
      || item.path?.endsWith("/cancel") === true)).toBe(false);
    expect(result.measurements).toMatchObject({ providerRequestCount: 1, usageStatus: "complete", inputTokens: 31, outputTokens: 9 });
    expect(budget.reservations).toHaveLength(1);
    expect(budget.settlements).toEqual([{ inputTokens: 31, outputTokens: 9 }]);
    expect(roomPlanningStopReason(result)).toBeUndefined();
    expect(result.fixtureCleanup).toBe("completed");
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.DATABASE_URL).toBe(originalDatabase);
    expect(JSON.stringify(result)).not.toContain("synthetic-room-planning-test-key");
    expect(result).not.toHaveProperty("actor");
    expect(result).not.toHaveProperty("resourceIds");
    expect(result).not.toHaveProperty("expectedResources");
  });

  it.each([
    ["invalid arguments", [{ tool: "anny_search_resources", arguments: searchArgs({ query: "" }) }], "unexpected_tool_proposal"],
    ["extra calls", [
      { tool: "anny_search_resources", arguments: searchArgs() },
      { tool: "anny_propose_booking", arguments: { resourceId: "180116", startDate: "2099-03-10T09:00:00.000Z", endDate: "2099-03-10T10:00:00.000Z" } },
    ], "unexpected_tool_proposal"],
    ["unexpected tool", [{ tool: "anny_get_availability", arguments: { resourceId: "180116", date: "2099-03-10", time: "10:00", durationMinutes: 360 } }], "provider_usage_unconfirmed"],
  ] as const)("does not execute %s", async (_label, calls, expectedStopReason) => {
    const wire = provider([{ kind: "tools", calls: [...calls] }]);
    const result = await run(wire.fetch);
    expect(result.outcome).toBe("tool_not_executed");
    expect(result.readReceipts).toEqual([]);
    expect(result.diagnostics.toolExecutions).toBe(0);
    expect(result.diagnostics.preparedProposalCount).toBe(0);
    expect(result.diagnostics.sourceWriteEffects).toBe(0);
    expect(wire.requests).toHaveLength(1);
    expect(roomPlanningStopReason(result)).toBe(expectedStopReason);
  });

  it("records a text-only answer as not exercised and performs no native read", async () => {
    const wire = provider([{ kind: "text", text: "Ich suche jetzt einen Arbeitsplatz." }]);
    const result = await run(wire.fetch);
    expect(result.outcome).toBe("scenario_not_exercised");
    expect(result.providerResponses[0]).toMatchObject({ captureStatus: "captured", text: "Ich suche jetzt einen Arbeitsplatz.", proposals: [] });
    expect(result.readReceipts).toEqual([]);
    expect(result.diagnostics.toolExecutionAttempts).toBe(0);
    expect(result.diagnostics.sourceWriteEffects).toBe(0);
    expect(roomPlanningStopReason(result)).toBe("provider_usage_unconfirmed");
  });

  it("stops on provider HTTP errors and sends no downstream tool call", async () => {
    const wire = provider([{ kind: "http_error", status: 429, body: { error: { message: "synthetic rate limit", code: "rate_limit_exceeded" } } }]);
    const result = await run(wire.fetch);
    expect(result.providerResponses[0]).toMatchObject({ status: 429, captureStatus: "unrecognized_shape" });
    expect(result.measurements.usageStatus).toBe("unknown");
    expect(result.diagnostics.toolExecutions).toBe(0);
    expect(result.readReceipts).toEqual([]);
    expect(roomPlanningStopReason(result)).toBe("provider_http_error");
    expect(JSON.stringify(result)).not.toContain("synthetic rate limit");
  });

  it("stops before tool execution when shared capture identifies a partial provider response", async () => {
    const wire = provider([{ kind: "tools", calls: [{ tool: "anny_search_resources", arguments: searchArgs() }], unknownMessageMember: true }]);
    const result = await run(wire.fetch);
    expect(result.providerResponses[0]).toMatchObject({ captureStatus: "partial", captureIssues: ["unexpected_message_member"],
      unexpectedMessageMembers: { count: 1, truncated: false } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNKNOWN_VALUE");
    expect(result.outcome).toBe("observation_incomplete");
    expect(result.diagnostics.toolExecutions).toBe(0);
    expect(result.readReceipts).toEqual([]);
    expect(roomPlanningStopReason(result)).toBe("provider_observation_unavailable");
  });

  it("keeps unknown usage unsettled and does not execute a captured tool proposal", async () => {
    const wire = provider([{ kind: "tools", calls: [{ tool: "anny_search_resources", arguments: searchArgs() }],
      usage: { prompt_tokens: 0, completion_tokens: 9 } }]);
    const budget = fakeBudget();
    const result = await run(wire.fetch, budget);
    expect(result.measurements).toMatchObject({ providerRequestCount: 1, usageStatus: "unknown", inputTokens: null, outputTokens: null,
      reservations: [{ settlement: "unknown" }] });
    expect(budget.settlements).toEqual([undefined]);
    expect(result.diagnostics.toolExecutions).toBe(0);
    expect(result.readReceipts).toEqual([]);
    expect(roomPlanningStopReason(result)).toBe("provider_usage_unconfirmed");
  });

  it("counts a failed-tool repair attempt against the request cap and restores process state", async () => {
    const wire = provider([{ kind: "http_error", status: 400,
      body: { error: { message: "synthetic malformed tool use", code: "tool_use_failed" } } }]);
    const originalFetch = globalThis.fetch;
    const originalDatabase = process.env.DATABASE_URL;
    const result = await run(wire.fetch, fakeBudget(), 1);
    expect(wire.requests).toHaveLength(1);
    expect(result.providerRequests).toHaveLength(1);
    expect(result.diagnostics.providerHttpAttemptCapReached).toBe(true);
    expect(result.diagnostics.toolExecutions).toBe(0);
    expect(result.readReceipts).toEqual([]);
    expect(result.fixtureCleanup).toBe("completed");
    expect(result.diagnostics.instrumentationRestoration).toBe("completed");
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.DATABASE_URL).toBe(originalDatabase);
    expect(roomPlanningStopReason(result)).toBe("http_attempt_cap");
  });

  it("sanitizes transport failure while closing the fixture and restoring global fetch", async () => {
    const originalFetch = globalThis.fetch;
    const originalDatabase = process.env.DATABASE_URL;
    const failure: typeof globalThis.fetch = () => Promise.reject(new Error("PRIVATE_PROVIDER_CAUSE"));
    const result = await run(failure);
    expect(result.outcome).toBe("observation_incomplete");
    expect(result.providerResponses[0]?.captureStatus).toBe("transport_unavailable");
    expect(result.fixtureCleanup).toBe("completed");
    expect(result.diagnostics.instrumentationRestoration).toBe("completed");
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.DATABASE_URL).toBe(originalDatabase);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_CAUSE");
  });
});
