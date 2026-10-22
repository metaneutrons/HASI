import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fromMarkdown } from "mdast-util-from-markdown";
import { chatRequestSchema, type WireMessage } from "../../chat-contract";
import { loadModelConfiguration, resolveModelConnection } from "../model-config";
import { loadModelPrices, modelPrice, type ModelPrice } from "../model-budgets";
import { ModelRouterError, runModelStep, type ModelBudgetAdmission } from "../model-router";
import { evaluationCaseSchema } from "./case-schema";
import { digestEvaluationModelInput, projectEvaluationModelInput, type EvaluationModelInput } from "./input-projection";
import { assessEvaluationOracle, parseEvaluationOracle, type EvaluationOracleAssessment, type EvaluationOracleResponse } from "./oracles";
import { createProviderObservationMeter, type ProviderMeasurements } from "./provider-observations";
import { parseEvaluationWorkflowObservation, type EvaluationWorkflowObservation } from "./workflow-observations";

export interface ProviderWorkflowObservationRequest {
  runId: string;
  caseId: string;
  inputDigestSha256: string;
  response: EvaluationOracleResponse;
}

/** Trusted fixture instrumentation, never a case field or model response. */
export type ProviderWorkflowObserver = (request: ProviderWorkflowObservationRequest) => Promise<unknown>;

export interface ProviderEvaluationDependencies {
  /** Operator-selected approved profile, never taken from the case or model output. */
  profileId: string;
  serverAuthorizedEvidence: ReadonlySet<string>;
  /** Live callers must supply existing shared durable admission, never a fresh local ledger. */
  budgetAdmission: ModelBudgetAdmission;
  oracle?: unknown;
  /** Required for an observed workflow; never creates or executes a model tool. */
  observeWorkflow?: ProviderWorkflowObserver;
  /** Actual HTTP attempt cap, including provider-specific repair calls. */
  maxProviderRequests?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Explicit synthetic transport seam for development tests; no implicit offline fallback. */
  fetch?: typeof fetch;
}

export interface ProviderEvaluationRun {
  runKind: "provider_fixed_evidence" | "provider_observed_workflow";
  workflowRunId?: string;
  caseId: string;
  familyId: string;
  datasetSplit: "development" | "validation" | "blind_final";
  reviewStatus: "draft" | "reviewed" | "adjudicated";
  inputDigestSha256: string;
  configurationDigestSha256: string;
  requestDigestsSha256: string[];
  pricing: ModelPrice;
  pricingDigestSha256: string;
  profile: { id: string; provider: string; modelId: string; resolvedProviderVersion: null };
  measurements: ProviderMeasurements;
  transport: { status: "completed"; response: EvaluationOracleResponse }
    | { status: "error"; code: string; providerStatus?: number; retryAfterSeconds?: number };
  assessment: (Omit<EvaluationOracleAssessment, "scope"> & { scope: "synthetic_fixed_evidence_only" | "synthetic_observed_workflow_only" }) | { status: "not_assessed"; reason: "no_quality_oracle" }
    | { status: "not_run"; reason: "provider_or_contract_error" | "workflow_observer_error" | "invalid_workflow_observation" };
}

function evidenceMessages(input: EvaluationModelInput): WireMessage[] {
  const messages: WireMessage[] = input.userMessages.map(content => ({ role: "user", content }));
  if (input.evidence.length) {
    // Runtime status is frozen as evidence, through the same read-only envelope
    // as knowledge cases. It is not a production actionContext injection or an
    // invented authorized tool history. The independent observer owns effects.
    const toolCallId = "evaluation-fixed-evidence";
    messages.push({ role: "assistant", content: "", toolCalls: [
      { id: toolCallId, name: "knowledge_search", arguments: { query: "Bereitgestellte Quellen" } },
    ] });
    messages.push({ role: "tool", name: "knowledge_search", toolCallId, content: JSON.stringify({
      documents: input.evidence.map(evidence => ({
        id: evidence.sourceId, title: evidence.title, text: evidence.text,
        revision: evidence.revision,
        citationId: `knowledge:${evidence.sourceId}:${String(evidence.revision)}`,
      })),
    }) });
  }
  return messages;
}

