import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryJsonStore } from "@hasi/state";
import { createDemoRuntime } from "@hasi/demo-runtime";
import { hshDemoCatalog } from '../../../fixtures/catalog';
import {
  createAnnyChatTools,
  availabilityInputForSlot,
  visibleAvailabilityIntervals,
  type AnnyChatToolResult,
} from "../src/lib/anny-chat-tools";
import type { Booking, Resource, TimeInterval } from "../src/lib/types";
import { required } from "./test-utils";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
interface HarnessCall { path: string; method: string; body?: unknown }
const runtimes: ReturnType<typeof createDemoRuntime>[] = [];
const origin = "http://127.0.0.1:3001";

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function recordSetCookie(jar: Map<string, string>, setCookie: string): void {
  const [pair, ...attributes] = setCookie.split(";");
  if (!pair) return;
  const separator = pair.indexOf("=");
  if (separator < 1) return;
  const name = pair.slice(0, separator).trim();
  const maxAge = attributes.find((attribute) => attribute.trim().toLowerCase().startsWith("max-age="));
  if (maxAge && Number(maxAge.trim().slice("max-age=".length)) <= 0) {
    jar.delete(name);
  } else {
    jar.set(name, pair.trim());
  }
}

function createHarness(startAt = "2030-01-01T10:30:00.000Z", catalog?: Parameters<typeof createDemoRuntime>[0]['catalog']) {
  const currentTime = new Date(startAt);
  const calls: HarnessCall[] = [];
  const cookies = new Map<string, string>();
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("origin", origin);
    if (cookies.size > 0) headers.set("cookie", [...cookies.values()].join("; "));
    const routedRequest = new Request(request, { headers, redirect: "error" });
    const url = new URL(routedRequest.url);
    const response = url.pathname.startsWith("/plugins/knowledge/") ? await runtime.handleKnowledgePlugin(routedRequest) : url.pathname === "/mcp" || url.pathname.startsWith("/.well-known/")
      ? await runtime.handlePlugin(routedRequest)
      : url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")
        ? await runtime.handleMock(routedRequest)
        : await runtime.handleCore(routedRequest);
    for (const setCookie of response.headers.getSetCookie()) recordSetCookie(cookies, setCookie);
    return response;
  };
  const runtime = createDemoRuntime({
    origin,
    store: new MemoryJsonStore(`web-chat-tools-${randomUUID()}`),
    secret: randomBytes(32).toString("base64url"),
    fetch: transport,
    ...(catalog ? { catalog } : {}),
  });
  runtimes.push(runtime);
  const request: Request = async <T>(path: string, init: RequestInit = {}) => {
    const url = new URL(path, origin);
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: (init.method ?? "GET").toUpperCase(),
      ...(typeof init.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const response = await transport(new Request(url, { ...init, headers }));
    const payload = await response.json() as unknown;
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${String(response.status)}.`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return payload as T;
  };
  return {
    calls,
    request,
    now: () => new Date(currentTime),
  };
}

async function login(request: Request, personaId: "student" | "employee" | "admin") {
  const session = await request<{ user: { id: string; role: string }; mode: string }>("/api/dev/login", { method: "POST", body: JSON.stringify({ personaId }) });
  const accounts = await request<{ accounts: { installationId: string; status: string }[] }>("/api/plugin-accounts");
  for (const account of accounts.accounts.filter(item => item.status !== "linked")) {
    const flow = await request<{ authorizationUrl: string }>(`/api/plugin-accounts/${account.installationId}/authorization`, { method: "POST", body: JSON.stringify({ operation: "consent", returnTo: "/" }) });
    const state = new URL(flow.authorizationUrl, origin).searchParams.get("state");
    await request(`/api/plugin-accounts/${account.installationId}/consent`, { method: "POST", body: JSON.stringify({ state, approved: true }) });
  }
  return session;
}

function outputIntervals(result: AnnyChatToolResult): TimeInterval[] {
  return Array.isArray(result.output.intervals) ? result.output.intervals as TimeInterval[] : [];
}

describe("bounded Anny chat tools", () => {
  it('prepares a cancellation with canonical booking details and never confirms it as a model tool', async () => {
    const harness = createHarness();
    await login(harness.request, 'student');
    const tools = createAnnyChatTools(harness.request, { now: harness.now });
    const search = await tools.run('anny_search_resources', { capacity: 4 });
    const resource = required(required(search.rooms)[0]).resource;
    const availability = await tools.run('anny_get_availability', { resourceId: resource.id, date: '2030-01-03', time: '09:00', durationMinutes: 60 });
    const slot = required(required(required(availability.rooms)[0]).intervals[0]);
    const prepared = await tools.run('anny_propose_booking', { resourceId: resource.id, startDate: slot.startDate, endDate: slot.endDate });
    const created = await harness.request<{ bookingId: string }>(`/api/proposals/${required(prepared.proposal).id}/confirm`, { method: 'POST', body: '{}' });
    harness.calls.length = 0;
    const cancellation = await tools.run('anny_propose_cancellation', { bookingId: created.bookingId });
    expect(cancellation.proposal).toMatchObject({ action: 'cancel_booking', status: 'pending', startDate: slot.startDate, endDate: slot.endDate });
    expect(harness.calls.map(call => call.path)).toEqual(['/api/cancellations']);
    expect((await harness.request<{ bookings: Booking[] }>('/api/bookings')).bookings.find(booking => booking.id === created.bookingId)?.status).toBe('accepted');
    await expect(tools.run('anny_execute_cancellation', { bookingId: created.bookingId })).rejects.toThrow(/nicht freigegeben/);
    await expect(tools.run('anny_propose_cancellation', { bookingId: created.bookingId, customerId: 'other' })).rejects.toThrow();
    await expect(tools.run('anny_propose_cancellation', { bookingId: 'not-owned' })).rejects.toThrow();
  });
  it('returns actual desk IDs and their offices without converting booking quantity to person capacity', async () => {
    const harness = createHarness('2030-01-01T10:30:00.000Z', hshDemoCatalog);
    await login(harness.request, 'employee');
    const tools = createAnnyChatTools(harness.request, { now: harness.now });
    const search = await tools.run('anny_search_resources', { kind: 'workplace', query: 'Amrum' });
    expect(search.rooms?.map(r => r.resource.id).sort()).toEqual(['180116', '180117']);
    expect(search.rooms?.every(r => r.resource.kind === 'workplace' && r.resource.parentId === '179669' && r.resource.capacity === null)).toBe(true);
    expect(search.output.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: '180116', parentId: '179669', bookingUnit: 'one_workplace', capacity: null })]));
    const officeAsLocation = await tools.run('anny_search_resources', { kind: 'workplace', location: 'Amrum' });
    expect(officeAsLocation.rooms?.map(r => r.resource.id).sort()).toEqual(['180116', '180117']);
    expect(officeAsLocation.output.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '180116', officeWorkplaceCount: officeAsLocation.rooms?.find(room => room.resource.id === '180116')?.resource.officeWorkplaceCount }),
    ]));
    expect((await tools.run('anny_search_resources', { kind: 'meeting_room', capacity: 8 })).rooms).toHaveLength(5);
    expect((await tools.run('anny_search_resources', { kind: 'lecture_hall' })).rooms).toEqual([]);
    harness.calls.length = 0;
    const ambiguous = await tools.run('anny_search_resources', { kind: 'workplace', capacity: 2 });
    expect(ambiguous.output.clarificationRequired).toContain('einzelne Arbeitsplätze');
    expect(harness.calls).toHaveLength(0);
    await expect(tools.run('anny_get_availability', { resourceId: '179669', date: '2030-01-03', time: '09:00', durationMinutes: 60 })).rejects.toThrow(/zugänglichen Ressourcen/);
    expect(harness.calls.map(c => c.path)).toEqual(['/api/resources']);
  });
  it("asks for office type before exposing many workplace candidates and explains unknown labels", async () => {
    const resources: Resource[] = Array.from({ length: 10 }, (_, index) => ({
      id: `synthetic-workplace-${String(index)}`,
      name: `Arbeitsplatz ${String(index)}`,
      description: "Synthetic catalog entry",
      capacity: null,
      location: "Gebäude 1J",
      features: [],
      serviceId: "synthetic-service",
      kind: "workplace",
      parentName: `Büro 1J.${String(index).padStart(2, "0")}`,
    }));
    const calls: string[] = [];
    const request: Request = <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path === "/api/resources") return Promise.resolve({ resources } as T);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    };
    const tools = createAnnyChatTools(request);

    const broad = await tools.run("anny_search_resources", { kind: "workplace", location: "Gebäude 1J" });
    expect(broad.rooms).toEqual([]);
    expect(broad.output).toMatchObject({
      availabilityChecked: false,
      returned: 0,
      truncated: 0,
      refinementRequired: true,
      officeTypeCounts: { single: 0, shared: 0, unknown: 10 },
      catalogCandidates: 10,
    });
    expect(broad.output.refinementQuestion).toContain("geteilten Büro");
    expect(broad.output.notice).toMatch(/keine Aussage zur Verfügbarkeit/u);

    const single = await tools.run("anny_search_resources", {
      kind: "workplace",
      location: "Gebäude 1J",
      officeType: "single",
    });
    expect(single.rooms).toEqual([]);
    expect(single.output).toMatchObject({ returned: 0, availabilityChecked: false });
    expect(single.output.notice).toMatch(/nicht dokumentiert/u);
    expect(single.output.notice).not.toMatch(/keine Einzelbüros gibt/u);
    expect(calls).toEqual(["/api/resources", "/api/resources"]);
  });
  it("finds 1J workplaces and prepares the requested eight-hour interval without committing", async () => {
    const harness = createHarness('2030-01-01T10:30:00.000Z', hshDemoCatalog);
    await login(harness.request, 'employee');
    const tools = createAnnyChatTools(harness.request, { now: harness.now });
    const search = await tools.run('anny_search_resources', { kind: 'workplace', location: 'Gebäude 1J', officeType: 'any' });
    expect(search.rooms).toHaveLength(8);
    expect(search.output).toMatchObject({ returned: 8, truncated: 19, availabilityChecked: false });
    expect(search.output.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ officeWorkplaceCount: search.rooms?.[0]?.resource.officeWorkplaceCount }),
    ]));
    const resource = required(required(search.rooms)[0]).resource;
    const availability = await tools.run('anny_get_availability', { resourceId: resource.id, date: '2030-01-07', time: '08:00', durationMinutes: 480 });
    const slot = required(required(availability.rooms)[0]).intervals.find(interval => interval.startDate === '2030-01-07T07:00:00.000Z');
    expect(slot).toMatchObject({ endDate: '2030-01-07T15:00:00.000Z', available: true });
    const proposal = await tools.run('anny_propose_booking', { resourceId: resource.id, startDate: required(slot).startDate, endDate: required(slot).endDate });
    expect(proposal.proposal?.status).toBe('pending');
    expect(harness.calls.some(({ path }) => path.endsWith('/confirm'))).toBe(false);
    const missing = await tools.run('anny_search_resources', { kind: 'workplace', location: 'Gebäude 99Z' });
    expect(missing.output).toMatchObject({ returned: 0, availabilityChecked: false });
    expect(missing.output.notice).toMatch(/keine Verfügbarkeitsprüfung|Verfügbarkeit wurde nicht geprüft/u);
  });

  it("rechecks a restored slot in Berlin time using a fresh bridge before proposing", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    const first = createAnnyChatTools(harness.request, { now: harness.now });
    const search = await first.run("anny_search_resources", { capacity: 4 });
    const resource = required(required(search.rooms)[0]).resource;
    const availability = await first.run("anny_get_availability", { resourceId: resource.id, date: "2030-01-03", time: "09:00", durationMinutes: 60 });
    const slot = required(required(required(availability.rooms)[0]).intervals[0]);
    const restored = createAnnyChatTools(harness.request, { now: harness.now });
    const args = { resourceId: resource.id, startDate: slot.startDate, endDate: slot.endDate };
    await expect(restored.run("anny_propose_booking", args)).rejects.toThrow(/nicht als verfügbar/);
    const check = availabilityInputForSlot(resource.id, slot);
    expect(check).toMatchObject({ date: "2030-01-03", time: "09:00", durationMinutes: 60 });
    await restored.run("anny_get_availability", check);
    expect((await restored.run("anny_propose_booking", args)).proposal?.status).toBe("pending");
    expect(harness.calls.some(({ path }) => path.endsWith("/confirm"))).toBe(false);
  });
  it("searches, checks a visible interval, and prepares a proposal without executing a booking", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    const before = await harness.request<{ bookings: Booking[] }>("/api/bookings");
    const search = await tools.run("anny_search_resources", {
      capacity: 4,
      features: ["Whiteboard"],
    });
    expect(search.name).toBe("anny_search_resources");
    expect(search.rooms?.map(({ resource }) => resource.name)).toEqual([
      "Seminarraum 101",
      "Projektraum 202",
    ]);
    expect(JSON.stringify(search.output).length).toBeLessThanOrEqual(8_000);

    const availability = await tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-15",
      time: "09:00",
      durationMinutes: 60,
    });
    expect(availability.rooms).toHaveLength(1);
    expect(availability.rooms?.[0]?.checked).toBe(true);
    const slot = outputIntervals(availability).find(({ available }) => available);
    expect(slot).toBeDefined();
    expect(JSON.stringify(availability.output).length).toBeLessThanOrEqual(8_000);

    const proposalResult = await tools.run("anny_propose_booking", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      startDate: slot?.startDate,
      endDate: slot?.endDate,
    });
    expect(proposalResult.proposal).toMatchObject({ status: "pending" });

    const after = await harness.request<{ bookings: Booking[] }>("/api/bookings");
    expect(after.bookings).toHaveLength(before.bookings.length);
    expect(proposalResult.proposal?.status).toBe("pending");
    expect(harness.calls.find(({ path, method }) => path === "/api/proposals" && method === "POST")?.body).toEqual({
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: slot?.startDate,
      endDate: slot?.endDate,
    });
  });

  it("rejects unknown execution tools and strict-schema violations before any request", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    harness.calls.length = 0;
    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    await expect(tools.run("anny_execute_booking", {})).rejects.toThrow(/nicht freigegeben/u);
    await expect(tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-15",
      time: "09:00",
      durationMinutes: 60,
      serviceId: "00000000-0000-4000-8000-000000000201",
    })).rejects.toThrow(/Argumente passen/u);
    await expect(tools.run("anny_list_my_bookings", { identity: "student" }))
      .rejects.toThrow(/Argumente passen/u);
    await expect(tools.run("anny_search_resources", { officeType: "private" }))
      .rejects.toThrow(/Argumente passen/u);

    expect(harness.calls).toEqual([]);
  });

  it("blocks an inaccessible resource using the current allowed-resource list", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    harness.calls.length = 0;
    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    await expect(tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000103",
      date: "2030-01-15",
      time: "09:00",
      durationMinutes: 60,
    })).rejects.toThrow(/aktuell zugänglichen Ressourcen/u);

    expect(harness.calls.map(({ path }) => path)).toEqual(["/api/resources"]);
  });

  it("matches slots by instant, rejects different instants, and sends cached timestamps", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    const tools = createAnnyChatTools(harness.request, { now: harness.now });
    await tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-15",
      time: "09:00",
      durationMinutes: 60,
    });
    harness.calls.length = 0;

    await expect(tools.run("anny_propose_booking", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      startDate: "2030-01-15T11:00:00.000Z",
      endDate: "2030-01-15T12:00:00.000Z",
    })).rejects.toThrow(/nicht als verfügbar geprüft/u);

    expect(harness.calls.map(({ path }) => path)).toEqual(["/api/resources"]);

    harness.calls.length = 0;
    const availability = await tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-15",
      time: "09:00",
      durationMinutes: 60,
    });
    const slot = outputIntervals(availability).find(({ available, startDate }) => available && startDate === "2030-01-15T09:00:00.000Z");
    expect(slot).toBeDefined();

    const equivalent = await tools.run("anny_propose_booking", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      startDate: "2030-01-15T10:00:00+01:00",
      endDate: "2030-01-15T11:00:00+01:00",
    });
    expect(equivalent.proposal?.status).toBe("pending");

    expect(harness.calls.find(({ path, method }) => path === "/api/proposals" && method === "POST")?.body).toEqual({
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: slot?.startDate,
      endDate: slot?.endDate,
    });
  });

  it("keeps unavailable intervals in model output but omits them from host cards", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    const bookingTools = createAnnyChatTools(harness.request, { now: harness.now });
    const bookingAvailability = await bookingTools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-03",
      time: "08:00",
      durationMinutes: 120,
    });
    const bookingSlot = outputIntervals(bookingAvailability).find((interval) => (
      interval.available && interval.startDate === "2030-01-03T09:00:00.000Z"
    ));
    expect(bookingSlot).toBeDefined();
    const prepared = await bookingTools.run("anny_propose_booking", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      startDate: bookingSlot?.startDate,
      endDate: bookingSlot?.endDate,
    });
    expect(prepared.proposal?.status).toBe("pending");
    const proposalId = prepared.proposal?.id;
    expect(proposalId).toBeDefined();
    const confirmed = await harness.request<{ proposal: { status: string } }>(`/api/proposals/${required(proposalId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(confirmed.proposal.status).toBe("confirmed");

    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    const result = await tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-03",
      time: "08:00",
      durationMinutes: 120,
    });
    const modelIntervals = outputIntervals(result);

    expect(modelIntervals).toHaveLength(3);
    expect(modelIntervals.some(({ available }) => !available)).toBe(true);
    expect(result.rooms?.[0]?.intervals.every(({ available }) => available)).toBe(true);
    expect(result.rooms?.[0]?.intervals).toEqual([
      expect.objectContaining({ startDate: "2030-01-03T07:00:00.000Z", available: true }),
    ]);
  });

  it("shows only the exact requested available interval, never unsolicited alternatives", () => {
    const intervals: TimeInterval[] = [
      { startDate: "2030-01-03T07:00:00.000Z", endDate: "2030-01-03T08:00:00.000Z", available: false },
      { startDate: "2030-01-03T08:00:00.000Z", endDate: "2030-01-03T09:00:00.000Z", available: true },
      { startDate: "2030-01-03T09:00:00.000Z", endDate: "2030-01-03T10:00:00.000Z", available: true },
      { startDate: "2030-01-03T10:00:00.000Z", endDate: "2030-01-03T11:00:00.000Z", available: true },
      { startDate: "2030-01-03T11:00:00.000Z", endDate: "2030-01-03T12:00:00.000Z", available: true },
    ];

    expect(visibleAvailabilityIntervals(intervals, "2030-01-03T07:00:00.000Z")).toEqual([]);
    expect(visibleAvailabilityIntervals(intervals, "2030-01-03T08:00:00.000Z")).toEqual([intervals[1]]);
    expect(visibleAvailabilityIntervals(intervals, "2030-01-03T06:00:00.000Z")).toEqual([]);
  });

  it("bounds result counts and metadata size", async () => {
    const resources: Resource[] = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Raum ${String(index + 1)}`,
      description: "Testbeschreibung",
      capacity: 8,
      location: "Campus Linden",
      features: ["Whiteboard"],
      serviceId: "00000000-0000-4000-8000-000000000201",
    }));
    const bookings: Booking[] = Array.from({ length: 14 }, (_, index) => ({
      id: `booking-${String(index)}`,
      resourceName: `Raum ${String(index)}`,
      startDate: "2030-02-01T09:00:00.000Z",
      endDate: "2030-02-01T10:00:00.000Z",
      status: "confirmed",
    }));
    const request: Request = <T>(path: string): Promise<T> => {
      if (path === "/api/resources") return Promise.resolve({ resources } as T);
      if (path === "/api/bookings") return Promise.resolve({ bookings } as T);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    };
    const tools = createAnnyChatTools(request, { now: () => new Date("2030-01-01T10:30:00.000Z") });

    const search = await tools.run("anny_search_resources", {});
    expect(search.rooms).toHaveLength(8);
    expect(search.output.truncated).toBe(4);
    expect(JSON.stringify(search.output).length).toBeLessThanOrEqual(8_000);

    const listed = await tools.run("anny_list_my_bookings", {});
    expect(listed.bookings).toHaveLength(10);
    expect(listed.output.truncated).toBe(4);
    expect(JSON.stringify(listed.output).length).toBeLessThanOrEqual(8_000);
  });

  it("preserves the disabled-plugin API error", async () => {
    const harness = createHarness();
    await login(harness.request, "admin");
    await harness.request("/api/admin/plugins/de.hsh.hasi.anny/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    await expect(tools.run("anny_search_resources", {})).rejects.toMatchObject({
      status: 409,
      message: "Das Plugin ist deaktiviert.",
    });
  });
});
