import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/demo-runtime", () => ({ canonicalDemoRequest: vi.fn(), getDemoRuntime: vi.fn() }));

import { expectedModelToolName } from "../src/lib/server/authorized-tools";
import { loadModelConfiguration } from "../src/lib/server/model-config";
import { runModelStep } from "../src/lib/server/model-router";
import type { PluginToolDescriptor } from "../src/lib/plugin-tools";
import type { ChatRequest } from "../src/lib/chat-contract";

const NOW = new Date("2026-10-22T08:00:00Z");
const QUESTION = "Wie beantrage ich Zugang zum Projekt Aurora?";
const CLAIM = "Das Suchtool ist nicht verfügbar; bitte suche selbst im Portal.";
const adapters = ["groq-oss-120b", "groq-oss-20b", "groq-qwen-3.8-27b", "gwdg-qwen3-30b",
  "deepinfra-deepseek-v4.1-flash", "custom-default", "openai-chat", "openai-responses", "anthropic"] as const;
type Adapter = typeof adapters[number];

function descriptor(pluginId = "de.hsh.hasi.knowledge", name = "knowledge.search"): PluginToolDescriptor {
  return { pluginId, name, modelName: expectedModelToolName(pluginId, name), title: "Authorized search",
    description: "Search current authorized evidence.", effect: "read", requiredPermissions: ["knowledge:read"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object" } };
}

function setup(adapter: Adapter) {
  const env: Record<string, string> = { GROQ_API_KEY: "synthetic-groq-plan-key", GWDG_API_KEY: "synthetic-gwdg-plan-key",
    DEEPINFRA_API_KEY: "synthetic-deepinfra-plan-key", CUSTOM_API_KEY: "synthetic-custom-plan-key",
    CUSTOM_ENDPOINT: "https://plan.example.test/v1", CUSTOM_MODEL_ID: "synthetic-model",
    OPENAI_API_KEY: "synthetic-openai-plan-key", ANTHROPIC_API_KEY: "synthetic-anthropic-plan-key" };
  let profileId: string = adapter;
  if (adapter === "openai-chat" || adapter === "openai-responses" || adapter === "anthropic") {
    const configuration = loadModelConfiguration({});
    const provider = adapter === "anthropic" ? "anthropic" : "openai";
    configuration.connections.push({ id: "plan-test", label: "Synthetic test", provider,
      credentialRef: provider === "anthropic" ? "env:ANTHROPIC_API_KEY" : "env:OPENAI_API_KEY",
      ...(provider === "openai" ? { api: adapter === "openai-chat" ? "chat-completions" as const : "responses" as const } : {}) });
    configuration.profiles.push({ id: "plan-test-model", label: "Synthetic test", connectionId: "plan-test", modelId: "synthetic-model",
      capabilities: { tools: true }, allowedDataClasses: ["synthetic_demo"],
      parameters: { temperature: null, maxOutputTokens: 256, timeoutMs: 20_000 } });
    configuration.policy.userChoice.profileIds.push("plan-test-model");
    env.HASI_LLM_CONFIG = JSON.stringify(configuration);
    profileId = "plan-test-model";
  }
  return { env, profileId };
}

function transport(adapter: Adapter, toolName?: string, content = CLAIM) {
  const requests: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    requests.push(body);
    const arguments_ = { query: "Zugang Projekt Aurora" };
    const output = adapter === "anthropic" ? {
      id: "msg_plan", type: "message", role: "assistant", model: body.model,
      content: [...(content ? [{ type: "text", text: content }] : []),
        ...(toolName ? [{ type: "tool_use", id: "plan_call", name: toolName, input: arguments_ }] : [])],
      stop_reason: toolName ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 },
    } : adapter === "openai-responses" ? {
      id: "resp_plan", object: "response", created_at: 1_792_656_000, status: "completed", model: body.model,
      output: [...(content ? [{ type: "message", id: "msg_plan", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }] }] : []),
      ...(toolName ? [{ type: "function_call", id: "fc_plan", call_id: "plan_call", name: toolName,
        arguments: JSON.stringify(arguments_), status: "completed" }] : [])],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    } : {
      id: "chatcmpl_plan", object: "chat.completion", created: 1_792_656_000, model: body.model,
      choices: [{ index: 0, finish_reason: toolName ? "tool_calls" : "stop", message: { role: "assistant", content,
        ...(toolName ? { tool_calls: [{ id: "plan_call", type: "function", function: { name: toolName, arguments: JSON.stringify(arguments_) } }] } : {}) } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    };
    return Response.json(output);
  };
  return { fetch, requests };
}

