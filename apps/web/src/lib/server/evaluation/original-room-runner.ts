import "server-only";

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createEvaluationRoomPlanningFixture } from "../../../../../../scripts/evaluation/room-planning-fixture";
import { createAnnyChatTools } from "../../anny-chat-tools";
import { chatRequestSchema, chatToolSchemas, type WireMessage } from "../../chat-contract";
import { parsePluginTools } from "../../plugin-tools";
import { expectedModelToolName, knownToolAlias } from "../authorized-tools";
import { loadModelConfiguration, resolveModelConnection } from "../model-config";
import { loadModelPrices } from "../model-budgets";
import { runModelStep, type ModelBudgetAdmission } from "../model-router";
import { ModelRouterError } from "../model-router-error";
import { parseGroqRateLimitDiagnostics, type GroqRateLimitDiagnostics } from "../provider-rate-limits";
import { originalRoomCase, createOriginalRoomPlan } from "./original-room-plan";
import { projectEvaluationModelInput, digestEvaluationModelInput } from "./input-projection";
import { createProviderObservationMeter } from "./provider-observations";
import { captureProviderAnswer, readProviderObservationBytes } from "./provider-response-capture";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const allowedTools = new Set(["anny_search_resources", "anny_get_availability", "anny_propose_booking"]);
const resourceId = "fixture-room-R104";
const expectedStart = "2026-10-27T13:00:00.000Z";
const expectedEnd = "2026-10-27T14:00:00.000Z";
type NumericGroqRateLimitDiagnostics = Pick<GroqRateLimitDiagnostics,
  "tokenLimit" | "tokenRemaining" | "requestLimit" | "requestRemaining" | "retryAfterSeconds">;
interface CapturedResponse {
  status: number | null;
  captureStatus: ReturnType<typeof captureProviderAnswer>["captureStatus"] | "transport_unavailable" | "body_unavailable" | "invalid_json";
  responseDigestSha256?: string;
  answer?: ReturnType<typeof captureProviderAnswer>;
  rateLimits?: NumericGroqRateLimitDiagnostics;
}

function numericGroqRateLimitDiagnostics(headers: HeadersInit, observedAt: Date): NumericGroqRateLimitDiagnostics | undefined {
  const parsed = parseGroqRateLimitDiagnostics(headers, undefined, observedAt);
  const numeric: NumericGroqRateLimitDiagnostics = {};
  if (parsed.tokenLimit !== undefined) numeric.tokenLimit = parsed.tokenLimit;
  if (parsed.tokenRemaining !== undefined) numeric.tokenRemaining = parsed.tokenRemaining;
  if (parsed.requestLimit !== undefined) numeric.requestLimit = parsed.requestLimit;
  if (parsed.requestRemaining !== undefined) numeric.requestRemaining = parsed.requestRemaining;
  if (parsed.retryAfterSeconds !== undefined) numeric.retryAfterSeconds = parsed.retryAfterSeconds;
  return Object.keys(numeric).length ? numeric : undefined;
}

function exactAvailability(args: Record<string, unknown>): boolean {
  const p = chatToolSchemas.anny_get_availability.safeParse(args);
  return p.success && p.data.resourceId === resourceId && p.data.date === "2026-10-27"
    && p.data.time === "14:00" && p.data.durationMinutes === 60;
}
function exactProposal(args: Record<string, unknown>): boolean {
  const p = chatToolSchemas.anny_propose_booking.safeParse(args);
  return p.success && p.data.resourceId === resourceId
    && new Date(p.data.startDate).toISOString() === expectedStart && new Date(p.data.endDate).toISOString() === expectedEnd;
}

