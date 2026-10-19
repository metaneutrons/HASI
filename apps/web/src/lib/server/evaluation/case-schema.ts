import "server-only";

import { isProxy } from "node:util/types";
import { z } from "zod";

const MAX_CASES = 200;
const MAX_DATASET_BYTES = 16 * 1024 * 1024;
const MAX_CASE_BYTES = 2 * 1024 * 1024;
const MAX_CASE_NODES = 20_000;
const MAX_DATASET_NODES = 1 + MAX_CASES * MAX_CASE_NODES;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORD_NODES = 20_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 2_000;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 100;
const MAX_JSON_STRING_LENGTH = 16_384;

const caseIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const familyIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const sourceIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);
const entitlementSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u);
const boundedText = (maximum: number) => z.string().min(1).max(maximum);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface EvaluationJsonBudget {
  maxBytes: number;
  maxNodes: number;
  maxDepth?: number;
  maxObjectKeys?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
}

export type EvaluationJsonPreflight =
  | { success: true; value: JsonValue }
  | { success: false; reason: string };

/**
 * Copies only ordinary JSON data properties while enforcing a shared byte and
 * node budget. It reads descriptors rather than property values, so accessors
 * are rejected without invoking them. Proxies, cycles and non-JSON objects are
 * rejected before Zod recursively examines the value.
 */
export function preflightEvaluationJson(
  value: unknown,
  budget: EvaluationJsonBudget,
): EvaluationJsonPreflight {
  const maxDepth = budget.maxDepth ?? 32;
  const maxObjectKeys = budget.maxObjectKeys ?? MAX_OBJECT_KEYS;
  const maxArrayItems = budget.maxArrayItems ?? MAX_ARRAY_ITEMS;
  const maxStringLength = budget.maxStringLength ?? 20_000;
  const encoder = new TextEncoder();
  const active = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;

  const addBytes = (amount: number): boolean => {
    bytes += amount;
    return bytes <= budget.maxBytes;
  };
  const addJsonString = (text: string): boolean => {
    const serialized = JSON.stringify(text);
    return addBytes(encoder.encode(serialized).byteLength);
  };

  const visit = (current: unknown, depth: number): JsonValue | undefined => {
    nodes += 1;
    if (nodes > budget.maxNodes || depth > maxDepth) return undefined;
    if (current === null) return addBytes(4) ? null : undefined;
    if (typeof current === "boolean") return addBytes(current ? 4 : 5) ? current : undefined;
    if (typeof current === "string") {
      return current.length <= maxStringLength && addJsonString(current) ? current : undefined;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) && addBytes(JSON.stringify(current).length) ? current : undefined;
    }
    if (typeof current !== "object" || isProxy(current) || active.has(current)) return undefined;

    active.add(current);
    try {
      if (Array.isArray(current)) {
        const prototype = Object.getPrototypeOf(current) as unknown;
        if (prototype !== Array.prototype || current.length > maxArrayItems) return undefined;
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.length !== current.length + 1 || !addBytes(2 + Math.max(0, current.length - 1))) return undefined;
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        if (!lengthDescriptor || "get" in lengthDescriptor || "set" in lengthDescriptor || lengthDescriptor.value !== current.length) {
          return undefined;
        }

        const clone: JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
          const child = visit(descriptor.value, depth + 1);
          if (child === undefined) return undefined;
          clone.push(child);
        }
        return clone;
      }

      const prototype = Object.getPrototypeOf(current) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.length > maxObjectKeys || !addBytes(2 + Math.max(0, ownKeys.length - 1))) return undefined;
      const clone: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const ownKey of ownKeys) {
        if (typeof ownKey !== "string" || ownKey.length === 0 || ownKey.length > 128 || !addJsonString(ownKey) || !addBytes(1)) {
          return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
        const child = visit(descriptor.value, depth + 1);
        if (child === undefined) return undefined;
        if (ownKey === "__proto__") return undefined;
        clone[ownKey] = child;
      }
      return clone;
    } catch {
      return undefined;
    } finally {
      active.delete(current);
    }
  };

  try {
    const clone = visit(value, 0);
    if (clone === undefined) return { success: false, reason: "Value is not bounded plain JSON data." };
    return { success: true, value: clone };
  } catch {
    return { success: false, reason: "Value is not bounded plain JSON data." };
  }
}

function boundedJsonPreprocess(budget: EvaluationJsonBudget) {
  return (value: unknown, context: z.RefinementCtx): unknown => {
    const result = preflightEvaluationJson(value, budget);
    if (!result.success) {
      context.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.value;
  };
}

const boundedJsonValueSchema = z.unknown().refine(
  (value): value is JsonValue => preflightEvaluationJson(value, {
    maxBytes: MAX_RECORD_BYTES,
    maxNodes: MAX_JSON_NODES,
    maxDepth: MAX_JSON_DEPTH,
    maxObjectKeys: MAX_OBJECT_KEYS,
    maxArrayItems: MAX_ARRAY_ITEMS,
    maxStringLength: MAX_JSON_STRING_LENGTH,
  }).success,
  "Value must be bounded JSON.",
);

const boundedEvaluationJsonObjectShape = z.record(z.string().min(1).max(128), boundedJsonValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    context.addIssue({ code: "custom", message: "Object has too many keys." });
  }
});

