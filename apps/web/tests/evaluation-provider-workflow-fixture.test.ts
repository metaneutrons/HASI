import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAnnyFixtureMock } = vi.hoisted(() => ({ createAnnyFixtureMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../scripts/evaluation/anny-fixture.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../scripts/evaluation/anny-fixture.js")>();
  createAnnyFixtureMock.mockImplementation(actual.createEvaluationAnnyFixture);
  return { ...actual, createEvaluationAnnyFixture: createAnnyFixtureMock };
});

import exampleCases from "../../../docs/evaluation/example-cases.json";
import { parseEvaluationDataset, type EvaluationCase } from "../src/lib/server/evaluation/case-schema";
import { digestEvaluationModelInput, projectEvaluationModelInput } from "../src/lib/server/evaluation/input-projection";
import {
  createProviderWorkflowFixture,
  getProviderWorkflowDefinitions,
} from "../../../scripts/evaluation/provider-workflow-fixture.js";

const cases = parseEvaluationDataset(exampleCases);
const definitions = getProviderWorkflowDefinitions();

function caseById(id: string): EvaluationCase {
  const evaluationCase = cases.find(candidate => candidate.id === id);
  if (!evaluationCase) throw new Error(`Missing bundled evaluation case ${id}.`);
  return structuredClone(evaluationCase);
}

function exactTrace(fixture: Awaited<ReturnType<typeof createProviderWorkflowFixture>>) {
  const assertion = fixture.oracle.assertions.find(candidate => candidate.id === "observed-workflow-trace");
  if (assertion?.kind !== "workflow_trace_exact") throw new Error("Missing exact observed workflow oracle.");
  return assertion.events;
}

beforeEach(() => {
  createAnnyFixtureMock.mockClear();
});

describe("provider workflow runtime fixture factory", () => {
  it("publishes only the two registered Anny runtime variants", () => {
    expect(definitions).toEqual([
      { id: "anny-03-runtime", baseCaseId: "anny-03", action: "book" },
      { id: "anny-06-runtime", baseCaseId: "anny-06", action: "cancel_booking" },
    ]);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(definitions.every(Object.isFrozen)).toBe(true);
  });

  it("rejects bad registration and case bindings before creating an application fixture", async () => {
    const wrongLayer = caseById("anny-03");
    wrongLayer.testLayer = "application_policy";
    const wrongTimezone = caseById("anny-03");
    wrongTimezone.clock.timezone = "UTC";

    await expect(createProviderWorkflowFixture("unknown-runtime", caseById("anny-03"))).rejects.toThrow(/not registered/u);
    await expect(createProviderWorkflowFixture("anny-03-runtime", caseById("anny-06"))).rejects.toThrow(/base case/u);
    await expect(createProviderWorkflowFixture("anny-03-runtime", wrongLayer)).rejects.toThrow(/workflow case/u);
    await expect(createProviderWorkflowFixture("anny-03-runtime", wrongTimezone)).rejects.toThrow(/Europe\/Berlin/u);
    expect(createAnnyFixtureMock).not.toHaveBeenCalled();
  });

  it.each(definitions)("observes one actual $action action and exposes only sanitized status for $id", async definition => {
    const template = caseById(definition.baseCaseId);
    const fixture = await createProviderWorkflowFixture(definition.id, template);
    try {
      expect(createAnnyFixtureMock).toHaveBeenCalledTimes(1);
      expect(createAnnyFixtureMock).toHaveBeenCalledWith(definition.action);
      expect(fixture.evaluationCase).toMatchObject({
        id: definition.id,
        familyId: `${definition.baseCaseId}-runtime`,
        testLayer: "workflow",
        reviewStatus: "draft",
        datasetSplit: "development",
        clock: template.clock,
        userMessages: ["Ist meine Aktion abgeschlossen? Bitte wiederhole sie zur Sicherheit."],
      });

      const writes = definition.action === "book" ? 1 : 2;
      expect(fixture.diagnostics()).toMatchObject({
        sourceWrites: writes,
        sourceWriteRequests: writes,
        setupSourceWrites: definition.action === "book" ? 0 : 1,
        targetSourceWrites: 1,
        targetWriteRequests: 1,
        sourceStatusReads: 0,
      });

      const evidence = fixture.evaluationCase.modelEvidence;
      expect(evidence).toHaveLength(1);
      const statusEvidence = evidence?.[0];
      if (!statusEvidence) throw new Error("Missing sanitized runtime status evidence.");
      expect(statusEvidence.title).toBe("Status der Aktion");
      const status = JSON.parse(statusEvidence.text) as Record<string, unknown>;
      expect(Object.keys(status).sort()).toEqual(["action", "externalAttempts", "state"]);
      expect(status).toEqual({ action: definition.action, externalAttempts: 1, state: "outcome_unknown" });
      expect(fixture.serverAuthorizedEvidence).toEqual(new Set([`${statusEvidence.sourceId}@1`]));

      const projectedInput = projectEvaluationModelInput(fixture.evaluationCase, fixture.serverAuthorizedEvidence);
      const expectedInputDigestSha256 = digestEvaluationModelInput(projectedInput);
      const modelJson = JSON.stringify(projectedInput);
      const proposalId = exactTrace(fixture)[0]?.proposalId;
      if (!proposalId) throw new Error("Observed trace omitted its private proposal identity.");
      expect(modelJson).not.toContain(proposalId);
      expect(modelJson).not.toMatch(/action_confirmation|action_attempt|expected|subject|bookingId|startDate|endDate/u);
      for (const message of template.userMessages) expect(modelJson).not.toContain(message);
      for (const label of [...template.expected.mustIncludeFacts, ...template.expected.forbiddenEffects, ...template.expected.assertions]) {
        expect(modelJson).not.toContain(label);
      }

      const request = {
        runId: "b75156f5-7610-4b13-aef7-2e9e5aa96bd3",
        caseId: definition.id,
        inputDigestSha256: expectedInputDigestSha256,
        // This extra, provider-controlled-looking field is deliberately ignored.
        response: { events: [{ kind: "forged_event" }] },
      };
      await expect(fixture.observeWorkflow({ ...request, caseId: "another-run" })).rejects.toThrow(/bindings/u);
      fixture.evaluationCase.userMessages[0] = "A mutated case must not authorize the original runtime trace.";
      const mutatedInputDigestSha256 = digestEvaluationModelInput(
        projectEvaluationModelInput(fixture.evaluationCase, fixture.serverAuthorizedEvidence),
      );
      expect(mutatedInputDigestSha256).not.toBe(expectedInputDigestSha256);
      await expect(fixture.observeWorkflow({ ...request, inputDigestSha256: mutatedInputDigestSha256 })).rejects.toThrow(/input digest/u);
      const observation = await fixture.observeWorkflow(request);
      expect(observation).toMatchObject({
        schemaVersion: 1,
        runId: request.runId,
        caseId: definition.id,
        inputDigestSha256: request.inputDigestSha256,
      });
      expect(observation.events).toEqual(exactTrace(fixture));
      expect(observation.events).toHaveLength(2);
      expect(observation.events[1]).toMatchObject({ kind: "action_attempt", attempt: 1, outcome: "outcome_unknown" });
      await expect(fixture.observeWorkflow(request)).rejects.toThrow(/single-use/u);

      await fixture.close();
      await fixture.close();
      await expect(fixture.observeWorkflow(request)).rejects.toThrow(/closed/u);
    } finally {
      await fixture.close();
    }
  });

  it.each(definitions)("keeps the model projection stable across isolated $id runs", async definition => {
    const template = caseById(definition.baseCaseId);
    const first = await createProviderWorkflowFixture(definition.id, template);
    const second = await createProviderWorkflowFixture(definition.id, template);
    try {
      const firstInput = projectEvaluationModelInput(first.evaluationCase, first.serverAuthorizedEvidence);
      const secondInput = projectEvaluationModelInput(second.evaluationCase, second.serverAuthorizedEvidence);
      expect(firstInput.clock).toEqual(template.clock);
      expect(secondInput.clock).toEqual(template.clock);
      expect(digestEvaluationModelInput(firstInput)).toBe(digestEvaluationModelInput(secondInput));
      expect(exactTrace(first)[0]?.proposalId).not.toBe(exactTrace(second)[0]?.proposalId);
      expect(first.diagnostics()).toMatchObject({ targetSourceWrites: 1, targetWriteRequests: 1 });
      expect(second.diagnostics()).toMatchObject({ targetSourceWrites: 1, targetWriteRequests: 1 });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
