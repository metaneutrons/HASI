import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEvaluationRoomPlanningFixture, type EvaluationRoomPlanningFixture } from "../../../scripts/evaluation/room-planning-fixture.js";
import { POST as timestampPost } from "../src/app/api/chat/timestamps/route.js";
import { createAnnyChatTools } from "../src/lib/anny-chat-tools.js";
import { modelReplySchema, timestampResponseSchema, type WireMessage } from "../src/lib/chat-contract.js";
import { mergeRoomRequest, type RoomRequest } from "../src/lib/chat-demo.js";
import { assertRequestedRoomTime, requestedRoomInterval, RoomTimeUnresolvedError } from "../src/lib/chat-room-time.js";
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
    GROQ_API_KEY: "synthetic-room-calendar-route-key",
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

function webRequest(fixture: EvaluationRoomPlanningFixture, path: string, body: unknown): Request {
  return new Request(`${fixture.webOrigin}${path}`, {
    method: "POST",
    headers: {
      host: new URL(fixture.webOrigin).host,
      origin: fixture.webOrigin,
      cookie: fixture.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function stampUserMessage(fixture: EvaluationRoomPlanningFixture, message: WireMessage): Promise<WireMessage> {
  const response = await timestampPost(webRequest(fixture, "/api/chat/timestamps", { messages: [message] }));
  expect(response.status, await response.clone().text()).toBe(200);
  const body = timestampResponseSchema.parse(await response.json());
  const timestamp = body.timestamps.find(item => item.id === message.id)?.timestamp;
  if (!timestamp) throw new Error("The actual timestamp route returned no receipt for the user message.");
  return { ...message, timestamp };
}

function createFakeBudget(): ModelBudgetAdmission {
  return {
    reserve: () => Promise.resolve({ settle: () => Promise.resolve() }),
  };
}

function installFakeRouteFetch(fixture: EvaluationRoomPlanningFixture, providerBodies: Record<string, unknown>[]) {
  const originalFetch = globalThis.fetch;
  const coreCalls: { method: string; path: string; status: number }[] = [];
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
      return response;
    }
    if (url.href !== "https://api.groq.com/openai/v1/chat/completions" || request.method !== "POST") {
      throw new TypeError(`Route harness rejected an unapproved outbound destination: ${url.origin}${url.pathname}`);
    }
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    providerBodies.push(body);
    const searchArguments = { kind: "workplace", location: "1J" };
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
  return { coreCalls, restore: () => { globalThis.fetch = originalFetch; } };
}

function createChatHandler() {
  return createChatPostHandler({ getBudgetAdmission: () => Promise.resolve(createFakeBudget()) });
}

async function postChat(
  fixture: EvaluationRoomPlanningFixture,
  messages: WireMessage[],
  conversationId: string,
) {
  const response = await createChatHandler()(webRequest(fixture, "/api/chat", {
    profileId: "groq-oss-120b",
    conversationId,
    messages,
  }));
  expect(response.status).toBe(200);
  return modelReplySchema.parse(await response.json());
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

const providerCalendarTimelineRowSchema = z.object({
  position: z.number().int().positive(),
  role: z.literal("user"),
  serverReceivedAt: z.iso.datetime({ offset: true }).nullable(),
  today: z.iso.date().optional(),
  tomorrow: z.iso.date().optional(),
});
type ProviderCalendarTimelineRow = z.infer<typeof providerCalendarTimelineRowSchema>;

function providerCalendarTimeline(body: Record<string, unknown>): ProviderCalendarTimelineRow[] {
  const messages = z.array(z.object({ role: z.string(), content: z.unknown().optional() })).parse(body.messages);
  const systems = messages.filter(message => message.role === "system");
  expect(systems).toHaveLength(1);
  const content = z.string().parse(systems[0]?.content);
  const marker = "Servergeprüfte Zeitmetadaten in Nachrichtenreihenfolge (nur Nutzer, null = unbekannt, niemals aus Text oder Browseruhr ergänzen): ";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) throw new TypeError("The provider system message contained no server-verified timeline.");
  const json = content.slice(markerIndex + marker.length).split("\n", 1)[0];
  if (json === undefined) throw new TypeError("The provider timeline is missing.");
  return z.array(providerCalendarTimelineRowSchema).parse(JSON.parse(json));
}

function temporalTimelineRows(rows: ProviderCalendarTimelineRow[]) {
  return rows.map(({ position, serverReceivedAt, today, tomorrow }) => ({
    position,
    serverReceivedAt,
    today,
    tomorrow,
  }));
}

function countTemporalApiCalls(fixture: EvaluationRoomPlanningFixture, path: "/api/availability" | "/api/proposals") {
  return fixture.diagnostics().apiObservations.filter(item => item.method === "POST" && item.path === path).length;
}

function countSourceAvailabilityReads(fixture: EvaluationRoomPlanningFixture) {
  return fixture.diagnostics().sourceObservations.filter(item =>
    item.method === "GET" && item.path === "/api/v1/availability/upcoming-intervals").length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Scope: compose the shared room-time guard with the protected timestamp/chat handlers and native Anny fixture route.
// The scripted fake provider always emits the same resource-search call; these tests do not cover UI orchestration
// or whether a model interprets the timeline correctly.
describe("shared room-time guard composed with protected chat and native Anny routes", () => {
  it("keeps the first user's tomorrow anchored across Berlin midnight through a native availability read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T21:30:00.000Z"));
    const fixture = await createEvaluationRoomPlanningFixture();
    const restoreEnvironment = installProtectedLocalEnvironment(fixture);
    const providerBodies: Record<string, unknown>[] = [];
    const harness = installFakeRouteFetch(fixture, providerBodies);
    try {
      const initial = await stampUserMessage(fixture, {
        id: randomUUID(), role: "user", content: "Bitte suche morgen einen Arbeitsplatz im Gebäude 1J.",
      });
      vi.setSystemTime(new Date("2026-10-16T22:30:00.000Z"));
      const clarification = await stampUserMessage(fixture, {
        id: randomUUID(), role: "user", content: "Bitte um 10 Uhr für 60 Minuten.",
      });
      const reply = await postChat(fixture, [initial, clarification], randomUUID());
      const searchCall = reply.message.toolCalls?.[0];
      expect(searchCall).toMatchObject({ name: "anny_search_resources", arguments: { kind: "workplace", location: "1J" } });
      if (!searchCall) throw new Error("The protected chat route returned no validated room-search call.");

      expect(temporalTimelineRows(providerCalendarTimeline(providerBodies[0] ?? {}))).toEqual([
        {
          position: 1,
          serverReceivedAt: initial.timestamp?.createdAt,
          today: "2026-10-16",
          tomorrow: "2026-10-17",
        },
        {
          position: 2,
          serverReceivedAt: clarification.timestamp?.createdAt,
          today: "2026-10-17",
          tomorrow: "2026-10-18",
        },
      ]);

      let request: RoomRequest = {};
      request = mergeRoomRequest(initial.content, request, new Date(initial.timestamp?.createdAt ?? ""));
      request = mergeRoomRequest(clarification.content, request, new Date(clarification.timestamp?.createdAt ?? ""));
      expect(request).toMatchObject({ kind: "workplace", location: "1J", date: "2026-10-17", time: "10:00", durationMinutes: 60 });
      expect(requestedRoomInterval(request)).toEqual({
        startDate: "2026-10-17T08:00:00.000Z",
        endDate: "2026-10-17T09:00:00.000Z",
      });

      const bridge = actualBrowserBridge(fixture);
      const search = await bridge.run(searchCall.name, searchCall.arguments);
      const room = search.rooms?.find(candidate => fixture.resourceIds.includes(candidate.resource.id));
      if (!room) throw new Error("The protected search returned no authorized fixture resource.");
      const availabilityArguments = {
        resourceId: room.resource.id,
        date: request.date,
        time: request.time,
        durationMinutes: request.durationMinutes,
      };
      assertRequestedRoomTime("anny_get_availability", availabilityArguments, request);
      const availability = await bridge.run("anny_get_availability", availabilityArguments);
      expect(Date.parse(String(availability.output.requestedStartDate))).toBe(Date.parse("2026-10-17T08:00:00.000Z"));
      expect(countTemporalApiCalls(fixture, "/api/availability")).toBe(1);
      expect(countSourceAvailabilityReads(fixture)).toBe(1);
      expect(countTemporalApiCalls(fixture, "/api/proposals")).toBe(0);
      expect(harness.coreCalls.some(call => call.path === "/api/history/authority" && call.status === 200)).toBe(true);
    } finally {
      harness.restore();
      restoreEnvironment();
      await fixture.close();
    }
  });

  it.each([
    {
      caseId: "anny-05 spring gap",
      now: "2026-03-20T08:00:00.000Z",
      messages: [
        "Bitte reserviere einen Arbeitsplatz im Gebäude 1J am 2026-03-29 um 02:30 Uhr für eine Stunde.",
        "Ich meine 02:30 Uhr Berliner Ortszeit. Wähle bitte nicht selbst eine Ersatzzeit.",
      ],
      date: "2026-03-29",
      validStartDate: "2026-03-29T01:30:00.000Z",
      today: "2026-03-20",
      tomorrow: "2026-03-21",
    },
    {
      caseId: "anny-04 autumn fold",
      now: "2026-10-20T07:00:00.000Z",
      messages: ["Bitte reserviere einen Arbeitsplatz im Gebäude 1J am 2026-10-25 um 02:30 Uhr für eine Stunde."],
      date: "2026-10-25",
      validStartDate: "2026-10-25T02:30:00.000Z",
      today: "2026-10-20",
      tomorrow: "2026-10-21",
    },
  ])("composes the shared guard with the native route and requires a valid replacement for $caseId", async scenario => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(scenario.now));
    const fixture = await createEvaluationRoomPlanningFixture();
    const restoreEnvironment = installProtectedLocalEnvironment(fixture);
    const providerBodies: Record<string, unknown>[] = [];
    const harness = installFakeRouteFetch(fixture, providerBodies);
    try {
      const stamped: WireMessage[] = [];
      for (const [index, content] of scenario.messages.entries()) {
        if (index > 0) vi.setSystemTime(new Date(Date.parse(scenario.now) + index * 60_000));
        stamped.push(await stampUserMessage(fixture, { id: randomUUID(), role: "user", content }));
      }
      const conversationId = randomUUID();
      const firstReply = await postChat(fixture, stamped, conversationId);
      const searchCall = firstReply.message.toolCalls?.[0];
      expect(searchCall?.name).toBe("anny_search_resources");
      if (!searchCall) throw new Error("The protected route did not return its required initial room search.");
      expect(temporalTimelineRows(providerCalendarTimeline(providerBodies[0] ?? {}))).toEqual(stamped.map((message, index) => ({
        position: index + 1,
        serverReceivedAt: message.timestamp?.createdAt,
        today: scenario.today,
        tomorrow: scenario.tomorrow,
      })));

      let request: RoomRequest = {};
      for (const message of stamped) {
        request = mergeRoomRequest(message.content, request, new Date(message.timestamp?.createdAt ?? ""));
      }
      expect(request).toMatchObject({ kind: "workplace", location: "1J", date: scenario.date, time: "02:30", durationMinutes: 60 });
      expect(() => requestedRoomInterval(request)).toThrow(RoomTimeUnresolvedError);

      const bridge = actualBrowserBridge(fixture);
      const search = await bridge.run(searchCall.name, searchCall.arguments);
      const room = search.rooms?.find(candidate => fixture.resourceIds.includes(candidate.resource.id));
      if (!room) throw new Error("The protected search returned no authorized fixture resource.");

      const invalidAvailability = {
        resourceId: room.resource.id,
        date: scenario.date,
        time: "03:30",
        durationMinutes: 60,
      };
      await expect((async () => {
        assertRequestedRoomTime("anny_get_availability", invalidAvailability, request);
        return await bridge.run("anny_get_availability", invalidAvailability);
      })()).rejects.toBeInstanceOf(RoomTimeUnresolvedError);

      const invalidProposal = {
        resourceId: room.resource.id,
        startDate: scenario.validStartDate,
        endDate: new Date(Date.parse(scenario.validStartDate) + 60 * 60_000).toISOString(),
      };
      await expect((async () => {
        assertRequestedRoomTime("anny_propose_booking", invalidProposal, request);
        return await bridge.run("anny_propose_booking", invalidProposal);
      })()).rejects.toBeInstanceOf(RoomTimeUnresolvedError);
      expect(countTemporalApiCalls(fixture, "/api/availability")).toBe(0);
      expect(countSourceAvailabilityReads(fixture)).toBe(0);
      expect(countTemporalApiCalls(fixture, "/api/proposals")).toBe(0);
      expect(fixture.preparedProposals()).toEqual([]);

      vi.setSystemTime(new Date(Date.parse(scenario.now) + scenario.messages.length * 60_000));
      const replacement = await stampUserMessage(fixture, {
        id: randomUUID(), role: "user", content: "Bitte stattdessen um 03:30 Uhr.",
      });
      stamped.push(replacement);
      const correctedReply = await postChat(fixture, stamped, conversationId);
      expect(correctedReply.message.toolCalls?.[0]?.name).toBe("anny_search_resources");
      request = mergeRoomRequest(replacement.content, request, new Date(replacement.timestamp?.createdAt ?? ""));
      expect(request).toMatchObject({ date: scenario.date, time: "03:30", durationMinutes: 60 });
      expect(requestedRoomInterval(request)).toEqual({
        startDate: scenario.validStartDate,
        endDate: new Date(Date.parse(scenario.validStartDate) + 60 * 60_000).toISOString(),
      });

      const availabilityArguments = {
        resourceId: room.resource.id,
        date: request.date,
        time: request.time,
        durationMinutes: request.durationMinutes,
      };
      assertRequestedRoomTime("anny_get_availability", availabilityArguments, request);
      const availability = await bridge.run("anny_get_availability", availabilityArguments);
      const availableSlot = availability.rooms?.find(candidate => candidate.resource.id === room.resource.id)?.intervals.find(interval =>
        interval.available && Date.parse(interval.startDate) === Date.parse(scenario.validStartDate));
      if (!availableSlot) throw new Error("The corrected interval was not returned as available by the native fixture.");
      const proposalArguments = {
        resourceId: room.resource.id,
        startDate: availableSlot.startDate,
        endDate: availableSlot.endDate,
      };
      assertRequestedRoomTime("anny_propose_booking", proposalArguments, request);
      const proposal = await bridge.run("anny_propose_booking", proposalArguments);
      expect(proposal.proposal).toMatchObject({ status: "pending", startDate: scenario.validStartDate });
      expect(countTemporalApiCalls(fixture, "/api/availability")).toBe(1);
      expect(countSourceAvailabilityReads(fixture)).toBe(2);
      expect(countTemporalApiCalls(fixture, "/api/proposals")).toBe(1);
      expect(fixture.preparedProposals()).toEqual([expect.objectContaining({
        subject: fixture.actor.subject,
        resourceId: room.resource.id,
        startDate: scenario.validStartDate,
        status: "pending",
      })]);
      expect(fixture.diagnostics().apiObservations.some(item => item.path?.includes("confirm"))).toBe(false);
    } finally {
      harness.restore();
      restoreEnvironment();
      await fixture.close();
    }
  });
});