/** No client-selectable clock, global fetch/env mutation, confirmation or model-callable write. */
export async function runOriginalRoomCase(value: unknown, dependencies: {
  profileId: string; budgetAdmission: ModelBudgetAdmission; maxProviderRequests: number; fetch?: typeof fetch;
}) {
  const { definition, evaluationCase } = originalRoomCase(value);
  const admissionCandidate: unknown = dependencies.budgetAdmission;
  if (typeof admissionCandidate !== "object" || admissionCandidate === null || !("reserve" in admissionCandidate)
    || typeof admissionCandidate.reserve !== "function" || !Number.isInteger(dependencies.maxProviderRequests)
    || dependencies.maxProviderRequests < 1 || dependencies.maxProviderRequests > 6) throw new TypeError("Explicit shared admission and a bounded attempt cap are required.");
  const plan = createOriginalRoomPlan([evaluationCase], [dependencies.profileId], [definition.id], process.env);
  const configuration = loadModelConfiguration(process.env);
  const profile = configuration.profiles.find(p => p.id === dependencies.profileId);
  const connection = configuration.connections.find(c => c.id === profile?.connectionId);
  if (!profile || !connection) throw new TypeError("Unregistered original-case profile.");
  const endpoint = resolveModelConnection(connection);
  const suffix = endpoint.adapter === "anthropic" ? "messages" : endpoint.api === "responses" ? "responses" : "chat/completions";
  const providerUrl = `${endpoint.baseURL.replace(/\/+$/u, "")}/${suffix}`;
  const input = projectEvaluationModelInput(evaluationCase, new Set(definition.sources));
  const meter = createProviderObservationMeter({ admission: dependencies.budgetAdmission, configuration, prices: loadModelPrices(process.env) });
  const started = performance.now();
  const record = {
    kind: "original_room_observation", caseId: definition.id, profileId: profile.id, modelId: profile.modelId,
    caseDigestSha256: definition.digest, inputDigestSha256: digestEvaluationModelInput(input),
    configurationDigestSha256: plan.configurationDigestSha256,
    executionTrack: "controlled_full_original_evidence_and_native_pending_effects",
    caseClock: input.clock, realStartedAt: new Date().toISOString(), realFinishedAt: "",
    input, providerRequests: [] as { digest: string; modelInput: Record<string, unknown> }[],
    providerResponses: [] as CapturedResponse[],
    replies: [] as WireMessage[], attempts: [] as { tool: string; arguments: Record<string, unknown>; disposition: string }[],
    nativeResults: [] as { tool: string; output: Record<string, unknown> }[],
    outcome: "incomplete" as "completed_observation" | "incomplete" | "evaluation_error",
    stopReason: "not_started", fixtureCleanup: "not_created", rejectedToolAttempts: 0,
    errorCode: undefined as ModelRouterError["code"] | "operator_boundary" | undefined,
    providerStatus: undefined as number | undefined,
    transientFailure: undefined as ModelRouterError["transientFailure"],
  };
  let fixture: Awaited<ReturnType<typeof createEvaluationRoomPlanningFixture>> | undefined;
  let apiCalls = 0;
  let generationReserved = false;
  const permits: { dispatched: boolean; settled: boolean }[] = [];
  const deadline = AbortSignal.timeout(90_000);
  const admission: ModelBudgetAdmission = { async reserve(request) {
    if (generationReserved) throw new ModelRouterError("budget_unavailable", "Automatic evaluation retries are disabled.");
    if (permits.length >= dependencies.maxProviderRequests) throw new TypeError("Original-case provider attempt cap reached.");
    const real = await meter.admission.reserve(request);
    generationReserved = true;
    const permit = { dispatched: false, settled: false }; permits.push(permit);
    return { async settle(usage) { await real.settle(usage); permit.settled = true; } };
  } };
  const upstream = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const observedFetch: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    if (request.method !== "POST" || request.url !== providerUrl) throw new TypeError("Unapproved original-case provider destination.");
    const permit = permits.find(p => !p.dispatched && !p.settled);
    if (!permit) throw new TypeError("Every HTTP attempt requires its own current shared reservation.");
    const body = await request.clone().text();
    if (Buffer.byteLength(body) > 256 * 1024) throw new TypeError("Provider request exceeds observation bounds.");
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (payload.model !== profile.modelId || !Array.isArray(payload.messages)) throw new TypeError("Unexpected provider input shape or model.");
    const modelInput = Object.fromEntries(["messages", "tools", "tool_choice"].filter(k => k in payload).map(k => [k, payload[k]]));
    record.providerRequests.push({ digest: hash(body), modelInput });
    permit.dispatched = true;
    const observed: CapturedResponse = { status: null, captureStatus: "transport_unavailable" };
    record.providerResponses.push(observed);
    const response = await upstream(request, { redirect: "error" });
    observed.status = response.status; observed.captureStatus = "body_unavailable";
    if (endpoint.adapter === "groq") {
      const rateLimits = numericGroqRateLimitDiagnostics(response.headers, new Date());
      if (rateLimits) observed.rateLimits = rateLimits;
    }
    const bytes = await readProviderObservationBytes(response);
    observed.responseDigestSha256 = hash(bytes); observed.captureStatus = "invalid_json";
    try {
      observed.answer = captureProviderAnswer(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
      observed.captureStatus = observed.answer.captureStatus;
    } catch { /* Preserve the bounded response status and digest; the router still validates the original bytes. */ }
    return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(bytes), { status: response.status, headers: response.headers });
  };
  let diagnostics: ReturnType<Awaited<ReturnType<typeof createEvaluationRoomPlanningFixture>>["diagnostics"]> | undefined;
  let proposals: ReturnType<Awaited<ReturnType<typeof createEvaluationRoomPlanningFixture>>["preparedProposals"]> = [];
  try {
    fixture = await createEvaluationRoomPlanningFixture({ mode: "proposal_only", catalogVariant: definition.catalog });
    const owned = fixture;
    const apiRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const allowed = method === "GET" && ["/api/tools", "/api/resources"].includes(path)
        || method === "POST" && ["/api/availability", "/api/proposals"].includes(path);
      if (!allowed || ++apiCalls > 32) throw new TypeError("Original-case API destination or count rejected.");
      const headers = new Headers(init?.headers); headers.set("cookie", owned.cookie); headers.set("accept", "application/json");
      if (method === "POST") { headers.set("origin", owned.webOrigin); headers.set("content-type", "application/json"); }
      const response = await owned.coreFetch(new Request(owned.apiOrigin + path, { ...init, method, headers, signal: deadline }));
      if (!response.ok) throw new TypeError("The native original-case API request failed.");
      return await response.json() as T;
    };
    const tools = parsePluginTools(await apiRequest<unknown>("/api/tools"));
    if (!tools || tools.some(t => t.modelName !== expectedModelToolName(t.pluginId, t.name))) throw new TypeError("Unverified tool registry.");
    const eligible = tools.filter(t => allowedTools.has(knownToolAlias(t) ?? ""));
    if (new Set(eligible.map(t => knownToolAlias(t))).size !== allowedTools.size) throw new TypeError("The original-case tool registry is incomplete.");
    const bridge = createAnnyChatTools(apiRequest, { now: () => new Date(input.clock.now) });
    const messages: WireMessage[] = input.userMessages.map(content => ({ role: "user", content }));
    if (input.evidence.length) {
      const id = "original-case-evidence";
      messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "knowledge_search", arguments: { query: "Bereitgestellte Testbelege" } }] });
      messages.push({ role: "tool", name: "knowledge_search", toolCallId: id, content: JSON.stringify({ documents: input.evidence.map(e => ({ ...e, citationId: `knowledge:${e.sourceId}:${String(e.revision)}` })) }) });
    }
    for (let step = 0; step < 6; step++) {
      generationReserved = false;
      const reply = await runModelStep(chatRequestSchema.parse({ profileId: profile.id, messages }), {
        fetch: observedFetch, budgetAdmission: admission, signal: deadline, now: new Date(input.clock.now),
        messageTimes: messages.map(() => new Date(input.clock.now).toISOString()), authorizedTools: eligible,
        context: { dataClasses: ["synthetic_demo"], toolsRequired: true },
      });
      if (reply.profile.id !== profile.id || reply.profile.modelId !== profile.modelId) throw new TypeError("Unexpected selected model.");
      record.replies.push(structuredClone(reply.message)); messages.push(reply.message);
      const calls = reply.message.toolCalls ?? [];
      if (!calls.length) { record.outcome = "completed_observation"; record.stopReason = "model_final_reply"; break; }
      if (calls.length !== 1) {
        record.attempts.push(...calls.map(call => ({ tool: call.name, arguments: structuredClone(call.arguments), disposition: "multiple_calls_rejected" })));
        record.stopReason = "multiple_calls_rejected"; record.rejectedToolAttempts += calls.length; break;
      }
      const call = calls[0]; if (!call) throw new TypeError("Missing model call.");
      const attempt = { tool: call.name, arguments: structuredClone(call.arguments), disposition: "rejected" }; record.attempts.push(attempt);
      const known = allowedTools.has(call.name);
      const valid = known && (call.name === "anny_search_resources"
        || definition.pendingAllowed && (call.name === "anny_get_availability" && exactAvailability(call.arguments)
          || call.name === "anny_propose_booking" && exactProposal(call.arguments)));
      if (!valid) { record.stopReason = "unapproved_tool_or_interval_rejected"; record.rejectedToolAttempts++; break; }
      const result = await bridge.run(call.name, call.arguments);
      attempt.disposition = "native_execution";
      record.nativeResults.push({ tool: result.name, output: structuredClone(result.output) });
      if (result.name === "anny_propose_booking") {
        record.outcome = "completed_observation"; record.stopReason = "native_pending_proposal"; break;
      }
      messages.push({ role: "tool", name: result.name, toolCallId: call.id, content: JSON.stringify(result.output) });
    }
    if (record.stopReason === "not_started") record.stopReason = "step_cap";
  } catch (error) {
    if (error instanceof ModelRouterError) {
      record.errorCode = error.code;
      if (Number.isInteger(error.providerStatus) && error.providerStatus !== undefined
        && error.providerStatus >= 100 && error.providerStatus <= 599) record.providerStatus = error.providerStatus;
      if (error.transientFailure === "rate_limit" || error.transientFailure === "server_error" || error.transientFailure === "timeout") {
        record.transientFailure = error.transientFailure;
      }
    } else record.errorCode = "operator_boundary";
    record.outcome = "evaluation_error"; record.stopReason = "sanitized_operator_error";
  } finally {
    if (fixture) {
      try { diagnostics = fixture.diagnostics(); proposals = fixture.preparedProposals(); }
      catch { record.outcome = "incomplete"; record.stopReason = "fixture_observation_unavailable"; }
      finally {
        try { await fixture.close(); record.fixtureCleanup = "completed"; }
        catch { record.fixtureCleanup = "failed"; record.outcome = "incomplete"; }
      }
    }
    record.realFinishedAt = new Date().toISOString();
  }
  const nativeEffectsSafe = !!diagnostics && diagnostics.bookingClock === new Date(input.clock.now).toISOString() && !diagnostics.annyClientWritesEnabled && diagnostics.sourceWriteAttempts === 0
    && diagnostics.sourceWriteEffects === 0 && !diagnostics.apiObservationsTruncated && !diagnostics.sourceObservationsTruncated
    && !diagnostics.preparedProposalsTruncated && proposals.length <= 1
    && proposals.every(p => definition.pendingAllowed && p.resourceId === resourceId
      && p.subject === fixture?.actor.subject && new Date(p.startDate).toISOString() === expectedStart && new Date(p.endDate).toISOString() === expectedEnd);
  if (!nativeEffectsSafe) { record.outcome = "incomplete"; record.stopReason = "native_effect_or_observation_boundary_failed"; }
  return { ...record, apiCalls, diagnostics, proposals,
    nativeEffectsSafe, modelAssessment: "requires_semantic_review", protectedHttpRouteUsed: false,
    measurements: meter.snapshot({ latencyMs: performance.now() - started, providerRequestCount: record.providerRequests.length }),
  };
}

/** A model mistake remains an observation; transport, unknown usage or lost effects stop the paid schedule. */
export function originalRoomStopReason(result: Awaited<ReturnType<typeof runOriginalRoomCase>>): string | undefined {
  if (result.fixtureCleanup !== "completed") return "fixture_cleanup_unavailable";
  if (!result.nativeEffectsSafe) return "native_effect_boundary_failed";
  if (result.providerResponses.some(response => response.status !== null && response.status >= 400)) return "provider_http_error";
  if (result.measurements.usageStatus === "unknown"
    || result.measurements.reservations.some(item => ["reserved", "unknown", "unconfirmed"].includes(item.settlement))) return "provider_usage_unconfirmed";
  if (result.providerResponses.length !== result.measurements.providerRequestCount
    || result.providerResponses.some(response => response.captureStatus !== "captured")) return "provider_observation_unavailable";
  if (result.outcome === "evaluation_error") return "operator_or_provider_error";
  if (result.stopReason === "step_cap") return "step_cap";
  return undefined;
}
