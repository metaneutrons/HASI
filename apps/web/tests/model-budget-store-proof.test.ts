import { describe, expect, it } from "vitest";
import { MemoryJsonStore } from "@hasi/state";
import { budgetStoreEndpointId, verifyBudgetStoreBinding } from "../scripts/model-budget-store-proof";

const runId = "9cb1006a-d6c3-43d1-99a6-639ff7a9d40a";
const endpointId = budgetStoreEndpointId("postgresql://synthetic:fixture@db.example.test/hasi?sslmode=require");

describe("operator budget store binding proof", () => {
  it("allows Production to observe the marker created by Preview in the same store", async () => {
    const store = new MemoryJsonStore("budget-proof");
    await verifyBudgetStoreBinding(store, runId, "preview", endpointId);
    await expect(verifyBudgetStoreBinding(store, runId, "production", endpointId)).resolves.toMatchObject({
      environment: "production", runId, endpointId, previewMarkerObserved: true,
    });
  });

  it("denies a separate Production database without creating a misleading marker", async () => {
    const preview = new MemoryJsonStore("preview");
    const production = new MemoryJsonStore("production");
    await verifyBudgetStoreBinding(preview, runId, "preview", endpointId);
    await expect(verifyBudgetStoreBinding(production, runId, "production", endpointId)).rejects.toThrow("could not be verified");
    expect(await production.read(`operator-topology:${runId}`)).toBeUndefined();
  });

  it("denies a copied marker used with a different database destination", async () => {
    const store = new MemoryJsonStore("copied-marker");
    await verifyBudgetStoreBinding(store, runId, "preview", endpointId);
    const different = budgetStoreEndpointId("postgresql://db.other.test/hasi");
    await expect(verifyBudgetStoreBinding(store, runId, "production", different)).rejects.toThrow("could not be verified");
  });

  it("does not derive the destination identifier from credentials or log connection options", () => {
    expect(budgetStoreEndpointId("postgresql://another:replacement@db.example.test/hasi?password=changed")).toBe(endpointId);
  });

  it.each(["host=other.test", "port=5433", "database=other", "dbname=other", "hostaddr=127.0.0.1", "service=other", "options=-c%20search_path%3Dother"])("rejects effective database routing override %s", override => {
    expect(() => budgetStoreEndpointId(`postgresql://db.example.test/hasi?${override}`)).toThrow("routing overrides");
  });

  it("rejects non-operator environments and malformed run IDs before writing", async () => {
    const store = new MemoryJsonStore("invalid-proof");
    await expect(verifyBudgetStoreBinding(store, runId, "development", endpointId)).rejects.toThrow("Managed deployment");
    await expect(verifyBudgetStoreBinding(store, "not-a-run-id", "preview", endpointId)).rejects.toThrow();
    expect(await store.read(`operator-topology:${runId}`)).toBeUndefined();
  });
});
