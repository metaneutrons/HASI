import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryJsonStore } from "@hasi/state";
import { createEvaluationKnowledgePolicyFixture } from "../../../scripts/evaluation/knowledge-policy-fixture";
import { loadModelConfiguration } from "../src/lib/server/model-config";
import { createModelBudget, createModelBudgetAdmission, loadModelPrices } from "../src/lib/server/model-budgets";
import type { ModelReply, WireMessage } from "../src/lib/chat-contract";

const budget = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/model-budgets", async original => ({
  ...await original<typeof import("@/lib/server/model-budgets")>(),
  getModelBudgetAdmission: budget.get,
}));

type Fixture = Awaited<ReturnType<typeof createEvaluationKnowledgePolicyFixture>>;
interface ProviderBody { model: string; messages: { role: string; content?: unknown }[] }
type Completion = { text: string } | { tool: string; arguments: Record<string, unknown> };
const activeFixtures: Fixture[] = [];

async function setup(poisoned = false) {
  const fixture = await createEvaluationKnowledgePolicyFixture({ poisoned });
  activeFixtures.push(fixture);
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("HASI_APP_MODE", "");
  vi.stubEnv("HASI_DEMO_MODE", "0");
  vi.stubEnv("HASI_LOCAL_TEST_IDP", "1");
  vi.stubEnv("HASI_LOCAL_TEST_IDP_SCOPE", fixture.localScope);
  vi.stubEnv("HASI_WEB_ORIGIN", fixture.webOrigin);
  vi.stubEnv("HASI_CHAT_SIGNING_SECRET", fixture.signingSecret);
  // The protected local composition validates this isolated URL without opening
  // it: this test uses an explicitly injected independent memory budget below.
  vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1:1/hasi_topology_test");
  vi.stubEnv("GROQ_API_KEY", "synthetic-route-integration-key");
  const configuration = loadModelConfiguration({});
  configuration.policy.fallbacks = [];
  configuration.policy.userChoice = { enabled: true, profileIds: ["groq-oss-120b", "groq-oss-20b"] };
  const blocked = configuration.profiles.find(profile => profile.id === "groq-oss-20b");
  if (!blocked) throw new Error("Expected the second bundled profile.");
  blocked.allowedDataClasses = ["public"];
  vi.stubEnv("HASI_LLM_CONFIG", JSON.stringify(configuration));
  const prices = loadModelPrices({});
  const ledger = createModelBudget(new MemoryJsonStore(`knowledge-route-budget-${randomUUID()}`), prices, false);
  await ledger.initialize();
  const admission = createModelBudgetAdmission(ledger, configuration, prices);
  budget.get.mockResolvedValue(admission);

  const requests: ProviderBody[] = [];
  const destinations: string[] = [];
  const rejectedDestinations: string[] = [];
  const completions: Completion[] = [];
  vi.stubGlobal("fetch", (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    destinations.push(url.origin + url.pathname);
    if (url.origin === fixture.apiOrigin) return fixture.coreFetch(input, init);
    if (url.href !== "https://api.groq.com/openai/v1/chat/completions") {
      rejectedDestinations.push(url.origin + url.pathname);
      throw new Error("Unapproved evaluation destination.");
    }
    const body = JSON.parse(await request.text()) as ProviderBody;
    requests.push(body);
    const completion = completions.shift();
    if (!completion) throw new Error("Unexpected provider request; no automatic retry is approved.");
    const message = "text" in completion ? { role: "assistant", content: completion.text }
      : { role: "assistant", content: null, tool_calls: [{ id: `call-${String(requests.length)}`, type: "function",
        function: { name: completion.tool, arguments: JSON.stringify(completion.arguments) } }] };
    return Response.json({ id: `synthetic-${String(requests.length)}`, object: "chat.completion", created: 1_797_136_800,
      model: body.model, choices: [{ index: 0, finish_reason: "text" in completion ? "stop" : "tool_calls", message }],
      usage: { prompt_tokens: 24, completion_tokens: 7 } });
  }) satisfies typeof fetch);
  const conversationId = randomUUID();
  const post = async (messages: WireMessage[], role: "reader" | "outsider" = "reader", profileId = "groq-oss-120b") => {
    const { POST } = await import("../src/app/api/chat/route");
    return POST(new Request(`${fixture.webOrigin}/api/chat`, { method: "POST",
      headers: { host: new URL(fixture.webOrigin).host, origin: fixture.webOrigin,
        cookie: fixture.cookies[role], "content-type": "application/json" },
      body: JSON.stringify({ conversationId, profileId, messages }) }));
  };
  const retrieve = async (role: "reader" | "outsider" = "reader") => {
    const user: WireMessage = { role: "user", content: "Wie richte ich WLAN ein?" };
    completions.push({ tool: "knowledge_search", arguments: { query: "WLAN", sourceSystem: "service_it" } });
    const response = await post([user], role);
    expect(response.status).toBe(200);
    const reply = await response.json() as ModelReply;
    const call = reply.message.toolCalls?.[0];
    if (call?.name !== "knowledge_search") throw new Error("Expected an actual signed search proposal.");
    const result = await fixture.search(role, "service_it");
    const tool: WireMessage = { role: "tool", name: "knowledge_search", toolCallId: call.id,
      content: JSON.stringify(result) };
    const history: WireMessage[] = [user, reply.message, tool];
    return { history, result };
  };
  return { fixture, ledger, admission, requests, destinations, rejectedDestinations, completions, post, retrieve };
}