function responseCitations(text: string): EvaluationOracleResponse["citations"] {
  const citations: EvaluationOracleResponse["citations"] = [];
  const seen = new Set<string>();
  const ignored = new Set(["code", "inlineCode", "link", "linkReference", "image", "imageReference", "html"]);
  const visit = (node: { type: string; value?: string; children?: readonly unknown[] }) => {
    if (ignored.has(node.type)) return;
    if (node.type === "text" && node.value) {
      for (const match of node.value.matchAll(/\[knowledge:([^\]\r\n]{1,512})\]/gu)) {
        const identity = /^([A-Za-z0-9][A-Za-z0-9:._-]{0,159}):([1-9]\d{0,4})$/u.exec(match[1] ?? "");
        if (!identity?.[1] || !identity[2] || Number(identity[2]) > 10_000) {
          throw new ModelRouterError("invalid_model_response", "The model returned an invalid evaluation citation.");
        }
        const key = `${identity[1]}@${identity[2]}`;
        if (!seen.has(key)) citations.push({ sourceId: identity[1], revision: Number(identity[2]) });
        seen.add(key);
        if (citations.length > 32) throw new ModelRouterError("invalid_model_response", "Too many evaluation citations.");
      }
    }
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(fromMarkdown(text));
  return citations;
}

/**
 * Executes the existing router on authorized evidence or a separately observed
 * synthetic workflow. It has no model tool executor, source fetcher, automatic
 * fallback, storage initialization or grading-label projection. Application-policy
 * cases remain rejected; a workflow requires explicit trusted instrumentation.
 */
