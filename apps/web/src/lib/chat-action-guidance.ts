import type { ChatProposal } from "./chat-sessions";
import { forwardProposalStatus, readProposalSnapshot, sameProposalDetails } from "./proposal-presentation";

/** Closed UI help replies, never a general booking/topic classifier. */
export function asksForActionControls(text: string): boolean {
  if (text.length > 240) return false;
  const normalized = text.trim().toLocaleLowerCase("de-DE").replace(/[.!?]+$/u, "").replace(/\s+/gu, " ")
    .replace(/^was soll das(?: denn)?[,.!?]?\s+/u, "");
  if (/^(?:i (?:don't|do not|cannot|can't) (?:see|find) (?:a|the|any) (?:confirmation |confirm )?button|where is the (?:confirmation |confirm )?button)$/u.test(normalized)) return true;
  return /^(?:(?:ich )?(?:sehe|finde) (?:hier )?kein(?:e|en)? (?:schaltfläche|schaltflaeche|button|bestätigung|bestaetigung|bestätigungsschaltfläche|bestätigungsbutton)|wo (?:ist|finde ich) (?:die |den )?(?:schaltfläche|schaltflaeche|button|bestätigung|bestaetigung|bestätigungsschaltfläche|bestätigungsbutton)|(?:ich )?(?:möchte|moechte|will) (?:direkt )?(?:hier|von hier) buchen)$/u.test(normalized);
}

/** Standalone status questions only; mixed requests still enter normal planning. */
export function asksForActionStatus(text: string): boolean {
  if (text.length > 240) return false;
  const normalized = text.trim().replace(/\s+/gu, " ");
  return /^(?:hat das (?:geklappt|funktioniert)|was ist der (?:aktuelle )?status|ist (?:das|die buchung|meine buchung|die stornierung) (?:bestätigt|storniert|abgeschlossen)|gibt es (?:da |dazu )?(?:keine|eine) rückmeldung|(?:ich habe|es gibt) (?:noch )?keine rückmeldung|did that (?:work|go through)|what is the (?:current )?status|is (?:that|the booking|my booking|the cancellation) (?:confirmed|cancelled|completed)|(?:is there|i have) no feedback)[.!?…]*$/iu.test(normalized);
}

/** A help request may restore only the identical still-pending preview.
 * It never grants confirmation or regresses a completed/uncertain action.
 */
export function currentActionControls(displayed: ChatProposal, response: unknown, now = Date.now()):
  { proposal: ChatProposal; confirmable: boolean } | null {
  const current = readProposalSnapshot(response, displayed, now);
  if (!current || !sameProposalDetails(displayed, current)) return null;
  const invalidated = displayed.status === "pending" && current.status === "invalidated";
  if (!invalidated && !forwardProposalStatus(displayed.status, current.status)) return null;
  return { proposal: current, confirmable: displayed.status === "pending" && current.status === "pending" };
}
