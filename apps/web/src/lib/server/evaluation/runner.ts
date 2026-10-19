import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  boundedEvaluationJsonObjectSchema,
  evaluationCaseSchema,
  preflightEvaluationJson,
  type EvaluationCase,
} from "./case-schema";
import {
  projectEvaluationModelInput,
  type EvaluationModelInput,
} from "./input-projection";
import {
  assessEvaluationOracle,
  parseEvaluationOracle,
  type EvaluationOracleAssessment,
} from "./oracles";

const syntheticMeasurementsSchema = z.strictObject({
  kind: z.literal("synthetic"),
  latencyMs: z.number().min(0).max(120_000),
  inputTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(0).max(100_000),
  estimatedCostUsd: z.number().min(0).max(100_000),
});

const transportResponseShape = z.strictObject({
  text: z.string().max(20_000),
  citations: z.array(z.strictObject({
    sourceId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u),
    revision: z.number().int().min(1).max(10_000),
  })).max(32),
  proposedCalls: z.array(z.strictObject({
    tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    arguments: boundedEvaluationJsonObjectSchema,
  })).max(32),
  measurements: syntheticMeasurementsSchema,
});

const transportResponseSchema = z.preprocess((value, context) => {
  const preflight = preflightEvaluationJson(value, {
    maxBytes: 256 * 1024,
    maxNodes: 20_000,
    maxDepth: 32,
    maxObjectKeys: 64,
    maxArrayItems: 100,
    maxStringLength: 20_000,
  });
  if (!preflight.success) {
    context.addIssue({ code: "custom", message: "Transport response is not bounded plain JSON data." });
    return z.NEVER;
  }
  return preflight.value;
}, transportResponseShape);

export type EvaluationTransportResponse = z.infer<typeof transportResponseSchema>;
export type EvaluationTransport = (input: EvaluationModelInput) => Promise<unknown>;

export interface EvaluationRunDependencies {
  /** Server-produced evidence identity allowlist for this synthetic fixture run. */
  serverAuthorizedEvidence: ReadonlySet<string>;
  /** Optional server-owned deterministic assertions; this is never case or model input. */
  oracle?: unknown;
  /** Required injection point. This module deliberately provides no transport implementation. */
  transport: EvaluationTransport;
}

interface NotRunAssessment {
  status: "not_run";
  reason: "transport_error" | "invalid_transport_response";
}

interface NotAssessed {
  status: "not_assessed";
  reason: "synthetic_transport_only";
}

type RunMetadata = Pick<EvaluationCase, "id" | "familyId" | "datasetSplit" | "reviewStatus">;

export type EvaluationRun = RunMetadata & {
  runKind: "offline_fixture_transport";
  inputDigestSha256: string;
} & (
  | {
      transport: { status: "error"; errorCode: "injected_transport_failed" };
      assessment: NotRunAssessment;
    }
  | {
      transport: { status: "invalid_response"; errorCode: "transport_response_schema_invalid" };
      assessment: NotRunAssessment;
    }
  | {
      transport: { status: "completed"; response: EvaluationTransportResponse };
      assessment: NotAssessed | EvaluationOracleAssessment;
    }
);

function digestModelInput(input: EvaluationModelInput): string {
  return createHash("sha256")
    .update("hasi-evaluation-model-input-v1\0")
    .update(JSON.stringify(input))
    .digest("hex");
}

function runMetadata(evaluationCase: EvaluationCase): RunMetadata {
  return {
    id: evaluationCase.id,
    familyId: evaluationCase.familyId,
    datasetSplit: evaluationCase.datasetSplit,
    reviewStatus: evaluationCase.reviewStatus,
  };
}

/**
 * Runs only an explicitly injected transport against the allowlisted projection.
 * It never executes tools and never grades a synthetic response as model quality.
 */
export async function runEvaluationCase(
  value: unknown,
  dependencies: EvaluationRunDependencies,
): Promise<EvaluationRun> {
  if (typeof dependencies.transport !== "function") {
    throw new TypeError("An evaluation transport must be explicitly injected.");
  }

  const evaluationCase = evaluationCaseSchema.parse(value);
  const input = projectEvaluationModelInput(evaluationCase, dependencies.serverAuthorizedEvidence);
  const oracle = dependencies.oracle === undefined
    ? undefined
    : parseEvaluationOracle(dependencies.oracle);
  const metadata = runMetadata(evaluationCase);
  const inputDigestSha256 = digestModelInput(input);
  const common = {
    ...metadata,
    runKind: "offline_fixture_transport" as const,
    inputDigestSha256,
  };

  let responseValue: unknown;
  try {
    responseValue = await dependencies.transport(structuredClone(input));
  } catch {
    return {
      ...common,
      transport: { status: "error", errorCode: "injected_transport_failed" },
      assessment: { status: "not_run", reason: "transport_error" },
    };
  }

  const response = transportResponseSchema.safeParse(responseValue);
  if (!response.success) {
    return {
      ...common,
      transport: { status: "invalid_response", errorCode: "transport_response_schema_invalid" },
      assessment: { status: "not_run", reason: "invalid_transport_response" },
    };
  }

  return {
    ...common,
    transport: { status: "completed", response: response.data },
    assessment: oracle
      ? assessEvaluationOracle(oracle, response.data, input)
      : { status: "not_assessed", reason: "synthetic_transport_only" },
  };
}
