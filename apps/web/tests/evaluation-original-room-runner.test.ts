import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import { createOriginalRoomPlan, originalRoomCase } from "../src/lib/server/evaluation/original-room-plan";
import { originalRoomStopReason, runOriginalRoomCase } from "../src/lib/server/evaluation/original-room-runner";
import { loadModelConfiguration } from "../src/lib/server/model-config";
import { loadModelPrices } from "../src/lib/server/model-budgets";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";

const corpus = parseEvaluationDataset(JSON.parse(readFileSync(new URL("../../../docs/evaluation/example-cases.json", import.meta.url), "utf8")));
const fixtureCase = (id: string) => corpus.find(item => item.id === id);
const availability = { resourceId: "fixture-room-R104", date: "2026-10-27", time: "14:00", durationMinutes: 60 };
const proposal = { resourceId: "fixture-room-R104", startDate: "2026-10-27T14:00:00+01:00", endDate: "2026-10-27T15:00:00+01:00" };
type Step = string | { name: string; args: Record<string, unknown> }[] | Response;
function scripted(steps: Step[]) {
  const requests: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>; requests.push(body);
    const step = steps.shift();
    if (step === undefined) throw new Error("Unexpected additional provider request.");
    if (step instanceof Response) return step;
    const message = typeof step === "string" ? { role: "assistant", content: step } : {
      role: "assistant", content: null, tool_calls: step.map((call, index) => ({ id: `original-${String(requests.length)}-${String(index)}`,
        type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    };
    return Response.json({ id: "synthetic-original", object: "chat.completion", created: 1_797_136_800, model: body.model,
      choices: [{ index: 0, finish_reason: typeof step === "string" ? "stop" : "tool_calls", message }],
      usage: { prompt_tokens: 41, completion_tokens: 11 } });
  };
  return { transport, requests };
}
function budget() {
  const settlements: unknown[] = [];
  const reserve = vi.fn(() => Promise.resolve({ settle: (usage: unknown) => { settlements.push(usage); return Promise.resolve(); } }));
  const admission: ModelBudgetAdmission = { reserve };
  return { admission, reserve, settlements };
}
function run(id: string, steps: Step[], maxProviderRequests = 6) {
  const provider = scripted(steps); const ledger = budget();
  return { provider, ledger, result: runOriginalRoomCase(fixtureCase(id), {
    profileId: "groq-oss-120b", budgetAdmission: ledger.admission, maxProviderRequests, fetch: provider.transport,
  }) };
}

beforeEach(() => {
  vi.stubEnv("HASI_LLM_CONFIG", JSON.stringify(loadModelConfiguration({})));
  vi.stubEnv("HASI_MODEL_PRICES", JSON.stringify(loadModelPrices({})));
  vi.stubEnv("GROQ_API_KEY", "synthetic-original-provider-key");
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic@127.0.0.1:1/no-live-storage");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("pinned original room planning observations", () => {
  it("plans all five exact original cases without resolving credentials or budget", () => {
    const ids = ["anny-01", "anny-02", "anny-04", "anny-05", "inject-02"];
    const plan = createOriginalRoomPlan(corpus, ["groq-oss-120b"], ids, {});
    expect(plan.cases.map(item => item.definition.id)).toEqual(ids);
    const changed = structuredClone(fixtureCase("anny-02"));
    if (!changed) throw new Error("Missing case.");
    changed.userMessages.push("An altered case.");
    expect(() => originalRoomCase(changed)).toThrow(/exact registered/u);
    expect(() => createOriginalRoomPlan(corpus, ["groq-oss-120b"], ["anny-02", "anny-02"], {})).toThrow();
  });

  it.each(["anny-02", "inject-02"])("retains the full original evidence and prepares one exact native pending proposal for %s", async id => {
    const { provider, ledger, result: pending } = run(id, [
      [{ name: "anny_search_resources", args: { kind: "meeting_room", query: "Birke" } }],
      [{ name: "anny_get_availability", args: availability }],
      [{ name: "anny_propose_booking", args: proposal }],
    ]);
    const result = await pending;
    expect(result.outcome, JSON.stringify({ error: result.errorCode, stop: result.stopReason, attempts: result.attempts, replies: result.replies, usage: result.measurements.usageStatus })).toBe("completed_observation");
    expect(result.stopReason).toBe("native_pending_proposal");
    expect(result.nativeEffectsSafe).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ status: "pending", resourceId: availability.resourceId,
      startDate: "2026-10-27T13:00:00.000Z", endDate: "2026-10-27T14:00:00.000Z" });
    expect(result.diagnostics).toMatchObject({ mode: "proposal_only", baseExecuteEntitlement: true,
      accountPermissions: ["rooms:read", "rooms:prepare"], annyClientWritesEnabled: false, sourceWriteEffects: 0, sourceWriteAttempts: 0 });
    expect(result.nativeResults.map(item => item.tool)).toEqual(["anny_search_resources", "anny_get_availability", "anny_propose_booking"]);
    const payload = JSON.stringify(provider.requests[0]);
    const original = fixtureCase(id);
    if (!original) throw new Error("Missing original case.");
    expect(payload).toContain(new Date(original.clock.now).toISOString());
    const sourceMessages = provider.requests[0]?.messages as { role: string; content: string }[];
    const sourceMessage = sourceMessages.find(message => message.role === "tool");
    if (!sourceMessage) throw new Error("Missing original tool-role evidence.");
    const sourcePayload = JSON.parse(sourceMessage.content) as { documents: { text: string }[] };
    expect(sourcePayload.documents.map(document => document.text)).toEqual(result.input.evidence.map(evidence => evidence.text));
    expect(payload).not.toContain("toolFixtures");
    expect(payload).not.toContain("requiredAssertions");
    expect(JSON.stringify(result)).not.toContain("synthetic-original-provider-key");
    expect(result.measurements).toMatchObject({ providerRequestCount: 3, usageStatus: "complete", inputTokens: 123, outputTokens: 33 });
    expect(ledger.settlements).toHaveLength(3);
    expect(result.fixtureCleanup).toBe("completed");
    expect(originalRoomStopReason(result)).toBeUndefined();
  });

  it.each(["anny-01", "anny-04", "anny-05"])("allows clarification without native time effects for %s", async id => {
    const { result: pending } = run(id, [[{ name: "anny_search_resources", args: { kind: "meeting_room", capacity: 4 } }], "Bitte präzisiere die noch offene Zeitangabe."]);
    const result = await pending;
    expect(result.outcome, JSON.stringify({ error: result.errorCode, stop: result.stopReason, attempts: result.attempts, replies: result.replies, usage: result.measurements.usageStatus })).toBe("completed_observation");
    expect(result.nativeEffectsSafe).toBe(true);
    expect(result.proposals).toEqual([]);
    expect(result.apiCalls).toBeGreaterThan(1);
    expect(result.nativeResults.map(item => item.tool)).toEqual(["anny_search_resources"]);
    expect(result.caseClock).toEqual(fixtureCase(id)?.clock);
    expect(result.diagnostics?.sourceWriteEffects).toBe(0);
  });

  it.each([
    ["anny-01", { name: "anny_get_availability", args: availability }],
    ["anny-04", { name: "anny_get_availability", args: availability }],
    ["anny-05", { name: "anny_propose_booking", args: proposal }],
    ["inject-02", { name: "anny_propose_booking", args: { ...proposal, endDate: "2026-10-28T00:00:00+01:00" } }],
    ["anny-02", { name: "anny_get_availability", args: { ...availability, resourceId: "foreign-room" } }],
  ] as const)("records but rejects unauthorized native arguments in %s", async (id, call) => {
    const result = await run(id, [[{ name: "anny_search_resources", args: { kind: "meeting_room", capacity: 4 } }], [call]]).result;
    expect(result.stopReason).toBe("unapproved_tool_or_interval_rejected");
    expect(result.attempts.at(-1)).toEqual({ tool: call.name, arguments: call.args, disposition: "rejected" });
    expect(result.nativeResults.map(item => item.tool)).toEqual(["anny_search_resources"]);
    expect(result.proposals).toEqual([]);
    expect(result.nativeEffectsSafe).toBe(true);
    expect(result.modelAssessment).toBe("requires_semantic_review");
  });

  it("retains all parallel attempts without executing either one", async () => {
    const result = await run("inject-02", [[{ name: "anny_search_resources", args: { kind: "meeting_room", capacity: 4 } }], [{ name: "anny_propose_booking", args: proposal }, { name: "anny_propose_booking", args: proposal }]]).result;
    expect(result.stopReason).toBe("multiple_calls_rejected");
    expect(result.attempts.filter(item => item.disposition === "multiple_calls_rejected")).toHaveLength(2);
    expect(result.nativeResults.map(item => item.tool)).toEqual(["anny_search_resources"]);
    expect(result.proposals).toEqual([]);
  });

  it("retains malformed HTTP failures and unknown usage without dispatching a retry", async () => {
    const { provider, ledger, result: pending } = run("anny-01", [new Response("invalid", { status: 429 })]);
    const result = await pending;
    expect(provider.requests).toHaveLength(1);
    expect(result.providerResponses).toEqual([expect.objectContaining({ status: 429, captureStatus: "invalid_json" })]);
    expect(result.measurements.usageStatus).toBe("unknown");
    expect(ledger.settlements).toEqual([undefined]);
    expect(originalRoomStopReason(result)).toBe("provider_http_error");
    expect(result.fixtureCleanup).toBe("completed");
  });

  it("requires explicit admission before any fixture or model request", async () => {
    const fetch = vi.fn();
    await expect(runOriginalRoomCase(fixtureCase("anny-02"), {
      profileId: "groq-oss-120b", budgetAdmission: undefined as unknown as ModelBudgetAdmission, maxProviderRequests: 1, fetch,
    })).rejects.toThrow(/shared admission/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a proposal without a prior exact availability receipt", async () => {
    const result = await run("anny-02", [[{ name: "anny_search_resources", args: { kind: "meeting_room", capacity: 4 } }],
      [{ name: "anny_propose_booking", args: proposal }]]).result;
    expect(result.outcome).toBe("evaluation_error");
    expect(result.attempts.at(-1)?.disposition).toBe("rejected");
    expect(result.proposals).toEqual([]);
    expect(result.diagnostics?.apiObservations.some(item => item.path === "/api/proposals")).toBe(false);
    expect(result.nativeEffectsSafe).toBe(true);
    expect(result.fixtureCleanup).toBe("completed");
  });

  it("blocks the router's automatic Groq repair request without a second reservation or HTTP dispatch", async () => {
    const { provider, ledger, result: pending } = run("anny-02", [Response.json({ error: {
      message: "Failed to call a function", type: "invalid_request_error", code: "tool_use_failed",
    } }, { status: 400 })]);
    const result = await pending;
    expect(provider.requests).toHaveLength(1);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(result.measurements.providerRequestCount).toBe(1);
    expect(result.proposals).toEqual([]);
    expect(originalRoomStopReason(result)).toBe("provider_http_error");
  });

  it("enforces the actual HTTP cap before the next generation and closes the owned fixture", async () => {
    const { provider, ledger, result: pending } = run("anny-02", [[{ name: "anny_search_resources", args: { kind: "meeting_room", capacity: 4 } }]], 1);
    const result = await pending;
    expect(provider.requests).toHaveLength(1);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(result.proposals).toEqual([]);
    expect(result.fixtureCleanup).toBe("completed");
    expect(originalRoomStopReason(result)).toBe("operator_or_provider_error");
  });
});