function input(profileId: string, messages: ChatRequest["messages"] = [{ role: "user", content: QUESTION }]): ChatRequest {
  return { profileId, messages };
}

function expectedChoice(adapter: Adapter) {
  return adapter === "anthropic" ? { type: "any" } : "required";
}

describe("initial authorized live-chat tool planning", () => {
  it.each(adapters)("uses one required native tool plan with %s and suppresses pre-read prose", async adapter => {
    const config = setup(adapter);
    const wire = transport(adapter, "knowledge_search");
    const reply = await runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW,
      context: { dataClasses: ["synthetic_demo"], toolsRequired: true }, authorizedTools: [descriptor()] });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.tool_choice).toEqual(expectedChoice(adapter));
    expect(reply.message.content).toBe("");
    expect(reply.message.toolCalls).toEqual([{ id: "plan_call", name: "knowledge_search", arguments: { query: "Zugang Projekt Aurora" } }]);
    expect(JSON.stringify(wire.requests)).not.toContain("synthetic-gwdg-plan-key");
  });

  it.each(adapters)("does not publish a text-only tool-unavailability claim from %s", async adapter => {
    const config = setup(adapter);
    const wire = transport(adapter);
    await expect(runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW,
      authorizedTools: [descriptor()] })).rejects.toMatchObject({ name: "ModelRouterError" });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.tool_choice).toEqual(expectedChoice(adapter));
    // The same wire response is a valid answer in an explicitly answer-only
    // host context; rejection above is the planning rule, not a broken fake.
    const control = transport(adapter);
    const reply = await runModelStep(input(config.profileId), { env: config.env, fetch: control.fetch, now: NOW,
      authorizedTools: [descriptor()], context: { dataClasses: ["synthetic_demo"], toolsRequired: false } });
    expect(reply.message.content).toBe(CLAIM);
    expect(control.requests).toHaveLength(1);
  });

  it.each(["Hallo HASI!", "Hello!", "Danke!", "Kannst du mir helfen?", "What can you do?"])(
    "leaves a plain conversational/help turn automatic: %s", async content => {
      const config = setup("gwdg-qwen3-30b");
      const wire = transport("gwdg-qwen3-30b", undefined, "Gerne.");
      const reply = await runModelStep(input(config.profileId, [{ role: "user", content }]), {
        env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [descriptor()],
      });
      expect(wire.requests[0]?.tool_choice).toBe("auto");
      expect(reply.message.content).toBe("Gerne.");
    });

  it("synthesizes an actual current-turn result without requiring another model/tool cycle", async () => {
    const config = setup("gwdg-qwen3-30b");
    const wire = transport("gwdg-qwen3-30b", undefined, "Die Quelle beschreibt den Zugang [knowledge:intranet:aurora:1].");
    const reply = await runModelStep(input(config.profileId, [
      { role: "user", content: QUESTION },
      { role: "assistant", content: "", toolCalls: [{ id: "source", name: "knowledge_search", arguments: { query: "Aurora" } }] },
      { role: "tool", toolCallId: "source", name: "knowledge_search", content: '{"documents":[{"citationId":"knowledge:intranet:aurora:1","text":"Zugang über die Projektkoordination."}]}' },
    ]), { env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [descriptor()] });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.tools ?? []).toEqual([]);
    expect(reply.message.content).toContain("[knowledge:intranet:aurora:1]");
  });

  it("requires a new first tool plan for a substantive new user turn after older evidence", async () => {
    const config = setup("gwdg-qwen3-30b");
    const wire = transport("gwdg-qwen3-30b", "knowledge_search", "");
    await runModelStep(input(config.profileId, [
      { role: "user", content: "Wie geht VPN?" },
      { role: "assistant", content: "", toolCalls: [{ id: "old", name: "knowledge_search", arguments: { query: "VPN" } }] },
      { role: "tool", toolCallId: "old", name: "knowledge_search", content: '{"documents":[]}' },
      { role: "assistant", content: "Die Suche lieferte keine Belege." }, { role: "user", content: QUESTION },
    ]), { env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [descriptor()] });
    expect(wire.requests[0]?.tool_choice).toBe("required");
  });

  it("keeps an arbitrary authorized plug-in eligible for the required tool plan", async () => {
    const config = setup("gwdg-qwen3-30b");
    const external = descriptor("example.learning", "courses.search");
    const wire = transport("gwdg-qwen3-30b", external.modelName, "");
    const reply = await runModelStep(input(config.profileId, [{ role: "user", content: "Zeige meine Kurse." }]), {
      env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [descriptor(), external],
    });
    expect(wire.requests[0]?.tool_choice).toBe("required");
    expect(JSON.stringify(wire.requests[0]?.tools)).toContain(external.modelName);
    expect(reply.message.toolCalls?.[0]?.name).toBe(external.modelName);
  });

  it("requires a plan for an unfamiliar topic without narrowing a complete native registry to knowledge only", async () => {
    const config = setup("gwdg-qwen3-30b");
    const native = ["anny.search_resources", "anny.get_availability", "anny.list_my_bookings",
      "anny.propose_booking", "anny.propose_cancellation"].map(name => ({
      ...descriptor("de.hsh.hasi.anny", name), effect: name.includes("propose") ? "prepare" as const : "read" as const,
      requiredPermissions: [name.includes("propose") ? "rooms:prepare" : "rooms:read"],
    }));
    const wire = transport("gwdg-qwen3-30b", "knowledge_search");
    const reply = await runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW,
      authorizedTools: [descriptor(), ...native] });
    expect(wire.requests[0]?.tool_choice).toBe("required");
    expect(wire.requests[0]?.tools).toHaveLength(6);
    expect(reply.message.toolCalls?.[0]?.name).toBe("knowledge_search");
    expect(reply.message.content).toBe("");
  });

  it("does not force unavailable tools when the current registry is empty", async () => {
    const config = setup("gwdg-qwen3-30b");
    const wire = transport("gwdg-qwen3-30b");
    const reply = await runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [] });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.tool_choice).not.toBe("required");
    expect(reply.message.content).toBe(CLAIM);
  });

  it("does not add a paid repair call and preserves the first request's usage settlement", async () => {
    const config = setup("gwdg-qwen3-30b");
    const wire = transport("gwdg-qwen3-30b", "knowledge_search", "");
    const settle = vi.fn(() => Promise.resolve());
    const reserve = vi.fn(() => Promise.resolve({ settle }));
    const reply = await runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW,
      authorizedTools: [descriptor()], budgetAdmission: { reserve } });
    expect(wire.requests).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 5 });
    expect(reply.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it.each(["confirmed", "outcome_unknown", "unavailable"] as const)(
    "answers a status-only question from current host evidence (%s) without an unrelated search", async status => {
      const config = setup("gwdg-qwen3-30b");
      const wire = transport("gwdg-qwen3-30b", undefined, "Der aktuelle Aktionsstatus steht an der Karte.");
      const reply = await runModelStep(input(config.profileId, [{ role: "user", content: "Hat das geklappt?" }]), {
        env: config.env, fetch: wire.fetch, now: NOW, authorizedTools: [descriptor()], actionContext: [{ id: randomUUID(), status }],
      });
      expect(wire.requests[0]?.tool_choice).toBe("auto");
      expect(reply.message.content).toBe("Der aktuelle Aktionsstatus steht an der Karte.");
    });

  it("does not use unrelated current action statuses to bypass a new knowledge request", async () => {
    const config = setup("gwdg-qwen3-30b");
    const wire = transport("gwdg-qwen3-30b", "knowledge_search", "");
    await runModelStep(input(config.profileId), { env: config.env, fetch: wire.fetch, now: NOW,
      authorizedTools: [descriptor()], actionContext: [{ id: randomUUID(), status: "confirmed" }] });
    expect(wire.requests[0]?.tool_choice).toBe("required");
  });
});
