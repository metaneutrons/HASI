import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import { parseEvaluationDataset, type EvaluationCase } from "../src/lib/server/evaluation/case-schema";
import { evaluationEvidenceKey } from "../src/lib/server/evaluation/input-projection";
import {
  runEvaluationCase,
  type EvaluationTransportResponse,
  type EvaluationWorkflowObservationRequest,
} from "../src/lib/server/evaluation/runner";
import type {
  EvaluationOracleAssessment,
  EvaluationOracleSpecification,
} from "../src/lib/server/evaluation/oracles";
import type { EvaluationWorkflowEvent } from "../src/lib/server/evaluation/workflow-observations";

const cases = parseEvaluationDataset(exampleCases);

function caseById(id: string): EvaluationCase {
  const evaluationCase = cases.find((candidate) => candidate.id === id);
  if (!evaluationCase) throw new Error(`Missing evaluation case ${id}.`);
  return evaluationCase;
}

function evidenceAllowlist(evaluationCase: EvaluationCase): ReadonlySet<string> {
  return new Set((evaluationCase.modelEvidence ?? []).map(evaluationEvidenceKey));
}

function syntheticResponse(overrides: Partial<EvaluationTransportResponse> = {}): EvaluationTransportResponse {
  return {
    text: "Die Anwendung meldet einen unbekannten Ausgang.",
    citations: [],
    proposedCalls: [],
    measurements: {
      kind: "synthetic",
      latencyMs: 42,
      inputTokens: 120,
      outputTokens: 14,
      estimatedCostUsd: 0.0001,
    },
    ...overrides,
  };
}

const bookingTrace = [
  {
    kind: "action_confirmation",
    action: "book",
    subject: "fixture-user-room-03",
    proposalId: "fixture-proposal-03",
    actionDigestSha256: "a".repeat(64),
  },
  {
    kind: "action_attempt",
    action: "book",
    subject: "fixture-user-room-03",
    proposalId: "fixture-proposal-03",
    actionDigestSha256: "a".repeat(64),
    attempt: 1,
    outcome: "outcome_unknown",
  },
] satisfies EvaluationWorkflowEvent[];

const cancellationTrace = [
  {
    kind: "action_confirmation",
    action: "cancel_booking",
    subject: "fixture-user-room-07",
    proposalId: "fixture-proposal-cancel-06",
    actionDigestSha256: "b".repeat(64),
  },
  {
    kind: "action_attempt",
    action: "cancel_booking",
    subject: "fixture-user-room-07",
    proposalId: "fixture-proposal-cancel-06",
    actionDigestSha256: "b".repeat(64),
    attempt: 1,
    outcome: "outcome_unknown",
  },
] satisfies EvaluationWorkflowEvent[];

function workflowOracle(events: EvaluationWorkflowEvent[]): EvaluationOracleSpecification {
  return {
    schemaVersion: 1,
    assertions: [{ id: "exact-action-trace", kind: "workflow_trace_exact", events }],
  };
}

function observation(
  request: EvaluationWorkflowObservationRequest,
  events: EvaluationWorkflowEvent[],
) {
  return {
    schemaVersion: 1 as const,
    caseId: request.caseId,
    inputDigestSha256: request.inputDigestSha256,
    runId: request.runId,
    events,
  };
}

function traceStatus(run: Awaited<ReturnType<typeof runEvaluationCase>>): string | undefined {
  if (!("kind" in run.assessment)) return undefined;
  return run.assessment.assertions.find((assertion) => assertion.id === "exact-action-trace")?.status;
}

function fixtureAssessment(run: Awaited<ReturnType<typeof runEvaluationCase>>): EvaluationOracleAssessment {
  if (!("kind" in run.assessment)) throw new Error("Expected a deterministic fixture assessment.");
  return run.assessment;
}

function bookingEvents(events: EvaluationWorkflowEvent[]) {
  const confirmation = events.find((event) => event.kind === "action_confirmation");
  const attempt = events.find((event) => event.kind === "action_attempt");
  if (!confirmation || !attempt) throw new Error("Expected the booking confirmation and attempt events.");
  return { confirmation, attempt };
}

type EventMutation = (events: EvaluationWorkflowEvent[]) => EvaluationWorkflowEvent[];

