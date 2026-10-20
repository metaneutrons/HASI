import { classifyIntent, mergeRoomRequest, parseStandaloneOfficePreference, type RoomRequest } from "./chat-demo";
import type { ChatToolName, WireMessage } from "./chat-contract";

// One planning call; only knowledge synthesis or a failed planning call needs a follow-up.
export const MAX_MODEL_STEPS = 2;
export const toolNeedsModelFollowUp = (name: ChatToolName) => name === "knowledge_search";
export const toolBatchNeedsModelFollowUp = (names: ChatToolName[]) => names.some(toolNeedsModelFollowUp);
export const isAvailabilityFollowUp = (text: string) => /\b(?:frei|verfügbar|verfuegbar|verfügbarkeit|available|availability)\b/iu.test(text);

/** User task continuity only; assistant/tool text cannot request capabilities. */
export function annyWorkflow(messages: readonly WireMessage[]): "rooms" | "bookings" | null {
  const users = messages.filter(message => message.role === "user");
  const latest = users.at(-1)?.content ?? "";
  const intent = classifyIntent(latest, false);
  if (intent === "rooms" || intent === "bookings") return intent;
  if (intent !== "help") return null;
  const continuesTask = (text: string) => /^(?:(?:dann|bitte|ja|okay|ok)\s+)*(?:mir\s+egal|egal|beides|keine\s+präferenz|pr[üu](?:f|pf)\w*|such\w*|mach\s+das|weiter)[.!?\s]*$/iu.test(text.trim())
    || isAvailabilityFollowUp(text) || classifyIntent(text, true) === "rooms";
  // Contextual classification detects detail-only replies; it does not choose
  // their calendar anchor. Actual dates still use verified message receipts.
  if (!continuesTask(latest)) return null;
  for (const message of users.slice(0, -1).reverse()) {
    const earlier = classifyIntent(message.content, false);
    if (earlier === "rooms" || earlier === "bookings") return earlier;
    if (earlier !== "help" || !continuesTask(message.content)) return null;
  }
  return null;
}


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
  if (parseStandaloneOfficePreference(text) === undefined) return null;
  const next = mergeRoomRequest(text, previous, now);
  return next.officeType !== undefined ? next : null;
}

export function isOwnBookingsRequest(text: string): boolean {
  return /^(?:(?:zeige|zeig)\s+(?:mir\s+)?)?meine\s+(?:buchungen|reservierungen)[.!?\s]*$/iu.test(text.trim());
}
