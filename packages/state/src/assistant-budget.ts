/** Shared admission policy; changing it requires an explicit ledger policy migration. */
export const ASSISTANT_BUDGET_NAMESPACE = 'model-budgets:shared:v1';
export const ASSISTANT_BUDGET_POLICY = Object.freeze({
  scope: 'hasi-demo:daily:v1', windowMs: 86_400_000,
  inputTokenLimit: 1_250_000, outputTokenLimit: 250_000, microUsdLimit: 1_000_000,
  inputMicroUsdPerMillion: 800_000, outputMicroUsdPerMillion: 4_000_000,
});
