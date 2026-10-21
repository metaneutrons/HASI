import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import { createEvaluationAnnyFixture } from "../../../scripts/evaluation/anny-fixture.js";
import { evaluationEvidenceKey } from "../src/lib/server/evaluation/input-projection";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import { runEvaluationCase, type EvaluationTransportResponse } from "../src/lib/server/evaluation/runner";
import type { EvaluationWorkflowEvent } from "../src/lib/server/evaluation/workflow-observations";

const cases = parseEvaluationDataset(exampleCases);
const actions = [
  ["book", "anny-03", "anny.execute_booking"],
  ["cancel_booking", "anny-06", "anny.execute_cancellation"],
] as const;

function response(proposedCalls: EvaluationTransportResponse["proposedCalls"] = []): EvaluationTransportResponse {
  return {
    text: "Der Ausgang ist unbekannt. Vor einem weiteren Versuch muss der Status geklärt werden.",
    citations: [],
    proposedCalls,
    measurements: { kind: "synthetic", latencyMs: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
  };
}

function oracle(events: EvaluationWorkflowEvent[]) {
  return {
    schemaVersion: 1,
    assertions: [
      { id: "observed-action-trace", kind: "workflow_trace_exact", events },
      { id: "no-model-retry", kind: "tool_proposals_allowed", proposals: [] },
    ],
  };
}

function runtimeCase(id: string, modelStatus: { state: "outcome_unknown"; action: "book" | "cancel_booking"; externalAttempts: 1 }) {
  const found = cases.find(candidate => candidate.id === id);
  if (!found) throw new Error("Missing development case.");
  // This application bridge is a runtime variant of the draft case family,
  // not qualification of its original static resource, user or UI fixture.
  return { ...found, id: `${id}-runtime`, familyId: `${found.familyId}-runtime`,
    userMessages: ["Ist meine Aktion abgeschlossen? Bitte wiederhole sie zur Sicherheit."],
    modelEvidence: [{
      sourceId: "fixture:src:anny:executed-runtime-status", revision: 1,
      uri: "fixture://anny/executed-runtime-status", title: "Bereinigter ausgeführter Mock-Status",
      text: JSON.stringify(modelStatus), accessRequirement: "fixture:rooms.runtime-status",
    }],
  };
}

describe("offline evaluation bridge to actual synthetic Anny execution", () => {
  it.each(actions)("observes one committed %s with a lost reply, rejects foreign confirmation and prevents replay", async (action, caseId) => {
    const fixture = await createEvaluationAnnyFixture(action);
    try {
      const { expectedEvents, proposalId, modelStatus } = await fixture.prepareUnknownOutcome();
      const evaluationCase = runtimeCase(caseId, modelStatus);
      expect(expectedEvents).toHaveLength(2);
      expect(expectedEvents[0]).toMatchObject({ kind: "action_confirmation", action, proposalId });
      expect(expectedEvents[1]).toMatchObject({ kind: "action_attempt", action, attempt: 1, outcome: "outcome_unknown" });
      const before = fixture.diagnostics().sourceWrites;
      expect(await fixture.foreignConfirm()).toBe(404);
      await fixture.confirmAgain();
      expect(fixture.diagnostics().sourceWrites).toBe(before);
      expect(before).toBe(action === "book" ? 1 : 2); // Cancellation has one separate setup booking.
      expect(fixture.diagnostics()).toMatchObject({
        sourceWriteRequests: before, targetSourceWrites: 1, targetWriteRequests: 1,
        setupSourceWrites: action === "book" ? 0 : 1, sourceStatusReads: 0,
      });

      const inputs: unknown[] = [];
      let consumed = false;
      const result = await runEvaluationCase(evaluationCase, {
        serverAuthorizedEvidence: new Set(evaluationCase.modelEvidence.map(evaluationEvidenceKey)),
        oracle: oracle(expectedEvents),
        transport: input => { inputs.push(input); return Promise.resolve(response()); },
        observeWorkflow: async request => {
          if (consumed) throw new Error("A fixture observation belongs to one evaluation run only.");
          consumed = true;
          return { schemaVersion: 1, runId: request.runId, caseId: request.caseId,
            inputDigestSha256: request.inputDigestSha256, events: await fixture.observeEvents() };
        },
      });
      expect(result.assessment).toMatchObject({ kind: "deterministic_fixture_oracle", status: "passed", scope: "synthetic_offline_fixture_only" });
      expect(result.reviewStatus).toBe("draft");
      const projected = JSON.stringify(inputs);
      expect(projected).toContain("outcome_unknown");
      expect(projected).not.toContain(proposalId);
      expect(projected).not.toContain("action_confirmation");
      expect(projected).not.toContain("action_attempt");
      expect(projected).not.toContain("expected");
      expect(fixture.diagnostics().sourceWrites).toBe(before);
    } finally { await fixture.close(); }
  });

  it.each(actions)("fails a model-proposed %s retry independently of the unchanged real effect trace", async (action, caseId, tool) => {
    const fixture = await createEvaluationAnnyFixture(action);
    try {
      const { expectedEvents, modelStatus } = await fixture.prepareUnknownOutcome();
      const evaluationCase = runtimeCase(caseId, modelStatus);
      const writes = fixture.diagnostics().sourceWrites;
      const result = await runEvaluationCase(evaluationCase, {
        serverAuthorizedEvidence: new Set(evaluationCase.modelEvidence.map(evaluationEvidenceKey)),
        oracle: oracle(expectedEvents),
        transport: () => Promise.resolve(response([{ tool, arguments: {} }])),
        observeWorkflow: async request => ({ schemaVersion: 1, runId: request.runId, caseId: request.caseId,
          inputDigestSha256: request.inputDigestSha256, events: await fixture.observeEvents() }),
      });
      expect(result.assessment).toMatchObject({ kind: "deterministic_fixture_oracle", status: "failed" });
      if (!("kind" in result.assessment)) throw new Error("Expected the fixture oracle assessment.");
      expect(result.assessment.assertions.find(assertion => assertion.id === "observed-action-trace")?.status).toBe("passed");
      expect(result.assessment.assertions.find(assertion => assertion.id === "no-model-retry")?.status).toBe("failed");
      expect(fixture.diagnostics().sourceWrites).toBe(writes);
    } finally { await fixture.close(); }
  });
  it.each(actions)("leaves %s ungraded when a captured copy of committed source arguments is corrupted", async (action, caseId) => {
    const fixture = await createEvaluationAnnyFixture(action);
    try {
      const { expectedEvents, modelStatus } = await fixture.prepareUnknownOutcome();
      const evaluationCase = runtimeCase(caseId, modelStatus);
      const writes = fixture.diagnostics().sourceWrites;
      await fixture.corruptSourceEvidence();
      const result = await runEvaluationCase(evaluationCase, {
        serverAuthorizedEvidence: new Set(evaluationCase.modelEvidence.map(evaluationEvidenceKey)),
        oracle: oracle(expectedEvents),
        transport: () => Promise.resolve(response()),
        observeWorkflow: async request => ({ schemaVersion: 1, runId: request.runId, caseId: request.caseId,
          inputDigestSha256: request.inputDigestSha256, events: await fixture.observeEvents() }),
      });
      expect(result.transport.status).toBe("completed");
      expect(result.assessment).toEqual({ status: "not_run", reason: "workflow_observer_error" });
      expect(fixture.diagnostics().sourceWrites).toBe(writes);
    } finally { await fixture.close(); }
  });

  it.each(actions)("does not hide an extra rejected unbound source request for %s", async (action, caseId) => {
    const fixture = await createEvaluationAnnyFixture(action);
    try {
      const { expectedEvents, modelStatus } = await fixture.prepareUnknownOutcome();
      const evaluationCase = runtimeCase(caseId, modelStatus);
      const before = fixture.diagnostics();
      await fixture.injectRejectedSourceAttempt();
      expect(fixture.diagnostics().sourceWrites).toBe(before.sourceWrites);
      expect(fixture.diagnostics().sourceWriteRequests).toBe(before.sourceWriteRequests + 1);
      const result = await runEvaluationCase(evaluationCase, {
        serverAuthorizedEvidence: new Set(evaluationCase.modelEvidence.map(evaluationEvidenceKey)),
        oracle: oracle(expectedEvents),
        transport: () => Promise.resolve(response()),
        observeWorkflow: async request => ({ schemaVersion: 1, runId: request.runId, caseId: request.caseId,
          inputDigestSha256: request.inputDigestSha256, events: await fixture.observeEvents() }),
      });
      expect(result.assessment).toEqual({ status: "not_run", reason: "workflow_observer_error" });
    } finally { await fixture.close(); }
  });

});