describe("offline workflow-observation runner contract", () => {
  it.each([
    ["anny-03", bookingTrace],
    ["anny-06", cancellationTrace],
  ] as const)("passes the injected one-attempt unknown-outcome trace for %s", async (caseId, events) => {
    const evaluationCase = caseById(caseId);
    const transportReply = syntheticResponse();
    const modelInputs: unknown[] = [];
    const observedRequests: EvaluationWorkflowObservationRequest[] = [];
    const observeWorkflow = vi.fn((request: EvaluationWorkflowObservationRequest) => {
      observedRequests.push(structuredClone(request));
      // Mutating the observer's copy must not alter the recorded transport reply.
      request.response.text = "observer mutation";
      request.response.proposedCalls.push({ tool: "fixture.observer_mutation", arguments: {} });
      return Promise.resolve(observation(request, [...events]));
    });
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle([...events]),
      transport: (input) => {
        modelInputs.push(input);
        return Promise.resolve(transportReply);
      },
      observeWorkflow,
    });

    expect(observeWorkflow).toHaveBeenCalledTimes(1);
    const observedRequest = observedRequests[0];
    if (!observedRequest) throw new Error("Expected the workflow observer request.");
    expect(observedRequest.caseId).toBe(caseId);
    expect(observedRequest.inputDigestSha256).toBe(result.inputDigestSha256);
    expect(observedRequest.runId).toBe(result.workflowRunId);
    expect(observedRequest.response.text).toBe("Die Anwendung meldet einen unbekannten Ausgang.");
    expect(result.workflowRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(modelInputs[0]).not.toHaveProperty("runId");
    expect(result.transport).toMatchObject({
      status: "completed",
      response: {
        text: "Die Anwendung meldet einen unbekannten Ausgang.",
        proposedCalls: [],
        measurements: { kind: "synthetic" },
      },
    });
    expect(result).toMatchObject({ runKind: "offline_fixture_transport", reviewStatus: "draft", datasetSplit: "development" });
    const assessment = fixtureAssessment(result);
    expect(assessment.scope).toBe("synthetic_offline_fixture_only");
    expect(assessment.status).toBe("passed");
    expect(assessment.workflowObservationDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(traceStatus(result)).toBe("passed");
  });

  const traceMutations: [string, EventMutation][] = [
    ["missing confirmation or attempt", (events) => events.slice(1)],
    ["an extra retry attempt", (events) => {
      const { attempt } = bookingEvents(events);
      return [...events, { ...attempt, attempt: 2, outcome: "rejected" }];
    }],
    ["reordered events", (events) => [...events].reverse()],
    ["a different confirming subject", (events) => {
      const { confirmation, attempt } = bookingEvents(events);
      return [{ ...confirmation, subject: "fixture-other-user" }, attempt];
    }],
    ["a different action", (events) => {
      const { confirmation, attempt } = bookingEvents(events);
      return [{ ...confirmation, action: "cancel_booking" }, attempt];
    }],
    ["a different action digest", (events) => {
      const { confirmation, attempt } = bookingEvents(events);
      return [{ ...confirmation, actionDigestSha256: "c".repeat(64) }, attempt];
    }],
    ["a different action-attempt subject", (events) => {
      const { confirmation, attempt } = bookingEvents(events);
      return [confirmation, { ...attempt, subject: "fixture-other-user" }];
    }],
    ["a different action-attempt digest", (events) => {
      const { confirmation, attempt } = bookingEvents(events);
      return [confirmation, { ...attempt, actionDigestSha256: "c".repeat(64) }];
    }],
  ];

  it.each(traceMutations)("fails exact trace matching for %s", async (_description, alterEvents) => {
    const evaluationCase = caseById("anny-03");
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve(syntheticResponse({
        text: "I completed the booking after the user confirmed it.",
      })),
      observeWorkflow: (request) => Promise.resolve(observation(request, alterEvents([...bookingTrace]))),
    });

    expect(result.transport.status).toBe("completed");
    expect(result.assessment).toMatchObject({
      kind: "deterministic_fixture_oracle",
      scope: "synthetic_offline_fixture_only",
      status: "failed",
    });
    expect(traceStatus(result)).toBe("failed");
  });

  it("does not infer an authenticated confirmation from model text", async () => {
    const evaluationCase = caseById("anny-03");
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve(syntheticResponse({
        text: "The user confirmed the exact action and the booking is complete.",
      })),
      observeWorkflow: (request) => Promise.resolve(observation(request, [])),
    });

    expect(result.transport.status).toBe("completed");
    expect(result.assessment).toMatchObject({ kind: "deterministic_fixture_oracle", status: "failed" });
    expect(traceStatus(result)).toBe("failed");
  });

  it("requires an observer for workflow assertions and rejects an observer without one before transport", async () => {
    const evaluationCase = caseById("anny-03");
    const transport = vi.fn(() => Promise.resolve(syntheticResponse()));
    const oracle = workflowOracle(bookingTrace);

    await expect(runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle,
      transport,
    })).rejects.toThrow("A workflow oracle requires an explicitly injected server observer.");
    expect(transport).not.toHaveBeenCalled();

    await expect(runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport,
      observeWorkflow: () => Promise.resolve({}),
    })).rejects.toThrow("A workflow observer requires an explicit workflow oracle.");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["another case", (request: EvaluationWorkflowObservationRequest) => ({
      ...observation(request, bookingTrace), caseId: "anny-06",
    })],
    ["another model-input digest", (request: EvaluationWorkflowObservationRequest) => ({
      ...observation(request, bookingTrace), inputDigestSha256: "d".repeat(64),
    })],
    ["an invalid event", (request: EvaluationWorkflowObservationRequest) => ({
      ...observation(request, bookingTrace), events: [{
        kind: "action_attempt",
        action: "book",
        subject: "fixture-user-room-03",
        proposalId: "fixture-proposal-03",
        actionDigestSha256: "a".repeat(64),
        attempt: 0,
        outcome: "outcome_unknown",
      }],
    })],
  ] as const)("returns not_run for an observation bound to %s", async (_description, makeObservation) => {
    const evaluationCase = caseById("anny-03");
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve(syntheticResponse()),
      observeWorkflow: (request) => Promise.resolve(makeObservation(request)),
    });

    expect(result.transport.status).toBe("completed");
    expect(result.assessment).toEqual({ status: "not_run", reason: "invalid_workflow_observation" });
  });

  it("keeps observer failures ungraded and does not expose their error details", async () => {
    const evaluationCase = caseById("anny-06");
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(cancellationTrace),
      transport: () => Promise.resolve(syntheticResponse()),
      observeWorkflow: () => Promise.reject(new Error("HIDDEN-OBSERVER-DETAIL")),
    });

    expect(result.transport.status).toBe("completed");
    expect(result.assessment).toEqual({ status: "not_run", reason: "workflow_observer_error" });
    expect(JSON.stringify(result)).not.toContain("HIDDEN-OBSERVER-DETAIL");
  });

  it("rejects a prior run's trace even when the case and projected input are unchanged", async () => {
    const evaluationCase = caseById("anny-03");
    let previousObservation: ReturnType<typeof observation> | undefined;
    const first = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve(syntheticResponse()),
      observeWorkflow: (request) => {
        previousObservation = observation(request, bookingTrace);
        return Promise.resolve(previousObservation);
      },
    });
    if (!previousObservation) throw new Error("Expected the first workflow observation.");

    const second = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve(syntheticResponse()),
      observeWorkflow: (request) => Promise.resolve({
        ...previousObservation,
        caseId: request.caseId,
        inputDigestSha256: request.inputDigestSha256,
      }),
    });

    expect(first.inputDigestSha256).toBe(second.inputDigestSha256);
    expect(first.workflowRunId).not.toBe(second.workflowRunId);
    expect(second.assessment).toEqual({ status: "not_run", reason: "invalid_workflow_observation" });
  });

  it("rejects model-supplied workflow observations before the observer runs", async () => {
    const evaluationCase = caseById("anny-03");
    const observeWorkflow = vi.fn((request: EvaluationWorkflowObservationRequest) =>
      Promise.resolve(observation(request, bookingTrace)));
    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: workflowOracle(bookingTrace),
      transport: () => Promise.resolve({
        ...syntheticResponse(),
        workflowObservation: observation({
          caseId: evaluationCase.id,
          inputDigestSha256: "e".repeat(64),
          runId: "123e4567-e89b-42d3-a456-426614174000",
          response: syntheticResponse(),
        }, bookingTrace),
      }),
      observeWorkflow,
    });

    expect(result.transport).toEqual({ status: "invalid_response", errorCode: "transport_response_schema_invalid" });
    expect(result.assessment).toEqual({ status: "not_run", reason: "invalid_transport_response" });
    expect(observeWorkflow).not.toHaveBeenCalled();
  });
});
