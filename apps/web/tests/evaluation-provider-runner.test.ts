import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import exampleCases from "../../../docs/evaluation/example-cases.json";
import {
  parseEvaluationDataset,
  type EvaluationCase,
} from "../src/lib/server/evaluation/case-schema";
import { evaluationEvidenceKey } from "../src/lib/server/evaluation/input-projection";
import { runProviderEvaluationCase } from "../src/lib/server/evaluation/provider-runner";
import {
  createModelBudget,
  createModelBudgetAdmission,
  loadModelPrices,
} from "../src/lib/server/model-budgets";
import { loadModelConfiguration } from "../src/lib/server/model-config";

const cases = parseEvaluationDataset(exampleCases);
const fakeGroqKey = "test-only-groq-key";
const fakeGwdgKey = "test-only-gwdg-key";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  bodyText: string;
  body: Record<string, unknown>;
}

function caseById(id: string): EvaluationCase {
  const found = cases.find((evaluationCase) => evaluationCase.id === id);
  if (!found) throw new Error(`Missing fixture evaluation case ${id}.`);
  return structuredClone(found);
}

function environment(config = loadModelConfiguration({})): Record<string, string> {
  return {
    HASI_LLM_CONFIG: JSON.stringify(config),
    GROQ_API_KEY: fakeGroqKey,
    GWDG_API_KEY: fakeGwdgKey,
  };
}

async function budgetAdmission(env: Record<string, string>) {
  const configuration = loadModelConfiguration(env);
  const prices = loadModelPrices(env);
  const ledger = createModelBudget(
    new MemoryJsonStore(`evaluation-provider-test-${randomUUID()}`),
    prices,
    false,
  );
  await ledger.initialize();
  return createModelBudgetAdmission(ledger, configuration, prices);
}

function recordedFetch(
  respond: (request: CapturedRequest, callNumber: number) => Response | Promise<Response>,
) {
  const calls: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const bodyText = await request.clone().text();
    const body: unknown = JSON.parse(bodyText);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("Expected an object provider request.");
    }
    const captured: CapturedRequest = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      bodyText,
      body: body as Record<string, unknown>,
    };
    calls.push(captured);
    return respond(captured, calls.length);
  };
  return { fetch, calls };
}

function completion(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-provider-evaluation-test",
    object: "chat.completion",
    created: 1_797_136_800,
    model: "openai/gpt-oss-120b",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    ...(usage ? { usage } : {}),
  }), { headers: { "content-type": "application/json" } });
}

function authorizedEvidence(evaluationCase: EvaluationCase): ReadonlySet<string> {
  return new Set((evaluationCase.modelEvidence ?? []).map(evaluationEvidenceKey));
}

function providerDependencies(options: {
  env?: Record<string, string>;
  profileId?: string;
  fetch: typeof globalThis.fetch;
  maxProviderRequests?: number;
  oracle?: unknown;
  evaluationCase: EvaluationCase;
}) {
  const env = options.env ?? environment();
  return budgetAdmission(env).then((admission) => ({
    profileId: options.profileId ?? "groq-oss-120b",
    serverAuthorizedEvidence: authorizedEvidence(options.evaluationCase),
    budgetAdmission: admission,
    env,
    fetch: options.fetch,
    ...(options.maxProviderRequests !== undefined ? { maxProviderRequests: options.maxProviderRequests } : {}),
    ...(options.oracle !== undefined ? { oracle: options.oracle } : {}),
  }));
}

