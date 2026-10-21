import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import { loadModelConfiguration } from "../src/lib/server/model-config";

const budgetMock = vi.hoisted(() => ({ getAdmission: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/model-budgets", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/server/model-budgets")>(),
  getModelBudgetAdmission: budgetMock.getAdmission,
}));

const webOrigin = "https://hasi.example.edu";
const apiOrigin = "https://api.example.edu";
const conversationId = "61f65b8d-d053-4e0a-8d69-e56c6b1650f7";

interface ProviderRequest {
  model?: string;
  messages?: { role?: string; content?: string }[];
  tools?: { name?: string; function?: { name?: string } }[];
}

function tool(pluginId: string, name: string) {
  return {
    pluginId,
    name,
    title: "Status",
    description: "Liest einen freigegebenen Status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    effect: "read",
    requiredPermissions: ["status:read"],
    modelName: expectedModelToolName(pluginId, name),
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function readProviderRequest(init: RequestInit | undefined): ProviderRequest {
  if (typeof init?.body !== "string") throw new TypeError("Expected a serialized provider request.");
  return JSON.parse(init.body) as ProviderRequest;
}

function providerToolNames(body: ProviderRequest): string[] {
  return (body.tools ?? []).map(item => item.function?.name ?? item.name).filter((name): name is string => typeof name === "string");
}

function configureModelPolicy(): void {
  const configuration = loadModelConfiguration({});
  const profileIds = ["groq-oss-120b", "groq-oss-20b", "groq-qwen-3.8-27b"] as const;
  for (const profileId of profileIds) {
    const profile = configuration.profiles.find(candidate => candidate.id === profileId);
    if (!profile) throw new Error("Expected a bundled Groq profile.");
    profile.capabilities.tools = true;
    profile.allowedDataClasses = profileId === "groq-qwen-3.8-27b" ? ["public"] : ["public", "confidential"];
  }
  configuration.policy.userChoice = { enabled: true, profileIds: [...profileIds] };
  configuration.policy.fallbacks = [];
  vi.stubEnv("HASI_LLM_CONFIG", JSON.stringify(configuration));
}

async function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
  const { POST } = await import("../src/app/api/chat/route");
  return POST(new Request(webOrigin + "/api/chat", {
    method: "POST", ...(signal ? { signal } : {}),
    headers: {
      host: new URL(webOrigin).host,
      origin: webOrigin,
      cookie: "hasi_session=test-only-cookie",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }));
}

describe("chat route profile switching policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("HASI_APP_MODE", "production");
    vi.stubEnv("HASI_DEMO_MODE", "0");
    vi.stubEnv("HASI_WEB_ORIGIN", webOrigin);
    vi.stubEnv("HASI_API_ORIGIN", apiOrigin);
    vi.stubEnv("HASI_CHAT_SIGNING_SECRET", "test-only-signing-secret-".padEnd(43, "x"));
    vi.stubEnv("HASI_CONTEXT_DATA_CLASSES", JSON.stringify(["public", "confidential"]));
    vi.stubEnv("GROQ_API_KEY", "test-only-groq-key");
    configureModelPolicy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reloads actor-approved tools on each profile switch and blocks a profile that cannot receive the full context", async () => {
    const toolSnapshots = [
      [tool("example.status", "status.read")],
      [tool("example.catalog", "catalog.read")],
      [tool("example.records", "records.read")],
    ];
    const providerRequests: ProviderRequest[] = [];
    const sessionFetches: string[] = [];
    const toolFetches: string[] = [];
    const reservedProfiles: string[] = [];

    budgetMock.getAdmission.mockImplementation(() => Promise.resolve({
      reserve: (input: { profileId: string }) => {
        reservedProfiles.push(input.profileId);
        return Promise.resolve({ settle: () => Promise.resolve(undefined) });
      },
    }));

    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      if (url.origin === apiOrigin && url.pathname === "/api/session") {
        sessionFetches.push(url.href);
        return Promise.resolve(Response.json({
          user: { id: "test-account" },
          mode: "oidc",
          modelContext: { dataClasses: ["public", "confidential"] },
        }));
      }
      if (url.origin === apiOrigin && url.pathname === "/api/history/authority") {
        return Promise.resolve(Response.json({ authorityDigest: "a".repeat(64) }));
      }
      if (url.origin === apiOrigin && url.pathname === "/api/tools") {
        toolFetches.push(url.href);
        const snapshot = toolSnapshots[toolFetches.length - 1];
        if (!snapshot) throw new Error("Unexpected extra tool-catalog request.");
        return Promise.resolve(Response.json({ tools: snapshot }));
      }
      if (url.origin === "https://api.groq.com" && url.pathname === "/openai/v1/chat/completions") {
        const request = readProviderRequest(init);
        providerRequests.push(request);
        return Promise.resolve(Response.json({
          id: "chatcmpl-route-policy-test",
          object: "chat.completion",
          created: 1_797_136_800,
          model: request.model ?? "test-model",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Test response." } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }));
      }
      throw new Error("Unexpected test fetch: " + url.href);
    }) satisfies typeof fetch);

    const first = await postChat({
      conversationId,
      profileId: "groq-oss-120b",
      messages: [{ role: "user", content: "Read the current status." }],
    });
    expect(first.status).toBe(200);
    const firstReply = await first.json() as { message: Record<string, unknown>; profile: { id: string } };
    expect(firstReply.profile.id).toBe("groq-oss-120b");

    const second = await postChat({
      conversationId,
      profileId: "groq-oss-20b",
      messages: [
        { role: "user", content: "Read the current status." },
        firstReply.message,
        { role: "user", content: "Read the status again." },
      ],
    });
    expect(second.status).toBe(200);
    const secondReply = await second.json() as { message: Record<string, unknown>; profile: { id: string } };
    expect(secondReply.profile.id).toBe("groq-oss-20b");

    const third = await postChat({
      conversationId,
      profileId: "groq-qwen-3.8-27b",
      messages: [
        { role: "user", content: "Read the current status." },
        firstReply.message,
        { role: "user", content: "Read the status again." },
        secondReply.message,
        { role: "user", content: "Read the status after switching models." },
      ],
    });

    expect(third.status).toBe(403);
    expect(await third.text()).toContain("Routing-Freigabe");
    expect(sessionFetches).toHaveLength(3);
    expect(toolFetches).toHaveLength(3);
    expect(providerRequests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Read the current status." }),
      expect.objectContaining({ role: "assistant", content: "Test response." }),
      expect.objectContaining({ role: "user", content: "Read the status again." }),
    ]));
    expect(providerRequests.map(request => request.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(providerToolNames(providerRequests[0] ?? {})).toEqual([toolSnapshots[0]?.[0]?.modelName]);
    expect(providerToolNames(providerRequests[1] ?? {})).toEqual([toolSnapshots[1]?.[0]?.modelName]);
    expect(providerToolNames(providerRequests[1] ?? {})).not.toContain(toolSnapshots[0]?.[0]?.modelName);
    expect(reservedProfiles).toEqual(["groq-oss-120b", "groq-oss-20b"]);
    expect(JSON.stringify(providerRequests)).not.toContain("authorityDigest");
    expect(JSON.stringify(providerRequests)).not.toContain("receipt");
  });
  it("stops before provider I/O when current authority changes after history admission", async () => {
    let authorityReads = 0;
    let providerCalls = 0;
    budgetMock.getAdmission.mockImplementation(() => Promise.resolve({
      reserve: () => Promise.resolve({ settle: () => Promise.resolve(undefined) }),
    }));
    vi.stubGlobal("fetch", ((input: RequestInfo | URL) => {
      const url = new URL(urlOf(input));
      if (url.origin === apiOrigin && url.pathname === "/api/session") return Promise.resolve(Response.json({
        user: { id: "test-account" }, mode: "oidc", modelContext: { dataClasses: ["public", "confidential"] },
      }));
      if (url.origin === apiOrigin && url.pathname === "/api/history/authority") return Promise.resolve(Response.json({
        authorityDigest: (++authorityReads === 1 ? "a" : "b").repeat(64),
      }));
      if (url.origin === apiOrigin && url.pathname === "/api/tools") return Promise.resolve(Response.json({ tools: [tool("example.status", "status.read")] }));
      if (url.origin === "https://api.groq.com") { providerCalls += 1; throw new Error("Provider must not be reached"); }
      throw new Error("Unexpected test fetch");
    }) satisfies typeof fetch);
    const response = await postChat({ conversationId, profileId: "groq-oss-120b", messages: [{ role: "user", content: "Read status" }] });
    expect(response.status).toBe(409);
    expect(providerCalls).toBe(0);
    expect(authorityReads).toBeGreaterThanOrEqual(2);
  });

  it.each(["stable", "before", "after", "denied", "aborted"] as const)("fences current action lookup around provider I/O: %s", async mode => {
    const proposalId = "5f891aac-81c0-4c7e-9a89-aed77396eea9";
    const controller = new AbortController();
    let actionReads = 0;
    let providerCalls = 0;
    const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
    let providerText = "";
    budgetMock.getAdmission.mockImplementation(() => Promise.resolve({
      reserve: () => Promise.resolve({ settle: (usage: { inputTokens: number; outputTokens: number } | undefined) => { settlements.push(usage); return Promise.resolve(); } }),
    }));
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      if (url.origin === apiOrigin && url.pathname === "/api/session") return Promise.resolve(Response.json({
        user: { id: "test-account" }, mode: "oidc", modelContext: { dataClasses: ["public", "confidential"] },
      }));
      if (url.origin === apiOrigin && url.pathname === "/api/history/authority") return Promise.resolve(Response.json({ authorityDigest: "a".repeat(64) }));
      if (url.origin === apiOrigin && url.pathname === "/api/tools") return Promise.resolve(Response.json({ tools: [] }));
      if (url.origin === apiOrigin && url.pathname === `/api/proposals/${proposalId}`) {
        actionReads += 1;
        if (mode === "aborted") { controller.abort(); return Promise.resolve(Response.json({ error: "denied" }, { status: 403 })); }
        expect(init?.method ?? (input instanceof Request ? input.method : "GET")).toBe("GET");
        if (mode === "denied") return Promise.resolve(Response.json({ error: "private owner detail" }, { status: 403 }));
        const changed = mode === "before" && actionReads >= 2 || mode === "after" && actionReads >= 3;
        return Promise.resolve(Response.json({ proposal: { id: proposalId, status: changed ? "confirmed" : "pending", expiresAt: "2030-01-01T00:00:00Z", preview: "PRIVATE_PREVIEW" } }));
      }
      if (url.origin === "https://api.groq.com") {
        providerCalls += 1;
        providerText = JSON.stringify(readProviderRequest(init));
        return Promise.resolve(Response.json({ id: "test-completion", object: "chat.completion", created: 1797136800,
          model: "openai/gpt-oss-120b", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "VPN diagnostics" } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 } }));
      }
      throw new Error("Unexpected test fetch");
    }) satisfies typeof fetch);
    const response = await postChat({ conversationId, profileId: "groq-oss-120b", proposalIds: [proposalId], messages: [{ role: "user", content: "Mein VPN funktioniert nicht" }] }, controller.signal);
    expect(response.status).toBe(mode === "aborted" ? 499 : mode === "before" || mode === "after" ? 409 : 200);
    const responseText = await response.text();
    if (mode === "before" || mode === "after") { expect(responseText).toContain("Aktionsstatus"); expect(responseText).not.toContain("Quellenrechte"); }
    expect(providerCalls).toBe(mode === "before" || mode === "aborted" ? 0 : 1);
    expect(actionReads).toBe(mode === "aborted" ? 1 : mode === "before" ? 2 : 3);
    expect(providerText).not.toContain("PRIVATE_PREVIEW");
    expect(providerText).not.toContain("private owner detail");
    if (mode === "denied") expect(providerText).toContain("unavailable");
    if (mode === "stable") expect(providerText).toContain("pending");
    expect(settlements).toEqual(mode === "aborted" ? [] : mode === "before" ? [{ inputTokens: 0, outputTokens: 0 }] : [{ inputTokens: 12, outputTokens: 3 }]);
  });
});
