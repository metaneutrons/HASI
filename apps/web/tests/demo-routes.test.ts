import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn<(
    id: string,
    options?: { rateLimitKey?: string },
  ) => Promise<{ rateLimited: boolean; error?: "not-found" | "blocked" }>>(),
  createDemoRuntime: vi.fn(),
  deleteExpired: vi.fn(),
  handleChatPost: vi.fn(),
  handleTimestampPost: vi.fn(),
  initialize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server/chat-http", () => ({ handleChatPost: mocks.handleChatPost, handleTimestampPost: mocks.handleTimestampPost }));
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
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

function chatRequest() {
  const origin = process.env.VERCEL_ENV === "preview"
    ? `https://${String(process.env.VERCEL_URL)}`
    : "https://hasi.metaneutrons.cc";
  return new Request(`${origin}/api/chat`, {
    method: "POST",
    headers: {
      host: new URL(origin).host,
      origin,
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
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  originalEnv.clear();
});

describe("chat route demo boundary", () => {
  it("rejects a foreign Host before opening session storage", async () => {
    setPreviewEnv();
    const request = chatRequest();
    request.headers.set("host", "attacker.invalid");
    request.headers.set("x-forwarded-host", "hasi-preview.vercel.app");

    expect((await postChat(request)).status).toBe(403);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.handleChatPost).not.toHaveBeenCalled();
  });

  it("rejects anonymous visitors before invoking chat", async () => {
    setPreviewEnv();
    mocks.createDemoRuntime.mockReturnValue({ chatScope: vi.fn().mockResolvedValue(null) });

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
    mocks.createDemoRuntime.mockReturnValue({ chatScope: vi.fn().mockResolvedValue("workspace:student") });
    mocks.handleChatPost.mockResolvedValue(new Response("handled by chat", { status: 202 }));

    const response = await postChat(chatRequest());

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("handled by chat");
    expect(mocks.handleChatPost).toHaveBeenCalledOnce();
  });
});

describe("timestamp route session and admission boundary", () => {
  it("rejects anonymous receipt requests", async () => {
    setPreviewEnv();
    mocks.createDemoRuntime.mockReturnValue({ chatScope: vi.fn().mockResolvedValue(null) });
    const { POST } = await import("../src/app/api/chat/timestamps/route");
    expect((await POST(chatRequest())).status).toBe(401);
    expect(mocks.handleTimestampPost).not.toHaveBeenCalled();
  });

  it("keeps receipt and inference rate buckets separate", async () => {
    setPreviewEnv();
    mocks.createDemoRuntime.mockReturnValue({ chatScope: vi.fn().mockResolvedValue("workspace:student") });
    mocks.checkRateLimit.mockResolvedValue({ rateLimited: false });
    mocks.handleChatPost.mockImplementation(async (_request: Request, deps: { admit: () => Promise<boolean> }) => { await deps.admit(); return new Response(); });
    mocks.handleTimestampPost.mockImplementation(async (_request: Request, deps: { admit: () => Promise<boolean> }) => { await deps.admit(); return new Response(); });
    await postChat(chatRequest());
    const { POST } = await import("../src/app/api/chat/timestamps/route");
    await POST(chatRequest());
    const keys = mocks.checkRateLimit.mock.calls.map(call => call[1]?.rateLimitKey);
    expect(keys[0]).toBe("hasi:groq:shared:v1");
    expect(keys[1]).toMatch(/^hasi:timestamps:v1:[0-9a-f]{64}$/u);
    expect(keys[1]).not.toContain("workspace:student");
  });
});

describe("demo response host boundary", () => {
  it("pins the internal request origin while preserving path and query", async () => {
    setPreviewEnv();
    const handleCore = vi.fn((request: Request) => Response.json({ url: request.url }));
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
