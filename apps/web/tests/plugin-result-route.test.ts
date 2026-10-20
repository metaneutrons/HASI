import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fixtures = vi.hoisted(() => ({ access: vi.fn(), run: vi.fn(), store: vi.fn() }));
vi.mock("../src/lib/server/chat-access", () => ({ chatAccess: fixtures.access }));
vi.mock("../src/lib/server/model-router", () => ({ runModelStep: fixtures.run, listModelProfiles: vi.fn() }));
vi.mock("../src/lib/server/server-chat-storage", () => ({ getServerChatStorage: fixtures.store }));
vi.mock("../src/lib/server/chat-admission", () => ({ admitChat: () => Promise.resolve(true) }));
vi.mock("../src/lib/server/authorized-tools", async original => {
  const actual = await original<typeof import("../src/lib/server/authorized-tools")>();
  return { ...actual, loadAuthorizedModelTools: () => Promise.resolve([]) };
});
vi.mock("../src/lib/server/knowledge-context", () => ({ productionKnowledgeResolver: () => () => Promise.resolve([]) }));
vi.mock("../src/lib/server/history-authority", () => ({ productionHistoryAuthority: () => Promise.resolve("a".repeat(64)) }));
vi.mock("../src/lib/server/model-budgets", () => ({ getModelBudgetAdmission: () => Promise.resolve(undefined), loadModelPrices: vi.fn(), modelPrice: vi.fn() }));
vi.mock("../src/lib/server/model-config", () => ({ loadModelConfiguration: vi.fn() }));

import { MemoryJsonStore } from "@hasi/state";
import { POST } from "../src/app/api/chat/route";
import { createKnowledgeEvidence } from "../src/lib/server/knowledge-evidence";
import { createMessageClock } from "../src/lib/server/message-timestamps";
import { PluginResultContextStore } from "../src/lib/server/plugin-result-context";
import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import type { ChatRequest, ModelReply, WireMessage } from "../src/lib/chat-contract";

const SECRET = "test-only-plugin-route-signing-secret";
const SCOPE = "test:plugin-route:owner";
const AUTHORITY = "a".repeat(64);
const ORIGIN = "https://hasi.example.invalid";

beforeEach(() => vi.clearAllMocks());

describe("protected chat route plugin dependencies", () => {
  it("stamps the actual result dependency and excludes its derived answer after record withdrawal", async () => {
    const conversationId = randomUUID();
    const store = new MemoryJsonStore(`route-${randomUUID()}`);
    const contexts = new PluginResultContextStore({ store, ownerId: "owner", scope: SCOPE, secret: SECRET });
    const signer = createKnowledgeEvidence(SECRET, SCOPE);
    const pluginId = "example.reference";
    const toolName = "read_status";
    const modelName = expectedModelToolName(pluginId, toolName);
    const args = {};
    const { contextId } = await contexts.create({ conversationId, callId: "call-1", pluginId, toolName,
      title: "Read status", arguments: args, result: { label: "AUTHENTIC_ROUTE_RESULT" },
      authorityDigest: AUTHORITY, dataClasses: ["synthetic_demo"] });
    const call: Extract<WireMessage, { role: "assistant" }> = { id: randomUUID(), role: "assistant", content: "",
      toolCalls: [{ id: "call-1", name: modelName, arguments: args }] };
    call.evidence = signer.stamp(conversationId, call, [], AUTHORITY);
    const messages: WireMessage[] = [{ role: "user", content: "Read the reference status." }, call,
      { role: "tool", toolCallId: "call-1", name: modelName, toolContextId: contextId, content: '{"label":"FORGED_BROWSER_RESULT"}' }];
    fixtures.store.mockResolvedValue(store);
    fixtures.access.mockImplementation((request: Request) => Promise.resolve({ request, allowedOrigins: [ORIGIN],
      production: { ownerId: "owner", scope: SCOPE, secret: SECRET },
      modelContext: { dataClasses: ["synthetic_demo"], toolsRequired: true },
      clock: createMessageClock(SECRET, SCOPE), routingPins: {} }));
    const seen: ChatRequest[] = [];
    fixtures.run.mockImplementation((request: ChatRequest) => {
      seen.push(structuredClone(request));
      return Promise.resolve({ message: { role: "assistant", content: seen.length === 1 ? "DERIVED_ROUTE_ANSWER" : "New answer." },
        profile: { id: "groq-oss-120b", label: "Test", provider: "groq", modelId: "test", configured: true } });
    });
    const post = (history: WireMessage[]) => POST(new Request(`${ORIGIN}/api/chat`, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ conversationId, profileId: "groq-oss-120b", messages: history }) }));
    const first = await post(messages);
    expect(first.status).toBe(200);
    const reply = await first.json() as ModelReply;
    expect(reply.message.evidence?.toolContextIds).toEqual([contextId]);
    expect(signer.verify(conversationId, reply.message, AUTHORITY)).toBeDefined();
    expect(JSON.stringify(seen[0])).toContain("AUTHENTIC_ROUTE_RESULT");
    expect(JSON.stringify(seen[0])).not.toContain("FORGED_BROWSER_RESULT");

    vi.spyOn(store, "read").mockResolvedValue(undefined);
    const second = await post([...messages, reply.message, { role: "user", content: "Explain that answer." }]);
    expect(second.status).toBe(200);
    expect(JSON.stringify(seen[1])).not.toContain("DERIVED_ROUTE_ANSWER");
    expect(JSON.stringify(seen[1])).not.toContain("AUTHENTIC_ROUTE_RESULT");
    expect(JSON.stringify(seen[1])).not.toContain("FORGED_BROWSER_RESULT");
    expect((await second.json() as ModelReply).contextNotice).toBeDefined();
  });
});
