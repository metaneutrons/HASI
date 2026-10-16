import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  matchingResources,
  mergeRoomRequest,
  missingRoomDetails,
  requestStartDate,
  roomRequestSummary,
  type RoomRequest,
} from "../src/lib/chat-demo";
import type { Resource } from "../src/lib/types";

const rooms: Resource[] = [
  {
    id: "seminar",
    name: "Seminarraum 101",
    description: "Heller Seminarraum für gemeinsame Projekte und Workshops.",
    capacity: 12,
    location: "Campus Linden · Gebäude 1",
    features: ["Display", "Whiteboard"],
    serviceId: "rooms",
  },
  {
    id: "project",
    name: "Projektraum 202",
    description: "Ruhiger Projektraum für Gruppenarbeit und Besprechungen.",
    capacity: 6,
    location: "Campus Linden · Gebäude 2",
    features: ["Videokonferenz", "Whiteboard"],
    serviceId: "rooms",
  },
  {
    id: "studio",
    name: "Medienstudio",
    description: "Studio für Audioaufnahmen und kleinere Produktionen.",
    capacity: 4,
    location: "Campus Expo Plaza · Studio",
    features: ["Audio", "Produktion"],
    serviceId: "studio",
  },
];

describe("bounded German chat demo parser", () => {
  it("fills the initial room request and carries omitted slots across follow-ups", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    const first = mergeRoomRequest(
      "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.",
      {},
      now,
    );
    expect(first).toMatchObject({
      date: "2026-06-02",
      time: "14:00",
      durationMinutes: 60,
      capacity: 4,
    });
    expect(missingRoomDetails(first)).toEqual([]);
    expect(requestStartDate(first)).toBe("2026-06-02T14:00:00+02:00");

    const followUp = mergeRoomRequest("morgen um 14 Uhr für eine Stunde", {}, now);
    expect(followUp).toMatchObject({ date: "2026-06-02", time: "14:00", durationMinutes: 60 });

    const refined = mergeRoomRequest("doch um 15:30 und mit Display", first, now);
    expect(refined).toMatchObject({
      date: "2026-06-02",
      time: "15:30",
      durationMinutes: 60,
      capacity: 4,
      features: ["Display"],
    });
    expect(refined.query).toBeUndefined();
    expect(roomRequestSummary(refined)).toContain("für 4 Personen");
  });

  it("does not turn polite room wording into a search query", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    const polite = mergeRoomRequest(
      "Kannst du mir einen Raum für morgen um 14 Uhr für eine Stunde suchen?",
      {},
      now,
    );
    const imperative = mergeRoomRequest("Zeige mir Räume", {}, now);
    const bookingRequest = mergeRoomRequest("Ich möchte einen Raum buchen", {}, now);
    expect(polite.query).toBeUndefined();
    expect(imperative.query).toBeUndefined();
    expect(bookingRequest.query).toBeUndefined();
    expect(matchingResources(rooms, polite)).toHaveLength(3);
    expect(matchingResources(rooms, imperative)).toHaveLength(3);
  });

  it("keeps common room questions and the room-booking noun out of the search query", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    const question = mergeRoomRequest("Welche Räume gibt es?", {}, now);
    const bookingQuestion = mergeRoomRequest("Welche Räume kannst du buchen?", {}, now);
    const bookingNoun = mergeRoomRequest("Raumbuchung", {}, now);

    expect(question.query).toBeUndefined();
    expect(bookingQuestion.query).toBeUndefined();
    expect(bookingNoun.query).toBeUndefined();
    expect(matchingResources(rooms, question)).toHaveLength(3);
    expect(matchingResources(rooms, bookingQuestion)).toHaveLength(3);
    expect(classifyIntent("Raumbuchung", false)).toBe("rooms");
  });

  it("accepts explicit room ranges and the supported duration and group spellings", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    expect(mergeRoomRequest("übermorgen 14 bis 16 Uhr, wir sind zu viert", {}, now)).toMatchObject({
      date: "2026-06-03",
      time: "14:00",
      durationMinutes: 120,
      capacity: 4,
    });
    expect(mergeRoomRequest("heute um 14:30 für 1,5 Stunden für 2 Personen", {}, now)).toMatchObject({
      date: "2026-06-01",
      time: "14:30",
      durationMinutes: 90,
      capacity: 2,
    });
    expect(mergeRoomRequest("morgen um 9 Uhr für 30 Minuten für zwei Personen", {}, now)).toMatchObject({
      time: "09:00",
      durationMinutes: 30,
      capacity: 2,
    });
  });

  it("uses Berlin calendar dates and refuses nonexistent or ambiguous DST times", () => {
    const beforeSpringShift = new Date("2026-03-29T00:30:00.000Z");
    const springDate = mergeRoomRequest("heute um 14 Uhr", {}, beforeSpringShift);
    expect(springDate.date).toBe("2026-03-29");
    expect(requestStartDate(springDate)).toBe("2026-03-29T14:00:00+02:00");

    const missingSpringHour = mergeRoomRequest("2026-03-29 um 02:30", {}, beforeSpringShift);
    expect(requestStartDate(missingSpringHour)).toBeNull();
    const repeatedAutumnHour = mergeRoomRequest("2026-10-25 um 02:30", {}, beforeSpringShift);
    expect(requestStartDate(repeatedAutumnHour)).toBeNull();
  });

  it("clears stale valid slots when the user gives impossible or ambiguous values", () => {
    const previous: RoomRequest = {
      date: "2026-06-02",
      time: "14:00",
      durationMinutes: 60,
      capacity: 4,
    };
    const invalid = mergeRoomRequest("31.02.2026 um 25 Uhr für 0 Minuten für 0 Personen", previous);
    expect(invalid.date).not.toBe(previous.date);
    expect(invalid.time).not.toBe(previous.time);
    expect(invalid.durationMinutes).toBe(0);
    expect(invalid.capacity).toBe(0);
    expect(missingRoomDetails(invalid)).toEqual([
      "Datum (heute, morgen oder TT.MM.JJJJ)",
      "Uhrzeit (z. B. 14:30)",
      "Dauer (15 Minuten bis 24 Stunden)",
      "Personenzahl",
    ]);
    expect(requestStartDate(invalid)).toBeNull();

    const ambiguous = mergeRoomRequest("morgen um halb drei", previous);
    expect(ambiguous.time).toBe("__invalid__");
    expect(missingRoomDetails(ambiguous)).toContain("Uhrzeit (z. B. 14:30)");
  });

  it("does not read negated or alternative constraints as positive room requirements", () => {
    const previous: RoomRequest = {
      date: "2026-06-02",
      time: "14:00",
      durationMinutes: 60,
      features: ["Whiteboard"],
    };
    const negated = mergeRoomRequest("nicht morgen um 14 Uhr ohne Whiteboard für 30 Minuten", previous);
    expect(negated.date).toBe("__invalid__");
    expect(negated.time).toBe("__invalid__");
    expect(negated.durationMinutes).toBe(30);
    expect(negated.features).toEqual(["__invalid__"]);
    expect(missingRoomDetails(negated)).toContain("Ausstattung (bitte eindeutig angeben)");
    expect(matchingResources(rooms, negated)).toEqual([]);
    expect(roomRequestSummary(negated)).toContain("ungeklärter Ausstattung");

    const alternatives = mergeRoomRequest("morgen oder übermorgen um 14 Uhr", previous);
    expect(alternatives.date).toBe("__invalid__");
    expect(missingRoomDetails(alternatives)).toContain("Datum (heute, morgen oder TT.MM.JJJJ)");

    const negatedCapacity = mergeRoomRequest("nicht zu viert", { ...previous, capacity: 4 });
    expect(negatedCapacity.capacity).toBe(0);
    expect(missingRoomDetails(negatedCapacity)).toContain("Personenzahl");
    expect(mergeRoomRequest("nicht für 30 Minuten", previous).durationMinutes).toBe(0);
  });

  it("filters capacity, every requested feature, location, and query without substituting equipment", () => {
    expect(matchingResources(rooms, { capacity: 7, features: ["Whiteboard"], location: "Linden" }).map(({ id }) => id))
      .toEqual(["seminar"]);
    expect(matchingResources(rooms, { features: ["Display", "Whiteboard"] }).map(({ id }) => id))
      .toEqual(["seminar"]);
    expect(matchingResources(rooms, { features: ["Beamer"] })).toEqual([]);
    expect(matchingResources(rooms, { location: "Expo Plaza" }).map(({ id }) => id)).toEqual(["studio"]);
    expect(matchingResources(rooms, { query: "Seminarraum" }).map(({ id }) => id)).toEqual(["seminar"]);
    expect(matchingResources(rooms, { query: "ruhigen Projektraum" }).map(({ id }) => id)).toEqual(["project"]);
    expect(matchingResources(rooms, { capacity: 0 })).toEqual([]);
  });

  it("classifies focused intents and sends unrelated follow-ups to help", () => {
    expect(classifyIntent("Raum suchen", false)).toBe("rooms");
    expect(classifyIntent("Zeig mir Räume", false)).toBe("rooms");
    expect(classifyIntent("Ich möchte einen Raum buchen", false)).toBe("rooms");
    expect(classifyIntent("meine Buchungen anzeigen", false)).toBe("bookings");
    expect(classifyIntent("Wie richte ich eduroam ein?", false)).toBe("knowledge");
    expect(classifyIntent("Guten Morgen", false)).toBe("greeting");
    expect(classifyIntent("morgen um 14 Uhr", true)).toBe("rooms");
    expect(classifyIntent("mit Beamer", true)).toBe("rooms");
    expect(classifyIntent("Erkläre mir das Intranet", true)).toBe("knowledge");
    expect(classifyIntent("Kannst du meine Steuererklärung ausfüllen?", true)).toBe("help");
  });
});