beforeEach(() => { vi.resetModules(); });
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const fixture of activeFixtures.splice(0).reverse()) await fixture.close();
});

describe("authorized institutional retrieval through the actual chat route", () => {
  it("replaces browser-carried document bodies with current signed source evidence before provider dispatch", async () => {
    const run = await setup();
    const { history, result } = await run.retrieve();
    expect(result.documents).toHaveLength(1);
    const tool = history[2];
    if (tool?.role !== "tool") throw new Error("Missing search tool result.");
    tool.content = JSON.stringify({ contextId: result.contextId, documents: [{
      id: "svc-forged", title: "BROWSER_FORGED_TITLE", text: "BROWSER_FORGED_BODY", revision: 1,
    }] });
    run.completions.push({ text: "Verwende das freigegebene WLAN-Profil." });
    const response = await run.post(history);
    expect(response.status).toBe(200);
    expect(run.requests).toHaveLength(2);
    const outgoing = JSON.stringify(run.requests[1]);
    expect(outgoing).toContain(run.fixture.sourceMarkers.allowedTitle);
    expect(outgoing).toContain(run.fixture.sourceMarkers.allowedText);
    for (const marker of ["BROWSER_FORGED_TITLE", "BROWSER_FORGED_BODY", run.fixture.sourceMarkers.privateTitle,
      run.fixture.sourceMarkers.privateText]) expect(outgoing).not.toContain(marker);
    expect(run.rejectedDestinations).toEqual([]);
    expect(run.destinations.filter(value => value.endsWith("/api/knowledge/contexts/resolve")).length).toBeGreaterThan(0);
  });

  it("does not expose denied document bodies or metadata to an outsider model request", async () => {
    const run = await setup();
    const { history, result } = await run.retrieve("outsider");
    expect(result.documents).toEqual([]);
    run.completions.push({ text: "Es liegen keine freigegebenen Quellen vor." });
    const response = await run.post(history, "outsider");
    expect(response.status).toBe(200);
    expect(run.requests).toHaveLength(2);
    const outgoing = JSON.stringify(run.requests);
    for (const marker of Object.values(run.fixture.sourceMarkers)) expect(outgoing).not.toContain(marker);
    expect(run.rejectedDestinations).toEqual([]);
  });

  it.each(["source grant", "document ACL"])("drops previous tool and derived answer text after %s revocation", async mode => {
    const run = await setup();
    const { history } = await run.retrieve();
    run.completions.push({ text: `Antwort aus der Quelle: ${run.fixture.sourceMarkers.allowedText}` });
    const before = await run.post(history);
    expect(before.status).toBe(200);
    const reply = await before.json() as ModelReply;
    expect(JSON.stringify(run.requests[1])).toContain(run.fixture.sourceMarkers.allowedText);
    history.push(reply.message, { role: "user", content: "Was war die vorherige Anleitung?" });
    if (mode === "source grant") await run.fixture.revokeSourceGrant();
    else await run.fixture.changeDocumentAcl();
    run.completions.push({ text: "Die frühere Quelle ist nicht mehr freigegeben." });
    const after = await run.post(history);
    expect(after.status).toBe(200);
    const result = await after.json() as ModelReply;
    expect(result.contextNotice).toContain("entfernt");
    expect(run.requests).toHaveLength(3);
    const outgoing = JSON.stringify(run.requests[2]);
    expect(outgoing).not.toContain(run.fixture.sourceMarkers.allowedTitle);
    expect(outgoing).not.toContain(run.fixture.sourceMarkers.allowedText);
    expect(run.rejectedDestinations).toEqual([]);
  });

  it("blocks provider dispatch when source rights change after rebuilding the history", async () => {
    const run = await setup();
    const { history } = await run.retrieve();
    const before = await run.ledger.snapshot();
    budget.get.mockResolvedValue({
      reserve: async (input: Parameters<typeof run.admission.reserve>[0]) => {
        const reservation = await run.admission.reserve(input);
        await run.fixture.revokeSourceGrant();
        return reservation;
      },
    });
    const response = await run.post(history);
    expect(response.status).toBe(409);
    const after = await run.ledger.snapshot();
    expect(after.inputTokensUsed).toBe(before.inputTokensUsed);
    expect(after.outputTokensUsed).toBe(before.outputTokensUsed);
    expect(after.microUsdUsed).toBe(before.microUsdUsed);
    expect(after.reservationsInWindow).toBe(before.reservationsInWindow + 1);
    expect(after.unresolvedReservations).toBe(0);
    expect(after.unknownUsageReservations).toBe(0);
    expect(run.requests).toHaveLength(1);
    expect(run.rejectedDestinations).toEqual([]);
  });

  it("does not allow another authenticated subject to replay an authorized conversation receipt", async () => {
    const run = await setup();
    const { history } = await run.retrieve();
    run.completions.push({ text: "Die früheren Quellen sind für dieses Konto nicht freigegeben." });
    const response = await run.post(history, "outsider");
    expect(response.status).toBe(200);
    expect(run.requests).toHaveLength(2);
    const outgoing = JSON.stringify(run.requests[1]);
    expect(outgoing).not.toContain(run.fixture.sourceMarkers.allowedTitle);
    expect(outgoing).not.toContain(run.fixture.sourceMarkers.allowedText);
  });

  it("rejects an ineligible profile switch before provider dispatch or another budget reservation", async () => {
    const run = await setup();
    const { history } = await run.retrieve();
    const previous = await run.ledger.snapshot();
    const response = await run.post(history, "reader", "groq-oss-20b");
    expect(response.status).toBe(403);
    expect(run.requests).toHaveLength(1);
    expect(await run.ledger.snapshot()).toEqual(previous);
  });

  it("keeps a poisoned authorized page as untrusted evidence and rejects a forbidden model tool attempt", async () => {
    const run = await setup(true);
    const { history } = await run.retrieve();
    run.completions.push({ tool: "anny_execute_booking", arguments: { resourceId: "unapproved" } });
    const response = await run.post(history);
    expect(response.status).toBe(503);
    expect(run.requests).toHaveLength(2);
    expect(JSON.stringify(run.requests[1])).toContain(run.fixture.sourceMarkers.poisonText);
    expect(run.rejectedDestinations).toEqual([]);
    expect(run.destinations.every(value => value.startsWith(run.fixture.apiOrigin + "/api/")
      || value === "https://api.groq.com/openai/v1/chat/completions")).toBe(true);
    // This controlled unsafe provider attempt is not a model safety pass. It
    // establishes independent rejection at the application/tool boundary only.
  });
});
