import { PostgresJsonStore } from "@hasi/state";
import { createModelBudget, loadModelPrices } from "../src/lib/server/model-budgets";
import { budgetStoreEndpointId, verifyBudgetStoreBinding } from "./model-budget-store-proof";

// Operator deployment step, never imported by a request handler. No credentials,
// prompts or reservation identifiers are printed. Re-running preserves usage.
const mode = process.argv.slice(2).join(" ");
if (mode === "--if-enabled" && process.env.HASI_INITIALIZE_MODEL_BUDGET !== "1") process.exit(0);
if (mode !== "--initialize" && mode !== "--if-enabled") {
  throw new Error("Use --initialize to explicitly provision the shared daily ledger.");
}
if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required in the server environment.");
async function initialize() {
  const store = new PostgresJsonStore("model-budgets:shared:v1", { poolConfig: { connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 } });
  try {
    await store.initialize();
    const verificationId = process.env.HASI_MODEL_BUDGET_VERIFY_RUN;
    if (verificationId !== undefined) {
      const proof = await verifyBudgetStoreBinding(store, verificationId, process.env.VERCEL_ENV,
        budgetStoreEndpointId(process.env.DATABASE_URL ?? ""));
      console.info("Shared model budget topology verified.", JSON.stringify(proof));
    }
    const ledger = createModelBudget(store, loadModelPrices(process.env), true);
    await ledger.initialize();
    console.info("Shared model budget initialized; existing reservations preserved.", JSON.stringify(await ledger.snapshot()));
  } finally { await store.close(); }
}
void initialize().catch(() => { console.error("Shared model budget initialization failed; existing state was not reset."); process.exitCode = 1; });
