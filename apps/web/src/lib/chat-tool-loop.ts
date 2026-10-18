import { classifyIntent, mergeRoomRequest, type RoomRequest } from "./chat-demo";
import type { ChatToolName } from "./chat-contract";

// One planning call; only knowledge synthesis or a failed planning call needs a follow-up.
export const MAX_MODEL_STEPS = 2;
export const toolNeedsModelFollowUp = (name: ChatToolName) => name === "knowledge_search";
export const toolBatchNeedsModelFollowUp = (names: ChatToolName[]) => names.some(toolNeedsModelFollowUp);
export const isAvailabilityFollowUp = (text: string) => /\b(?:frei|verfügbar|verfuegbar|verfügbarkeit|available|availability)\b/iu.test(text);


/** Preserve compound tasks; their read/read/synthesis path may need one extra step. */
export function isMixedKnowledgeRequest(text: string, hasRoomContext: boolean): boolean {
  const strongKnowledge = /\b(?:wissen|intranet|service[- ]?it|vpn|passwort|eduroam|zeiterfassung|urlaub|fortbildung)\b/iu.test(text)
    || /\b(?:wlan)\b/iu.test(text) && (/\b(?:wie|erkläre|anleitung|problem|hilfe)\b/iu.test(text) || hasRoomContext && isAvailabilityFollowUp(text));
  const task = classifyIntent(text, false);
  return strongKnowledge && (task === "rooms" || task === "bookings" || /\b(?:buch\w*|reservier\w*)\b/iu.test(text) || hasRoomContext && isAvailabilityFollowUp(text));
}

/** Only standalone, unambiguous replies qualify. Compound requests still use the model. */
export function officePreferenceSearch(text: string, previous: RoomRequest, now: Date): RoomRequest | null {
  if (previous.kind !== "workplace") return null;
  const normalized = text.toLowerCase().trim().replace(/[.!?]+$/u, "").trim();
  if (!/^(?:(?:bitte|lieber)\s+)?(?:(?:ein|einen)\s+)?(?:einzelbüro|1er[- ]?büro|geteiltes büro|gemeinsames büro|shared office|beides|egal|keine präferenz)(?:\s+bitte)?$/u.test(normalized)) return null;
  const next = mergeRoomRequest(text, previous, now);
  return next.officeType !== undefined ? next : null;
}

export function isOwnBookingsRequest(text: string): boolean {
  return /^(?:(?:zeige|zeig)\s+(?:mir\s+)?)?meine\s+(?:buchungen|reservierungen)[.!?\s]*$/iu.test(text.trim());
}
