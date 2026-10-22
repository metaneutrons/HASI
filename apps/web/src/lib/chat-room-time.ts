import { requestStartDate, type RoomRequest } from "./chat-demo";
import { chatToolSchemas, type ChatToolName } from "./chat-contract";

export class RoomTimeMismatchError extends Error {
  constructor(public readonly expectedInterval: { startDate: string; endDate: string }) {
    super("Der vorgeschlagene Zeitraum entspricht nicht deiner Anfrage und wird nicht verwendet.");
  }
}
export class RoomTimeUnresolvedError extends Error {
  constructor() {
    super("Diese Ortszeit ist wegen der Zeitumstellung in Europe/Berlin nicht eindeutig oder existiert nicht. Bitte wähle eine andere Uhrzeit.");
  }
}

export class RoomTimeInvalidError extends RoomTimeUnresolvedError {
  constructor(fields: string[]) {
    super();
    this.message = `Bitte korrigiere die Angaben für ${fields.join(", ")}. Datum, Uhrzeit und eine Dauer von 15 Minuten bis 24 Stunden müssen gültig sein.`;
  }
}

/** Resolve complete user-entered time constraints, never model-generated dates. */
export function requestedRoomInterval(request: RoomRequest) {
  if (request.date === undefined || request.time === undefined || request.durationMinutes === undefined) return null;
  const shape = chatToolSchemas.anny_get_availability.safeParse({ resourceId: "intent", date: request.date, time: request.time, durationMinutes: request.durationMinutes });
  const startDate = requestStartDate(request);
  const duration = request.durationMinutes;
  if (!shape.success) {
    const labels: Record<string, string> = { date: "Datum", time: "Uhrzeit", durationMinutes: "Dauer" };
    throw new RoomTimeInvalidError([...new Set(shape.error.issues.map(issue => labels[String(issue.path[0])] ?? "Zeitraum"))]);
  }
  if (!startDate) throw new RoomTimeUnresolvedError();
  return { startDate: new Date(startDate).toISOString(), endDate: new Date(Date.parse(startDate) + duration * 60_000).toISOString() };
}

/** A model may not silently move a complete requested interval. Explicit UI
 * selection of a labelled alternate slot remains a separate user action. */
export function assertRequestedRoomTime(name: ChatToolName, args: unknown, request: RoomRequest) {
  if (name !== "anny_get_availability" && name !== "anny_propose_booking") return;
  const expected = requestedRoomInterval(request);
  if (!expected) return;
  let start: string | null;
  let end: number;
  if (name === "anny_get_availability") {
    const parsed = chatToolSchemas.anny_get_availability.parse(args);
    start = requestStartDate({ date: parsed.date, time: parsed.time, durationMinutes: parsed.durationMinutes });
    end = Date.parse(start ?? "") + parsed.durationMinutes * 60_000;
  } else {
    const parsed = chatToolSchemas.anny_propose_booking.parse(args);
    start = parsed.startDate;
    end = Date.parse(parsed.endDate);
  }
  if (Date.parse(start ?? "") !== Date.parse(expected.startDate) || end !== Date.parse(expected.endDate)) {
    throw new RoomTimeMismatchError(expected);
  }
}
