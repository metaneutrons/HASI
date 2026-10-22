import "server-only";

import { createHash } from "node:crypto";
import { evaluationCaseSchema, type EvaluationCase } from "./case-schema";
import { loadModelConfiguration, resolveModelConnection } from "../model-config";
import { loadModelPrices, modelPrice } from "../model-budgets";

const definitions = [
  { id: "anny-01", digest: "fe973a4d1b4c931ebd5e55ed1a61093586f9f7ba334d3663e7fedc45f7cef4ec", catalog: "original_birke_clean", pendingAllowed: false, sources: ["fixture:src:anny:room-catalog-a@2"] },
  { id: "anny-02", digest: "f69ac4c9eddcdff9f70021e2c39d4093b12878e981161d6759e6e24a8fdbf485", catalog: "original_birke_clean", pendingAllowed: true, sources: ["fixture:src:anny:room-birch@2"] },
  { id: "anny-04", digest: "69938a5b4d87d79f073cc6c3227ae85601dd608c6344b9bdf2c472dd611c6be3", catalog: "original_birke_clean", pendingAllowed: false, sources: [] },
  { id: "anny-05", digest: "5496cd1619a51bc2b7287ed598ccb1c196859e0efb20ce399b500172b3823dfa", catalog: "original_fichte", pendingAllowed: false, sources: ["fixture:src:rooms:berlin-spring-gap-2026@2"] },
  { id: "inject-02", digest: "1ced7f64f49568ad30c00171d62077832c1e781efcc1b32b1a49aa1a41e0dbec", catalog: "original_birke_poisoned", pendingAllowed: true, sources: ["fixture:src:anny:room-birch@2"] },
] as const;

export type OriginalRoomDefinition = typeof definitions[number];
export function originalRoomCase(value: unknown): { definition: OriginalRoomDefinition; evaluationCase: EvaluationCase } {
  const evaluationCase = evaluationCaseSchema.parse(value);
  const definition = definitions.find(item => item.id === evaluationCase.id);
  if (createHash("sha256").update(JSON.stringify(evaluationCase)).digest("hex") !== definition?.digest) {
    throw new TypeError("Only the exact registered original room cases may run.");
  }
  return { definition, evaluationCase };
}

export function createOriginalRoomPlan(corpus: readonly EvaluationCase[], profileIds: readonly string[], caseIds: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  if (!profileIds.length || profileIds.length > 8 || new Set(profileIds).size !== profileIds.length
    || !caseIds.length || new Set(caseIds).size !== caseIds.length) throw new TypeError("Select distinct registered profiles and original room cases.");
  const configuration = loadModelConfiguration(env);
  if (configuration.policy.fallbacks.length) throw new TypeError("Original case evaluation requires disabled fallback.");
  const prices = loadModelPrices(env);
  const profiles = profileIds.map(id => {
    const profile = configuration.profiles.find(item => item.id === id);
    const connection = configuration.connections.find(item => item.id === profile?.connectionId);
    if (!profile || !connection || !profile.capabilities.tools || !profile.allowedDataClasses.includes("synthetic_demo")
      || !(configuration.policy.defaultProfileId === id || configuration.policy.userChoice.enabled && configuration.policy.userChoice.profileIds.includes(id))
      || !modelPrice(id, configuration, prices)) throw new TypeError("The selected profile lacks approved synthetic tool capability or price.");
    const resolved = resolveModelConnection(connection);
    if (resolved.adapter === "anthropic" || resolved.api === "responses") {
      throw new TypeError("This bounded original-room observation track currently requires a chat-completions provider.");
    }
    return { id, provider: connection.provider, connectionId: connection.id, modelId: profile.modelId };
  });
  const cases = caseIds.map(id => originalRoomCase(corpus.find(item => item.id === id)));
  return { profiles, cases, configurationDigestSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
    limits: [
      "Exact draft original cases and full authorized benchmark evidence; no expected labels or runner fixtures in model input.",
      "Controlled direct production-router comparison with real isolated native API/MCP/Anny-contract effects; not protected HTTP/browser acceptance.",
      "Benchmark evidence is intentionally full, separate from the normal native bridge's compact description projection; both are recorded, not equated.",
      "Case clock affects router context and bridge date interpretation only; authentication, proposal expiry and shared daily budget retain real time.",
      "Only exact R-104 2026-10-27 14:00–15:00 Berlin pending proposals may execute; no confirmation, cancellation, reconciliation or external write.",
      "Synthetic base identity may retain execute entitlement required by the existing proposal gate; independent fixture transport/client deny execution.",
      "All model tool attempts are recorded, including disallowed ones; backend blocking is not a semantic/model-quality pass.",
      "Existing shared durable budget required before fixture creation; no initialization, refund, alternate ledger or fallback.",
      "Draft observations require semantic/citation review; no adopted score, gold label, institutional permission or M6 acceptance.",
    ] };
}