describe("provider-backed fixed-evidence evaluation runner", () => {
  it("sends only projected user turns and authorized evidence through the Groq protocol and records priced usage", async () => {
    const evaluationCase = caseById("sit-01");
    const evidence = evaluationCase.modelEvidence?.[0];
    if (!evidence) throw new Error("Expected the synthetic ServiceIT evidence.");

    evaluationCase.authenticatedContext = {
      subject: "runner-subject-sentinel",
      entitlements: ["runner:entitlement-sentinel"],
    };
    evaluationCase.expected.behavior = "runner-expected-label-sentinel";
    evaluationCase.expected.mustIncludeFacts = ["runner-must-include-sentinel"];
    evaluationCase.provenanceNote = "runner-provenance-sentinel";
    evaluationCase.toolFixtures = { runnerOnly: "runner-tool-fixture-sentinel" };
    evaluationCase.candidateDocuments = [{
      sourceId: "fixture:src:candidate:hidden",
      revision: 1,
      uri: "fixture://candidate/hidden",
      title: "runner-candidate-title-sentinel",
      text: "runner-candidate-body-sentinel",
      accessRequirement: "runner:candidate-entitlement",
    }];

    const authorizedCitation = { sourceId: evidence.sourceId, revision: evidence.revision };
    const responseText = [
      `Dokumentiere Gerätecode und Fehlertext. [knowledge:${evidence.sourceId}:${String(evidence.revision)}]`,
      `Codebeispiel: \`[knowledge:fixture:src:code-example:1]\`.`,
      "[knowledge:fixture:src:authored-link:2](https://example.invalid/source)",
    ].join(" ");
    const oracle = {
      schemaVersion: 1,
      assertions: [
        { id: "citation-required", kind: "citations_required", citations: [authorizedCitation] },
        { id: "citation-allowlist", kind: "citations_allowed", citations: [authorizedCitation] },
      ],
    };
    const provider = recordedFetch(() => completion(responseText, { prompt_tokens: 100, completion_tokens: 10 }));
    const deps = await providerDependencies({ evaluationCase, fetch: provider.fetch, oracle });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(provider.calls).toHaveLength(1);
    const request = provider.calls[0];
    expect(request).toBeDefined();
    expect(request?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.authorization).toBe(`Bearer ${fakeGroqKey}`);
    expect(request?.body.model).toBe("openai/gpt-oss-120b");
    expect(request?.bodyText).toContain(evidence.title);
    expect(request?.bodyText).toContain(evidence.text);
    expect(request?.bodyText).toContain(evaluationCase.userMessages[0]);
    const messages = request?.body.messages as { role: string; content?: string; tool_calls?: { function: { arguments: string } }[] }[];
    const evidenceFrame = messages.find(message => message.role === "tool");
    expect(evidenceFrame).toBeDefined();
    const sourceResult = JSON.parse(evidenceFrame?.content ?? "null") as { documents: Record<string, unknown>[] };
    expect(sourceResult.documents).toHaveLength(1);
    expect(sourceResult.documents[0]).toEqual({
      id: evidence.sourceId, title: evidence.title, text: evidence.text, revision: evidence.revision,
      citationId: `knowledge:${evidence.sourceId}:${String(evidence.revision)}`,
    });
    expect(messages.flatMap(message => message.tool_calls ?? []).map(call => JSON.parse(call.function.arguments) as unknown))
      .toEqual([{ query: "Bereitgestellte Quellen" }]);
    expect(request?.bodyText).not.toMatch(/runner-(?:subject|entitlement|expected|must-include|provenance|tool-fixture|candidate)/u);
    expect(request?.bodyText).not.toContain("runner-candidate-body-sentinel");
    expect(request?.bodyText).not.toContain("runner:candidate-entitlement");
    expect(request?.bodyText).not.toContain("fixture:src:candidate:hidden");
    expect(request?.bodyText).not.toContain("fixture:serviceit.catalog.read");
    expect(request?.body.tools ?? []).toEqual([]);

    expect(result.requestDigestsSha256).toHaveLength(1);
    expect(result.profile).toEqual({
      id: "groq-oss-120b",
      provider: "groq",
      modelId: "openai/gpt-oss-120b",
      resolvedProviderVersion: null,
    });
    expect(result.pricing).toEqual({
      provider: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      modelId: "openai/gpt-oss-120b",
      inputMicroUsdPerMillion: 150_000,
      outputMicroUsdPerMillion: 600_000,
      basis: "published",
    });
    expect(result.pricingDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.transport).toMatchObject({
      status: "completed",
      response: { citations: [authorizedCitation], proposedCalls: [] },
    });
    expect(result.assessment).toMatchObject({ status: "passed" });
    expect(result.measurements).toMatchObject({
      kind: "provider_reported",
      providerRequestCount: 1,
      usageStatus: "complete",
      inputTokens: 100,
      outputTokens: 10,
      estimatedCostUsd: 0.000021,
      reservations: [{
        profileId: "groq-oss-120b",
        inputTokens: 100,
        outputTokens: 10,
        estimatedCostUsd: 0.000021,
        pricingBasis: "published",
        settlement: "reported",
      }],
    });
  });

  it("uses GWDG's OpenAI-compatible endpoint and the approved operator-estimate price", async () => {
    const evaluationCase = caseById("sit-02");
    const config = loadModelConfiguration({});
    config.policy.defaultProfileId = "gwdg-qwen3-30b";
    const env = environment(config);
    const provider = recordedFetch(() => new Response(JSON.stringify({
      id: "gwdg-evaluation-test",
      object: "chat.completion",
      created: 1_797_136_800,
      model: "qwen3-30b-a3b-instruct-2507",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "In den Quellen steht dazu nichts." } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }), { headers: { "content-type": "application/json" } }));
    const deps = await providerDependencies({ evaluationCase, env, profileId: "gwdg-qwen3-30b", fetch: provider.fetch });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://chat-ai.academiccloud.de/v1/chat/completions");
    expect(provider.calls[0]?.authorization).toBe(`Bearer ${fakeGwdgKey}`);
    expect(provider.calls[0]?.body.model).toBe("qwen3-30b-a3b-instruct-2507");
    expect(result.profile.provider).toBe("gwdg");
    expect(result.pricing).toMatchObject({
      provider: "gwdg",
      basis: "operator_estimate",
      inputMicroUsdPerMillion: 800_000,
      outputMicroUsdPerMillion: 4_000_000,
    });
    expect(result.measurements).toMatchObject({ usageStatus: "complete", estimatedCostUsd: 0.000036 });
  });

  it("extracts ordinary unauthorized citations and fails the citation oracle", async () => {
    const evaluationCase = caseById("sit-01");
    const evidence = evaluationCase.modelEvidence?.[0];
    if (!evidence) throw new Error("Expected the synthetic ServiceIT evidence.");
    const authorizedCitation = { sourceId: evidence.sourceId, revision: evidence.revision };
    const oracle = {
      schemaVersion: 1,
      assertions: [{ id: "only-authorized", kind: "citations_allowed", citations: [authorizedCitation] }],
    };
    const responseText = `[knowledge:${evidence.sourceId}:${String(evidence.revision)}] [knowledge:fixture:src:not-authorized:1] `
      + "`[knowledge:fixture:src:code-only:1]` [knowledge:fixture:src:link-only:1](https://example.invalid)";
    const provider = recordedFetch(() => completion(responseText, { prompt_tokens: 80, completion_tokens: 8 }));
    const deps = await providerDependencies({ evaluationCase, fetch: provider.fetch, oracle });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(result.transport).toMatchObject({ status: "completed", response: {
      citations: [
        authorizedCitation,
        { sourceId: "fixture:src:not-authorized", revision: 1 },
      ],
    } });
    expect(result.assessment).toMatchObject({
      status: "failed",
      assertions: [
        { id: "$projection.authorized-citations", status: "failed" },
        { id: "only-authorized", status: "failed" },
      ],
    });
  });

  it("marks missing provider usage unknown and keeps the cost null", async () => {
    const evaluationCase = caseById("sit-02");
    const provider = recordedFetch(() => completion("Keine passende Information gefunden."));
    const deps = await providerDependencies({ evaluationCase, fetch: provider.fetch });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(provider.calls).toHaveLength(1);
    expect(result.transport).toMatchObject({ status: "error", code: "budget_usage_invalid" });
    expect(result.measurements).toMatchObject({
      providerRequestCount: 1,
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      reservations: [{ settlement: "unknown", inputTokens: null, outputTokens: null, estimatedCostUsd: null }],
    });
  });

  it("sanitizes a Groq 429 body and never falls back, even when the profile policy defines a target", async () => {
    const evaluationCase = caseById("sit-02");
    const config = loadModelConfiguration({});
    config.policy.fallbacks = [{ from: "groq-oss-120b", targets: ["gwdg-qwen3-30b"], on: ["rate_limit"] }];
    const env = environment(config);
    const privateProviderBody = JSON.stringify({ error: {
      message: "PRIVATE_PROVIDER_BODY_SENTINEL test-only-groq-key",
      code: "rate_limit_exceeded",
    } });
    const provider = recordedFetch(() => new Response(privateProviderBody, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    }));
    const deps = await providerDependencies({ evaluationCase, env, fetch: provider.fetch });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(result.transport).toMatchObject({ status: "error", code: "provider_rate_limited", providerStatus: 429 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROVIDER_BODY_SENTINEL|test-only-groq-key/u);
    expect(result.measurements).toMatchObject({ providerRequestCount: 1, usageStatus: "unknown" });
  });

  it("counts Groq's malformed-tool repair against the actual provider HTTP cap", async () => {
    const evaluationCase = caseById("sit-02");
    const provider = recordedFetch(() => new Response(JSON.stringify({
      error: { message: "synthetic malformed tool response", code: "tool_use_failed" },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const deps = await providerDependencies({
      evaluationCase,
      fetch: provider.fetch,
      maxProviderRequests: 1,
    });

    const result = await runProviderEvaluationCase(evaluationCase, deps);

    expect(provider.calls).toHaveLength(1);
    expect(result.requestDigestsSha256).toHaveLength(1);
    expect(result.measurements).toMatchObject({
      providerRequestCount: 1,
      usageStatus: "unknown",
      reservations: [
        { profileId: "groq-oss-120b", settlement: "unknown" },
        { profileId: "groq-oss-120b", settlement: "unknown" },
      ],
    });
    expect(result.assessment).toEqual({ status: "not_run", reason: "provider_or_contract_error" });
  });

  it.each([
    ["a profile outside operator selection", () => caseById("sit-01"), () => {
      const config = loadModelConfiguration({});
      config.policy.userChoice.enabled = false;
      return { env: environment(config), profileId: "gwdg-qwen3-30b" };
    }],
    ["a workflow case", () => caseById("anny-01"), () => ({})],
    ["an oracle that claims workflow observations", () => caseById("sit-01"), () => ({ oracle: {
      schemaVersion: 1,
      assertions: [{ id: "trace", kind: "workflow_trace_exact", events: [] }],
    } })],
    ["a non-production timezone", () => {
      const evaluationCase = caseById("sit-01");
      evaluationCase.clock.timezone = "UTC";
      return evaluationCase;
    }, () => ({})],
    ["an invalid HTTP attempt cap", () => caseById("sit-01"), () => ({ maxProviderRequests: 17 })],
  ] as const)("rejects %s before provider I/O", async (_label, makeCase, makeOptions) => {
    const evaluationCase = makeCase();
    const options = makeOptions();
    const provider = recordedFetch(() => completion("must not be dispatched", { prompt_tokens: 10, completion_tokens: 1 }));
    const deps = await providerDependencies({
      evaluationCase,
      fetch: provider.fetch,
      ...options,
    });

    await expect(runProviderEvaluationCase(evaluationCase, deps)).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});
