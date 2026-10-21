import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import exampleCases from "../../../docs/evaluation/example-cases.json";
import { createProviderWorkflowFixture, getProviderWorkflowDefinitions } from "../../../scripts/evaluation/provider-workflow-fixture";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import { runProviderEvaluationCase, type ProviderWorkflowObserver, type ProviderEvaluationDependencies } from "../src/lib/server/evaluation/provider-runner";
import { parseEvaluationWorkflowObservation } from "../src/lib/server/evaluation/workflow-observations";
import { createModelBudget, createModelBudgetAdmission, loadModelPrices } from "../src/lib/server/model-budgets";
import { loadModelConfiguration } from "../src/lib/server/model-config";

const corpus = parseEvaluationDataset(exampleCases);
const env = { GROQ_API_KEY: "provider-workflow-test-only" };

async function setup(id = "anny-03-runtime") {
  const definition = getProviderWorkflowDefinitions().find(item => item.id === id);
  const template = corpus.find(item => item.id === definition?.baseCaseId);
  if (!template) throw new Error("Missing registered template.");
  const fixture = await createProviderWorkflowFixture(id, template);
  try {
    const config = loadModelConfiguration(env);
    const prices = loadModelPrices(env);
    const ledger = createModelBudget(new MemoryJsonStore(`provider-workflow-${randomUUID()}`), prices, false);
    await ledger.initialize();
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = (_target, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected provider body.");
      requests.push(init.body);
      return Promise.resolve(new Response(JSON.stringify({ id: "workflow-response", object: "chat.completion", created: 1_797_136_800,
        model: "openai/gpt-oss-120b", choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant", content: "Der Ausgang ist unbekannt. Prüfe den Status vor einem weiteren Versuch.",
        } }], usage: { prompt_tokens: 100, completion_tokens: 10 },
      }), { headers: { "content-type": "application/json" } }));
    };
    return { fixture, requests, deps: { profileId: "groq-oss-120b", env, fetch,
      budgetAdmission: createModelBudgetAdmission(ledger, config, prices),
      serverAuthorizedEvidence: fixture.serverAuthorizedEvidence, oracle: fixture.oracle,
      observeWorkflow: (request: Parameters<ProviderWorkflowObserver>[0]) => fixture.observeWorkflow(request),
    } };
  } catch (error) { await fixture.close(); throw error; }
}

