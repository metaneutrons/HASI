import "server-only";

import { createHash } from "node:crypto";
import { loadModelConfiguration } from "../model-config";
import { loadModelPrices, modelPrice } from "../model-budgets";
import { parseEvaluationDataset } from "./case-schema";
import type { EvaluationOracleSpecification } from "./oracles";

/** Operator-owned fixture authorization; case entitlements/expected labels are not grants. */
const fixedEvidence = [
  { id: "sit-01", sources: [["fixture:src:serviceit:ticket-guide-v1", 1]] },
  { id: "sit-02", sources: [] },
  { id: "intra-01", sources: [["fixture:src:intranet:atlas-rev3", 3], ["fixture:src:intranet:atlas-rev2", 2]] },
  { id: "intra-02", sources: [["fixture:src:intranet:orion-handbook", 1]] },
  { id: "sit-03", sources: [["fixture:src:serviceit:vpn-mfa-recovery", 1]] },
  { id: "sit-04", sources: [["fixture:src:serviceit:wlan-status", 2], ["fixture:src:serviceit:wlan-status", 1]] },
  { id: "intra-03", sources: [["fixture:src:intranet:visiting-scholar-guidance", 3], ["fixture:src:intranet:visiting-scholar-guidance", 2]] },
  { id: "sit-vpn-grounding-01", sources: [["svc-catalog-6c79c1e68f04", 2], ["svc-catalog-9b30ce8b226d", 2], ["svc-catalog-94f501ccd7be", 2]] },
  { id: "sit-vpn-specificity-02", sources: [["fixture:src:serviceit:vpn-lab-north-cisco-anyconnect-410", 1]] },
  { id: "sit-vpn-editorial-grounding-01", sources: [["svc-catalog-6c79c1e68f04", 4], ["svc-catalog-9b30ce8b226d", 4], ["svc-catalog-94f501ccd7be", 4]] },
  { id: "sit-vpn-editorial-specificity-02", sources: [["fixture:src:serviceit:vpn-lab-north-cisco-anyconnect-410", 2]] },
] as const;

export function createProviderEvaluationPlan(value: unknown, profileIds: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  const cases = parseEvaluationDataset(value);
  if (profileIds.length < 1 || profileIds.length > 8 || new Set(profileIds).size !== profileIds.length) {
    throw new TypeError("Select between one and eight distinct configured profiles.");
  }
  const configuration = loadModelConfiguration(env);
  const prices = loadModelPrices(env);
  const profiles = profileIds.map(id => {
    const profile = configuration.profiles.find(item => item.id === id);
    const connection = configuration.connections.find(item => item.id === profile?.connectionId);
    const selectable = configuration.policy.defaultProfileId === id
      || (configuration.policy.userChoice.enabled && configuration.policy.userChoice.profileIds.includes(id));
    if (!profile || !connection || !selectable || !profile.allowedDataClasses.includes("synthetic_demo")) {
      throw new TypeError("An operator-selected profile is not approved for the synthetic evaluation.");
    }
    if (!modelPrice(id, configuration, prices)) throw new TypeError("An evaluation profile has no approved price.");
    return { id, connectionId: connection.id, provider: connection.provider, modelId: profile.modelId };
  });
  const selectedCases = fixedEvidence.map(fixture => {
    const evaluationCase = cases.find(item => item.id === fixture.id);
    if (evaluationCase?.testLayer !== "fixed_evidence" || evaluationCase.datasetSplit !== "development"
      || evaluationCase.clock.timezone !== "Europe/Berlin") throw new TypeError("The bundled development fixture contract changed.");
    const citations = fixture.sources.map(([sourceId, revision]) => ({ sourceId, revision }));
    if (citations.some(citation => !evaluationCase.modelEvidence?.some(evidence => evidence.sourceId === citation.sourceId && evidence.revision === citation.revision))) {
      throw new TypeError("An approved synthetic source revision is missing.");
    }
    // Only bounded citation-presence and no-tool assertions. Semantic facts,
    // support/completeness and language still require blinded human review.
    const oracle: EvaluationOracleSpecification = { schemaVersion: 1, assertions: [
      { id: "only-approved-citations", kind: "citations_allowed", citations },
      { id: "no-tool-proposals", kind: "tool_proposals_allowed", proposals: [] },
      ...(citations[0] ? [{ id: "current-source-cited", kind: "citations_required" as const, citations: [citations[0]] }] : []),
    ] };
    return { evaluationCase, serverAuthorizedEvidence: new Set(citations.map(citation => `${citation.sourceId}@${String(citation.revision)}`)), oracle };
  });
  return {
    profiles, cases: selectedCases,
    excludedCases: cases.filter(item => !fixedEvidence.some(fixture => fixture.id === item.id)).map(item => ({ id: item.id, layer: item.testLayer, reason: "requires_separate_observed_executor" as const })),
    configurationDigestSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
  };
}
