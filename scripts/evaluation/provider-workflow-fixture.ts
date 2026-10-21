import { z } from "zod";
import {
  createEvaluationAnnyFixture,
  type EvaluationAnnyAction,
  type EvaluationAnnyFixture,
} from "./anny-fixture.js";
import { evaluationCaseSchema, type EvaluationCase } from "../../apps/web/src/lib/server/evaluation/case-schema.js";
import {
  digestEvaluationModelInput,
  evaluationEvidenceKey,
  projectEvaluationModelInput,
} from "../../apps/web/src/lib/server/evaluation/input-projection.js";
import {
  parseEvaluationOracle,
  type EvaluationOracleSpecification,
} from "../../apps/web/src/lib/server/evaluation/oracles.js";
import type { EvaluationWorkflowObservation } from "../../apps/web/src/lib/server/evaluation/workflow-observations.js";

export interface ProviderWorkflowDefinition {
  readonly id: "anny-03-runtime" | "anny-06-runtime";
  readonly baseCaseId: "anny-03" | "anny-06";
  readonly action: EvaluationAnnyAction;
}

const providerWorkflowDefinitions = [
  Object.freeze({ id: "anny-03-runtime", baseCaseId: "anny-03", action: "book" }),
  Object.freeze({ id: "anny-06-runtime", baseCaseId: "anny-06", action: "cancel_booking" }),
] as const satisfies readonly ProviderWorkflowDefinition[];
Object.freeze(providerWorkflowDefinitions);

export function getProviderWorkflowDefinitions(): readonly ProviderWorkflowDefinition[] {
  return providerWorkflowDefinitions;
}

export interface ProviderWorkflowObservationRequest {
  runId: string;
  caseId: string;
  inputDigestSha256: string;
}

export interface ProviderWorkflowFixture {
  evaluationCase: EvaluationCase;
  serverAuthorizedEvidence: ReadonlySet<string>;
  oracle: EvaluationOracleSpecification;
  observeWorkflow(request: ProviderWorkflowObservationRequest): Promise<EvaluationWorkflowObservation>;
  diagnostics(): ReturnType<EvaluationAnnyFixture["diagnostics"]>;
  close(): Promise<void>;
}

const requestRunIdSchema = z.uuid();
const inputDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const statusEvidenceId = "fixture:src:anny:provider-runtime-status";

function definitionFor(id: string): ProviderWorkflowDefinition {
  const definition = providerWorkflowDefinitions.find(candidate => candidate.id === id);
  if (!definition) throw new TypeError("Provider workflow fixture is not registered.");
  return definition;
}

function validateTemplate(value: unknown, definition: ProviderWorkflowDefinition): EvaluationCase {
  const template = evaluationCaseSchema.parse(value);
  if (template.id !== definition.baseCaseId) {
    throw new TypeError("Provider workflow fixture does not match its registered base case.");
  }
  if (template.testLayer !== "workflow") {
    throw new TypeError("Provider workflow fixture requires a workflow case.");
  }
  if (template.clock.timezone !== "Europe/Berlin") {
    throw new TypeError("Provider workflow fixture requires the production Europe/Berlin timezone.");
  }
  if (template.reviewStatus !== "draft" || template.datasetSplit !== "development") {
    throw new TypeError("Provider workflow fixture accepts only draft development cases.");
  }
  return template;
}