describe("provider response with independently observed synthetic actions", () => {
  it.each(["anny-03-runtime", "anny-06-runtime"])("grades %s against actual effects without giving the model execution authority", async id => {
    const { fixture, requests, deps } = await setup(id);
    try {
      const before = fixture.diagnostics();
      const result = await runProviderEvaluationCase(fixture.evaluationCase, deps);
      expect(requests).toHaveLength(1);
      const body = JSON.parse(requests[0] ?? "null") as { tools?: unknown[] };
      expect(body.tools ?? []).toEqual([]);
      expect(requests[0]).toContain("outcome_unknown");
      expect(requests[0]).toContain("knowledge_search");
      expect(requests[0]).not.toMatch(/action_confirmation|action_attempt|actionDigestSha256|proposalId|expectedEvents/u);
      expect(fixture.diagnostics()).toEqual(before);
      expect(result.runKind).toBe("provider_observed_workflow");
      expect(result.workflowRunId).toMatch(/^[a-f0-9-]{36}$/u);
      expect(result.reviewStatus).toBe("draft");
      expect(result.assessment).toMatchObject({ status: "passed", scope: "synthetic_observed_workflow_only" });
      expect(result.measurements).toMatchObject({ providerRequestCount: 1, usageStatus: "complete", inputTokens: 100, outputTokens: 10 });
      expect(before).toMatchObject({ targetSourceWrites: 1, targetWriteRequests: 1 });
    } finally { await fixture.close(); }
  });

  it.each(["runId", "caseId", "inputDigestSha256"] as const)("leaves a mismatched %s observation ungraded while preserving real usage", async field => {
    const { fixture, requests, deps } = await setup();
    try {
      const observer: ProviderWorkflowObserver = async request => {
        const observed = parseEvaluationWorkflowObservation(await fixture.observeWorkflow(request));
        return { ...observed, [field]: field === "runId" ? randomUUID() : field === "caseId" ? "other-case" : "0".repeat(64) };
      };
      const result = await runProviderEvaluationCase(fixture.evaluationCase, { ...deps, observeWorkflow: observer });
      expect(requests).toHaveLength(1);
      expect(result.transport.status).toBe("completed");
      expect(result.assessment).toEqual({ status: "not_run", reason: "invalid_workflow_observation" });
      expect(result.measurements).toMatchObject({ providerRequestCount: 1, usageStatus: "complete", estimatedCostUsd: 0.000021 });
    } finally { await fixture.close(); }
  });

  it("keeps observer failures ungraded without exposing their private causes", async () => {
    const { fixture, requests, deps } = await setup();
    try {
      const observer: ProviderWorkflowObserver = () => Promise.reject(new Error("PRIVATE_OBSERVER_FAILURE"));
      const result = await runProviderEvaluationCase(fixture.evaluationCase, { ...deps, observeWorkflow: observer });
      expect(requests).toHaveLength(1);
      expect(result.transport.status).toBe("completed");
      expect(result.assessment).toEqual({ status: "not_run", reason: "workflow_observer_error" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_OBSERVER_FAILURE");
      expect(result.measurements.usageStatus).toBe("complete");
    } finally { await fixture.close(); }
  });

  it("does not let observation code mutate the recorded provider answer", async () => {
    const { fixture, deps } = await setup();
    try {
      const observer: ProviderWorkflowObserver = async request => {
        request.response.text = "MUTATED_OBSERVER_ANSWER";
        request.response.proposedCalls.push({ tool: "anny.execute_booking", arguments: {} });
        return fixture.observeWorkflow(request);
      };
      const result = await runProviderEvaluationCase(fixture.evaluationCase, { ...deps, observeWorkflow: observer });
      expect(result.transport).toMatchObject({ status: "completed", response: { proposedCalls: [] } });
      expect(JSON.stringify(result)).not.toContain("MUTATED_OBSERVER_ANSWER");
      expect(result.assessment.status).toBe("passed");
      expect(fixture.diagnostics()).toMatchObject({ targetSourceWrites: 1 });
    } finally { await fixture.close(); }
  });

  it("does not invoke the workflow observer after a provider failure or retry it", async () => {
    const { fixture, requests, deps } = await setup();
    try {
      const observer = vi.fn((request: Parameters<ProviderWorkflowObserver>[0]) => fixture.observeWorkflow(request));
      const upstream = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: {
        message: "PRIVATE_PROVIDER_WORKFLOW_ERROR", type: "requests", code: "rate_limit_exceeded",
      } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } })));
      const result = await runProviderEvaluationCase(fixture.evaluationCase, { ...deps, fetch: upstream, observeWorkflow: observer });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(observer).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
      expect(result.transport).toMatchObject({ status: "error", code: "provider_rate_limited", providerStatus: 429 });
      expect(result.assessment).toEqual({ status: "not_run", reason: "provider_or_contract_error" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_WORKFLOW_ERROR");
      expect(result.measurements.usageStatus).toBe("unknown");
    } finally { await fixture.close(); }
  });

  it("cannot reuse an earlier fixture observation for a second provider answer", async () => {
    const { fixture, requests, deps } = await setup();
    try {
      const first = await runProviderEvaluationCase(fixture.evaluationCase, deps);
      const second = await runProviderEvaluationCase(fixture.evaluationCase, deps);
      expect(first.assessment.status).toBe("passed");
      expect(second.workflowRunId).not.toBe(first.workflowRunId);
      expect(second.assessment).toEqual({ status: "not_run", reason: "workflow_observer_error" });
      expect(second.measurements.providerRequestCount).toBe(1);
      expect(requests).toHaveLength(2);
      expect(fixture.diagnostics()).toMatchObject({ targetSourceWrites: 1, targetWriteRequests: 1 });
    } finally { await fixture.close(); }
  });

  it.each(["missing-observer", "missing-oracle", "fixed-with-observer", "policy-case"])("rejects %s registration before provider I/O", async fault => {
    const { fixture, requests, deps } = await setup();
    try {
      const evaluationCase = fault === "policy-case" ? corpus.find(item => item.id === "inject-01")
        : fault === "fixed-with-observer" ? corpus.find(item => item.id === "sit-01") : fixture.evaluationCase;
      const changed: ProviderEvaluationDependencies = { ...deps };
      if (fault === "missing-observer") delete changed.observeWorkflow;
      if (fault === "missing-oracle") delete changed.oracle;
      await expect(runProviderEvaluationCase(evaluationCase, changed)).rejects.toThrow();
      expect(requests).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});
