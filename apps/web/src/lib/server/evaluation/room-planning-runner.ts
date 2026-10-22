import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createEvaluationRoomPlanningFixture, type EvaluationRoomPlanningDiagnostics, type EvaluationRoomPlanningFixture, type EvaluationRoomPlanningObservation } from "../../../../../../scripts/evaluation/room-planning-fixture";
import { createAnnyChatTools } from "../../anny-chat-tools";
import { classifyIntent, mergeRoomRequest, type RoomRequest } from "../../chat-demo";
import { chatToolSchemas, modelReplySchema, timestampResponseSchema, type WireMessage } from "../../chat-contract";
import { officePreferenceSearch } from "../../chat-tool-loop";
import { POST as timestampPost } from "../../../app/api/chat/timestamps/route";
import { createChatPostHandler } from "../chat-route";
import { loadModelConfiguration, resolveModelConnection } from "../model-config";
import { loadModelPrices, modelPrice } from "../model-budgets";
import type { ModelBudgetAdmission } from "../model-router";
import { ModelRouterError } from "../model-router-error";
import { captureProviderAnswer, readProviderObservationBytes, type ProviderCaptureIssue } from "./provider-response-capture";
import { createProviderObservationMeter, type ProviderMeasurements } from "./provider-observations";
import { roomPlanningDefinition } from "./room-planning-plan";

const environmentKeys = ["HASI_LOCAL_TEST_IDP", "HASI_LOCAL_TEST_IDP_SCOPE", "HASI_WEB_ORIGIN",
  "HASI_CHAT_SIGNING_SECRET", "HASI_APP_MODE", "HASI_DEMO_MODE", "VERCEL", "DATABASE_URL"] as const;
const executionLease = { active: false };
const maxCoreHttpAttempts = 32;
const maxToolExecutionAttempts = 2;
const maxProviderRequestBytes = 256 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

type CaptureStatus = "captured" | "partial" | "unrecognized_shape" | "invalid_json" | "body_unavailable" | "transport_unavailable";

export interface RoomPlanningRun {
  runKind: "provider_room_planning_observation";
  schemaVersion: 1;
  runId: string;
  caseId: string;
  scenario: string;
  caseStatus: "draft_development_observation";
  profileId: string;
  connectionId: string;
  provider: string;
  modelId: string;
  configurationDigestSha256: string;
  configuredEndpointDigestSha256: string;
  budgetAdmissionBoundary: "explicit_supplied_before_fixture_environment";
  fixtureScopeDigestSha256?: string;
  startedAt: string;
  finishedAt: string;
  runtimeClock: "actual_server_time_not_frozen";
  runtimeNow: string;
  calendarInput: {
    timezone: "Europe/Berlin";
    date: string;
    startTime: "10:00";
    endTime: "16:00";
    durationMinutes: 360;
    initialUserMessage: string;
    preferenceFollowUp: "mir egal";
    generatedAt: string;
  };
  hostRoomRequest?: RoomRequest;
  preferenceRoomRequest?: RoomRequest;
  inputIdentities: {
    initialMessageDigestSha256: string;
    preferenceMessageDigestSha256: string;
    scenarioInputDigestSha256: string;
  };
  timestampObservations: {
    phase: "initial" | "preference_follow_up";
    path: "/api/chat/timestamps";
    status: number;
    messageId: string;
    createdAt?: string;
    receiptDigestSha256?: string;
  }[];
  providerRequests: { attempt: number; requestDigestSha256: string; effectiveInputDigestSha256: string }[];
  providerResponses: {
    attempt: number;
    status: number | null;
    responseDigestSha256?: string;
    captureStatus: CaptureStatus;
    captureIssues?: ProviderCaptureIssue[];
    unexpectedMessageMembers?: { count: number; nameSha256: string[]; truncated: boolean };
    text?: string;
    proposals?: { tool: string; argumentsText: string }[];
  }[];
  routeResponses: {
    phase: "initial";
    path: "/api/chat";
    status: number;
    text?: string;
    proposedCalls?: { tool: string; arguments: Record<string, unknown> }[];
  }[];
  readReceipts: {
    phase: "initial" | "preference_follow_up";
    tool: "anny_search_resources";
    argumentsDigestSha256: string;
    resultDigestSha256: string;
    apiObservations: EvaluationRoomPlanningObservation[];
    sourceObservations: EvaluationRoomPlanningObservation[];
  }[];
  independentSourceProbes: [];
  apiObservations: EvaluationRoomPlanningObservation[];
  sourceObservations: EvaluationRoomPlanningObservation[];
  blockedDestinations: { origin: string; destinationDigestSha256: string }[];
  diagnostics: {
    fixtureMode: "read_only" | "not_created";
    fixtureTransport: EvaluationRoomPlanningDiagnostics["transport"] | "not_created";
    annyClientWritesEnabled: boolean | null;
    apiObservationCount: number;
    sourceObservationCount: number;
    apiHttpAttempts: number;
    blockedApiAttempts: number;
    providerHttpAttemptCap: number;
    apiHttpAttemptCap: number;
    toolExecutionAttemptCap: number;
    toolExecutionAttempts: number;
    toolExecutions: number;
    providerHttpAttempts: number;
    capturedProposalCount: number;
    preparedProposalCount: number;
    blockedWriteAttempts: number;
    sourceWriteAttempts: number;
    sourceWriteEffects: number;
    apiObservationsTruncated: boolean;
    sourceObservationsTruncated: boolean;
    preparedProposalsTruncated: boolean;
    apiHttpAttemptCapReached: boolean;
    providerHttpAttemptCapReached: boolean;
    instrumentationRestoration: "completed" | "failed";
  };
  measurements: ProviderMeasurements;
  outcome: "completed_observation" | "route_rejected" | "tool_not_executed" | "scenario_not_exercised" | "observation_incomplete" | "evaluation_error";
  modelAssessment: "requires_human_review";
  fixtureCleanup: "completed" | "failed" | "not_created";
}

