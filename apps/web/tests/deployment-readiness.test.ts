import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ budget: vi.fn(), storage: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/model-budgets", () => ({ getModelBudgetAdmission: mocks.budget }));
vi.mock("@/lib/server/server-chat-storage", () => ({ getServerChatStorage: mocks.storage }));

import { GET } from "../src/app/api/health/route";

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("deployment readiness", () => {
  it("checks the existing budget and durable state without spending tokens or writing rows", async () => {
    vi.stubEnv("HASI_BUILD_REVISION", "a".repeat(40));
    mocks.budget.mockResolvedValue({ reserve: vi.fn() });
    mocks.storage.mockResolvedValue({ read: mocks.read });
    mocks.read.mockResolvedValue(undefined);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ready", revision: "a".repeat(40) });
    expect(mocks.budget).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith("deployment-readiness");
  });

  it.each(["", "unknown", "private-revision", "a".repeat(41)])("rejects unbound image revision %s", async revision => {
    vi.stubEnv("HASI_BUILD_REVISION", revision);
    expect((await GET()).status).toBe(503);
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalled();
  });

  it.each(["budget", "storage", "read"] as const)("fails closed and redacts %s errors", async failure => {
    vi.stubEnv("HASI_BUILD_REVISION", "b".repeat(40));
    mocks.budget.mockResolvedValue({});
    mocks.storage.mockResolvedValue({ read: mocks.read });
    mocks.read.mockResolvedValue(undefined);
    mocks[failure].mockRejectedValue(new Error("synthetic-private-database-credential"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"unavailable"}');
  });
});
