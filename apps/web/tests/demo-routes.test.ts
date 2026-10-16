import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createDemoRuntime: vi.fn(),
  deleteExpired: vi.fn(),
  handleChatPost: vi.fn(),
  initialize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server/chat-http", () => ({ handleChatPost: mocks.handleChatPost }));
vi.mock("@/lib/server/model-router", () => ({
  listModelProfiles: vi.fn(() => ({ configured: false, profiles: [] })),
  runModelStep: vi.fn(),
}));
vi.mock("@hasi/demo-runtime", () => ({ createDemoRuntime: mocks.createDemoRuntime }));
vi.mock("@hasi/state", () => ({
  PostgresJsonStore: vi.fn().mockImplementation(function PostgresJsonStoreMock() {
    return {
      initialize: mocks.initialize,
      deleteExpired: mocks.deleteExpired,
      close: mocks.close,
    };
  }),
}));

const originalEnv = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function chatRequest() {
  return new Request("https://hasi.metaneutrons.cc/api/chat", {
    method: "POST",
    headers: {
      origin: "https://hasi.metaneutrons.cc",
      "content-type": "application/json",
    },
    body: JSON.stringify({ messages: [] }),
  });
}

async function postChat(request: Request) {
  const { POST } = await import("../src/app/api/chat/route");
  return POST(request);
}

function setPreviewEnv() {
  setEnv({
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_URL: "hasi-preview.vercel.app",
    VERCEL_GIT_COMMIT_SHA: "test-commit",
    HASI_DEMO_MODE: "1",
    HASI_DEMO_ORIGIN: undefined,
    HASI_DEMO_SECRET: "test-only-secret",
    DATABASE_URL: "postgres://unused:test@localhost/hasi",
    VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.deleteExpired.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
});

describe("chat route demo boundary", () => {
  it("rejects anonymous visitors before invoking chat", async () => {
    setPreviewEnv();
    mocks.createDemoRuntime.mockReturnValue({ hasSession: vi.fn().mockResolvedValue(false) });

    const response = await postChat(chatRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.handleChatPost).not.toHaveBeenCalled();
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });

  it("fails closed on Vercel when HASI_DEMO_MODE is missing", async () => {
    setEnv({ VERCEL: "1", HASI_DEMO_MODE: undefined });

    const response = await postChat(chatRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.handleChatPost).not.toHaveBeenCalled();
  });

  it("returns a generic unavailable response when session storage fails", async () => {
    setPreviewEnv();
    mocks.initialize.mockRejectedValue(new Error("database password leaked"));

    const response = await postChat(chatRequest());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toContain("database password leaked");
    expect(mocks.handleChatPost).not.toHaveBeenCalled();
  });

  it("passes an authenticated visitor through the existing chat handler", async () => {
    setPreviewEnv();
    mocks.createDemoRuntime.mockReturnValue({ hasSession: vi.fn().mockResolvedValue(true) });
    mocks.handleChatPost.mockResolvedValue(new Response("handled by chat", { status: 202 }));

    const response = await postChat(chatRequest());

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("handled by chat");
    expect(mocks.handleChatPost).toHaveBeenCalledOnce();
  });
});

describe("demo response host boundary", () => {
  it("pins the internal request origin while preserving path and query", async () => {
    setPreviewEnv();
    const handleCore = vi.fn(async (request: Request) => Response.json({ url: request.url }));
    mocks.createDemoRuntime.mockReturnValue({ handleCore });
    const { demoResponse } = await import("../src/lib/server/demo-runtime");

    const response = await demoResponse(
      new Request("http://localhost:3000/api/rooms?building=main&limit=2", {
        headers: { host: "hasi-preview.vercel.app" },
      }),
      "handleCore",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://hasi-preview.vercel.app/api/rooms?building=main&limit=2",
    });
    expect(handleCore).toHaveBeenCalledOnce();
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched Host without opening the backend", async () => {
    setPreviewEnv();
    const { demoResponse } = await import("../src/lib/server/demo-runtime");

    const response = await demoResponse(
      new Request("http://localhost:3000/api/rooms?building=main", {
        headers: { host: "attacker.example" },
      }),
      "handleCore",
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.createDemoRuntime).not.toHaveBeenCalled();
  });
});
