import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import {
  evaluationEvidenceKey,
  projectEvaluationModelInput,
} from "../src/lib/server/evaluation/input-projection";

const cases = parseEvaluationDataset(exampleCases);

function objectAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("development smoke corpus", () => {
  it("parses twenty-two distinct draft cases without promoting their split or review status", () => {
    expect(cases).toHaveLength(22);
    expect(new Set(cases.map((evaluationCase) => evaluationCase.id)).size).toBe(22);
    expect(cases.every((evaluationCase) => evaluationCase.reviewStatus === "draft")).toBe(true);
    expect(cases.every((evaluationCase) => evaluationCase.datasetSplit === "development")).toBe(true);
  });

  it("meets smoke-suite language, turn-count, family and category coverage floors", () => {
    expect(cases.filter((evaluationCase) => evaluationCase.language === "en").length).toBeGreaterThanOrEqual(Math.ceil(cases.length * 0.2));
    expect(cases.filter((evaluationCase) => evaluationCase.userMessages.length > 1).length).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((evaluationCase) => evaluationCase.familyId)).size).toBeGreaterThanOrEqual(17);
    for (const category of ["service_it", "intranet", "anny", "access", "prompt_injection"] as const) {
      expect(cases.filter((evaluationCase) => evaluationCase.category === category).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("contains aggregate examples for revision conflict, server ACL filtering, a DST gap, cancellation uncertainty and attacks", () => {
    expect(cases.some((evaluationCase) => {
      const evidence = evaluationCase.modelEvidence ?? [];
      return evidence.some((item) => evidence.some((other) =>
        item.sourceId === other.sourceId && item.revision !== other.revision,
      ));
    })).toBe(true);

    expect(cases.some((evaluationCase) =>
      (evaluationCase.candidateDocuments?.length ?? 0) > 0 && (evaluationCase.modelEvidence?.length ?? 0) === 0,
    )).toBe(true);

    expect(cases.some((evaluationCase) =>
      evaluationCase.category === "anny" && objectAt(evaluationCase.toolFixtures, ["localTimeCheck", "result"]) === "nonexistent_local_time",
    )).toBe(true);

    expect(cases.some((evaluationCase) =>
      objectAt(evaluationCase.trustedApplicationContext, ["actionStatus", "state"]) === "outcome_unknown" &&
      (evaluationCase.applicationEvents ?? []).some((event) =>
        objectAt(event, ["type"]) === "external_cancellation_attempt" && objectAt(event, ["outcome"]) === "unknown",
      ),
    )).toBe(true);

    expect(cases.filter((evaluationCase) => evaluationCase.category === "prompt_injection").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps runner-only event records, gold and fixture canaries out of projected inputs", () => {
    const cancellation = cases.find((evaluationCase) =>
      (evaluationCase.applicationEvents ?? []).some((event) => objectAt(event, ["type"]) === "external_cancellation_attempt"),
    );
    if (!cancellation) throw new Error("Expected the synthetic cancellation event fixture.");
    const cancellationInput = projectEvaluationModelInput(
      cancellation,
      new Set((cancellation.modelEvidence ?? []).map(evaluationEvidenceKey)),
    );
    const serializedCancellationInput = JSON.stringify(cancellationInput);
    expect(serializedCancellationInput).toContain("The request timed out and the outcome is unknown.");
    expect(serializedCancellationInput).not.toContain("authenticated_ui_confirmation");
    expect(serializedCancellationInput).not.toContain("external_cancellation_attempt");
    expect(serializedCancellationInput).not.toContain("fixture-booking-BK774");

    const injection = cases.find((evaluationCase) =>
      objectAt(evaluationCase.toolFixtures, ["runnerOnlyDebugFixture", "hiddenToken"]) === "RUNNER-CANARY-Q4",
    );
    if (!injection) throw new Error("Expected the hidden runner-only canary fixture.");
    const injectionInput = projectEvaluationModelInput(
      injection,
      new Set((injection.modelEvidence ?? []).map(evaluationEvidenceKey)),
    );
    expect(JSON.stringify(injectionInput)).not.toContain("RUNNER-CANARY-Q4");
    const changedGold = structuredClone(injection);
    changedGold.expected.behavior = "SMOKE-GOLD-ONLY-CANARY-R7";
    const changedGoldInput = projectEvaluationModelInput(
      changedGold,
      new Set((changedGold.modelEvidence ?? []).map(evaluationEvidenceKey)),
    );
    expect(changedGoldInput).toEqual(injectionInput);
    expect(JSON.stringify(changedGoldInput)).not.toContain("SMOKE-GOLD-ONLY-CANARY-R7");
  });
});
