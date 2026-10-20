import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  digestEvaluationWorkflowObservation,
  evaluationWorkflowEventSchema,
  parseEvaluationWorkflowObservation,
  type EvaluationWorkflowObservation,
} from "../src/lib/server/evaluation/workflow-observations";

const digest = "a".repeat(64);

function observation(overrides: Partial<EvaluationWorkflowObservation> = {}): EvaluationWorkflowObservation {
  return {
    schemaVersion: 1,
    caseId: "workflow-01",
    inputDigestSha256: digest,
    runId: "f9ec8b8e-c88a-4e7e-b811-5d4c02f65f41",
    events: [
      {
        kind: "action_confirmation",
        action: "book",
        subject: "fixture-user-7",
        proposalId: "proposal-41",
        actionDigestSha256: "b".repeat(64),
      },
      {
        kind: "action_attempt",
        action: "book",
        subject: "fixture-user-7",
        proposalId: "proposal-41",
        actionDigestSha256: "b".repeat(64),
        attempt: 1,
        outcome: "confirmed",
      },
    ],
    ...overrides,
  };
}

describe("server-owned evaluation workflow observation contract", () => {
  it("accepts a bounded confirmation and attempt trace", () => {
    expect(parseEvaluationWorkflowObservation(observation())).toEqual(observation());
  });

  it("accepts an empty trace", () => {
    expect(parseEvaluationWorkflowObservation(observation({ events: [] })).events).toEqual([]);
  });

  it("rejects unknown top-level and event fields and unknown event kinds", () => {
    expect(() => parseEvaluationWorkflowObservation({ ...observation(), unexpected: true })).toThrow();
    expect(evaluationWorkflowEventSchema.safeParse({
      ...observation().events[0],
      unexpected: true,
    }).success).toBe(false);
    expect(evaluationWorkflowEventSchema.safeParse({ kind: "model_claim", claim: "confirmed" }).success).toBe(false);
  });

  it("rejects malformed digests and unsafe identifiers", () => {
    expect(() => parseEvaluationWorkflowObservation(observation({ inputDigestSha256: "A".repeat(64) }))).toThrow();
    expect(() => parseEvaluationWorkflowObservation(observation({ caseId: "Workflow-01" }))).toThrow();

    const invalidSubject = observation();
    const confirmation = invalidSubject.events[0];
    if (confirmation?.kind !== "action_confirmation") throw new Error("Expected confirmation event.");
    confirmation.subject = "../user";
    expect(() => parseEvaluationWorkflowObservation(invalidSubject)).toThrow();

    const invalidActionDigest = observation();
    const invalidConfirmation = invalidActionDigest.events[0];
    if (invalidConfirmation?.kind !== "action_confirmation") throw new Error("Expected confirmation event.");
    invalidConfirmation.actionDigestSha256 = "B".repeat(64);
    expect(() => parseEvaluationWorkflowObservation(invalidActionDigest)).toThrow();

    const invalidAttemptDigest = observation();
    const attempt = invalidAttemptDigest.events[1];
    if (attempt?.kind !== "action_attempt") throw new Error("Expected attempt event.");
    attempt.actionDigestSha256 = "B".repeat(64);
    expect(() => parseEvaluationWorkflowObservation(invalidAttemptDigest)).toThrow();

    const invalidAttemptSubject = observation();
    const attemptWithUnsafeSubject = invalidAttemptSubject.events[1];
    if (attemptWithUnsafeSubject?.kind !== "action_attempt") throw new Error("Expected attempt event.");
    attemptWithUnsafeSubject.subject = "../user";
    expect(() => parseEvaluationWorkflowObservation(invalidAttemptSubject)).toThrow();
  });

  it("rejects traces with more than 100 events", () => {
    expect(() => parseEvaluationWorkflowObservation(observation({
      events: Array.from({ length: 101 }, () => ({
        kind: "action_attempt" as const,
        action: "book" as const,
        subject: "fixture-user-7",
        proposalId: "proposal-41",
        actionDigestSha256: "b".repeat(64),
        attempt: 1,
        outcome: "rejected" as const,
      })),
    }))).toThrow();
  });

  it("enforces aggregate byte and depth limits before schema parsing", () => {
    const oversized: Record<string, unknown> = { ...observation() };
    for (let index = 0; index < 17; index += 1) {
      oversized[`unexpected-${String(index)}`] = "x".repeat(16_384);
    }
    expect(() => parseEvaluationWorkflowObservation(oversized)).toThrow();

    let nested: unknown = "leaf";
    for (let index = 0; index < 16; index += 1) nested = { next: nested };
    expect(() => parseEvaluationWorkflowObservation({ ...observation(), unexpected: nested })).toThrow();
  });

  it("rejects accessors without invoking getters and rejects proxies without invoking traps", () => {
    const withAccessor = observation() as EvaluationWorkflowObservation & { caseId: string };
    let getterCalls = 0;
    Object.defineProperty(withAccessor, "caseId", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "workflow-01";
      },
    });
    expect(() => parseEvaluationWorkflowObservation(withAccessor)).toThrow();
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxy = new Proxy(observation(), {
      get: () => {
        proxyTrapCalls += 1;
        throw new Error("Proxy must not be inspected.");
      },
      getPrototypeOf: () => {
        proxyTrapCalls += 1;
        throw new Error("Proxy must not be inspected.");
      },
      ownKeys: () => {
        proxyTrapCalls += 1;
        throw new Error("Proxy must not be inspected.");
      },
    });
    expect(() => parseEvaluationWorkflowObservation(proxy)).toThrow();
    expect(proxyTrapCalls).toBe(0);
  });

  it("produces stable digests and binds identity to trace order, content, case, and input", () => {
    const parsed = parseEvaluationWorkflowObservation(observation());
    const reorderedKeys = parseEvaluationWorkflowObservation({
      events: [
        {
          actionDigestSha256: "b".repeat(64),
          proposalId: "proposal-41",
          subject: "fixture-user-7",
          action: "book",
          kind: "action_confirmation",
        },
        {
          outcome: "confirmed",
          attempt: 1,
          actionDigestSha256: "b".repeat(64),
          proposalId: "proposal-41",
          subject: "fixture-user-7",
          action: "book",
          kind: "action_attempt",
        },
      ],
      inputDigestSha256: digest,
      runId: "f9ec8b8e-c88a-4e7e-b811-5d4c02f65f41",
      caseId: "workflow-01",
      schemaVersion: 1,
    });

    const originalDigest = digestEvaluationWorkflowObservation(parsed);
    expect(originalDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestEvaluationWorkflowObservation(reorderedKeys)).toBe(originalDigest);

    expect(digestEvaluationWorkflowObservation(parseEvaluationWorkflowObservation({
      ...parsed,
      events: [...parsed.events].reverse(),
    }))).not.toBe(originalDigest);
    expect(digestEvaluationWorkflowObservation(parseEvaluationWorkflowObservation({
      ...parsed,
      events: [parsed.events[0], {
        kind: "action_attempt",
        action: "book",
        subject: "fixture-user-7",
        proposalId: "proposal-41",
        actionDigestSha256: "c".repeat(64),
        attempt: 1,
        outcome: "confirmed",
      }],
    }))).not.toBe(originalDigest);
    expect(digestEvaluationWorkflowObservation(parseEvaluationWorkflowObservation({
      ...parsed,
      caseId: "workflow-02",
    }))).not.toBe(originalDigest);
    expect(digestEvaluationWorkflowObservation(parseEvaluationWorkflowObservation({
      ...parsed,
      inputDigestSha256: "c".repeat(64),
    }))).not.toBe(originalDigest);
    expect(digestEvaluationWorkflowObservation(parseEvaluationWorkflowObservation({
      ...parsed,
      runId: "f60d9b4f-af8d-4bbb-9ff5-99e8853d3af6",
    }))).not.toBe(originalDigest);
  });
});