interface MutableRun extends Omit<RoomPlanningRun, "measurements" | "diagnostics" | "apiObservations" | "sourceObservations"> {
  diagnostics: EvaluationRoomPlanningDiagnostics | undefined;
  apiObservations: EvaluationRoomPlanningObservation[];
  sourceObservations: EvaluationRoomPlanningObservation[];
  apiHttpAttemptCapReached: boolean;
  providerHttpAttemptCapReached: boolean;
  instrumentationRestoration: "completed" | "failed";
}

function berlinDateAfterSevenDays(now: Date): string {
  const target = new Date(now.getTime() + 7 * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(target);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("The runtime Berlin calendar date is unavailable.");
  return year + "-" + month + "-" + day;
}

function webRequest(fixture: EvaluationRoomPlanningFixture, path: string, body: unknown, signal: AbortSignal): Request {
  return new Request(fixture.webOrigin + path, {
    method: "POST",
    signal,
    headers: { host: new URL(fixture.webOrigin).host, origin: fixture.webOrigin,
      cookie: fixture.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function searchArgumentsFromRoomRequest(request: RoomRequest): Record<string, unknown> {
  // This projection matches the browser's direct office-preference branch.
  // The RoomRequest itself is produced by the shared host helpers, not model input.
  return Object.fromEntries(["kind", "officeType", "capacity", "features", "location", "query"].flatMap(key => {
    const value = request[key as keyof RoomRequest];
    return value === undefined ? [] : [[key, value]];
  }));
}

function effectiveProviderInput(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["messages", "system", "instructions", "input", "tools", "tool_choice"]
    .filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
}

function providerUsageIsConfirmed(measurements: ProviderMeasurements): boolean {
  return measurements.usageStatus === "complete"
    && measurements.reservations.every(item => item.settlement === "reported" || item.settlement === "released");
}

function copyObservations(items: readonly EvaluationRoomPlanningObservation[]): EvaluationRoomPlanningObservation[] {
  return items.map(item => ({ ...item }));
}

function diagnosticSnapshot(fixture: EvaluationRoomPlanningFixture): EvaluationRoomPlanningDiagnostics {
  return fixture.diagnostics();
}

function addTimestampObservation(record: MutableRun, phase: "initial" | "preference_follow_up", messageId: string, response: Response, body: unknown) {
  const observation: RoomPlanningRun["timestampObservations"][number] = { phase, path: "/api/chat/timestamps", status: response.status, messageId };
  record.timestampObservations.push(observation);
  if (!response.ok) return undefined;
  const parsed = timestampResponseSchema.parse(body);
  const receipt = parsed.timestamps.find(item => item.id === messageId)?.timestamp;
  if (!receipt) return undefined;
  observation.createdAt = receipt.createdAt;
  observation.receiptDigestSha256 = hash(receipt.receipt);
  return { id: messageId, role: "user" as const, content: phase === "initial" ? record.calendarInput.initialUserMessage : record.calendarInput.preferenceFollowUp,
    timestamp: receipt } satisfies WireMessage;
}

async function stampMessage(
  fixture: EvaluationRoomPlanningFixture,
  record: MutableRun,
  phase: "initial" | "preference_follow_up",
  content: string,
  signal: AbortSignal,
): Promise<WireMessage | undefined> {
  const message: WireMessage = { id: randomUUID(), role: "user", content };
  const response = await timestampPost(webRequest(fixture, "/api/chat/timestamps", { messages: [message] }, signal));
  const body = response.ok ? await response.json() as unknown : undefined;
  const stamped = addTimestampObservation(record, phase, message.id ?? "", response, body);
  return stamped ? { ...message, timestamp: stamped.timestamp } : undefined;
}

function routeSearchProposal(record: MutableRun): { toolName: "anny_search_resources"; arguments: Record<string, unknown> } | undefined {
  const responses = record.providerResponses;
  if (!responses.length) return undefined;
  const response = responses.at(-1);
  if (response?.captureStatus !== "captured") return undefined;
  const proposals = response.proposals ?? [];
  if (proposals.length !== 1) return undefined;
  const proposal = proposals[0];
  if (proposal?.tool !== "anny_search_resources") return undefined;
  let args: unknown;
  try { args = JSON.parse(proposal.argumentsText) as unknown; } catch { return undefined; }
  const parsed = chatToolSchemas.anny_search_resources.safeParse(args);
  if (!parsed.success || parsed.data.kind !== "workplace" || parsed.data.location !== "1J") return undefined;
  return { toolName: "anny_search_resources", arguments: { ...parsed.data } };
}

/** Run one code-owned room observation in an isolated operator process. */
export async function runRoomPlanningCase(dependencies: {
  caseId: string;
  profileId: string;
  /** Already opened against the existing shared ledger before fixture environment changes. */
  budgetAdmission: ModelBudgetAdmission;
  maxProviderRequests: number;
  /** Synthetic provider transport for offline tests; otherwise the actual configured provider. */
  fetch?: typeof fetch;
}): Promise<RoomPlanningRun> {
  if (executionLease.active) throw new TypeError("Room-planning evaluation requires an isolated sequential process.");
  const definition = roomPlanningDefinition(dependencies.caseId);
  if (typeof dependencies.budgetAdmission.reserve !== "function"
    || !Number.isInteger(dependencies.maxProviderRequests) || dependencies.maxProviderRequests < 1 || dependencies.maxProviderRequests > 16) {
    throw new TypeError("Explicit shared admission and a bounded provider HTTP attempt cap are required.");
  }
  const configuration = loadModelConfiguration(process.env);
  if (configuration.policy.fallbacks.length) throw new TypeError("Room-planning evaluation cannot enable or rewrite fallback policy.");
  const profile = configuration.profiles.find(item => item.id === dependencies.profileId);
  const connection = configuration.connections.find(item => item.id === profile?.connectionId);
  const selectable = configuration.policy.defaultProfileId === profile?.id
    || configuration.policy.userChoice.enabled && configuration.policy.userChoice.profileIds.includes(profile?.id ?? "");
  if (!profile || !connection || !selectable || !profile.capabilities.tools
    || !profile.allowedDataClasses.includes("synthetic_demo")) {
    throw new TypeError("The selected room-planning profile is not operator approved.");
  }
  const prices = loadModelPrices(process.env);
  if (!modelPrice(profile.id, configuration, prices)) throw new TypeError("The selected room-planning profile has no approved price.");
  const endpoint = resolveModelConnection(connection);
  const path = connection.provider === "anthropic" ? "messages" : endpoint.api === "responses" ? "responses" : "chat/completions";
  const providerUrl = endpoint.baseURL.replace(/\/+$/u, "") + "/" + path;
  const meter = createProviderObservationMeter({ admission: dependencies.budgetAdmission, configuration, prices });
  const permits: { dispatched: boolean; settled: boolean }[] = [];
  const now = new Date();
  const date = berlinDateAfterSevenDays(now);
  const initialUserMessage = "Bitte suche ein Büro im Gebäude 1J am " + date + " von 10:00 bis 16:00 Uhr.";
  const preferenceFollowUp = "mir egal" as const;
  const record: MutableRun = {
    runKind: "provider_room_planning_observation", schemaVersion: 1, runId: randomUUID(),
    caseId: definition.id, scenario: definition.scenario, caseStatus: definition.status,
    profileId: profile.id, connectionId: connection.id, provider: connection.provider, modelId: profile.modelId,
    configurationDigestSha256: hash(JSON.stringify(configuration)), configuredEndpointDigestSha256: hash(providerUrl),
    budgetAdmissionBoundary: "explicit_supplied_before_fixture_environment",
    startedAt: now.toISOString(), finishedAt: "", runtimeClock: "actual_server_time_not_frozen", runtimeNow: now.toISOString(),
    calendarInput: { timezone: "Europe/Berlin", date, startTime: "10:00", endTime: "16:00", durationMinutes: 360,
      initialUserMessage, preferenceFollowUp, generatedAt: now.toISOString() },
    inputIdentities: { initialMessageDigestSha256: hash(initialUserMessage), preferenceMessageDigestSha256: hash(preferenceFollowUp),
      scenarioInputDigestSha256: hash(JSON.stringify({ caseId: definition.id, date, timezone: "Europe/Berlin", startTime: "10:00", endTime: "16:00", initialUserMessage, preferenceFollowUp })) },
    timestampObservations: [], providerRequests: [], providerResponses: [], routeResponses: [], readReceipts: [],
    independentSourceProbes: [], apiObservations: [], sourceObservations: [], blockedDestinations: [],
    diagnostics: undefined, apiHttpAttemptCapReached: false, providerHttpAttemptCapReached: false,
    instrumentationRestoration: "completed",
    outcome: "evaluation_error", modelAssessment: "requires_human_review", fixtureCleanup: "not_created",
  };
  const observedAdmission: ModelBudgetAdmission = { async reserve(input) {
    if (permits.length >= dependencies.maxProviderRequests) {
      record.providerHttpAttemptCapReached = true;
      throw new ModelRouterError("budget_unavailable", "The room-planning provider HTTP attempt cap was reached.");
    }
    const reservation = await meter.admission.reserve(input);
    const permit = { dispatched: false, settled: false };
    permits.push(permit);
    return { settle(usage) { permit.settled = true; return reservation.settle(usage); } };
  } };

  const upstream = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const previousFetch = globalThis.fetch;
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const started = performance.now();
  const deadline = AbortSignal.timeout(90_000);
  let fixture: EvaluationRoomPlanningFixture | undefined;
  let environmentChanged = false;
  let apiHttpAttempts = 0;
  let blockedApiAttempts = 0;
  let preparedProposalCount = 0;
  let toolExecutionAttempts = 0;
  let toolExecutions = 0;
  executionLease.active = true;

  try {
    fixture = await createEvaluationRoomPlanningFixture({ mode: "read_only" });
    record.fixtureScopeDigestSha256 = hash(fixture.localScope);
    const values: Record<typeof environmentKeys[number], string | undefined> = {
      HASI_LOCAL_TEST_IDP: "1", HASI_LOCAL_TEST_IDP_SCOPE: fixture.localScope, HASI_WEB_ORIGIN: fixture.webOrigin,
      HASI_CHAT_SIGNING_SECRET: fixture.signingSecret, HASI_APP_MODE: undefined, HASI_DEMO_MODE: "0",
      VERCEL: undefined, DATABASE_URL: "postgresql://evaluation@127.0.0.1:1/hasi_topology_test",
    };
    environmentChanged = true;
    for (const key of environmentKeys) {
      const value = values[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }

    const ownedFixture = fixture;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
      const target = new URL(request.url);
      if (target.origin === ownedFixture.apiOrigin) {
        if (apiHttpAttempts >= maxCoreHttpAttempts) {
          record.apiHttpAttemptCapReached = true;
          blockedApiAttempts += 1;
          throw new TypeError("Room-planning core API HTTP attempt cap reached.");
        }
        apiHttpAttempts += 1;
        const routeKey = request.method.toUpperCase() + " " + target.pathname;
        const allowed = ["GET /api/session", "GET /api/history/authority", "GET /api/tools"].includes(routeKey);
        if (!allowed || target.username || target.password || target.search || target.hash) {
          blockedApiAttempts += 1;
          record.blockedDestinations.push({ origin: target.origin.slice(0, 200), destinationDigestSha256: hash(target.href) });
          throw new TypeError("Room-planning evaluation rejected an unapproved core API destination.");
        }
        return ownedFixture.coreFetch(request);
      }
      if (target.href !== providerUrl || request.method !== "POST" || target.username || target.password) {
        record.blockedDestinations.push({ origin: target.origin.slice(0, 200), destinationDigestSha256: hash(target.href) });
        throw new TypeError("Room-planning evaluation rejected an unapproved provider destination.");
      }
      const body = await request.clone().text();
      if (Buffer.byteLength(body) > maxProviderRequestBytes) {
        record.providerHttpAttemptCapReached = true;
        throw new TypeError("Room-planning provider request exceeded its observation bound.");
      }
      if (record.providerRequests.length >= dependencies.maxProviderRequests) {
        record.providerHttpAttemptCapReached = true;
        throw new ModelRouterError("budget_unavailable", "The room-planning provider HTTP attempt cap was reached.");
      }
      let payload: unknown;
      try { payload = JSON.parse(body) as unknown; } catch { throw new TypeError("The provider request was not valid JSON."); }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)
        || (payload as Record<string, unknown>).model !== profile.modelId) {
        throw new TypeError("The protected route selected an unexpected model profile.");
      }
      const permit = permits.find(item => !item.dispatched && !item.settled);
      if (!permit) throw new TypeError("Every room-planning provider request requires a fresh shared reservation.");
      permit.dispatched = true;
      const requestNumber = record.providerRequests.length + 1;
      const providerInput = effectiveProviderInput(payload as Record<string, unknown>);
      record.providerRequests.push({ attempt: requestNumber, requestDigestSha256: hash(body), effectiveInputDigestSha256: hash(JSON.stringify(providerInput)) });
      const observation: RoomPlanningRun["providerResponses"][number] = { attempt: requestNumber, status: null, captureStatus: "body_unavailable" };
      record.providerResponses.push(observation);
      let response: Response;
      try { response = await upstream(request, { redirect: "error" }); }
      catch {
        observation.captureStatus = "transport_unavailable";
        throw new TypeError("The configured provider transport did not return an observable response.");
      }
      observation.status = response.status;
      let bytes: Uint8Array;
      try { bytes = await readProviderObservationBytes(response); }
      catch {
        observation.captureStatus = "body_unavailable";
        throw new TypeError("The bounded provider response could not be captured.");
      }
      observation.responseDigestSha256 = hash(bytes);
      let answer: ReturnType<typeof captureProviderAnswer> | { captureStatus: "invalid_json" } = { captureStatus: "invalid_json" };
      try { answer = captureProviderAnswer(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); } catch { /* The route separately rejects malformed provider data. */ }
      Object.assign(observation, answer);
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.from(bytes), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    };
    const initial = await stampMessage(fixture, record, "initial", initialUserMessage, deadline);
    if (!initial?.timestamp) {
      record.outcome = "route_rejected";
    } else {
      const parsedInitialRequest = mergeRoomRequest(initial.content, {}, new Date(initial.timestamp.createdAt));
      record.hostRoomRequest = { ...parsedInitialRequest };
      if (classifyIntent(initial.content, false) !== "rooms" || parsedInitialRequest.kind !== "workplace"
        || parsedInitialRequest.location !== "1J" || parsedInitialRequest.date !== date
        || parsedInitialRequest.time !== "10:00" || parsedInitialRequest.durationMinutes !== 360) {
        record.outcome = "scenario_not_exercised";
      } else {
        const post = createChatPostHandler({ getBudgetAdmission: () => Promise.resolve(observedAdmission) });
        const response = await post(new Request(fixture.webOrigin + "/api/chat", {
          method: "POST", signal: deadline,
          headers: { host: new URL(fixture.webOrigin).host, origin: fixture.webOrigin,
            cookie: fixture.cookie, "content-type": "application/json" },
          body: JSON.stringify({ profileId: profile.id, conversationId: randomUUID(), messages: [initial] }),
        }));
        const routeObservation: RoomPlanningRun["routeResponses"][number] = { phase: "initial", path: "/api/chat", status: response.status };
        record.routeResponses.push(routeObservation);
        const providerError = record.providerResponses.some(item => item.status !== null && item.status >= 400);
        if (providerError) {
          record.outcome = "route_rejected";
        } else if (record.providerResponses.some(item => item.captureStatus !== "captured")) {
          record.outcome = "observation_incomplete";
        } else if (!response.ok) {
          const lastCapture = record.providerResponses.at(-1);
          if (lastCapture?.captureStatus === "captured" && !(lastCapture.proposals?.length)) record.outcome = "scenario_not_exercised";
          else if (lastCapture?.captureStatus === "captured" && !routeSearchProposal(record)) record.outcome = "tool_not_executed";
          else record.outcome = "route_rejected";
        } else if (!providerUsageIsConfirmed(meter.snapshot({ latencyMs: performance.now() - started,
          providerRequestCount: record.providerRequests.length }))) {
          record.outcome = "observation_incomplete";
        } else {
          const reply = modelReplySchema.parse(await response.json());
          if (reply.profile.id !== profile.id || reply.profile.modelId !== profile.modelId) throw new Error("The protected route returned a different configured profile.");
          Object.assign(routeObservation, { text: reply.message.content,
            proposedCalls: (reply.message.toolCalls ?? []).map(call => ({ tool: call.name, arguments: call.arguments })) });
          const captured = routeSearchProposal(record);
          const calls = reply.message.toolCalls ?? [];
          if (!captured || calls.length !== 1 || calls[0]?.name !== "anny_search_resources"
            || JSON.stringify(calls[0].arguments) !== JSON.stringify(captured.arguments)
            || captured.arguments.kind !== "workplace" || captured.arguments.location !== "1J") {
            record.outcome = calls.length > 0 || (record.providerResponses.at(-1)?.proposals?.length ?? 0) > 0
              ? "tool_not_executed" : "scenario_not_exercised";
          } else {
            const bridge = createAnnyChatTools(async <T>(pathValue: string, init?: RequestInit): Promise<T> => {
              const method = (init?.method ?? "GET").toUpperCase();
              if (apiHttpAttempts >= maxCoreHttpAttempts) {
                record.apiHttpAttemptCapReached = true;
                blockedApiAttempts += 1;
                throw new TypeError("The read-only room-planning bridge rejected an unapproved API attempt.");
              }
              apiHttpAttempts += 1;
              if (pathValue !== "/api/resources" || method !== "GET") {
                blockedApiAttempts += 1;
                record.blockedDestinations.push({ origin: ownedFixture.apiOrigin, destinationDigestSha256: hash(method + " " + pathValue) });
                throw new TypeError("The read-only room-planning bridge rejected an unapproved API attempt.");
              }
              const headers = new Headers(init?.headers);
              headers.set("cookie", ownedFixture.cookie);
              headers.set("accept", "application/json");
              const apiResponse = await ownedFixture.coreFetch(new Request(ownedFixture.apiOrigin + pathValue, {
                ...init, method, signal: deadline, headers,
              }));
              if (!apiResponse.ok) throw new TypeError("The protected Anny read route rejected the request.");
              return await apiResponse.json() as T;
            });

            const observeSearch = async (phase: "initial" | "preference_follow_up", arguments_: Record<string, unknown>) => {
              if (toolExecutionAttempts >= maxToolExecutionAttempts) {
                record.outcome = "observation_incomplete";
                return false;
              }
              toolExecutionAttempts += 1;
              const before = diagnosticSnapshot(ownedFixture);
              const typedArguments = chatToolSchemas.anny_search_resources.parse(arguments_);
              const result = await bridge.run("anny_search_resources", typedArguments);
              toolExecutions += 1;
              if (result.name !== "anny_search_resources") throw new TypeError("The native Anny bridge returned an unexpected tool result.");
              const after = diagnosticSnapshot(ownedFixture);
              if (after.apiObservationsTruncated || after.sourceObservationsTruncated
                || after.preparedProposalsTruncated || before.apiObservationsTruncated || before.sourceObservationsTruncated) {
                record.outcome = "observation_incomplete";
                return false;
              }
              const apiReads = after.apiObservations.slice(before.apiObservations.length);
              const sourceReads = after.sourceObservations.slice(before.sourceObservations.length);
              if (!apiReads.some(item => item.kind === "request" && item.method === "GET" && item.path === "/api/resources" && item.status === 200)
                || !sourceReads.some(item => item.kind === "request" && item.method === "GET" && item.path === "/api/v1/resources" && item.status === 200)) {
                record.outcome = "observation_incomplete";
                return false;
              }
              record.readReceipts.push({ phase, tool: "anny_search_resources", argumentsDigestSha256: hash(JSON.stringify(typedArguments)),
                resultDigestSha256: hash(JSON.stringify({ name: result.name, output: result.output, rooms: result.rooms })),
                apiObservations: copyObservations(apiReads), sourceObservations: copyObservations(sourceReads) });
              return true;
            };

            if (await observeSearch("initial", captured.arguments)) {
              const preferenceMessage = await stampMessage(ownedFixture, record, "preference_follow_up", preferenceFollowUp, deadline);
              if (!preferenceMessage?.timestamp) {
                record.outcome = "route_rejected";
              } else if (classifyIntent(preferenceMessage.content, true) !== "rooms") {
                record.outcome = "scenario_not_exercised";
              } else {
                const preference = officePreferenceSearch(preferenceMessage.content, parsedInitialRequest, new Date(preferenceMessage.timestamp.createdAt));
                if (!preference) {
                  record.outcome = "scenario_not_exercised";
                } else {
                  record.preferenceRoomRequest = { ...preference };
                  const preferenceArguments = chatToolSchemas.anny_search_resources.parse(searchArgumentsFromRoomRequest(preference));
                  if (preferenceArguments.kind !== "workplace" || preferenceArguments.officeType !== "any" || preferenceArguments.location !== "1J") {
                    record.outcome = "scenario_not_exercised";
                  } else if (await observeSearch("preference_follow_up", preferenceArguments)) {
                    record.outcome = "completed_observation";
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    record.outcome = record.providerResponses.some(item => item.captureStatus === "body_unavailable" || item.captureStatus === "transport_unavailable")
      ? "observation_incomplete" : "evaluation_error";
  } finally {
    try {
      if (globalThis.fetch !== previousFetch) globalThis.fetch = previousFetch;
    } catch { record.instrumentationRestoration = "failed"; }
    if (environmentChanged) {
      for (const [key, value] of previousEnvironment) {
        try {
          if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
        } catch { record.instrumentationRestoration = "failed"; }
      }
    }
    if (fixture) {
      try {
        record.diagnostics = diagnosticSnapshot(fixture);
        record.apiObservations = copyObservations(record.diagnostics.apiObservations);
        record.sourceObservations = copyObservations(record.diagnostics.sourceObservations);
        preparedProposalCount = fixture.preparedProposals().length;
      } catch { record.outcome = "observation_incomplete"; }
    }
    record.fixtureCleanup = fixture ? "completed" : "not_created";
    if (fixture) {
      try { await fixture.close(); } catch { record.fixtureCleanup = "failed"; }
    }
    executionLease.active = false;
    record.finishedAt = new Date().toISOString();
  }

  const diagnostics = record.diagnostics;
  const measurements = meter.snapshot({ latencyMs: performance.now() - started, providerRequestCount: record.providerRequests.length });
  if (record.fixtureCleanup === "failed" || record.instrumentationRestoration === "failed"
    || record.providerResponses.some(item => item.captureStatus !== "captured")
    || diagnostics && (diagnostics.mode !== "read_only" || diagnostics.annyClientWritesEnabled
      || diagnostics.blockedWriteAttempts > 0 || diagnostics.sourceWriteAttempts > 0 || diagnostics.sourceWriteEffects > 0
      || diagnostics.preparedProposalsTruncated || diagnostics.apiObservationsTruncated || diagnostics.sourceObservationsTruncated
      || preparedProposalCount > 0)) {
    if (record.outcome === "completed_observation") record.outcome = "observation_incomplete";
  }
  return {
    runKind: record.runKind, schemaVersion: record.schemaVersion, runId: record.runId, caseId: record.caseId,
    scenario: record.scenario, caseStatus: record.caseStatus, profileId: record.profileId, connectionId: record.connectionId,
    provider: record.provider, modelId: record.modelId, configurationDigestSha256: record.configurationDigestSha256,
    configuredEndpointDigestSha256: record.configuredEndpointDigestSha256, budgetAdmissionBoundary: record.budgetAdmissionBoundary,
    ...(record.fixtureScopeDigestSha256 ? { fixtureScopeDigestSha256: record.fixtureScopeDigestSha256 } : {}),
    startedAt: record.startedAt, finishedAt: record.finishedAt, runtimeClock: record.runtimeClock, runtimeNow: record.runtimeNow,
    calendarInput: record.calendarInput, ...(record.hostRoomRequest ? { hostRoomRequest: record.hostRoomRequest } : {}),
    ...(record.preferenceRoomRequest ? { preferenceRoomRequest: record.preferenceRoomRequest } : {}), inputIdentities: record.inputIdentities,
    timestampObservations: record.timestampObservations, providerRequests: record.providerRequests, providerResponses: record.providerResponses,
    routeResponses: record.routeResponses, readReceipts: record.readReceipts, independentSourceProbes: [],
    apiObservations: record.apiObservations, sourceObservations: record.sourceObservations,
    blockedDestinations: record.blockedDestinations,
    diagnostics: {
      fixtureMode: diagnostics?.mode === "read_only" ? "read_only" : "not_created",
      fixtureTransport: diagnostics?.transport ?? "not_created",
      annyClientWritesEnabled: diagnostics?.annyClientWritesEnabled ?? null,
      apiObservationCount: record.apiObservations.length, sourceObservationCount: record.sourceObservations.length,
      apiHttpAttempts, blockedApiAttempts,
      providerHttpAttemptCap: dependencies.maxProviderRequests, apiHttpAttemptCap: maxCoreHttpAttempts,
      toolExecutionAttemptCap: maxToolExecutionAttempts,
      toolExecutionAttempts, toolExecutions, providerHttpAttempts: record.providerRequests.length,
      capturedProposalCount: record.providerResponses.reduce((count, item) => count + (item.proposals?.length ?? 0), 0),
      preparedProposalCount,
      blockedWriteAttempts: diagnostics?.blockedWriteAttempts ?? 0,
      sourceWriteAttempts: diagnostics?.sourceWriteAttempts ?? 0, sourceWriteEffects: diagnostics?.sourceWriteEffects ?? 0,
      apiObservationsTruncated: diagnostics?.apiObservationsTruncated ?? false,
      sourceObservationsTruncated: diagnostics?.sourceObservationsTruncated ?? false,
      preparedProposalsTruncated: diagnostics?.preparedProposalsTruncated ?? false,
      apiHttpAttemptCapReached: record.apiHttpAttemptCapReached,
      providerHttpAttemptCapReached: record.providerHttpAttemptCapReached,
      instrumentationRestoration: record.instrumentationRestoration,
    },
    measurements, outcome: record.outcome, modelAssessment: "requires_human_review", fixtureCleanup: record.fixtureCleanup,
  };
}

/** Used by the CLI before it starts another explicitly selected observation. */
export function roomPlanningStopReason(result: RoomPlanningRun): string | undefined {
  if (result.fixtureCleanup !== "completed") return "fixture_cleanup_unavailable";
  if (result.diagnostics.instrumentationRestoration !== "completed") return "instrumentation_restoration_unavailable";
  if (result.diagnostics.fixtureMode !== "read_only" || result.diagnostics.annyClientWritesEnabled !== false) return "read_only_fixture_unavailable";
  if (result.diagnostics.providerHttpAttemptCapReached || result.diagnostics.apiHttpAttemptCapReached) return "http_attempt_cap";
  if (result.providerResponses.some(item => item.status !== null && item.status >= 400)) return "provider_http_error";
  if (result.measurements.usageStatus === "unknown"
    || result.measurements.reservations.some(item => ["reserved", "unknown", "unconfirmed"].includes(item.settlement))) return "provider_usage_unconfirmed";
  if (result.providerResponses.some(item => item.captureStatus !== "captured")) return "provider_observation_unavailable";
  if (result.blockedDestinations.length) return "unapproved_destination_attempt";
  if (result.diagnostics.blockedWriteAttempts || result.diagnostics.sourceWriteAttempts || result.diagnostics.sourceWriteEffects
    || result.diagnostics.preparedProposalCount || result.diagnostics.preparedProposalsTruncated) return "read_only_boundary_triggered";
  if (result.diagnostics.apiObservationsTruncated || result.diagnostics.sourceObservationsTruncated) return "observation_truncated";
  if (result.outcome === "tool_not_executed") return "unexpected_tool_proposal";
  if (result.outcome !== "completed_observation" || result.readReceipts.length !== 2) return "scenario_not_exercised";
  return undefined;
}
