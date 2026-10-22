import "server-only";

import { createHash } from "node:crypto";
import { loadModelConfiguration } from "../model-config";
import { loadModelPrices, modelPrice } from "../model-budgets";

export const ROOM_PLANNING_CASE_ID = "room-initial-preference-1j" as const;

const definitions = [{
  id: ROOM_PLANNING_CASE_ID,
  scenario: "initial_workplace_search_then_direct_office_preference",
  location: "1J",
  timezone: "Europe/Berlin",
  status: "draft_development_observation",
}] as const;

export type RoomPlanningDefinition = typeof definitions[number];

export function roomPlanningDefinitions(): readonly RoomPlanningDefinition[] {
  return definitions.map(item => ({ ...item }));
}

export function roomPlanningDefinition(caseId: string): RoomPlanningDefinition {
  const definition = definitions.find(item => item.id === caseId);
  if (!definition) throw new TypeError("The selected case is outside the code-owned room-planning manifest.");
  return { ...definition };
}

/** Plan-only validation reads configuration and prices, but no credential, fixture, network, or budget. */
export function createRoomPlanningPlan(
  profileIds: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  caseIds: readonly string[] = [ROOM_PLANNING_CASE_ID],
) {
  if (profileIds.length < 1 || profileIds.length > 8 || new Set(profileIds).size !== profileIds.length) {
    throw new TypeError("Select between one and eight distinct configured profiles.");
  }
  if (caseIds.length < 1 || new Set(caseIds).size !== caseIds.length
    || caseIds.some(id => !definitions.some(item => item.id === id))) {
    throw new TypeError("Select only registered room-planning cases.");
  }

  const configuration = loadModelConfiguration(env);
  if (configuration.policy.fallbacks.length) {
    throw new TypeError("Room-planning evaluation requires the configured fallback policy to be disabled.");
  }
  const prices = loadModelPrices(env);
  const profiles = profileIds.map(id => {
    const profile = configuration.profiles.find(item => item.id === id);
    const connection = configuration.connections.find(item => item.id === profile?.connectionId);
    const selectable = configuration.policy.defaultProfileId === id
      || configuration.policy.userChoice.enabled && configuration.policy.userChoice.profileIds.includes(id);
    if (!profile || !connection || !selectable || !profile.capabilities.tools
      || !profile.allowedDataClasses.includes("synthetic_demo")) {
      throw new TypeError("An operator-selected profile is not approved for the synthetic room-planning observation.");
    }
    if (!modelPrice(id, configuration, prices)) {
      throw new TypeError("A room-planning profile has no approved price.");
    }
    return { id, connectionId: connection.id, provider: connection.provider, modelId: profile.modelId };
  });

  return {
    profiles,
    cases: caseIds.map(id => roomPlanningDefinition(id)),
    configurationDigestSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
    limits: [
      "one code-owned draft development scenario; no gold label, semantic score, or acceptance claim",
      "actual protected timestamp and chat routes plus the native Anny read bridge under synthetic read-only authority",
      "only the typed anny_search_resources read may execute; no availability, proposal, confirmation, cancellation, or booking action",
      "actual server clock with a runtime-generated Berlin date; follow-up preference branch does not call the model again",
      "the fixture identity and configured 1J catalog do not establish production authority or model-visible expected results",
      "existing shared durable budget admission is required before fixture environment changes; no budget initialization or refund",
      "response capture is bounded at 128 KiB; every admitted provider HTTP attempt is metered; HTTP errors stop the batch",
      "this is not full React/browser/calendar coverage; Groq cache status remains unknown and deferred to M8-A10",
    ],
  };
}
