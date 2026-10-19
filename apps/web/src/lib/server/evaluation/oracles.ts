import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedEvaluationJsonObjectSchema, preflightEvaluationJson } from "./case-schema";
import type { EvaluationModelInput } from "./input-projection";

const MAX_ORACLE_BYTES = 256 * 1024;
const MAX_ORACLE_NODES = 12_000;

const assertionIdSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/u);
const sourceIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);
const revisionSchema = z.number().int().min(1).max(10_000);
const citationIdentitySchema = z.strictObject({
  sourceId: sourceIdSchema,
  revision: revisionSchema,
});

const toolProposalSchema = z.strictObject({
  tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  arguments: boundedEvaluationJsonObjectSchema,
});

const assertionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("text_contains"),
    text: z.string().min(1).max(2_000),
  }),
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("text_not_contains"),
    text: z.string().min(1).max(2_000),
  }),
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("citations_required"),
    citations: z.array(citationIdentitySchema).min(1).max(32),
  }),
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("citations_allowed"),
    citations: z.array(citationIdentitySchema).max(32),
  }),
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("tool_proposals_required"),
    proposals: z.array(toolProposalSchema).min(1).max(32),
  }),
  z.strictObject({
    id: assertionIdSchema,
    kind: z.literal("tool_proposals_allowed"),
    proposals: z.array(toolProposalSchema).max(32),
  }),
]);

const evaluationOracleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assertions: z.array(assertionSchema).min(1).max(64),
}).superRefine((oracle, context) => {
  const ids = new Set<string>();
  oracle.assertions.forEach((assertion, index) => {
    if (ids.has(assertion.id)) {
      context.addIssue({
        code: "custom",
        path: ["assertions", index, "id"],
        message: "Assertion IDs must be unique within an oracle.",
      });
    }
    ids.add(assertion.id);

    if (assertion.kind === "citations_required" || assertion.kind === "citations_allowed") {
      const identities = new Set<string>();
      assertion.citations.forEach((citation, citationIndex) => {
        const key = citationKey(citation);
        if (identities.has(key)) {
          context.addIssue({
            code: "custom",
            path: ["assertions", index, "citations", citationIndex],
            message: "Citation identities must be unique within an assertion.",
          });
        }
        identities.add(key);
      });
    }
  });
});

export type EvaluationOracleSpecification = z.infer<typeof evaluationOracleSchema>;

export interface EvaluationOracleResponse {
  text: string;
  citations: { sourceId: string; revision: number }[];
  proposedCalls: { tool: string; arguments: Record<string, unknown> }[];
}

export type EvaluationOracleAssertionKind = EvaluationOracleSpecification["assertions"][number]["kind"]
  | "projection_citations_authorized";

export interface EvaluationOracleAssertionResult {
  id: string;
  kind: EvaluationOracleAssertionKind;
  status: "passed" | "failed";
}

export interface EvaluationOracleAssessment {
  kind: "deterministic_fixture_oracle";
  scope: "synthetic_offline_fixture_only";
  oracleDigestSha256: string;
  status: "passed" | "failed";
  assertions: EvaluationOracleAssertionResult[];
}

/**
 * Validates and copies the server-owned oracle before a transport can run.
 * The bounded preflight rejects proxies, accessors, cycles, and non-JSON data
 * without reading accessor values.
 */
export function parseEvaluationOracle(value: unknown): EvaluationOracleSpecification {
  const bounded = preflightEvaluationJson(value, {
    maxBytes: MAX_ORACLE_BYTES,
    maxNodes: MAX_ORACLE_NODES,
    maxDepth: 16,
    maxObjectKeys: 64,
    maxArrayItems: 100,
    maxStringLength: 16_384,
  });
  if (!bounded.success) {
    throw new TypeError("Evaluation oracle must be bounded plain JSON data.");
  }
  return evaluationOracleSchema.parse(bounded.value);
}