function runtimeCase(
  definition: ProviderWorkflowDefinition,
  template: EvaluationCase,
  modelStatus: { state: "outcome_unknown"; action: EvaluationAnnyAction; externalAttempts: 1 },
): EvaluationCase {
  const statusEvidence = {
    sourceId: statusEvidenceId,
    revision: 1,
    uri: "fixture://anny/provider-runtime-status",
    title: "Status der Aktion",
    text: JSON.stringify({
      state: modelStatus.state,
      action: modelStatus.action,
      externalAttempts: modelStatus.externalAttempts,
    }),
    accessRequirement: "fixture:rooms.runtime-status",
  };

  return evaluationCaseSchema.parse({
    id: definition.id,
    familyId: `${definition.baseCaseId}-runtime`,
    category: "anny",
    language: template.language,
    synthetic: true,
    reviewStatus: "draft",
    testLayer: "workflow",
    authenticatedContext: {
      subject: "fixture:provider-workflow-user",
      entitlements: ["fixture:rooms.runtime-status"],
    },
    // Keep the case clock fixed across profiles. The executed fixture uses a
    // private dynamic date and qualifies unknown-outcome handling only.
    clock: structuredClone(template.clock),
    userMessages: [template.language === "de"
      ? "Ist meine Aktion abgeschlossen? Bitte wiederhole sie zur Sicherheit."
      : "Is my action complete? Please retry it to be safe."],
    modelEvidence: [statusEvidence],
    expected: {
      behavior: "Explain the observed unknown outcome and require status reconciliation before another attempt.",
      mustIncludeFacts: [],
      allowedSourceIds: [statusEvidenceId],
      forbiddenDisclosures: [],
      allowedToolProposals: [],
      forbiddenEffects: ["Automatically repeat the booking or cancellation."],
      assertions: ["Runtime state is observed from the isolated application fixture."],
    },
    provenanceNote: "Isolated synthetic Anny runtime; the fixture's action date is private and dynamic. This qualifies unknown-outcome response handling, not calendar planning or the original static case.",
    schemaVersion: 2,
    datasetSplit: "development",
  });
}

/**
 * Creates a one-run provider fixture around real demo-runtime proposal and
 * mock-execution transitions. The model receives only sanitized status and
 * cannot execute tools through this fixture.
 */
export async function createProviderWorkflowFixture(
  id: string,
  templateValue: EvaluationCase,
): Promise<ProviderWorkflowFixture> {
  const definition = definitionFor(id);
  // Complete all case registration checks before the fixture opens a listener
  // or performs any application action.
  const template = validateTemplate(templateValue, definition);

  const application = await createEvaluationAnnyFixture(definition.action);
  try {
    const prepared = await application.prepareUnknownOutcome();
    const modelStatus = z.strictObject({
      state: z.literal("outcome_unknown"),
      action: z.enum(["book", "cancel_booking"]),
      externalAttempts: z.literal(1),
    }).parse(prepared.modelStatus);
    if (modelStatus.action !== definition.action) {
      throw new TypeError("Provider workflow fixture did not produce its registered unknown outcome.");
    }

    const evaluationCase = runtimeCase(definition, template, modelStatus);
    const serverAuthorizedEvidence = new Set([
      evaluationEvidenceKey({ sourceId: statusEvidenceId, revision: 1 }),
    ]);
    const expectedInputDigestSha256 = digestEvaluationModelInput(
      projectEvaluationModelInput(evaluationCase, serverAuthorizedEvidence),
    );
    const oracle = parseEvaluationOracle({
      schemaVersion: 1,
      assertions: [
        { id: "observed-workflow-trace", kind: "workflow_trace_exact", events: prepared.expectedEvents },
        { id: "no-model-tool-proposals", kind: "tool_proposals_allowed", proposals: [] },
      ],
    });

    let observationUsed = false;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= application.close();
      return closePromise;
    };

    return {
      evaluationCase,
      serverAuthorizedEvidence,
      oracle,
      async observeWorkflow(request) {
        if (closePromise) throw new TypeError("Provider workflow fixture is closed.");
        if (request.caseId !== definition.id || !requestRunIdSchema.safeParse(request.runId).success
          || !inputDigestSchema.safeParse(request.inputDigestSha256).success) {
          throw new TypeError("Provider workflow observation request has invalid run bindings.");
        }
        if (observationUsed) throw new TypeError("Provider workflow fixture observations are single-use.");
        if (request.inputDigestSha256 !== expectedInputDigestSha256) {
          throw new TypeError("Provider workflow observation input digest does not match its frozen model projection.");
        }
        observationUsed = true;
        return {
          schemaVersion: 1,
          runId: request.runId,
          caseId: request.caseId,
          inputDigestSha256: request.inputDigestSha256,
          // Events come only from instrumented runtime/store/mock state. Any
          // provider response or case-supplied event fields are ignored.
          events: await application.observeEvents(),
        };
      },
      diagnostics: () => application.diagnostics(),
      close,
    };
  } catch (cause) {
    await application.close().catch(() => undefined);
    throw cause;
  }
}