export async function runProviderEvaluationCase(value: unknown, dependencies: ProviderEvaluationDependencies): Promise<ProviderEvaluationRun> {
  const evaluationCase = evaluationCaseSchema.parse(value);
  const workflow = evaluationCase.testLayer === "workflow";
  if (!workflow && evaluationCase.testLayer !== "fixed_evidence") {
    throw new TypeError("Provider evaluation requires fixed evidence or a registered observed workflow.");
  }
  if (typeof dependencies.budgetAdmission.reserve !== "function") {
    throw new TypeError("Provider evaluation requires explicitly supplied shared budget admission.");
  }
  const oracle = dependencies.oracle === undefined ? undefined : parseEvaluationOracle(dependencies.oracle);
  const requiresWorkflow = oracle?.assertions.some(assertion => assertion.kind === "workflow_trace_exact") ?? false;
  if (workflow && (!requiresWorkflow || typeof dependencies.observeWorkflow !== "function")) {
    throw new TypeError("A provider workflow requires an explicit workflow oracle and trusted observer.");
  }
  if (!workflow && (requiresWorkflow || dependencies.observeWorkflow !== undefined)) {
    throw new TypeError("A fixed-evidence provider run cannot establish workflow observations.");
  }
  const maxProviderRequests = dependencies.maxProviderRequests ?? 16;
  if (!Number.isInteger(maxProviderRequests) || maxProviderRequests < 1 || maxProviderRequests > 16) {
    throw new TypeError("Provider request cap must be an integer between 1 and 16.");
  }
  if (evaluationCase.clock.timezone !== "Europe/Berlin") {
    throw new TypeError("This router evaluation requires the production Europe/Berlin timezone.");
  }
  const input = projectEvaluationModelInput(evaluationCase, dependencies.serverAuthorizedEvidence);
  const environment = dependencies.env ?? process.env;
  const configuration = loadModelConfiguration(environment);
  const profile = configuration.profiles.find(candidate => candidate.id === dependencies.profileId);
  const connection = configuration.connections.find(candidate => candidate.id === profile?.connectionId);
  if (!profile || !connection) throw new TypeError("The operator-selected evaluation profile is not configured.");
  const selected = configuration.policy.defaultProfileId === profile.id
    || (configuration.policy.userChoice.enabled && configuration.policy.userChoice.profileIds.includes(profile.id));
  if (!selected || !profile.allowedDataClasses.includes("synthetic_demo")) {
    throw new TypeError("The evaluation profile is not approved for this synthetic context.");
  }
  const messages = evidenceMessages(input);
  const request = chatRequestSchema.parse({ profileId: profile.id, messages });
  const prices = loadModelPrices(environment);
  const pricing = modelPrice(profile.id, configuration, prices);
  if (!pricing) throw new ModelRouterError("budget_unpriced", "The evaluation profile has no approved price.");
  const meter = createProviderObservationMeter({ admission: dependencies.budgetAdmission, configuration, prices });
  // Each actual HTTP request consumes one current admitted reservation. Even an
  // unexpected SDK-internal second fetch cannot reuse an earlier admission.
  const dispatchReservations: { dispatched: boolean; settled: boolean }[] = [];
  const budgetAdmission: ModelBudgetAdmission = {
    async reserve(request) {
      const reservation = await meter.admission.reserve(request);
      const permit = { dispatched: false, settled: false };
      dispatchReservations.push(permit);
      return { settle(usage) {
        permit.settled = true;
        return reservation.settle(usage);
      } };
    },
  };
  const requestDigestsSha256: string[] = [];
  const endpoint = new URL(resolveModelConnection(connection).baseURL);
  const upstream = dependencies.fetch ?? fetch;
  const observedFetch: typeof fetch = (target, init) => {
    const destination = new URL(target instanceof Request ? target.url : String(target));
    if (destination.origin !== endpoint.origin || destination.protocol !== "https:"
      || destination.username || destination.password || !destination.pathname.startsWith(`${endpoint.pathname.replace(/\/+$/u, "")}/`)) {
      throw new Error("Provider evaluation rejected an unapproved destination.");
    }
    const body = init?.body;
    if (typeof body !== "string" || Buffer.byteLength(body) > 256 * 1024 || requestDigestsSha256.length >= maxProviderRequests) {
      throw new Error("Provider evaluation rejected an unbounded request.");
    }
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== "object" || !("model" in payload) || payload.model !== profile.modelId) {
      throw new Error("Provider evaluation rejected an unexpected model.");
    }
    const permit = dispatchReservations.find(item => !item.dispatched && !item.settled);
    if (!permit) throw new Error("Provider evaluation requires a fresh admitted reservation for each HTTP request.");
    permit.dispatched = true;
    requestDigestsSha256.push(createHash("sha256").update(body).digest("hex"));
    return upstream(target, { ...init, redirect: "error" });
  };
  const inputDigestSha256 = digestEvaluationModelInput(input);
  const workflowRunId = workflow ? randomUUID() : undefined;
  const common = {
    runKind: workflow ? "provider_observed_workflow" as const : "provider_fixed_evidence" as const,
    ...(workflowRunId ? { workflowRunId } : {}),
    caseId: evaluationCase.id, familyId: evaluationCase.familyId,
    datasetSplit: evaluationCase.datasetSplit, reviewStatus: evaluationCase.reviewStatus,
    inputDigestSha256,
    configurationDigestSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
    requestDigestsSha256,
    pricing: { ...pricing },
    pricingDigestSha256: createHash("sha256").update(JSON.stringify(pricing)).digest("hex"),
    profile: { id: profile.id, provider: connection.provider, modelId: profile.modelId, resolvedProviderVersion: null },
  };
  const started = performance.now();
  try {
    const reply = await runModelStep(request, {
      env: environment, fetch: observedFetch, now: new Date(input.clock.now),
      messageTimes: messages.map(message => message.role === "user" ? input.clock.now : null),
      context: { dataClasses: ["synthetic_demo"], toolsRequired: false },
      authorizedTools: [], budgetAdmission,
    });
    if (reply.profile.id !== profile.id || reply.profile.modelId !== profile.modelId) {
      throw new ModelRouterError("invalid_model_response", "The evaluation returned another model profile.");
    }
    const response = {
      text: reply.message.content, citations: responseCitations(reply.message.content),
      proposedCalls: (reply.message.toolCalls ?? []).map(call => ({ tool: call.name, arguments: call.arguments })),
    };
    // Provider latency excludes fixture observation; retain actual provider usage
    // even if independent instrumentation fails and the case cannot be graded.
    const measurements = meter.snapshot({ latencyMs: performance.now() - started, providerRequestCount: requestDigestsSha256.length });
    let observation: EvaluationWorkflowObservation | undefined;
    if (workflow && workflowRunId && dependencies.observeWorkflow) {
      let observed: unknown;
      try {
        observed = await dependencies.observeWorkflow({ runId: workflowRunId,
          caseId: evaluationCase.id, inputDigestSha256, response: structuredClone(response) });
      } catch {
        return { ...common, measurements, transport: { status: "completed", response },
          assessment: { status: "not_run", reason: "workflow_observer_error" } };
      }
      try {
        observation = parseEvaluationWorkflowObservation(observed);
        if (observation.runId !== workflowRunId || observation.caseId !== evaluationCase.id
          || observation.inputDigestSha256 !== inputDigestSha256) throw new TypeError("Unbound workflow observation.");
      } catch {
        return { ...common, measurements, transport: { status: "completed", response },
          assessment: { status: "not_run", reason: "invalid_workflow_observation" } };
      }
    }
    return { ...common, measurements, transport: { status: "completed", response },
      assessment: oracle ? { ...assessEvaluationOracle(oracle, response, input, observation),
        scope: workflow ? "synthetic_observed_workflow_only" : "synthetic_fixed_evidence_only" }
        : { status: "not_assessed", reason: "no_quality_oracle" },
    };
  } catch (cause) {
    const known = cause instanceof ModelRouterError ? cause : undefined;
    return { ...common,
      measurements: meter.snapshot({ latencyMs: performance.now() - started, providerRequestCount: requestDigestsSha256.length }),
      transport: { status: "error", code: known?.code ?? "provider_evaluation_failed",
        ...(known?.providerStatus !== undefined ? { providerStatus: known.providerStatus } : {}),
        ...(known?.rateLimits?.retryAfterSeconds !== undefined ? { retryAfterSeconds: known.rateLimits.retryAfterSeconds } : {}),
      },
      assessment: { status: "not_run", reason: "provider_or_contract_error" },
    };
  }
}
