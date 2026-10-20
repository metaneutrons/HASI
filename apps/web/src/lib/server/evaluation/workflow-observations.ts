import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { preflightEvaluationJson } from "./case-schema";

const MAX_OBSERVATION_BYTES = 256 * 1024;
const MAX_OBSERVATION_NODES = 12_000;

const safeIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const caseIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const actionSchema = z.enum(["book", "cancel_booking"]);

/**
 * A bounded trace event emitted by an explicitly injected server observer for
 * synthetic offline fixtures. These records describe observations; they do
 * not authorize or execute application actions.
 */
export const evaluationWorkflowEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("action_confirmation"),
    action: actionSchema,
    subject: safeIdentifierSchema,
    proposalId: safeIdentifierSchema,
    actionDigestSha256: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("action_attempt"),
    action: actionSchema,
    subject: safeIdentifierSchema,
    proposalId: safeIdentifierSchema,
    actionDigestSha256: sha256Schema,
    attempt: z.number().int().min(1).max(100),
    outcome: z.enum(["confirmed", "outcome_unknown", "rejected"]),
  }),
]);

export type EvaluationWorkflowEvent = z.infer<typeof evaluationWorkflowEventSchema>;

const evaluationWorkflowObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: caseIdSchema,
  inputDigestSha256: sha256Schema,
  runId: z.uuid(),
  events: z.array(evaluationWorkflowEventSchema).max(100),
});

export type EvaluationWorkflowObservation = z.infer<typeof evaluationWorkflowObservationSchema>;

/**
 * Rejects values outside the plain-JSON budget before Zod sees them, including
 * accessors, proxies, cycles, and data that exceeds the shared byte/node caps.
 */
export function parseEvaluationWorkflowObservation(value: unknown): EvaluationWorkflowObservation {
  const bounded = preflightEvaluationJson(value, {
    maxBytes: MAX_OBSERVATION_BYTES,
    maxNodes: MAX_OBSERVATION_NODES,
    maxDepth: 16,
    maxObjectKeys: 64,
    maxArrayItems: 100,
    maxStringLength: 16_384,
  });
  if (!bounded.success) {
    throw new TypeError("Evaluation workflow observation must be bounded plain JSON data.");
  }
  return evaluationWorkflowObservationSchema.parse(bounded.value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  );
  return `{${fields.join(",")}}`;
}

/**
 * Returns a stable, domain-separated identity for a parsed observation.
 * Callers should pass the result of parseEvaluationWorkflowObservation; the
 * digest contains only its bounded public fields and no credentials or secrets.
 */
export function digestEvaluationWorkflowObservation(parsed: EvaluationWorkflowObservation): string {
  const validated = parseEvaluationWorkflowObservation(parsed);
  return createHash("sha256")
    .update("hasi-evaluation-workflow-observation-v1\0")
    .update(canonicalJson(validated))
    .digest("hex");
}
