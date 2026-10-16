import { describe, expect, it } from "vitest";
import {
  createPublicDemoTransport,
  PUBLIC_DEMO_STORAGE_KEY,
  type PublicDemoStorage,
} from "../src/lib/public-demo";

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

function createHarness(startAt = "2026-10-16T10:30:00.000Z", storage = new MemoryStorage()) {
  let currentTime = new Date(startAt);
  const transport = createPublicDemoTransport({ storage, now: () => new Date(currentTime) });
  return {
    storage,
    request: transport.request,
    setNow(value: string) {
      currentTime = new Date(value);
    },
  };
}

async function login(request: <T>(path: string, init?: RequestInit) => Promise<T>, personaId: string) {
  return request<{ user: { id: string; role: string }; mode: string }>("/api/dev/login", {
    method: "POST",
    body: JSON.stringify({ personaId }),
  });
}

async function post<T>(
  request: <U>(path: string, init?: RequestInit) => Promise<U>,
  path: string,
  body: unknown,
): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

describe("public browser demo transport", () => {
  it("keeps the existing persona and resource contracts for student and staff roles", async () => {
    const { request } = createHarness();
    const personas = await request<{ personas: { id: string }[] }>("/api/dev/personas");
    expect(personas.personas.map(({ id }) => id)).toEqual(["student", "employee", "admin"]);

    await expect(request("/api/resources")).rejects.toMatchObject({ status: 401 });
    const student = await login(request, "student");
    expect(student.mode).toBe("public-demo");
    const studentResources = await request<{ resources: { id: string }[] }>("/api/resources");
    expect(studentResources.resources).toHaveLength(2);

    await login(request, "employee");
    const staffResources = await request<{ resources: { id: string }[] }>("/api/resources");
    expect(staffResources.resources).toHaveLength(4);
  });

  it("omits past slots and marks an overlap with the current persona's booking unavailable", async () => {
    const { request } = createHarness();
    await login(request, "student");

    const sameDay = await post<{ intervals: { startDate: string }[] }>(request, "/api/availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-16T09:00:00Z",
      durationMinutes: 60,
    });
    expect(sameDay.intervals.map(({ startDate }) => startDate)).toEqual(["2026-10-16T13:00:00.000Z"]);

    const seedDay = await post<{ intervals: { startDate: string; available: boolean }[] }>(request, "/api/availability", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-18T09:00:00Z",
      durationMinutes: 120,
    });
    expect(seedDay.intervals).toEqual([
      { startDate: "2026-10-18T09:00:00.000Z", endDate: "2026-10-18T11:00:00.000Z", available: false },
      { startDate: "2026-10-18T13:00:00.000Z", endDate: "2026-10-18T15:00:00.000Z", available: true },
    ]);
  });

  it("confirms the exact proposal once and replays the same booking result", async () => {
    const { request } = createHarness();
    await login(request, "student");
    const before = await request<{ bookings: { id: string }[] }>("/api/bookings");
    const args = {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-23T09:00:00Z",
      endDate: "2026-10-23T10:30:00Z",
    };
    const created = await post<{ proposal: { id: string; arguments: typeof args; status: string } }>(request, "/api/proposals", args);
    expect(created.proposal.arguments).toEqual(args);
    expect(created.proposal.status).toBe("pending");

    const path = `/api/proposals/${encodeURIComponent(created.proposal.id)}/confirm`;
    const first = await post<{ bookingId: string; proposal: { status: string } }>(request, path, {});
    const replay = await post<{ bookingId: string; proposal: { status: string } }>(request, path, {});
    const after = await request<{ bookings: { id: string }[] }>("/api/bookings");
    expect(first.proposal.status).toBe("confirmed");
    expect(replay.bookingId).toBe(first.bookingId);
    expect(after.bookings).toHaveLength(before.bookings.length + 1);
  });

  it("rejects an expired proposal and hides it from another persona", async () => {
    const expiredHarness = createHarness();
    await login(expiredHarness.request, "student");
    const expired = await post<{ proposal: { id: string } }>(expiredHarness.request, "/api/proposals", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-23T09:00:00Z",
      endDate: "2026-10-23T10:00:00Z",
    });
    expiredHarness.setNow("2026-10-16T10:35:00.000Z");
    await expect(post(expiredHarness.request, `/api/proposals/${expired.proposal.id}/confirm`, {}))
      .rejects.toMatchObject({ status: 409 });

    const crossPersonaHarness = createHarness();
    await login(crossPersonaHarness.request, "student");
    const proposal = await post<{ proposal: { id: string } }>(crossPersonaHarness.request, "/api/proposals", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-23T13:00:00Z",
      endDate: "2026-10-23T14:00:00Z",
    });
    await login(crossPersonaHarness.request, "employee");
    await expect(post(crossPersonaHarness.request, `/api/proposals/${proposal.proposal.id}/confirm`, {}))
      .rejects.toMatchObject({ status: 404 });
  });

  it("resets malformed persisted data and continues with a valid local state", async () => {
    const storage = new MemoryStorage();
    storage.setItem(PUBLIC_DEMO_STORAGE_KEY, "{ broken state");
    const { request } = createHarness("2026-10-16T10:30:00.000Z", storage);

    const personas = await request<{ personas: { id: string }[] }>("/api/dev/personas");
    expect(personas.personas).toHaveLength(3);
    await login(request, "admin");
    const session = await request<{ user: { role: string } | null }>("/api/session");
    expect(session.user?.role).toBe("admin");
    expect(JSON.parse(storage.getItem(PUBLIC_DEMO_STORAGE_KEY) ?? "null")).toMatchObject({ version: 1 });
  });

  it("keeps update checks local and validates booking ranges", async () => {
    const { request } = createHarness();
    await login(request, "admin");
    const plugins = await request<{ plugins: { healthy: boolean; tools: { effect: string }[] }[] }>("/api/admin/plugins");
    expect(plugins.plugins[0]?.healthy).toBe(false);
    expect(plugins.plugins[0]?.tools).toHaveLength(5);
    const result = await post<{ status: string; message: string }>(request, "/api/admin/plugins/de.hsh.hasi.anny/check-update", {});
    expect(result).toMatchObject({ status: "current" });
    expect(result.message).toContain("kein Update-Server");

    await expect(post(request, "/api/proposals", {
      resourceId: "00000000-0000-4000-8000-000000000101",
      serviceId: "00000000-0000-4000-8000-000000000201",
      startDate: "2026-10-23T09:00:00Z",
      endDate: "2026-10-23T09:10:00Z",
    })).rejects.toMatchObject({ status: 400 });
    await expect(post(request, "/api/admin/plugins/de.hsh.hasi.anny/activate-update", {}))
      .rejects.toMatchObject({ status: 409 });

    await post(request, "/api/admin/plugins/de.hsh.hasi.anny/enabled", { enabled: false });
    await expect(request("/api/resources")).rejects.toMatchObject({ status: 409 });
  });
});
