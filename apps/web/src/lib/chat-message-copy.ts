import { formatDateTime, formatTime } from "./api";
import type { ChatMessage } from "./chat-sessions";
import { knowledgeCitationFromDocument, normalizeKnowledgeCitation, type KnowledgeCitation } from "./knowledge-citations";
import { proposalPresentation } from "./proposal-presentation";

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
const citationTokenPattern = /\[knowledge:(?:service_it|intranet):(?:svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}:[1-9][0-9]*\]/gu;

function absoluteReaderHref(value: unknown, origin: string): KnowledgeCitation | undefined {
  const citation = normalizeKnowledgeCitation(value);
  if (!citation) return undefined;

  try {
    const base = new URL(origin);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) return undefined;
    const href = new URL(citation.href, base);
    if (href.origin !== base.origin || !href.pathname.startsWith("/sources/")) return undefined;
    return { ...citation, href: href.href };
  } catch {
    return undefined;
  }
}

function citationMap(citations: readonly KnowledgeCitation[] | undefined, origin: string): Map<string, KnowledgeCitation> {
  const result = new Map<string, KnowledgeCitation>();
  for (const value of citations ?? []) {
    const citation = absoluteReaderHref(value, origin);
    if (citation && !result.has(citation.citationId)) result.set(citation.citationId, citation);
  }
  return result;
}

function replaceCitationTokens(source: string, citations: ReadonlyMap<string, KnowledgeCitation>): string {
  return source.replace(citationTokenPattern, (token) => {
    const citation = citations.get(token.slice(1, -1));
    return citation ? `[Quelle ${String(citation.number)}](${citation.href})` : "[Quelle nicht zugeordnet]";
  });
}

function sourceResultCitations(
  message: ChatMessage,
  provided: ReadonlyMap<string, KnowledgeCitation>,
  canDeriveFromMessageSources: boolean,
  origin: string,
): KnowledgeCitation[] {
  const result: KnowledgeCitation[] = [];
  const byId = new Map<string, KnowledgeCitation>();
  let nextNumber = 1;

  for (const source of message.sources ?? []) {
    const known = provided.get(source.citationId) ?? byId.get(source.citationId);
    if (known) {
      if (known.id === source.id && known.revision === source.revision) {
        result.push(known);
        byId.set(known.citationId, known);
      }
      continue;
    }
    if (!canDeriveFromMessageSources) continue;

    const generated = knowledgeCitationFromDocument(source, nextNumber);
    const citation = absoluteReaderHref(generated, origin);
    if (!citation) continue;
    nextNumber = Math.max(nextNumber + 1, citation.number + 1);
    byId.set(citation.citationId, citation);
    result.push(citation);
  }

  return result;
}

/** Return the exact Markdown source for clipboard and source-view use. */
export function chatMessageMarkdownSource(message: ChatMessage): string {
  return message.proposal ? proposalPresentation(message.proposal).summary : message.text;
}

/** Explicit content only: never serialize message metadata, tool arguments or UI controls. */
export function chatMessageCopyText(message: ChatMessage, origin: string, citations?: readonly KnowledgeCitation[]): string {
  const mappings = citationMap(citations, origin);
  const markdownSource = chatMessageMarkdownSource(message);
  const sections = [message.role === "assistant" ? replaceCitationTokens(markdownSource, mappings) : markdownSource];
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
  for (const source of message.role === "assistant" ? sourceResultCitations(message, mappings, citations === undefined, origin) : []) {
    sections.push(`${source.title}\n${source.sourceLabel} · Fassung ${String(source.revision)}\n${source.href}`);
  }
  if (message.proposal) {
    const proposal = message.proposal;
    sections.push([
      proposal.status !== "pending" ? proposalPresentation(proposal).label
        : proposal.action === "execute_tool" ? "Aktionsvorschlag" : proposal.action === "cancel_booking" ? "Stornierungsvorschlag" : "Buchungsvorschlag",
      proposal.resourceName,
      proposal.action === "execute_tool" ? "" : intervalText(proposal.startDate, proposal.endDate),
      proposal.status === "pending" ? "Bestätigung erforderlich" : "",
    ].filter(Boolean).join("\n"));
  }
  for (const booking of message.bookings ?? []) {
    sections.push(`${booking.resourceName}\n${intervalText(booking.startDate, booking.endDate)}\n${bookingStatusLabel(booking.status)}`);
  }
  return sections.filter(Boolean).join("\n\n");
}
