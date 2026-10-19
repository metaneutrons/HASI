import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryJsonStore } from "@hasi/state";

vi.mock("server-only", () => ({}));
const storage = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../src/lib/server/server-chat-storage", () => ({ getServerChatStorage: storage.get }));
import { protectedCoreRequest, protectedWebConfiguration, productionWebConfiguration } from "../src/lib/server/core-api";
import { GET, PUT } from "../src/app/api/chat/workspace/route";

const origin = "http://127.0.0.1:3001";
function urlOf(value: RequestInfo | URL): string {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}
function request(method = "GET", cookie = "first", body?: unknown, requestOrigin = origin) {
  return new Request(origin + "/api/chat/workspace", { method, headers: {
    host: "127.0.0.1:3001", origin: requestOrigin, cookie, "content-type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("explicit local TestIdP protected web composition", () => {
  beforeEach(() => {
    vi.stubEnv("HASI_APP_MODE", ""); vi.stubEnv("HASI_DEMO_MODE", "0"); vi.stubEnv("VERCEL", "");
    vi.stubEnv("HASI_LOCAL_TEST_IDP", "1"); vi.stubEnv("HASI_LOCAL_TEST_IDP_SCOPE", randomUUID());
    vi.stubEnv("HASI_WEB_ORIGIN", origin); vi.stubEnv("HASI_CHAT_SIGNING_SECRET", "s".repeat(43));
    vi.stubEnv("DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/hasi_topology_test");
    storage.get.mockResolvedValue(new MemoryJsonStore("local-protected-" + randomUUID()));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = new URL(urlOf(input)).pathname;
      if (path === "/api/session") {
        const cookie = new Headers(init?.headers).get("cookie");
        return Promise.resolve(Response.json(cookie === "anonymous" ? { mode: "oidc", user: null }
          : { mode: "oidc", user: { id: cookie === "second" ? "test-subject-two" : "test-subject-one" }, modelContext: { dataClasses: ["synthetic_demo"] } }));
      }
      if (path === "/api/tools") return Promise.resolve(Response.json({ tools: [] }));
      if (path === "/api/history/authority") return Promise.resolve(Response.json({ authorityDigest: "a".repeat(64) }));
      throw new Error("Unexpected fixture destination");
    }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("pins synthetic-only loopback authority without relaxing production configuration", async () => {
    expect(protectedWebConfiguration()).toMatchObject({ kind: "local-test-idp", origin, apiOrigin: "http://127.0.0.1:4100", dataClasses: ["synthetic_demo"] });
    expect(() => productionWebConfiguration()).toThrow();
    await protectedCoreRequest("/api/tools", request(), "GET");
    const calls = vi.mocked(fetch).mock.calls;
    const call = calls[0]; if (!call) throw new Error("Missing core call");
    expect(urlOf(call[0])).toBe("http://127.0.0.1:4100/api/tools");
  });

  it.each([
    ["VERCEL", "1"], ["HASI_DEMO_MODE", "1"], ["HASI_LOCAL_TEST_IDP", "0"],
    ["HASI_WEB_ORIGIN", "http://example.invalid:3001"], ["HASI_WEB_ORIGIN", "http://127.0.0.1:3001/path"],
    ["DATABASE_URL", "postgresql://postgres@database.invalid:5432/hasi_topology_test"],
    ["DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/hasi"],
    ["HASI_CHAT_SIGNING_SECRET", ""], ["HASI_LOCAL_TEST_IDP_SCOPE", "unbound"],
  ])("rejects unsafe local configuration %s before network/storage", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => protectedWebConfiguration()).toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(storage.get).not.toHaveBeenCalled();
  });

  it("keeps production HTTPS and classification even if the local flag is present", () => {
    vi.stubEnv("HASI_APP_MODE", "production"); vi.stubEnv("HASI_WEB_ORIGIN", "https://hasi.example.edu");
    vi.stubEnv("HASI_API_ORIGIN", "https://api.example.edu");
    expect(protectedWebConfiguration()).toMatchObject({ kind: "production", dataClasses: ["public", "internal", "confidential"] });
    vi.stubEnv("HASI_WEB_ORIGIN", origin);
    expect(() => protectedWebConfiguration()).toThrow();
  });

  it("persists the verified subject's draft with the real protected store and isolates another subject", async () => {
    const initial = await GET(request()); expect(initial.status).toBe(200);
    const payload = await initial.json() as { revision: string | null; workspace: { ownerId: string; sessions: { snapshot: { input: string } }[] } };
    expect(payload.workspace.ownerId).toBe("test-subject-one");
    const session = payload.workspace.sessions[0]; if (!session) throw new Error("Missing initial chat");
    session.snapshot.input = "Synthetic draft survives reload";
    const saved = await PUT(request("PUT", "first", { expectedRevision: payload.revision, workspace: payload.workspace }));
    expect(saved.status).toBe(200);
    const loaded = await GET(request());
    expect(await loaded.json()).toMatchObject({ workspace: { ownerId: "test-subject-one", sessions: [{ snapshot: { input: "Synthetic draft survives reload" } }] } });
    const foreign = await GET(request("GET", "second"));
    expect(await foreign.json()).toMatchObject({ workspace: { ownerId: "test-subject-two", sessions: [{ snapshot: { input: "" } }] } });
  });

  it("rejects an API that reports protected context instead of assuming local data is synthetic", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      mode: "oidc", user: { id: "test-subject" }, modelContext: { dataClasses: ["confidential"] },
    })));
    expect((await GET(request())).status).toBe(503);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("cannot promote a local mock persona into protected OIDC authority", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ mode: "mock", user: { id: "forged-persona" } })));
    expect((await GET(request())).status).toBe(401);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("denies anonymous sessions and cross-origin writes before opening protected storage", async () => {
    expect((await GET(request("GET", "anonymous"))).status).toBe(401);
    expect((await PUT(request("PUT", "first", {}, "http://evil.invalid"))).status).toBe(403);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
