import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvaluationRoomPlanningFixture, type EvaluationRoomPlanningFixture } from "../../../scripts/evaluation/room-planning-fixture.js";
import { POST as timestampPost } from "../src/app/api/chat/timestamps/route.js";
import { availabilityInputForSlot, createAnnyChatTools } from "../src/lib/anny-chat-tools.js";
import { chatToolSchemas, modelReplySchema, timestampResponseSchema, type WireMessage } from "../src/lib/chat-contract.js";
import { classifyIntent, mergeRoomRequest } from "../src/lib/chat-demo.js";
import { assertRequestedRoomTime, requestedRoomInterval } from "../src/lib/chat-room-time.js";
import { officePreferenceSearch } from "../src/lib/chat-tool-loop.js";
import { createChatPostHandler } from "../src/lib/server/chat-route.js";
import { loadModelConfiguration } from "../src/lib/server/model-config.js";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router.js";

vi.mock("server-only", () => ({}));

const environmentKeys = [
  "HASI_LOCAL_TEST_IDP",
  "HASI_LOCAL_TEST_IDP_SCOPE",
  "HASI_WEB_ORIGIN",
  "HASI_CHAT_SIGNING_SECRET",
  "HASI_APP_MODE",
  "HASI_DEMO_MODE",
  "HASI_API_ORIGIN",
  "HASI_LLM_CONFIG",
  "GROQ_API_KEY",
  "VERCEL",
  "DATABASE_URL",
] as const;