export const boundedEvaluationJsonObjectSchema = z.preprocess(boundedJsonPreprocess({
  maxBytes: MAX_RECORD_BYTES,
  maxNodes: MAX_RECORD_NODES,
  maxDepth: MAX_JSON_DEPTH,
  maxObjectKeys: MAX_OBJECT_KEYS,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxStringLength: MAX_JSON_STRING_LENGTH,
}), boundedEvaluationJsonObjectShape);

export const evaluationEvidenceSchema = z.strictObject({
  sourceId: sourceIdSchema,
  revision: z.number().int().min(1).max(10_000),
  uri: z.string().min(1).max(512).regex(/^fixture:\/\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~/-]*)?$/u),
  title: boundedText(512),
  text: z.string().max(20_000),
  accessRequirement: entitlementSchema,
});

const expectedToolProposalSchema = z.strictObject({
  tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  arguments: boundedEvaluationJsonObjectSchema,
});

const expectedSchema = z.strictObject({
  behavior: boundedText(2_000),
  mustIncludeFacts: z.array(boundedText(2_000)).max(64),
  allowedSourceIds: z.array(sourceIdSchema).max(64),
  forbiddenDisclosures: z.array(boundedText(2_000)).max(64),
  allowedToolProposals: z.array(expectedToolProposalSchema).max(32),
  forbiddenEffects: z.array(boundedText(2_000)).max(64),
  assertions: z.array(boundedText(2_000)).max(64),
});

const authenticatedContextSchema = z.strictObject({
  subject: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  entitlements: z.array(entitlementSchema).max(64),
});

export const evaluationClockSchema = z.strictObject({
  now: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(128).refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Timezone must be an IANA timezone identifier."),
});

const evaluationCaseShape = z.strictObject({
  id: caseIdSchema,
  familyId: familyIdSchema,
  category: z.enum(["service_it", "intranet", "anny", "access", "prompt_injection"]),
  language: z.enum(["de", "en"]),
  synthetic: z.literal(true),
  reviewStatus: z.enum(["draft", "reviewed", "adjudicated"]),
  testLayer: z.enum(["retrieval", "fixed_evidence", "workflow", "application_policy"]),
  authenticatedContext: authenticatedContextSchema,
  clock: evaluationClockSchema,
  userMessages: z.array(boundedText(4_000)).min(1).max(20),
  modelEvidence: z.array(evaluationEvidenceSchema).max(32).optional(),
  candidateDocuments: z.array(evaluationEvidenceSchema).max(32).optional(),
  toolFixtures: boundedEvaluationJsonObjectSchema.optional(),
  trustedApplicationContext: boundedEvaluationJsonObjectSchema.optional(),
  applicationEvents: z.array(boundedEvaluationJsonObjectSchema).max(100).optional(),
  expected: expectedSchema,
  provenanceNote: boundedText(2_000),
  schemaVersion: z.literal(2),
  datasetSplit: z.enum(["development", "validation", "blind_final"]),
}).superRefine((evaluationCase, context) => {
  for (const field of ["modelEvidence", "candidateDocuments"] as const) {
    const seen = new Set<string>();
    for (const [index, evidence] of (evaluationCase[field] ?? []).entries()) {
      const identity = `${evidence.sourceId}@${String(evidence.revision)}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [field, index, "sourceId"],
          message: "Evidence identities must be unique within a case.",
        });
      }
      seen.add(identity);
    }
  }
});

export const evaluationCaseSchema = z.preprocess(boundedJsonPreprocess({
  maxBytes: MAX_CASE_BYTES,
  maxNodes: MAX_CASE_NODES,
  maxDepth: 32,
  maxObjectKeys: MAX_OBJECT_KEYS,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxStringLength: 20_000,
}), evaluationCaseShape);

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type EvaluationEvidence = z.infer<typeof evaluationEvidenceSchema>;

const evaluationDatasetShape = z.array(evaluationCaseSchema).min(1).max(MAX_CASES).superRefine((cases, context) => {
  const seen = new Set<string>();
  for (const [index, evaluationCase] of cases.entries()) {
    if (seen.has(evaluationCase.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "Evaluation case IDs must be unique.",
      });
    }
    seen.add(evaluationCase.id);
  }
});

export const evaluationDatasetSchema = z.preprocess(boundedJsonPreprocess({
  maxBytes: MAX_DATASET_BYTES,
  maxNodes: MAX_DATASET_NODES,
  maxDepth: 32,
  maxArrayItems: MAX_CASES,
  maxStringLength: 20_000,
}), evaluationDatasetShape);

export function parseEvaluationDataset(value: unknown): EvaluationCase[] {
  return evaluationDatasetSchema.parse(value);
}
