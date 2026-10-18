import { createHash } from "node:crypto";
import type { JsonStore } from "@hasi/state";
import { z } from "zod";

const markerSchema = z.strictObject({ runId: z.uuid(), endpointId: z.string().regex(/^[a-f0-9]{64}$/) });

/** Identifies the database destination, excluding username, password and query credentials. */
export function budgetStoreEndpointId(connectionString: string): string {
  const endpoint = new URL(connectionString);
  if (endpoint.protocol !== "postgres:" && endpoint.protocol !== "postgresql:") throw new Error("Invalid database destination.");
  // pg accepts query parameters that override URI routing or search_path.
  // Do not attest an authority/path that differs from the effective destination.
  const routingOverrides = new Set(["host", "hostaddr", "port", "database", "dbname", "service", "options"]);
  for (const name of endpoint.searchParams.keys()) {
    if (routingOverrides.has(name.toLowerCase())) throw new Error("Database routing overrides are unsupported for this proof.");
  }
  return createHash("sha256").update(JSON.stringify([
    endpoint.hostname, endpoint.port || "5432", endpoint.pathname,
  ])).digest("hex");
}

/** Operator-only bootstrap proof. Production may read, but cannot invent, the Preview marker. */
export async function verifyBudgetStoreBinding(store: JsonStore, runId: string, environment: string | undefined, endpointId: string) {
  const expected = markerSchema.parse({ runId, endpointId });
  if (environment !== "preview" && environment !== "production") throw new Error("Managed deployment environment required.");
  const key = `operator-topology:${runId}`;
  if (environment === "preview") {
    await store.compareAndSet(key, null, expected, Date.now() + 3_600_000);
  }
  const current = await store.read(key);
  const marker = markerSchema.safeParse(current?.value);
  if (!marker.success || marker.data.runId !== expected.runId || marker.data.endpointId !== expected.endpointId) {
    throw new Error("Shared budget store binding could not be verified.");
  }
  return { environment, runId, endpointId, previewMarkerObserved: true };
}