function installProtectedLocalEnvironment(fixture: EvaluationRoomPlanningFixture) {
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const values: Record<typeof environmentKeys[number], string | undefined> = {
    HASI_LOCAL_TEST_IDP: "1",
    HASI_LOCAL_TEST_IDP_SCOPE: fixture.localScope,
    HASI_WEB_ORIGIN: fixture.webOrigin,
    HASI_CHAT_SIGNING_SECRET: fixture.signingSecret,
    HASI_APP_MODE: undefined,
    HASI_DEMO_MODE: "0",
    HASI_API_ORIGIN: undefined,
    HASI_LLM_CONFIG: JSON.stringify(loadModelConfiguration({})),
    GROQ_API_KEY: "synthetic-room-planning-route-key",
    VERCEL: undefined,
    DATABASE_URL: "postgresql://evaluation@127.0.0.1:1/hasi_topology_test",
  };
  for (const key of environmentKeys) {
    const value = values[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function webRequest(fixture: EvaluationRoomPlanningFixture, path: string, body: unknown, cookie = fixture.cookie, host = new URL(fixture.webOrigin).host): Request {
  return new Request(`${fixture.webOrigin}${path}`, {
    method: "POST",
    headers: { host, origin: fixture.webOrigin, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function stampUserMessage(fixture: EvaluationRoomPlanningFixture, message: WireMessage): Promise<WireMessage> {
  const response = await timestampPost(webRequest(fixture, "/api/chat/timestamps", { messages: [message] }));
  expect(response.status).toBe(200);
  const body = timestampResponseSchema.parse(await response.json());
  const timestamp = body.timestamps.find(item => item.id === message.id)?.timestamp;
  if (!timestamp) throw new Error("The actual timestamp route returned no receipt for the user message.");
  return { ...message, timestamp };
}

function futureBerlinDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + 7 * 86_400_000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Could not create a future Berlin calendar date.");
  return `${year}-${month}-${day}`;
}

function createFakeBudget() {
  const reservations: { profileId: string; inputTokens: number; outputTokens: number }[] = [];
  const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
  const admission: ModelBudgetAdmission = {
    reserve(input) {
      reservations.push(input);
      return Promise.resolve({
        settle(usage?: { inputTokens: number; outputTokens: number }) {
          settlements.push(usage);
          return Promise.resolve();
        },
      });
    },
  };
  return { admission, reservations, settlements };
}

function actualBrowserBridge(fixture: EvaluationRoomPlanningFixture) {
  return createAnnyChatTools(async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", fixture.cookie);
    headers.set("accept", "application/json");
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") headers.set("origin", fixture.webOrigin);
    const response = await fixture.coreFetch(new Request(`${fixture.apiOrigin}${path}`, { ...init, headers }));
    if (!response.ok) throw new Error(`HASI core request failed at ${path} (${String(response.status)}): ${await response.text()}`);
    return await response.json() as T;
  });
}

function installRouteFetch(fixture: EvaluationRoomPlanningFixture, providerBodies: Record<string, unknown>[], onAuthorityRead?: (readNumber: number) => boolean) {
  const originalFetch = globalThis.fetch;
  const coreCalls: { method: string; path: string; status: number }[] = [];
  let authorityReads = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === fixture.apiOrigin) {
      const key = `${request.method} ${url.pathname}`;
      if (!["GET /api/session", "GET /api/history/authority", "GET /api/tools"].includes(key)) {
        throw new TypeError(`Route harness rejected an unapproved core destination: ${key}`);
      }
      const response = await fixture.coreFetch(request);
      coreCalls.push({ method: request.method, path: url.pathname, status: response.status });
      if (key === "GET /api/history/authority") {
        authorityReads += 1;
        if (onAuthorityRead?.(authorityReads)) return Response.json({ authorityDigest: "f".repeat(64) });
      }
      return response;
    }
    if (url.href !== "https://api.groq.com/openai/v1/chat/completions" || request.method !== "POST") {
      throw new TypeError(`Route harness rejected an unapproved outbound destination: ${url.origin}${url.pathname}`);
    }
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    providerBodies.push(body);
    const searchArguments = chatToolSchemas.anny_search_resources.parse({ kind: "workplace", location: "1J" });
    return Response.json({
      id: `chatcmpl-${String(providerBodies.length)}`,
      object: "chat.completion",
      created: 1_797_136_800,
      model: body.model,
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-room-search-${String(providerBodies.length)}`,
            type: "function",
            function: { name: "anny_search_resources", arguments: JSON.stringify(searchArguments) },
          }],
        },
      }],
      usage: { prompt_tokens: 31, completion_tokens: 9 },
    });
  };
  return {
    originalFetch,
    coreCalls,
    authorityReads: () => authorityReads,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("protected room-planning chat route and browser bridge", () => {
  it("routes the first dated 1J request through the protected model route, then plans and prepares through the actual Anny bridge", async () => {
    const fixture = await createEvaluationRoomPlanningFixture();
    const restoreEnvironment = installProtectedLocalEnvironment(fixture);
    const providerBodies: Record<string, unknown>[] = [];
    const budget = createFakeBudget();
    const harness = installRouteFetch(fixture, providerBodies);
    try {
      const date = futureBerlinDate();
      const user = await stampUserMessage(fixture, {
        id: randomUUID(),
        role: "user",
        content: `Bitte suche einen Arbeitsplatz im Gebäude 1J am ${date} um 13:00 für 60 Minuten.`,
      });
      const roomRequest = mergeRoomRequest(user.content, {}, new Date(user.timestamp?.createdAt ?? ""));
      expect(roomRequest).toMatchObject({ kind: "workplace", location: "1J", date, time: "13:00", durationMinutes: 60 });
      const requestedInterval = requestedRoomInterval(roomRequest);
      expect(requestedInterval).not.toBeNull();
      if (!requestedInterval) throw new Error("The user supplied a complete room interval.");

      const route = createChatPostHandler({ getBudgetAdmission: () => Promise.resolve(budget.admission) });
      const response = await route(webRequest(fixture, "/api/chat", {
        profileId: "groq-oss-120b",
        conversationId: randomUUID(),
        messages: [user],
      }));
      expect(response.status).toBe(200);
      const reply = modelReplySchema.parse(await response.json());
      expect(reply.profile).toMatchObject({ id: "groq-oss-120b", provider: "groq" });
      expect(reply.message.toolCalls).toHaveLength(1);
      const searchCall = reply.message.toolCalls?.[0];
      expect(searchCall).toMatchObject({ name: "anny_search_resources", arguments: { kind: "workplace", location: "1J" } });
      if (!searchCall) throw new Error("The protected route returned no validated room-search call.");
      expect(providerBodies).toHaveLength(1);
      expect(providerBodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "anny_search_resources" } });
      const requestedTools = providerBodies[0]?.tools as { function?: { name?: string } }[] | undefined;
      expect(requestedTools?.map(tool => tool.function?.name)).toContain("anny_search_resources");
      expect(budget.reservations).toHaveLength(1);
      expect(budget.settlements).toEqual([{ inputTokens: 31, outputTokens: 9 }]);

      const bridge = actualBrowserBridge(fixture);
      const initialSearch = await bridge.run(searchCall.name, searchCall.arguments);
      expect(initialSearch.name).toBe("anny_search_resources");
      const initialIds = initialSearch.rooms?.map(room => room.resource.id) ?? [];
      expect(initialIds).toEqual(fixture.resourceIds);

      // This is the browser's direct standalone-preference branch. The helper
      // updates the retained request, and the returned tools run in the actual
      // bridge without sending a second request to the protected model route.
      const preferenceUser = await stampUserMessage(fixture, {
        id: randomUUID(), role: "user", content: "mir egal",
      });
      expect(classifyIntent(preferenceUser.content, true)).toBe("rooms");
      const preference = officePreferenceSearch(
        preferenceUser.content,
        roomRequest,
        new Date(preferenceUser.timestamp?.createdAt ?? ""),
      );
      expect(preference).toMatchObject({ ...roomRequest, officeType: "any" });
      if (!preference) throw new Error("The standalone office preference did not resolve.");
      const preferenceArguments = Object.fromEntries(["kind", "officeType", "capacity", "features", "location", "query"]
        .flatMap(key => {
          const value = preference[key as keyof typeof preference];
          return value === undefined ? [] : [[key, value]];
        }));
      const preferenceSearch = await bridge.run("anny_search_resources", preferenceArguments);
      const returnedResources = preferenceSearch.rooms?.map(room => room.resource) ?? [];
      expect(returnedResources.map(resource => resource.id)).toEqual(fixture.resourceIds);
      expect(providerBodies).toHaveLength(1);

      const availabilityPath = "/api/v1/availability/upcoming-intervals";
      const sourceAvailabilityCount = () => fixture.diagnostics().sourceObservations
        .filter(item => item.path === availabilityPath && item.method === "GET").length;
      const beforeForeignResource = sourceAvailabilityCount();
      await expect(bridge.run("anny_get_availability", {
        resourceId: "00000000-0000-4000-8000-000000000101",
        date,
        time: "13:00",
        durationMinutes: 60,
      })).rejects.toThrow("nicht enthalten");
      expect(sourceAvailabilityCount()).toBe(beforeForeignResource);

      const selected = returnedResources.find(resource => fixture.resourceIds.includes(resource.id));
      if (!selected) throw new Error("The scripted user selection did not choose a returned permitted resource.");
      expect(returnedResources.some(resource => resource.id === selected.id)).toBe(true);
      const selectedInterval = requestedRoomInterval(preference);
      expect(selectedInterval).toEqual(requestedInterval);
      if (!selectedInterval) throw new Error("The selected room request lost its requested interval.");

      const firstAvailabilityArguments = availabilityInputForSlot(selected.id, { ...selectedInterval, available: false });
      assertRequestedRoomTime("anny_get_availability", firstAvailabilityArguments, preference);
      const firstAvailability = await bridge.run("anny_get_availability", firstAvailabilityArguments);
      const visibleSlot = firstAvailability.rooms?.find(room => room.resource.id === selected.id)?.intervals.find(interval =>
        interval.available && Date.parse(interval.startDate) === Date.parse(selectedInterval.startDate)
        && Date.parse(interval.endDate) === Date.parse(selectedInterval.endDate));
      expect(visibleSlot?.available).toBe(true);
      if (!visibleSlot) throw new Error("The requested slot was not returned as available for the selected resource.");

      // The UI's prepare action rechecks the chosen interval, and the server's
      // proposal handler independently rechecks it before persisting a pending
      // proposal.
      const recheckArguments = availabilityInputForSlot(selected.id, visibleSlot);
      assertRequestedRoomTime("anny_get_availability", recheckArguments, preference);
      const rechecked = await bridge.run("anny_get_availability", recheckArguments);
      const currentSlot = rechecked.rooms?.find(room => room.resource.id === selected.id)?.intervals.find(interval =>
        interval.available && Date.parse(interval.startDate) === Date.parse(visibleSlot.startDate)
        && Date.parse(interval.endDate) === Date.parse(visibleSlot.endDate));
      expect(currentSlot?.available).toBe(true);
      if (!currentSlot) throw new Error("The selected interval changed before proposal preparation.");

      const proposalArguments = { resourceId: selected.id, startDate: currentSlot.startDate, endDate: currentSlot.endDate };
      assertRequestedRoomTime("anny_propose_booking", proposalArguments, preference);
      const prepared = await bridge.run("anny_propose_booking", proposalArguments);
      expect(prepared.proposal).toMatchObject({ status: "pending", action: "book", startDate: requestedInterval.startDate, endDate: requestedInterval.endDate });
      expect(fixture.preparedProposals()).toEqual([expect.objectContaining({
        subject: fixture.actor.subject,
        resourceId: selected.id,
        serviceId: "76878",
        startDate: requestedInterval.startDate,
        endDate: requestedInterval.endDate,
        status: "pending",
      })]);

      const diagnostics = fixture.diagnostics();
      expect(diagnostics.apiObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/api/history/authority", status: 200 }),
        expect.objectContaining({ method: "GET", path: "/api/tools", status: 200 }),
        expect.objectContaining({ method: "GET", path: "/api/resources", status: 200 }),
        expect.objectContaining({ method: "POST", path: "/api/availability", status: 200 }),
        expect.objectContaining({ method: "POST", path: "/api/proposals", status: 200 }),
      ]));
      expect(diagnostics.sourceObservations.filter(item => item.path === availabilityPath && item.method === "GET")).toHaveLength(3);
      expect(diagnostics.sourceWriteAttempts).toBe(0);
      expect(diagnostics.sourceWriteEffects).toBe(0);
      expect(diagnostics.apiObservations.some(item => item.path?.includes("confirm"))).toBe(false);
      expect(providerBodies).toHaveLength(1);
      expect(harness.coreCalls.some(item => item.path === "/api/history/authority" && item.status === 200)).toBe(true);
    } finally {
      harness.restore();
      restoreEnvironment();
      await fixture.close();
    }
  });

  it("re-stamps foreign-scope timestamps and denies invalid session, Host, Origin and changed authority", async () => {
    const fixture = await createEvaluationRoomPlanningFixture();
    const restoreEnvironment = installProtectedLocalEnvironment(fixture);
    const providerBodies: Record<string, unknown>[] = [];
    const harness = installRouteFetch(fixture, providerBodies, readNumber => readNumber === 2);
    try {
      const bareMessage: WireMessage = { id: randomUUID(), role: "user", content: "Hallo." };
      const scopedReceipt = await stampUserMessage(fixture, bareMessage);
      const sameScopeReceipt = await stampUserMessage(fixture, scopedReceipt);
      expect(sameScopeReceipt.timestamp).toEqual(scopedReceipt.timestamp);
      const originalScope = process.env.HASI_LOCAL_TEST_IDP_SCOPE;
      process.env.HASI_LOCAL_TEST_IDP_SCOPE = randomUUID();
      const mismatchedReceiptResponse = await timestampPost(webRequest(fixture, "/api/chat/timestamps", { messages: [scopedReceipt] }));
      expect(mismatchedReceiptResponse.status).toBe(200);
      const mismatchedReceipts = timestampResponseSchema.parse(await mismatchedReceiptResponse.json()).timestamps;
      expect(mismatchedReceipts[0]?.timestamp.receipt).not.toBe(scopedReceipt.timestamp?.receipt);
      if (originalScope) process.env.HASI_LOCAL_TEST_IDP_SCOPE = originalScope;

      const route = createChatPostHandler({ getBudgetAdmission: () => Promise.resolve(createFakeBudget().admission) });
      const invalidSession = await route(webRequest(fixture, "/api/chat", {
        profileId: "groq-oss-120b", conversationId: randomUUID(), messages: [bareMessage],
      }, "hasi-session=invalid-session"));
      expect(invalidSession.status).toBe(401);
      expect(providerBodies).toHaveLength(0);

      const wrongHost = await route(webRequest(fixture, "/api/chat", {
        profileId: "groq-oss-120b", conversationId: randomUUID(), messages: [bareMessage],
      }, fixture.cookie, "127.0.0.1:3002"));
      expect(wrongHost.status).toBe(403);
      expect(providerBodies).toHaveLength(0);

      const crossOriginRequest = webRequest(fixture, "/api/chat", {
        profileId: "groq-oss-120b", conversationId: randomUUID(), messages: [bareMessage],
      });
      crossOriginRequest.headers.set("origin", "https://unapproved.evaluation.example.edu");
      const wrongOrigin = await route(crossOriginRequest);
      expect(wrongOrigin.status).toBe(403);
      expect(providerBodies).toHaveLength(0);

      const changedAuthority = await route(webRequest(fixture, "/api/chat", {
        profileId: "groq-oss-120b", conversationId: randomUUID(), messages: [bareMessage],
      }));
      expect(changedAuthority.status).toBe(409);
      expect(await changedAuthority.text()).toContain("Quellenrechte");
      expect(harness.authorityReads()).toBe(2);
      expect(providerBodies).toHaveLength(0);
    } finally {
      harness.restore();
      restoreEnvironment();
      await fixture.close();
    }
  });
});
