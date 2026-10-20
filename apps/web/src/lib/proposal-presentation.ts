import { sameActionPreview } from "./action-preview";
import { proposalSchema, type ChatProposal } from "./chat-sessions";
import { parsePluginProposalSnapshot, samePluginProposalSnapshot } from "./plugin-tools";

/** Fixed host copy: an action receipt is the authorized proposal, never free tool text. */
export function proposalPresentation(proposal: ChatProposal) {
  const action = proposal.action === "execute_tool" ? "Aktion" : proposal.action === "cancel_booking" ? "Stornierung" : "Buchung";
  switch (proposal.status) {
    case "confirmed": return { label: `${action} bestätigt`, summary: `Die ${action} wurde bestätigt.`, bookingsLink: proposal.action !== "execute_tool" };
    case "executing": return { label: "Wird verarbeitet", summary: "Die Aktion wird verarbeitet. Bitte prüfe später den Status; bestätige sie nicht erneut.", bookingsLink: false };
    case "outcome_unknown": return { label: "Ausgang unklar", summary: "Der Ausgang ist noch unklar. Prüfe den Aktionsstatus, bevor du eine neue Aktion vorbereitest.", bookingsLink: false };
    case "failed": return { label: "Aktion fehlgeschlagen", summary: "Die Aktion konnte nicht bestätigt werden. Prüfe den aktuellen Stand im zuständigen Dienst.", bookingsLink: false };
    case "invalidated": return { label: "Vorschlag ungültig", summary: "Dieser Vorschlag ist nicht mehr gültig. Bereite ihn bei Bedarf neu vor.", bookingsLink: false };
    case "pending": return { label: `${action} prüfen`, summary: "Prüfe den aktuellen Vorschlag. Nur deine separate Bestätigung kann die Aktion ausführen.", bookingsLink: false };
  }
}

/** Status may advance, but every action-defining value must remain identical. */
export function sameProposalDetails(left: ChatProposal, right: ChatProposal): boolean {
  if (left.action === "execute_tool" || right.action === "execute_tool") {
    return left.action === "execute_tool" && right.action === "execute_tool" && samePluginProposalSnapshot(left, right);
  }
  const instant = (a: string, b: string) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
  return left.id === right.id && (left.action ?? "book") === (right.action ?? "book")
    && sameActionPreview(left.preview, right.preview) && left.resourceName === right.resourceName
    && instant(left.startDate, right.startDate) && instant(left.endDate, right.endDate) && instant(left.expiresAt, right.expiresAt);
}

export function readProposalSnapshot(value: unknown, expected: ChatProposal, now = Date.now()): ChatProposal | null {
  const currentStatus = (proposal: ChatProposal | null): ChatProposal | null => proposal?.status === "pending" && Date.parse(proposal.expiresAt) <= now
    ? { ...proposal, status: "invalidated" } : proposal;
  if (expected.action === "execute_tool") return currentStatus(parsePluginProposalSnapshot(value, expected));
  if (typeof value !== "object" || value === null || !("proposal" in value)) return null;
  const raw = value.proposal;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("action" in raw)
    || (raw.action !== "book" && raw.action !== "cancel_booking")) return null;
  const parsed = proposalSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([key]) =>
    ["preview", "action", "id", "resourceName", "startDate", "endDate", "status", "expiresAt"].includes(key))));
  return parsed.success ? currentStatus({ ...parsed.data, action: parsed.data.action ?? "book" }) : null;
}

export function forwardProposalStatus(before: ChatProposal["status"], after: ChatProposal["status"]): boolean {
  if (before === after) return true;
  if (before === "pending") return ["executing", "confirmed", "outcome_unknown", "failed"].includes(after);
  if (before === "executing") return ["confirmed", "outcome_unknown", "failed"].includes(after);
  return before === "outcome_unknown" && (after === "confirmed" || after === "failed");
}
