import { formatDateTime, formatTime } from "./api";
import type { ChatMessage } from "./chat-sessions";
import { knowledgeDocumentHref } from "./knowledge";

export function bookingStatusLabel(status: string) {
  switch (status.toLowerCase()) {
    case "requested":
    case "pending": return "Angefragt";
    case "accepted":
    case "confirmed": return "Bestätigt";
    case "cancelled":
    case "canceled": return "Storniert";
    default: return status;
  }
}

const intervalText = (start: string, end: string) => `${formatDateTime(start)} bis ${formatTime(end)} Uhr`;

/** Explicit content only: never serialize message metadata, tool arguments or UI controls. */
export function chatMessageCopyText(message: ChatMessage, origin: string): string {
  const sections = [message.text.trim()];
  for (const { resource, checked, intervals } of message.rooms ?? []) {
    sections.push([
      resource.name,
      resource.parentName ? `Büro: ${resource.parentName}` : "",
      resource.location,
      resource.kind === "workplace"
        ? resource.officeWorkplaceCount ? `Büro mit ${String(resource.officeWorkplaceCount)} ${resource.officeWorkplaceCount === 1 ? "Arbeitsplatz" : "Arbeitsplätzen"}` : "Einzelner Arbeitsplatz"
        : resource.capacity === null ? "Personenkapazität nicht hinterlegt" : `Bis ${String(resource.capacity)} Personen`,
      resource.features.join(" · "),
      checked
        ? intervals.some(slot => slot.available)
          ? intervals.filter(slot => slot.available).map(slot => `Freie Zeit: ${intervalText(slot.startDate, slot.endDate)}`).join("\n")
          : "Keine freien Zeiten zu diesen Anforderungen."
        : "Verfügbarkeit ungeprüft",
    ].filter(Boolean).join("\n"));
  }
  for (const source of message.sources ?? []) {
    sections.push(`${source.title}\n${source.citationId}\n${new URL(knowledgeDocumentHref(source.id, source.revision), origin).href}`);
  }
  if (message.proposal) {
    const proposal = message.proposal;
    sections.push([
      proposal.action === "cancel_booking" ? "Stornierungsvorschlag" : "Buchungsvorschlag",
      proposal.resourceName,
      intervalText(proposal.startDate, proposal.endDate),
      proposal.status === "pending" ? "Bestätigung erforderlich" : "Vorschlag abgeschlossen oder ersetzt",
    ].join("\n"));
  }
  for (const booking of message.bookings ?? []) {
    sections.push(`${booking.resourceName}\n${intervalText(booking.startDate, booking.endDate)}\n${bookingStatusLabel(booking.status)}`);
  }
  return sections.filter(Boolean).join("\n\n");
}
