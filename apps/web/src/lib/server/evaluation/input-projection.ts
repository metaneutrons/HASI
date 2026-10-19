import "server-only";

import { z } from "zod";
import {
  evaluationCaseSchema,
  evaluationClockSchema,
  evaluationEvidenceSchema,
  type EvaluationEvidence,
} from "./case-schema";

const projectedEvidenceSchema = evaluationEvidenceSchema.pick({
  sourceId: true,
  revision: true,
  title: true,
  text: true,
});

export const evaluationModelInputSchema = z.strictObject({
  clock: evaluationClockSchema,
  userMessages: z.array(z.string().min(1).max(4_000)).min(1).max(20),
  evidence: z.array(projectedEvidenceSchema).max(32),
});

export type EvaluationModelInput = z.infer<typeof evaluationModelInputSchema>;
export type EvaluationEvidenceIdentity = Pick<EvaluationEvidence, "sourceId" | "revision">;

/** Use only with an allowlist produced by the server-side source authorization fixture. */
export function evaluationEvidenceKey(identity: EvaluationEvidenceIdentity): string {
  return `${identity.sourceId}@${String(identity.revision)}`;
}

/**
 * Projects a case through a model-input allowlist. Case entitlements and expected
 * labels do not authorize evidence; the caller must supply the server's current
 * authorized source identities for this run.
 */
export function projectEvaluationModelInput(
  value: unknown,
  serverAuthorizedEvidence: ReadonlySet<string>,
): EvaluationModelInput {
  const evaluationCase = evaluationCaseSchema.parse(value);
  const modelEvidence = (evaluationCase.modelEvidence ?? [])
    .filter((evidence) => serverAuthorizedEvidence.has(evaluationEvidenceKey(evidence)))
    .map(({ sourceId, revision, title, text }) => ({ sourceId, revision, title, text }));

  return evaluationModelInputSchema.parse({
    clock: evaluationCase.clock,
    userMessages: evaluationCase.userMessages,
    evidence: modelEvidence,
  });
}