function citationKey(citation: { sourceId: string; revision: number }): string {
  return `${citation.sourceId}@${String(citation.revision)}`;
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

function proposalKey(proposal: { tool: string; arguments: Record<string, unknown> }): string {
  return `${proposal.tool}\0${canonicalJson(proposal.arguments)}`;
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function requiredProposalsPresent(
  required: { tool: string; arguments: Record<string, unknown> }[],
  actual: { tool: string; arguments: Record<string, unknown> }[],
): boolean {
  const requiredCounts = counts(required.map(proposalKey));
  const actualCounts = counts(actual.map(proposalKey));
  return [...requiredCounts].every(([key, count]) => (actualCounts.get(key) ?? 0) >= count);
}

function actualProposalsAllowed(
  actual: { tool: string; arguments: Record<string, unknown> }[],
  allowed: { tool: string; arguments: Record<string, unknown> }[],
): boolean {
  const actualCounts = counts(actual.map(proposalKey));
  const allowedCounts = counts(allowed.map(proposalKey));
  return [...actualCounts].every(([key, count]) => count <= (allowedCounts.get(key) ?? 0));
}

function result(
  id: string,
  kind: EvaluationOracleAssertionKind,
  passed: boolean,
): EvaluationOracleAssertionResult {
  return { id, kind, status: passed ? "passed" : "failed" };
}

/**
 * Applies only literal and exact-identity checks. This function evaluates the
 * parsed transport response and the exact authorized model projection; it
 * never invokes or executes proposed tools.
 */
export function assessEvaluationOracle(
  oracle: EvaluationOracleSpecification,
  response: EvaluationOracleResponse,
  modelInput: EvaluationModelInput,
): EvaluationOracleAssessment {
  const authorizedCitationKeys = new Set(modelInput.evidence.map(citationKey));
  const actualCitationKeys = response.citations.map(citationKey);
  const assertionResults: EvaluationOracleAssertionResult[] = [
    result(
      "$projection.authorized-citations",
      "projection_citations_authorized",
      actualCitationKeys.every((key) => authorizedCitationKeys.has(key)),
    ),
  ];

  for (const assertion of oracle.assertions) {
    switch (assertion.kind) {
      case "text_contains":
        assertionResults.push(result(assertion.id, assertion.kind, response.text.includes(assertion.text)));
        break;
      case "text_not_contains":
        assertionResults.push(result(assertion.id, assertion.kind, !response.text.includes(assertion.text)));
        break;
      case "citations_required": {
        const requiredKeys = assertion.citations.map(citationKey);
        const declaredCitationsAuthorized = requiredKeys.every((key) => authorizedCitationKeys.has(key));
        assertionResults.push(result(
          assertion.id,
          assertion.kind,
          declaredCitationsAuthorized && requiredKeys.every((key) => actualCitationKeys.includes(key)),
        ));
        break;
      }
      case "citations_allowed": {
        const allowedKeys = new Set(assertion.citations.map(citationKey));
        const declaredCitationsAuthorized = [...allowedKeys].every((key) => authorizedCitationKeys.has(key));
        assertionResults.push(result(
          assertion.id,
          assertion.kind,
          declaredCitationsAuthorized && actualCitationKeys.every((key) => allowedKeys.has(key)),
        ));
        break;
      }
      case "tool_proposals_required":
        assertionResults.push(result(
          assertion.id,
          assertion.kind,
          requiredProposalsPresent(assertion.proposals, response.proposedCalls),
        ));
        break;
      case "tool_proposals_allowed":
        assertionResults.push(result(
          assertion.id,
          assertion.kind,
          actualProposalsAllowed(response.proposedCalls, assertion.proposals),
        ));
        break;
    }
  }

  return {
    kind: "deterministic_fixture_oracle",
    scope: "synthetic_offline_fixture_only",
    oracleDigestSha256: createHash("sha256")
      .update("hasi-evaluation-oracle-v1\0")
      .update(canonicalJson(oracle))
      .digest("hex"),
    status: assertionResults.every((assertion) => assertion.status === "passed") ? "passed" : "failed",
    assertions: assertionResults,
  };
}
