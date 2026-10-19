import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import {
  parseEvaluationDataset,
  type EvaluationCase,
} from "../src/lib/server/evaluation/case-schema";
import {
  evaluationEvidenceKey,
} from "../src/lib/server/evaluation/input-projection";
import {
  runEvaluationCase,
  type EvaluationRun,
  type EvaluationTransportResponse,
} from "../src/lib/server/evaluation/runner";
import type {
  EvaluationOracleAssessment,
  EvaluationOracleSpecification,
} from "../src/lib/server/evaluation/oracles";

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

function fixtureAssessment(run: EvaluationRun): EvaluationOracleAssessment {
  if (!("kind" in run.assessment)) throw new Error("Expected a deterministic fixture assessment.");
  return run.assessment;
}

function assertionStatus(assessment: EvaluationOracleAssessment, id: string): "passed" | "failed" {
  const assertion = assessment.assertions.find((candidate) => candidate.id === id);
  if (!assertion) throw new Error(`Missing assertion result ${id}.`);
  return assertion.status;
}

function oracle(assertions: EvaluationOracleSpecification["assertions"]): EvaluationOracleSpecification {
  return { schemaVersion: 1, assertions };
}

async function runWithOracle(
  specification: unknown,
  response: EvaluationTransportResponse,
): Promise<EvaluationRun> {
  const evaluationCase = caseById("sit-01");
  return runEvaluationCase(evaluationCase, {
    serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
    oracle: specification,
    transport: () => Promise.resolve(response),
  });
}

