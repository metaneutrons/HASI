import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/demo-runtime", () => ({ canonicalDemoRequest: vi.fn(), getDemoRuntime: vi.fn() }));

import { loadAuthorizedModelTools } from "../src/lib/server/authorized-tools";
import { ModelRouterError } from "../src/lib/server/model-router-error";

function tool(modelName?: string) {
  const pluginId = "example.plugin";
  const name = "status.read";
  const digest = createHash("sha256").update(pluginId).update("\u0000").update(name).digest("hex").slice(0, 24);
  return {
    pluginId,
    name,
    title: "Status",
    description: "Liest Statusdaten.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    effect: "read",
    requiredPermissions: ["status:read"],
    modelName: modelName ?? `hasi_${digest}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("server-side authorized tool discovery", () => {
  it("uses only the fixed local core origin and forwards the authenticated cookie", async () => {
    vi.stubEnv("HASI_DEMO_MODE", "0");
    const requests: { url: string; init?: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      return Promise.resolve(Response.json({ tools: [tool()] }));
    });
    const request = new Request("https://attacker.invalid/api/chat", {
      headers: { cookie: "hasi_session=opaque", authorization: "Bearer never-forward-this" },
    });

    await expect(loadAuthorizedModelTools(request)).resolves.toMatchObject([{ pluginId: "example.plugin", name: "status.read" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4100/api/tools");
    expect(new Headers(requests[0]?.init?.headers).get("cookie")).toBe("hasi_session=opaque");
    expect(new Headers(requests[0]?.init?.headers).has("authorization")).toBe(false);
    expect(requests[0]?.init?.redirect).toBe("error");
  });

  it("rejects forged hashes and oversized responses as unavailable without exposing body details", async () => {
    vi.stubEnv("HASI_DEMO_MODE", "0");
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ tools: [tool("hasi_aaaaaaaaaaaaaaaaaaaaaaaa")] })));
    await expect(loadAuthorizedModelTools(new Request("http://web.local/api/chat"))).rejects.toMatchObject({ code: "tools_unavailable" });

    vi.stubGlobal("fetch", () => Promise.resolve(new Response("x".repeat(128 * 1024 + 1), { headers: { "content-type": "application/json" } })));
    let failure: unknown;
    try { await loadAuthorizedModelTools(new Request("http://web.local/api/chat")); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ModelRouterError);
    expect(failure).toMatchObject({ code: "tools_unavailable" });
    expect(failure).toHaveProperty("message", "Authorized model tools could not be verified.");
  });
});
