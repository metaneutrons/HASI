import "server-only";

import { parseEvaluationDataset, type EvaluationCase } from "./case-schema";
import { createProviderEvaluationPlan } from "./provider-suite";
import { loadModelConfiguration } from "../model-config";
import { getKnowledgePolicyScenario } from "../../../../../../scripts/evaluation/knowledge-policy-scenarios";

// These mappings are reviewed application composition. Corpus entitlements,
// candidate documents, expected labels and model output never establish rights.
const definitions = [
  { id: "access-01", baseCaseId: "access-01", scenario: "lumen", role: "reader", revokeAfterAnswer: false },
  { id: "access-02", baseCaseId: "access-02", scenario: "lumen", role: "outsider", revokeAfterAnswer: false },
  { id: "inject-01", baseCaseId: "inject-01", scenario: "atlas-poisoned", role: "reader", revokeAfterAnswer: false },
  { id: "inject-03", baseCaseId: "inject-03", scenario: "temporary-account", role: "reader", revokeAfterAnswer: false },
  { id: "inject-04", baseCaseId: "inject-04", scenario: "north-entry-card", role: "reader", revokeAfterAnswer: false },
  { id: "inject-04-host-preloaded-runtime", baseCaseId: "inject-04", scenario: "north-entry-card", role: "reader", revokeAfterAnswer: false },
  { id: "inject-01-clean-runtime", baseCaseId: "intra-01", scenario: "atlas-clean", role: "reader", revokeAfterAnswer: false },
  { id: "access-01-revoked-runtime", baseCaseId: "access-01", scenario: "lumen", role: "reader", revokeAfterAnswer: true },
  { id: "access-03-deployment-scoped-runtime", baseCaseId: "access-03", scenario: "tenant-alpha-empty", role: "reader", revokeAfterAnswer: false, tenancyScope: "isolated_in_process_deployments" },
] as const;

export type ApplicationPolicyDefinition = typeof definitions[number];
export interface ApplicationPolicyCase { definition: ApplicationPolicyDefinition; evaluationCase: EvaluationCase }

export function applicationPolicyDefinitions(): readonly ApplicationPolicyDefinition[] {
  return definitions.map(item => ({ ...item }));
}

export function applicationPolicyCase(value: unknown, caseId: string): ApplicationPolicyCase {
  const cases = parseEvaluationDataset([value]);
  const evaluationCase = cases[0];
  const definition = definitions.find(item => item.id === caseId);
  if (!definition || evaluationCase?.id !== definition.baseCaseId
    || evaluationCase.datasetSplit !== "development"
    || evaluationCase.clock.timezone !== "Europe/Berlin"
    || evaluationCase.testLayer !== (definition.id === "inject-01-clean-runtime" ? "fixed_evidence" : "application_policy")) {
    throw new TypeError("The selected case is outside the reviewed application-policy manifest.");
  }
  if (definition.id === "access-03-deployment-scoped-runtime") {
    // Corpus identity consistency is not an authorization grant: the separately
    // signed, code-owned peer fixture still establishes all source authority.
    const trusted = getKnowledgePolicyScenario("tenant-beta-private").sources[0];
    const candidate = evaluationCase.candidateDocuments?.[0];
    if (!trusted || evaluationCase.candidateDocuments?.length !== 1
      || candidate?.sourceId !== trusted.sourceId || candidate.revision !== trusted.revision
      || candidate.title !== trusted.title || candidate.text !== trusted.text) {
      throw new TypeError("The reviewed candidate identity differs from the trusted deployment fixture.");
    }
  }
  return { definition: { ...definition }, evaluationCase };
}

/** Plan-only validation reads no credentials, fixture network or budget store. */
export function createApplicationPolicyPlan(value: unknown, profileIds: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  const corpus = parseEvaluationDataset(value);
  const common = createProviderEvaluationPlan(corpus, profileIds, env);
  // Do not rewrite production routing to hide configured fallback behavior.
  // The operator must select a configuration whose fallback policy is disabled.
  if (loadModelConfiguration(env).policy.fallbacks.length) {
    throw new TypeError("Application-policy evaluation requires disabled fallback rules.");
  }
  const cases = definitions.map(definition => applicationPolicyCase(corpus.find(item => item.id === definition.baseCaseId), definition.id));
  return {
    profiles: common.profiles,
    configurationDigestSha256: common.configurationDigestSha256,
    cases,
    excludedCases: corpus.filter(item => !definitions.some(definition => definition.baseCaseId === item.id))
      .map(item => ({ id: item.id, layer: item.testLayer,
        reason: item.testLayer === "application_policy" ? "requires_additional_trusted_source_or_anny_fixture" : "outside_application_policy_manifest" })),
  };
}