describe("bounded deterministic offline evaluation oracles", () => {
  it("binds results to canonical oracle contents independently of object key order", async () => {
    const specification = oracle([{ id: "answer", kind: "text_contains", text: "Antwort" }]);
    const first = fixtureAssessment(await runWithOracle(specification, syntheticResponse()));
    const reordered = fixtureAssessment(await runWithOracle({
      assertions: [{ text: "Antwort", kind: "text_contains", id: "answer" }], schemaVersion: 1,
    }, syntheticResponse()));
    const changed = fixtureAssessment(await runWithOracle(
      oracle([{ id: "answer", kind: "text_contains", text: "Another answer" }]), syntheticResponse(),
    ));
    expect(first.oracleDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered.oracleDigestSha256).toBe(first.oracleDigestSha256);
    expect(changed.oracleDigestSha256).not.toBe(first.oracleDigestSha256);
  });

  it("evaluates literal text assertions and keeps oracle content out of model input", async () => {
    const evaluationCase = caseById("sit-01");
    const modelInputs: unknown[] = [];
    const specification = oracle([
      { id: "has-answer", kind: "text_contains", text: "ORACLE_REQUIRED_SENTINEL" },
      { id: "no-secret", kind: "text_not_contains", text: "ORACLE_FORBIDDEN_SENTINEL" },
    ]);
    const run = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: specification,
      transport: (input) => {
        modelInputs.push(input);
        return Promise.resolve(syntheticResponse({
          text: "ORACLE_REQUIRED_SENTINEL ORACLE_FORBIDDEN_SENTINEL",
        }));
      },
    });

    const assessment = fixtureAssessment(run);
    expect(assessment).toMatchObject({
      kind: "deterministic_fixture_oracle",
      scope: "synthetic_offline_fixture_only",
      status: "failed",
    });
    expect(assertionStatus(assessment, "has-answer")).toBe("passed");
    expect(assertionStatus(assessment, "no-secret")).toBe("failed");
    expect(JSON.stringify(modelInputs[0])).not.toContain("ORACLE_REQUIRED_SENTINEL");
    expect(JSON.stringify(modelInputs[0])).not.toContain("ORACLE_FORBIDDEN_SENTINEL");
    expect(run.runKind).toBe("offline_fixture_transport");
    expect(run.reviewStatus).toBe("draft");
    expect(run.datasetSplit).toBe("development");
  });

  it("requires exact authorized citation identities and rejects extra, wrong-revision, or unprojected citations", async () => {
    const evaluationCase = caseById("sit-01");
    const evidence = evaluationCase.modelEvidence?.[0];
    if (!evidence) throw new Error("Expected fixed fixture evidence.");
    const allowed = { sourceId: evidence.sourceId, revision: evidence.revision };
    const denied = { sourceId: "fixture:src:denied-document", revision: 1 };

    const valid = fixtureAssessment(await runWithOracle(oracle([
      { id: "required-source", kind: "citations_required", citations: [allowed] },
      { id: "allowed-source", kind: "citations_allowed", citations: [allowed] },
    ]), syntheticResponse({ citations: [allowed] })));
    expect(valid.status).toBe("passed");
    expect(assertionStatus(valid, "$projection.authorized-citations")).toBe("passed");

    const missing = fixtureAssessment(await runWithOracle(oracle([
      { id: "required-source", kind: "citations_required", citations: [allowed] },
    ]), syntheticResponse()));
    expect(assertionStatus(missing, "required-source")).toBe("failed");

    const wrongRevision = fixtureAssessment(await runWithOracle(oracle([
      { id: "required-source", kind: "citations_required", citations: [allowed] },
    ]), syntheticResponse({ citations: [{ ...allowed, revision: allowed.revision + 1 }] })));
    expect(assertionStatus(wrongRevision, "required-source")).toBe("failed");
    expect(assertionStatus(wrongRevision, "$projection.authorized-citations")).toBe("failed");

    const extraCitation = fixtureAssessment(await runWithOracle(oracle([
      { id: "allowed-source", kind: "citations_allowed", citations: [allowed] },
    ]), syntheticResponse({ citations: [allowed, denied] })));
    expect(assertionStatus(extraCitation, "allowed-source")).toBe("failed");
    expect(assertionStatus(extraCitation, "$projection.authorized-citations")).toBe("failed");

    const deniedEvenWhenRequested = fixtureAssessment(await runWithOracle(oracle([
      { id: "required-denied", kind: "citations_required", citations: [denied] },
      { id: "allowed-denied", kind: "citations_allowed", citations: [denied] },
    ]), syntheticResponse({ citations: [denied] })));
    expect(assertionStatus(deniedEvenWhenRequested, "required-denied")).toBe("failed");
    expect(assertionStatus(deniedEvenWhenRequested, "allowed-denied")).toBe("failed");
    expect(assertionStatus(deniedEvenWhenRequested, "$projection.authorized-citations")).toBe("failed");
  });

  it("matches exact tool proposals with object-key normalization and array order preserved", async () => {
    const expected = {
      tool: "anny.propose_booking",
      arguments: {
        room: "R104",
        period: { start: "2026-10-27T09:00:00+01:00", end: "2026-10-27T10:00:00+01:00" },
        attendees: ["fabian", "lea"],
      },
    };
    const allowedResponse = syntheticResponse({
      proposedCalls: [{
        tool: expected.tool,
        arguments: {
          attendees: ["fabian", "lea"],
          period: { end: "2026-10-27T10:00:00+01:00", start: "2026-10-27T09:00:00+01:00" },
          room: "R104",
        },
      }],
    });
    const specification = oracle([
      { id: "required-booking", kind: "tool_proposals_required", proposals: [expected] },
      { id: "only-booking", kind: "tool_proposals_allowed", proposals: [expected] },
    ]);
    const objectKeyReordered = fixtureAssessment(await runWithOracle(specification, allowedResponse));
    expect(objectKeyReordered.status).toBe("passed");
    expect(assertionStatus(objectKeyReordered, "required-booking")).toBe("passed");
    expect(assertionStatus(objectKeyReordered, "only-booking")).toBe("passed");

    const arrayReordered = fixtureAssessment(await runWithOracle(specification, syntheticResponse({
      proposedCalls: [{
        ...expected,
        arguments: { ...expected.arguments, attendees: ["lea", "fabian"] },
      }],
    })));
    expect(assertionStatus(arrayReordered, "required-booking")).toBe("failed");
    expect(assertionStatus(arrayReordered, "only-booking")).toBe("failed");

    const missing = fixtureAssessment(await runWithOracle(specification, syntheticResponse()));
    expect(assertionStatus(missing, "required-booking")).toBe("failed");
    expect(assertionStatus(missing, "only-booking")).toBe("passed");

    const wrongArguments = fixtureAssessment(await runWithOracle(specification, syntheticResponse({
      proposedCalls: [{ ...expected, arguments: { ...expected.arguments, room: "R105" } }],
    })));
    expect(assertionStatus(wrongArguments, "required-booking")).toBe("failed");
    expect(assertionStatus(wrongArguments, "only-booking")).toBe("failed");

    const missingArgument = fixtureAssessment(await runWithOracle(specification, syntheticResponse({
      proposedCalls: [{
        tool: expected.tool,
        arguments: { room: "R104", period: expected.arguments.period },
      }],
    })));
    expect(assertionStatus(missingArgument, "required-booking")).toBe("failed");
    expect(assertionStatus(missingArgument, "only-booking")).toBe("failed");

    const extraArgument = fixtureAssessment(await runWithOracle(specification, syntheticResponse({
      proposedCalls: [{
        ...expected,
        arguments: { ...expected.arguments, note: "unexpected" },
      }],
    })));
    expect(assertionStatus(extraArgument, "required-booking")).toBe("failed");
    expect(assertionStatus(extraArgument, "only-booking")).toBe("failed");

    const extraProposal = fixtureAssessment(await runWithOracle(specification, syntheticResponse({
      proposedCalls: [expected, { tool: "anny.propose_booking", arguments: { room: "R105" } }],
    })));
    expect(assertionStatus(extraProposal, "required-booking")).toBe("passed");
    expect(assertionStatus(extraProposal, "only-booking")).toBe("failed");

    const noCallsAllowed = fixtureAssessment(await runWithOracle(oracle([
      { id: "deny-all-proposals", kind: "tool_proposals_allowed", proposals: [] },
    ]), syntheticResponse()));
    expect(assertionStatus(noCallsAllowed, "deny-all-proposals")).toBe("passed");
    const unexpectedCall = fixtureAssessment(await runWithOracle(oracle([
      { id: "deny-all-proposals", kind: "tool_proposals_allowed", proposals: [] },
    ]), syntheticResponse({ proposedCalls: [expected] })));
    expect(assertionStatus(unexpectedCall, "deny-all-proposals")).toBe("failed");
  });

  it("rejects empty, duplicate, malformed, oversized, proxied, and accessor oracle input before transport", async () => {
    const valid = oracle([{ id: "contains", kind: "text_contains", text: "known" }]);
    const duplicateIds = oracle([
      { id: "same", kind: "text_contains", text: "first" },
      { id: "same", kind: "text_not_contains", text: "second" },
    ]);
    const emptyAssertions = { schemaVersion: 1, assertions: [] };
    const malformed = {
      schemaVersion: 1,
      unexpected: "not accepted",
      assertions: [{ id: "regex", kind: "text_matches", pattern: ".*" }],
    };
    const emptyRequiredProposals = oracle([
      { id: "required", kind: "tool_proposals_required", proposals: [] },
    ]);
    const oversized = oracle([{
      id: "too-large",
      kind: "tool_proposals_allowed",
      proposals: Array.from({ length: 32 }, (_, index) => ({
        tool: `fixture.tool_${String(index)}`,
        arguments: { payload: "x".repeat(12_000) },
      })),
    }]);
    const proxy = new Proxy(valid, {
      getPrototypeOf: () => { throw new Error("proxy trap must not run"); },
    });
    const accessor = structuredClone(valid) as unknown as { schemaVersion: number; assertions: Record<string, unknown>[] };
    let getterCalls = 0;
    Object.defineProperty(accessor.assertions[0], "text", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "must not run";
      },
    });
    const invalidSpecs: [string, unknown][] = [
      ["empty assertions", emptyAssertions],
      ["duplicate assertion IDs", duplicateIds],
      ["malformed assertion", malformed],
      ["empty required proposals", emptyRequiredProposals],
      ["oversized oracle", oversized],
      ["proxy oracle", proxy],
      ["accessor oracle", accessor],
    ];

    for (const [name, specification] of invalidSpecs) {
      const transport = vi.fn(() => Promise.resolve(syntheticResponse()));
      await expect(runEvaluationCase(caseById("sit-01"), {
        serverAuthorizedEvidence: evidenceAllowlist(caseById("sit-01")),
        oracle: specification,
        transport,
      })).rejects.toThrow();
      expect(transport, name).not.toHaveBeenCalled();
    }
    expect(getterCalls).toBe(0);
  });

  it("copies the oracle before awaiting transport, never executes calls, and distinguishes transport failure from ungraded output", async () => {
    const evaluationCase = caseById("sit-01");
    const mutableOracle = oracle([
      { id: "keep-original", kind: "text_contains", text: "ORACLE_STABLE_SENTINEL" },
    ]);
    const fetch = vi.spyOn(globalThis, "fetch");
    const passed = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: mutableOracle,
      transport: () => {
        mutableOracle.assertions[0] = {
          id: "mutated-after-parse",
          kind: "text_contains",
          text: "not in response",
        };
        return Promise.resolve(syntheticResponse({
          text: "ORACLE_STABLE_SENTINEL",
          proposedCalls: [{ tool: "anny.propose_booking", arguments: { room: "R104" } }],
        }));
      },
    });
    expect(assertionStatus(fixtureAssessment(passed), "keep-original")).toBe("passed");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();

    const failedTransport = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      oracle: oracle([{ id: "never-run", kind: "text_contains", text: "answer" }]),
      transport: () => Promise.reject(new Error("HIDDEN-TRANSPORT-DETAIL")),
    });
    expect(failedTransport.transport).toEqual({ status: "error", errorCode: "injected_transport_failed" });
    expect(failedTransport.assessment).toEqual({ status: "not_run", reason: "transport_error" });
    expect(JSON.stringify(failedTransport)).not.toContain("HIDDEN-TRANSPORT-DETAIL");

    const ungraded = await runEvaluationCase(evaluationCase, {
      serverAuthorizedEvidence: evidenceAllowlist(evaluationCase),
      transport: () => Promise.resolve(syntheticResponse()),
    });
    expect(ungraded.assessment).toEqual({ status: "not_assessed", reason: "synthetic_transport_only" });
  });
});
