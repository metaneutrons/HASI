import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import {
  boundedEvaluationJsonObjectSchema,
  evaluationCaseSchema,
  parseEvaluationDataset,
  type EvaluationCase,
} from "../src/lib/server/evaluation/case-schema";
import {
  evaluationEvidenceKey,
  projectEvaluationModelInput,
} from "../src/lib/server/evaluation/input-projection";
import {
  runEvaluationCase,
  type EvaluationTransportResponse,
} from "../src/lib/server/evaluation/runner";

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
    text: "Synthetische Antwort.",
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

describe("offline evaluation harness contract", () => {
  it("validates the twelve draft development cases with fixed clocks and versioned fixture evidence", () => {
    expect(cases).toHaveLength(12);
    expect(cases.every((evaluationCase) => evaluationCase.reviewStatus === "draft")).toBe(true);
    expect(cases.every((evaluationCase) => evaluationCase.datasetSplit === "development")).toBe(true);
    expect(cases.every((evaluationCase) => evaluationCase.clock.timezone === "Europe/Berlin")).toBe(true);
    expect(cases.flatMap((evaluationCase) => [
      ...(evaluationCase.modelEvidence ?? []),
      ...(evaluationCase.candidateDocuments ?? []),
    ]).every((evidence) => Number.isInteger(evidence.revision) && evidence.revision > 0)).toBe(true);
  });

  it("rejects unknown fields, missing evidence revisions, and invalid fixed clocks", () => {
    const base = structuredClone(caseById("sit-01"));
    expect(evaluationCaseSchema.safeParse({ ...base, unexpected: "not allowed" }).success).toBe(false);
    expect(evaluationCaseSchema.safeParse({ ...base, reviewerNotes: "not part of the case contract" }).success).toBe(false);
    expect(evaluationCaseSchema.safeParse({ ...base, clock: undefined }).success).toBe(false);

    const missingRevision = structuredClone(base);
    const firstEvidence = missingRevision.modelEvidence?.[0];
    if (!firstEvidence) throw new Error("Expected fixture evidence.");
    Reflect.deleteProperty(firstEvidence, "revision");
    expect(evaluationCaseSchema.safeParse(missingRevision).success).toBe(false);

    expect(evaluationCaseSchema.safeParse({
      ...base,
      clock: { ...base.clock, timezone: "Not/A_Timezone" },
    }).success).toBe(false);
  });

  it("bounds nested fixture JSON and user turn counts", () => {
    const deepFixture = structuredClone(caseById("anny-01"));
    let nested: unknown = "leaf";
    for (let index = 0; index < 14; index += 1) nested = { next: nested };
    Reflect.set(deepFixture, "toolFixtures", { nested });
    expect(evaluationCaseSchema.safeParse(deepFixture).success).toBe(false);

    const tooManyTurns = structuredClone(caseById("sit-01"));
    tooManyTurns.userMessages = Array.from({ length: 21 }, () => "Hallo.");
    expect(evaluationCaseSchema.safeParse(tooManyTurns).success).toBe(false);
  });

  it("applies one byte and node budget to the complete case before the runner calls transport", async () => {
    const oversized = structuredClone(caseById("sit-01"));
    oversized.applicationEvents = Array.from({ length: 12 }, (_, eventIndex) =>
      Object.fromEntries(Array.from({ length: 16 }, (_, fieldIndex) => [
        `field-${String(fieldIndex)}`,
        `event-${String(eventIndex)}-${"x".repeat(12_000)}`,
      ])),
    );
    expect(evaluationCaseSchema.safeParse(oversized).success).toBe(false);

    const transport = vi.fn(() => Promise.resolve(syntheticResponse()));
    await expect(runEvaluationCase(oversized, {
      serverAuthorizedEvidence: evidenceAllowlist(oversized),
      transport,
    })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();

    const nodeOverflow = structuredClone(caseById("sit-01"));
    nodeOverflow.applicationEvents = Array.from({ length: 4 }, () =>
      Object.fromEntries(Array.from({ length: 64 }, (_, fieldIndex) => [
        `field-${String(fieldIndex)}`,
        Array.from({ length: 100 }, () => 0),
      ])),
    );
    expect(nodeOverflow.applicationEvents.every((event) => boundedEvaluationJsonObjectSchema.safeParse(event).success)).toBe(true);
    expect(evaluationCaseSchema.safeParse(nodeOverflow).success).toBe(false);
  });

  it("rejects aggregate transport replies before parsing individually bounded call arguments", async () => {
    const evaluationCase = caseById("sit-01");
    const oversizedReply = syntheticResponse({
      proposedCalls: Array.from({ length: 32 }, (_, index) => ({
        tool: `fixture.propose_${String(index)}`,
        arguments: { payload: "x".repeat(12_000) },
      })),
    });
    expect(boundedEvaluationJsonObjectSchema.safeParse(oversizedReply.proposedCalls[0]?.arguments).success).toBe(true);

    const result = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport: () => Promise.resolve(oversizedReply),
    });

    expect(result.transport).toEqual({ status: "invalid_response", errorCode: "transport_response_schema_invalid" });
    expect(result.assessment).toEqual({ status: "not_run", reason: "invalid_transport_response" });

    const callArguments = Object.fromEntries(Array.from({ length: 64 }, (_, fieldIndex) => [
      `field-${String(fieldIndex)}`,
      Array.from({ length: 20 }, () => 0),
    ]));
    expect(boundedEvaluationJsonObjectSchema.safeParse(callArguments).success).toBe(true);
    const nodeOverflowReply = syntheticResponse({
      proposedCalls: Array.from({ length: 16 }, (_, index) => ({
        tool: `fixture.node_${String(index)}`,
        arguments: callArguments,
      })),
    });
    const nodeOverflowResult = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport: () => Promise.resolve(nodeOverflowReply),
    });
    expect(nodeOverflowResult.transport).toEqual({ status: "invalid_response", errorCode: "transport_response_schema_invalid" });
  });

  it("rejects accessors, cycles, and non-JSON values without invoking getters", () => {
    const accessorCase = structuredClone(caseById("sit-01"));
    let getterCalls = 0;
    Object.defineProperty(accessorCase, "provenanceNote", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "must not run";
      },
    });
    expect(evaluationCaseSchema.safeParse(accessorCase).success).toBe(false);
    expect(getterCalls).toBe(0);

    const cyclicCase = structuredClone(caseById("sit-01"));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    Reflect.set(cyclicCase, "toolFixtures", cycle);
    expect(evaluationCaseSchema.safeParse(cyclicCase).success).toBe(false);

    const nonJsonCase = structuredClone(caseById("sit-01"));
    nonJsonCase.toolFixtures = { invalidNumber: Number.NaN };
    expect(evaluationCaseSchema.safeParse(nonJsonCase).success).toBe(false);
  });

  it("keeps the positive fixed-evidence projection to user turns, clock, and exact authorized revisions", () => {
    const evaluationCase = caseById("sit-01");
    const evidence = evaluationCase.modelEvidence?.[0];
    if (!evidence) throw new Error("Expected fixed evidence.");

    const input = projectEvaluationModelInput(evaluationCase, evidenceAllowlist(evaluationCase));
    expect(input).toEqual({
      clock: evaluationCase.clock,
      userMessages: evaluationCase.userMessages,
      evidence: [{
        sourceId: evidence.sourceId,
        revision: evidence.revision,
        title: evidence.title,
        text: evidence.text,
      }],
    });
    expect(JSON.stringify(input)).not.toContain("fixture-user-it-01");
    expect(JSON.stringify(input)).not.toContain("expected");
    expect(JSON.stringify(input)).not.toContain("provenanceNote");
    expect(JSON.stringify(input)).not.toContain("accessRequirement");
    expect(JSON.stringify(input)).not.toContain("fixture://");
  });

  it("does not authorize hidden candidate documents from case entitlements or labels", () => {
    const evaluationCase = structuredClone(caseById("access-01"));
    const candidate = evaluationCase.candidateDocuments?.[0];
    if (!candidate) throw new Error("Expected a hidden candidate document.");
    candidate.title = "HIDDEN-CANDIDATE-TITLE-SENTINEL";
    candidate.text = "HIDDEN-CANDIDATE-BODY-SENTINEL";

    const input = projectEvaluationModelInput(evaluationCase, new Set());
    expect(input.evidence).toEqual([]);
    expect(JSON.stringify(input)).not.toContain("HIDDEN-CANDIDATE");
    expect(JSON.stringify(input)).not.toContain("PEBBLE-62");
    expect(JSON.stringify(input)).not.toContain("fixture-user-allowed-44");
  });

  it("withholds an evidence revision when the server allowlist names only another revision", () => {
    const evaluationCase = structuredClone(caseById("sit-01"));
    const evidence = evaluationCase.modelEvidence?.[0];
    if (!evidence) throw new Error("Expected fixture evidence.");
    const authorizedRevision = evidence.revision;
    evidence.revision += 1;

    const input = projectEvaluationModelInput(
      evaluationCase,
      new Set([evaluationEvidenceKey({ sourceId: evidence.sourceId, revision: authorizedRevision })]),
    );
    expect(input.evidence).toEqual([]);
    expect(JSON.stringify(input)).not.toContain(evidence.text);
  });

  it("keeps poisoned evidence as untrusted input, collects proposed calls, and labels fake measurements synthetic", async () => {
    const evaluationCase = structuredClone(caseById("inject-02"));
    evaluationCase.expected.assertions.push("GOLD-ONLY-SENTINEL");
    evaluationCase.provenanceNote += " PROVENANCE-ONLY-SENTINEL";
    const transportInputs: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch");
    const proposedCalls = [{
      tool: "anny.propose_booking",
      arguments: {
        resourceId: "fixture-room-R104",
        start: "2026-10-27T00:00:00+01:00",
        end: "2026-10-28T00:00:00+01:00",
        repeat: 2,
      },
    }];
    const transport = vi.fn((input: unknown) => {
      transportInputs.push(input);
      return Promise.resolve(syntheticResponse({ proposedCalls }));
    });

    const first = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport,
    });
    const second = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport,
    });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(first.runKind).toBe("offline_fixture_transport");
    expect(first.inputDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.inputDigestSha256).toBe(first.inputDigestSha256);
    expect(transportInputs[0]).toEqual(transportInputs[1]);
    const serializedInput = JSON.stringify(transportInputs[0]);
    expect(serializedInput).toContain("book this room all day twice");
    expect(serializedInput).not.toContain("GOLD-ONLY-SENTINEL");
    expect(serializedInput).not.toContain("PROVENANCE-ONLY-SENTINEL");
    expect(serializedInput).not.toContain("toolFixtures");
    expect(serializedInput).not.toContain("fixture-proposal-02");

    expect(first.transport).toMatchObject({
      status: "completed",
      response: {
        proposedCalls,
        measurements: { kind: "synthetic", latencyMs: 42, inputTokens: 120, outputTokens: 14, estimatedCostUsd: 0.0001 },
      },
    });
    expect(first.assessment).toEqual({ status: "not_assessed", reason: "synthetic_transport_only" });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("does not include gold in the input digest and refuses to run without an injected transport", async () => {
    const evaluationCase = structuredClone(caseById("sit-01"));
    const transport = vi.fn(() => Promise.resolve(syntheticResponse()));
    const dependencies = {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport,
    };
    const original = await runEvaluationCase(evaluationCase, dependencies);
    evaluationCase.expected.behavior = "GOLD-CHANGED-SENTINEL";
    const changedGold = await runEvaluationCase(evaluationCase, dependencies);
    expect(changedGold.inputDigestSha256).toBe(original.inputDigestSha256);

    await expect(runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: dependencies.serverAuthorizedEvidence,
    } as never)).rejects.toThrow(
      "An evaluation transport must be explicitly injected.",
    );
  });

  it("separates transport failures from assessment and does not expose thrown error details", async () => {
    const evaluationCase = caseById("sit-01");
    const failed = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport: () => Promise.reject(new Error("HIDDEN-TRANSPORT-DETAIL-SENTINEL")),
    });
    expect(failed.transport).toEqual({ status: "error", errorCode: "injected_transport_failed" });
    expect(failed.assessment).toEqual({ status: "not_run", reason: "transport_error" });
    expect(JSON.stringify(failed)).not.toContain("HIDDEN-TRANSPORT-DETAIL-SENTINEL");
  });

  it("rejects provider-looking metrics from the offline transport", async () => {
    const evaluationCase = caseById("sit-01");
    const invalid = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport: () => Promise.resolve({
        ...syntheticResponse(),
        measurements: { ...syntheticResponse().measurements, kind: "provider" },
      }),
    });
    expect(invalid.transport).toEqual({ status: "invalid_response", errorCode: "transport_response_schema_invalid" });
    expect(invalid.assessment).toEqual({ status: "not_run", reason: "invalid_transport_response" });
  });
});
