import "server-only";

import { randomUUID } from "node:crypto";
import { ASSISTANT_BUDGET_NAMESPACE, ASSISTANT_BUDGET_POLICY, MemoryJsonStore, ModelBudgetLedger, PostgresJsonStore, type JsonStore } from "@hasi/state";
import { z } from "zod";
import { loadModelConfiguration, resolveModelConnection, type ModelConfiguration } from "./model-config";
import type { ModelBudgetAdmission } from "./model-router";
import { ModelRouterError } from "./model-router-error";

const priceSchema = z.strictObject({
  provider: z.enum(["groq", "gwdg", "deepinfra", "openai", "anthropic", "custom"]),
  baseURL: z.url().max(2048),
  modelId: z.string().min(1).max(256),
  inputMicroUsdPerMillion: z.number().int().positive().max(1_000_000_000),
  outputMicroUsdPerMillion: z.number().int().positive().max(1_000_000_000),
  basis: z.enum(["published", "operator_estimate"]),
});
export type ModelPrice = z.infer<typeof priceSchema>;

/** Reviewed 2026-10-19. GWDG's temporary estimate was expressly approved by Fabian. */
const defaultPrices: readonly ModelPrice[] = [
  { provider: "groq", baseURL: "https://api.groq.com/openai/v1", modelId: "openai/gpt-oss-120b", inputMicroUsdPerMillion: 150_000, outputMicroUsdPerMillion: 600_000, basis: "published" },
  { provider: "groq", baseURL: "https://api.groq.com/openai/v1", modelId: "openai/gpt-oss-20b", inputMicroUsdPerMillion: 75_000, outputMicroUsdPerMillion: 300_000, basis: "published" },
  { provider: "groq", baseURL: "https://api.groq.com/openai/v1", modelId: "qwen/qwen3.8-27b", inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000, basis: "published" },
  { provider: "gwdg", baseURL: "https://chat-ai.academiccloud.de/v1", modelId: "qwen3-30b-a3b-instruct-2507", inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000, basis: "operator_estimate" },
  // Published standard rates; do not depend on temporary promotional/cache discounts.
  { provider: "deepinfra", baseURL: "https://api.deepinfra.com/v1/openai", modelId: "deepseek-ai/DeepSeek-V4.1-Flash", inputMicroUsdPerMillion: 200_000, outputMicroUsdPerMillion: 600_000, basis: "published" },
];

export function loadModelPrices(env: Readonly<Record<string, string | undefined>>): readonly ModelPrice[] {
  if (env.HASI_MODEL_PRICES === undefined) return defaultPrices;
  try {
    if (Buffer.byteLength(env.HASI_MODEL_PRICES) > 32_768) throw new Error();
    const prices = z.array(priceSchema).min(1).max(64).parse(JSON.parse(env.HASI_MODEL_PRICES));
    const keys = prices.map(price => JSON.stringify([price.provider, price.baseURL, price.modelId]));
    if (new Set(keys).size !== keys.length) throw new Error();
    return prices;
  } catch { throw new ModelRouterError("configuration_invalid", "Invalid operator model pricing configuration."); }
}

export function modelPrice(profileId: string, configuration: ModelConfiguration, prices: readonly ModelPrice[]): ModelPrice | undefined {
  const profile = configuration.profiles.find(item => item.id === profileId);
  const connection = configuration.connections.find(item => item.id === profile?.connectionId);
  if (!profile || !connection) return undefined;
  const endpoint = resolveModelConnection(connection).baseURL;
  return prices.find(price => price.provider === connection.provider && price.baseURL === endpoint && price.modelId === profile.modelId);
}

/** Fixed shared scope across users, workspaces, deployments, retries and fallbacks. */
export function createModelBudget(store: JsonStore, prices: readonly ModelPrice[], requireExistingState: boolean, now?: () => number) {
  return new ModelBudgetLedger(store, {
    ...ASSISTANT_BUDGET_POLICY,
    // Admission deliberately charges the highest approved rates. This is a
    // conservative spending bound, not a provider invoice/cost measurement.
    inputMicroUsdPerMillion: Math.max(...prices.map(price => price.inputMicroUsdPerMillion)),
    outputMicroUsdPerMillion: Math.max(...prices.map(price => price.outputMicroUsdPerMillion)),
    requireExistingState,
    ...(now ? { now } : {}),
  });
}

export function createModelBudgetAdmission(ledger: ModelBudgetLedger, configuration: ModelConfiguration, prices: readonly ModelPrice[]): ModelBudgetAdmission {
  return {
    async reserve(input) {
      if (!modelPrice(input.profileId, configuration, prices)) throw new ModelRouterError("budget_unpriced", "The selected model has no approved price.");
      const id = randomUUID();
      await ledger.reserve({ id, inputTokens: input.inputTokens, outputTokens: input.outputTokens });
      return { settle: usage => ledger.settle(id, usage) };
    },
  };
}

let pending: Promise<ModelBudgetAdmission> | undefined;
let pendingDurable: Promise<ModelBudgetAdmission> | undefined;

export function getModelBudgetAdmission(): Promise<ModelBudgetAdmission> {
  pending ??= initializeRuntimeBudget().catch(() => { pending = undefined; throw new ModelRouterError("budget_unavailable", "The shared model budget is unavailable."); });
  return pending;
}

/** Live operator probes must not silently use a fresh process-local budget. */
export function getDurableModelBudgetAdmission(): Promise<ModelBudgetAdmission> {
  pendingDurable ??= initializeRuntimeBudget(true).catch(() => { pendingDurable = undefined; throw new ModelRouterError("budget_unavailable", "The shared model budget is unavailable."); });
  return pendingDurable;
}

async function initializeRuntimeBudget(requireDurable = false): Promise<ModelBudgetAdmission> {
  const configuration = loadModelConfiguration(process.env);
  const prices = loadModelPrices(process.env);
  const deployed = requireDurable || Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
  let store: JsonStore;
  let postgres: PostgresJsonStore | undefined;
  if (deployed || process.env.DATABASE_URL) {
    if (!process.env.DATABASE_URL?.trim()) throw new Error("Budget database configuration is missing.");
    postgres = new PostgresJsonStore(ASSISTANT_BUDGET_NAMESPACE, { poolConfig: { connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 20000, allowExitOnIdle: true } });
    try { await postgres.initialize(); } catch { await postgres.close(); throw new Error("Budget database unavailable."); }
    store = postgres;
  } else {
    // Local development only. Deployed requests never fall back to memory.
    store = new MemoryJsonStore("local-model-budget");
  }
  try {
    const ledger = createModelBudget(store, prices, deployed);
    if (!deployed) await ledger.initialize();
    await ledger.snapshot();
    return createModelBudgetAdmission(ledger, configuration, prices);
  } catch {
    await postgres?.close();
    throw new ModelRouterError("budget_unavailable", "The shared model budget could not be loaded.");
  }
}
