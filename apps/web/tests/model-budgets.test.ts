import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MemoryJsonStore } from "@hasi/state";
import { createModelBudget, createModelBudgetAdmission, loadModelPrices, modelPrice } from "../src/lib/server/model-budgets";
import { loadModelConfiguration } from "../src/lib/server/model-config";

describe("shared model budget admission", () => {
  it("records the explicitly approved GWDG estimate without assuming free usage", () => {
    const configuration = loadModelConfiguration({});
    expect(modelPrice("gwdg-qwen3-30b", configuration, loadModelPrices({}))).toMatchObject({
      basis: "operator_estimate", inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000,
    });
    expect(modelPrice("unknown", configuration, loadModelPrices({}))).toBeUndefined();
  });

  it("shares a one-dollar ceiling across models and runtimes, keeps unknown holds and resets only on UTC day change", async () => {
    const store = new MemoryJsonStore("shared-budget-runtime");
    const configuration = loadModelConfiguration({});
    const prices = loadModelPrices({});
    let now = 0;
    const first = createModelBudget(store, prices, true, () => now);
    const second = createModelBudget(store, prices, true, () => now);
    await first.initialize();
    const admission = createModelBudgetAdmission(first, configuration, prices);
    const other = createModelBudgetAdmission(second, configuration, prices);
    const reservation = await admission.reserve({ profileId: "groq-oss-120b", inputTokens: 100_000, outputTokens: 100_000 });
    await reservation.settle();
    expect((await first.snapshot()).microUsdUsed).toBe(480_000);
    const next = await other.reserve({ profileId: "gwdg-qwen3-30b", inputTokens: 100_000, outputTokens: 100_000 });
    await next.settle({ inputTokens: 100_000, outputTokens: 100_000 });
    await expect(admission.reserve({ profileId: "groq-oss-20b", inputTokens: 100_000, outputTokens: 1 })).rejects.toMatchObject({ code: "exhausted" });
    now = 86_400_000;
    await expect(admission.reserve({ profileId: "groq-oss-20b", inputTokens: 100_000, outputTokens: 1 })).resolves.toBeDefined();
  });

  it("rejects changed model identity and malformed pricing instead of silently using another tariff", async () => {
    const configuration = loadModelConfiguration({});
    const profile = configuration.profiles.find(item => item.id === "groq-oss-120b");
    if (!profile) throw new Error("Fixture profile missing");
    profile.modelId = "unpriced-model";
    const ledger = createModelBudget(new MemoryJsonStore("unpriced-budget"), loadModelPrices({}), false);
    const admission = createModelBudgetAdmission(ledger, configuration, loadModelPrices({}));
    await expect(admission.reserve({ profileId: profile.id, inputTokens: 1, outputTokens: 1 })).rejects.toMatchObject({ code: "budget_unpriced" });
    expect(() => loadModelPrices({ HASI_MODEL_PRICES: "[{\"inputMicroUsdPerMillion\":0}]" })).toThrow();
    expect((await ledger.snapshot()).reservationsInWindow).toBe(0);
  });
});
