import { chatToolSchemas } from "./chat-contract";
import type { ResourceKind, TimeInterval } from "./types";

const RESOURCE_KINDS = new Set<ResourceKind>(["workplace", "meeting_room", "lecture_hall", "room"]);
const resourceIdSchema = chatToolSchemas.anny_get_availability.shape.resourceId;
const bookingIdSchema = chatToolSchemas.anny_propose_cancellation.shape.bookingId;

export interface GeneratedUserMessages {
  display: { id: string; role: "user"; content: string };
  canonical: { id: string; role: "user"; content: string };
}

function safeKind(kind: unknown): ResourceKind {
  const value = kind === undefined ? "room" : kind;
  if (typeof value !== "string" || !RESOURCE_KINDS.has(value as ResourceKind)) {
    throw new TypeError("The selected resource kind is invalid.");
  }
  return value as ResourceKind;
}

function canonicalInterval(interval: Pick<TimeInterval, "startDate" | "endDate">) {
  const schema = chatToolSchemas.anny_propose_booking.shape;
  const startDate = schema.startDate.parse(interval.startDate);
  const endDate = schema.endDate.parse(interval.endDate);
  if (Date.parse(endDate) <= Date.parse(startDate)) throw new TypeError("The selected interval is invalid.");
  return {
    startDate: new Date(startDate).toISOString(),
    endDate: new Date(endDate).toISOString(),
  };
}

function intervalText(interval: { startDate: string; endDate: string }) {
  return `startDate=${interval.startDate}; endDate=${interval.endDate}`;
}

function pair(displayText: string, canonicalText: string): GeneratedUserMessages {
  const displayId = crypto.randomUUID();
  const canonicalId = crypto.randomUUID();
  if (displayId === canonicalId) throw new Error("Generated chat event IDs must be unique.");
  return {
    display: { id: displayId, role: "user", content: displayText },
    canonical: { id: canonicalId, role: "user", content: canonicalText },
  };
}

export function roomSelectionMessages(
  displayText: string,
  kind: ResourceKind | undefined,
  resourceId: string,
): GeneratedUserMessages {
  const safeResourceId = resourceIdSchema.parse(resourceId);
  const safeResourceKind = safeKind(kind);
  return pair(
    displayText,
    `Die Ressource für die Raumbuchung ist ausgewählt. Ressourcenart: ${safeResourceKind}; resourceId=${safeResourceId}. Bitte verwende diese Ressource und frage nach fehlenden Angaben.`,
  );
}

export function availabilityCheckMessages(
  displayText: string,
  kind: ResourceKind | undefined,
  resourceId: string,
  interval: Pick<TimeInterval, "startDate" | "endDate">,
): GeneratedUserMessages {
  const safeResourceId = resourceIdSchema.parse(resourceId);
  const safeResourceKind = safeKind(kind);
  const canonical = canonicalInterval(interval);
  return pair(
    displayText,
    `Prüfe die Verfügbarkeit der ausgewählten Ressource. Ressourcenart: ${safeResourceKind}; resourceId=${safeResourceId}; ${intervalText(canonical)}.`,
  );
}

export function bookingPreparationMessages(
  displayText: string,
  kind: ResourceKind | undefined,
  resourceId: string,
  interval: Pick<TimeInterval, "startDate" | "endDate">,
): GeneratedUserMessages {
  const safeResourceId = resourceIdSchema.parse(resourceId);
  const safeResourceKind = safeKind(kind);
  const canonical = canonicalInterval(interval);
  return pair(
    displayText,
    `Bereite einen Buchungsvorschlag für die ausgewählte Ressource vor. Ressourcenart: ${safeResourceKind}; resourceId=${safeResourceId}; ${intervalText(canonical)}.`,
  );
}

export function cancellationPreparationMessages(
  displayText: string,
  bookingId: string,
  interval: Pick<TimeInterval, "startDate" | "endDate">,
): GeneratedUserMessages {
  const safeBookingId = bookingIdSchema.parse(bookingId);
  const canonical = canonicalInterval(interval);
  return pair(
    displayText,
    `Bereite die Stornierung der ausgewählten Buchung vor. bookingId=${safeBookingId}; ${intervalText(canonical)}.`,
  );
}
