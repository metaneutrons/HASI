import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHostDialogueSigner } from "../src/lib/server/host-dialogue";
import { required } from "./test-utils";

const origin = "https://hasi.example.edu";
const api = "https://api.example.edu";
const secret = "synthetic-dialogue-route-secret".padEnd(43, "x");
const authority = "a".repeat(64);
const resources = Array.from({ length: 9 }, (_, index) => ({ id: `desk-${String(index)}`, name: `Synthetic desk ${String(index)}`, description: "", capacity: 1,
  serviceId: "synthetic-anny", location: "1J", kind: "workplace" as const, features: [], officeWorkplaceCount: index % 2 ? 1 : 2 }));
function pathOf(input: RequestInfo | URL) { return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); }
async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("../src/app/api/chat/dialogue/route");
  return POST(new Request(origin + "/api/chat/dialogue", { method: "POST", headers: {
    host: new URL(origin).host, origin, "content-type": "application/json", cookie: "hasi_session=synthetic-only", ...headers }, body: JSON.stringify(body) }));
}
beforeEach(() => {
  vi.stubEnv("HASI_APP_MODE", "production"); vi.stubEnv("HASI_DEMO_MODE", "0"); vi.stubEnv("HASI_LOCAL_TEST_IDP", ""); vi.stubEnv("VERCEL", "");
  vi.stubEnv("HASI_WEB_ORIGIN", origin); vi.stubEnv("HASI_API_ORIGIN", api); vi.stubEnv("HASI_CHAT_SIGNING_SECRET", secret);
  vi.stubEnv("HASI_CONTEXT_DATA_CLASSES", '["public"]');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("protected host dialogue Next route", () => {
  it("computes a clarification through pinned authenticated GETs, with no model or write request", async () => {
    const calls: { path: string; method: string }[] = [];
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = pathOf(input);
      expect(url.origin).toBe(api);
      const method = init?.method ?? "GET";
      expect(method).toBe("GET");
      expect(new Headers(init?.headers).get("cookie")).toBe("hasi_session=synthetic-only");
      calls.push({ path: url.pathname, method });
      if (url.pathname === "/api/session") return Promise.resolve(Response.json({ mode: "oidc", user: { id: "synthetic-user" }, modelContext: { dataClasses: ["public"] } }));
      if (url.pathname === "/api/history/authority") return Promise.resolve(Response.json({ authorityDigest: authority }));
      if (url.pathname === "/api/resources") return Promise.resolve(Response.json({ resources }));
      throw new Error("Unexpected test destination");
    }) satisfies typeof fetch);
    const conversationId = randomUUID();
    const response = await post({ kind: "rooms", conversationId, request: { kind: "workplace", location: "1J" } });
    expect(response.status).toBe(200);
    const body = await response.json() as { message: { hostDialogue: { code: string } }; plan: { code: string; resources: unknown[] } };
    expect(body.plan.code).toBe("room_refine"); expect(body.plan.resources).toEqual([]);
    expect(body.message.hostDialogue.code).toBe("room_refine");
    expect(createHostDialogueSigner(secret, "production:synthetic-user").verify(conversationId, body.message,
      { authorityDigest: authority, resources, resourcesAvailable: true })).toBeDefined();
    expect(calls.map(call => call.path)).toEqual(["/api/session", "/api/history/authority", "/api/resources", "/api/history/authority"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects an unauthenticated or cross-origin caller before reading source data", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ mode: "oidc", user: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await post({ kind: "static", code: "greeting", conversationId: randomUUID() })).status).toBe(401);
    fetchMock.mockResolvedValue(Response.json({ mode: "oidc", user: { id: "synthetic-user" }, modelContext: { dataClasses: ["public"] } }));
    expect((await post({ kind: "rooms", conversationId: randomUUID(), request: {} }, { origin: "https://attacker.example" })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pathOf(required(fetchMock.mock.calls[1])[0]).pathname).toBe("/api/session");
  });
});
