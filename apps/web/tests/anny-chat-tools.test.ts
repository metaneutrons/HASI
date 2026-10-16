import { describe, expect, it } from "vitest";
import {
  createAnnyChatTools,
  type AnnyChatToolResult,
} from "../src/lib/anny-chat-tools";
import {
  createPublicDemoTransport,
  PUBLIC_DEMO_STORAGE_KEY,
  type PublicDemoStorage,
} from "../src/lib/public-demo";
import type { Booking, Resource, TimeInterval } from "../src/lib/types";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

class MemoryStorage implements PublicDemoStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function createHarness(startAt = "2030-01-01T10:30:00.000Z", storage = new MemoryStorage()) {
  const currentTime = new Date(startAt);
  const transport = createPublicDemoTransport({ storage, now: () => new Date(currentTime) });
  const calls: Array<{ path: string; method: string }> = [];
  const request: Request = <T>(path: string, init: RequestInit = {}) => {
    calls.push({ path, method: (init.method ?? "GET").toUpperCase() });
    return transport.request<T>(path, init);
  };
  return {
    calls,
    storage,
    request,
    now: () => new Date(currentTime),
  };
}

async function login(request: Request, personaId: "student" | "employee" | "admin") {
  return request<{ user: { id: string; role: string }; mode: string }>("/api/dev/login", {
    method: "POST",
    body: JSON.stringify({ personaId }),
  });
}

function outputIntervals(result: AnnyChatToolResult): TimeInterval[] {
  return Array.isArray(result.output.intervals) ? result.output.intervals as TimeInterval[] : [];
}

describe("bounded Anny chat tools", () => {
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
    const saved = JSON.parse(harness.storage.getItem(PUBLIC_DEMO_STORAGE_KEY) ?? "null") as {
      proposals?: Array<{ status: string }>;
    };
    expect(saved.proposals?.at(-1)?.status).toBe("pending");
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
    const slot = outputIntervals(availability).find(({ available }) => available);
    expect(slot).toBeDefined();

    const equivalent = await tools.run("anny_propose_booking", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      startDate: "2030-01-15T10:00:00+01:00",
      endDate: "2030-01-15T11:00:00+01:00",
    });
    expect(equivalent.proposal?.status).toBe("pending");

    const saved = JSON.parse(harness.storage.getItem(PUBLIC_DEMO_STORAGE_KEY) ?? "null") as {
      proposals?: Array<{ arguments: { startDate: string; endDate: string } }>;
    };
    expect(saved.proposals?.at(-1)?.arguments).toEqual({
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: slot?.startDate,
      endDate: slot?.endDate,
    });
  });

  it("keeps unavailable intervals in model output but omits them from host cards", async () => {
    const harness = createHarness();
    await login(harness.request, "student");
    const tools = createAnnyChatTools(harness.request, { now: harness.now });

    const result = await tools.run("anny_get_availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      date: "2030-01-03",
      time: "08:00",
      durationMinutes: 120,
    });
    const modelIntervals = outputIntervals(result);

    expect(modelIntervals).toHaveLength(2);
    expect(modelIntervals.some(({ available }) => !available)).toBe(true);
    expect(result.rooms?.[0]?.intervals.every(({ available }) => available)).toBe(true);
    expect(result.rooms?.[0]?.intervals).toHaveLength(1);
  });

  it("bounds result counts and metadata size", async () => {
    const resources: Resource[] = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Raum ${index + 1}`,
      description: "Testbeschreibung",
      capacity: 8,
      location: "Campus Linden",
      features: ["Whiteboard"],
      serviceId: "00000000-0000-4000-8000-000000000201",
    }));
    const bookings: Booking[] = Array.from({ length: 14 }, (_, index) => ({
      id: `booking-${index}`,
      resourceName: `Raum ${index}`,
      startDate: "2030-02-01T09:00:00.000Z",
      endDate: "2030-02-01T10:00:00.000Z",
      status: "confirmed",
    }));
    const request: Request = async <T>(path: string): Promise<T> => {
      if (path === "/api/resources") return { resources } as T;
      if (path === "/api/bookings") return { bookings } as T;
      throw new Error(`Unexpected request: ${path}`);
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
      message: "Das Demo-Plug-in ist deaktiviert.",
    });
  });
});
