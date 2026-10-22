import { describe, expect, it } from "vitest";
import { hshDemoCatalog } from "../../../fixtures/catalog";
import {
  classifyIntent,
  matchingResources,
  mergeRoomRequest,
  missingRoomDetails,
  requestStartDate,
  roomRequestSummary,
  workplaceOfficeTypeCounts,
  workplaceRefinementQuestion,
  type RoomRequest,
} from "../src/lib/chat-demo";
import type { Resource } from "../src/lib/types";
import { required } from "./test-utils";

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
  it('recognizes a new single-office search and office preference follow-ups as room intent', () => {
    expect(classifyIntent('Ich brauche am kommenden Montag ein Einzelbüro im Gebäude 1J von 8-16 Uhr.', false)).toBe('rooms');
    expect(classifyIntent('Ein Einzelbüro bitte.', true)).toBe('rooms');
    expect(classifyIntent('Beides passt, keine Präferenz.', true)).toBe('rooms');
    expect(classifyIntent('Mir egal.', false)).toBe('help');
  });
  it('treats a new-search prefix as control text while preserving resource-name keywords', () => {
    const now = new Date('2026-10-19T08:00:00.000Z');
    const request = mergeRoomRequest(
      'Neue Raumsuche: Ich brauche morgen ein Einzelbüro im Gebäude 1J von 10 bis 16 Uhr.',
      {},
      now,
    );
    expect(request).toMatchObject({
      kind: 'workplace',
      officeType: 'single',
      date: '2026-10-20',
      time: '10:00',
      durationMinutes: 360,
      location: '1J',
    });
    expect(request.query).toBeUndefined();
    expect(matchingResources(hshDemoCatalog.resources, request)).toHaveLength(7);

    const namedRequest = mergeRoomRequest(
      'Neue Raumsuche: Ich brauche morgen ein Einzelbüro, das Flex-Büro Grace Hopper, im Gebäude 1J von 10 bis 16 Uhr.',
      {},
      now,
    );
    expect(namedRequest.query).toBe('grace hopper');
    expect(matchingResources(hshDemoCatalog.resources, namedRequest).map(({ id }) => id)).toEqual(['190449']);

    const quotedNamedRequest = mergeRoomRequest(
      'Neue Raumsuche: Ich brauche morgen ein Einzelbüro, das "Flex-Büro Grace Hopper", im Gebäude 1J von 10 bis 16 Uhr.',
      {},
      now,
    );
    expect(quotedNamedRequest.query).toBe('flex buro grace hopper');
    expect(matchingResources(hshDemoCatalog.resources, quotedNamedRequest).map(({ id }) => id)).toEqual(['190449']);
  });
  it('distinguishes one workplace in an office from rooms with person capacities', () => {
    const resources: Resource[] = [
      { ...required(rooms[0]), id: 'desk', name: 'Platz 1', kind: 'workplace', parentId: 'office', parentName: 'Büro Amrum', capacity: null },
      { ...required(rooms[1]), id: 'meeting', kind: 'meeting_room', capacity: 8 },
      { ...required(rooms[0]), id: 'hall', name: 'Synthetic lecture hall', kind: 'lecture_hall', capacity: 120 },
    ];
    const office = mergeRoomRequest('Ich möchte ein Büro buchen', {});
    expect(classifyIntent('Ich möchte ein Büro buchen', false)).toBe('rooms');
    expect(office.kind).toBe('workplace');
    expect(office.query).toBeUndefined();
    for (const phrase of ['Ich suche einen Büroraum', 'Ich suche nach Arbeitsplätzen', 'Ich brauche zwei Arbeitsplätze']) {
      expect(classifyIntent(phrase, false)).toBe('rooms');
      expect(mergeRoomRequest(phrase, {}).kind).toBe('workplace');
      expect(mergeRoomRequest(phrase, {}).query).toBeUndefined();
    }
    expect(matchingResources(resources, office).map(r => r.id)).toEqual(['desk']);
    expect(matchingResources(resources, { kind: 'workplace', query: 'Amrum' }).map(r => r.id)).toEqual(['desk']);
    expect(matchingResources(resources, { kind: 'workplace', location: 'Amrum' }).map(r => r.id)).toEqual(['desk']);
    expect(matchingResources(resources, { kind: 'meeting_room', location: 'Amrum' })).toEqual([]);
    expect(matchingResources(resources, { kind: 'workplace', capacity: 2 })).toEqual([]);
    expect(matchingResources(resources, { capacity: 4 }).map(r => r.id)).toEqual(['meeting', 'hall']);
    expect(matchingResources(resources, { kind: 'room' }).map(r => r.id)).toEqual(['meeting', 'hall']);
    expect(matchingResources(resources, mergeRoomRequest('Besprechungsraum für 6 Personen', {})).map(r => r.id)).toEqual(['meeting']);
    expect(matchingResources(resources, mergeRoomRequest('Hörsaal für 100 Personen', {})).map(r => r.id)).toEqual(['hall']);
    expect(mergeRoomRequest('lieber ein Büro', { kind: 'meeting_room', capacity: 8 })).toEqual({ kind: 'workplace' });
    expect(mergeRoomRequest('einzelne Arbeitsplätze', { kind: 'workplace', capacity: 2 })).toEqual({ kind: 'workplace' });
    expect(mergeRoomRequest('einen Besprechungsraum', { kind: 'workplace', capacity: 2 })).toMatchObject({ kind: 'meeting_room', capacity: 2 });
    expect(roomRequestSummary(mergeRoomRequest('Ich brauche zwei Arbeitsplätze', {}))).toContain('Jede Buchung reserviert genau einen Arbeitsplatz');
  });
  it("parses explicit office preferences and preserves the rest of a follow-up request", () => {
    const previous: RoomRequest = {
      kind: "workplace",
      location: "Gebäude 1J",
      date: "2026-06-02",
      time: "14:00",
      durationMinutes: 60,
    };

    const single = mergeRoomRequest("Einzelbüro", previous);
    const shared = mergeRoomRequest("geteiltes Büro", previous);
    const sharedAccepted = mergeRoomRequest("Ein geteiltes Büro ist okay.", { ...previous, query: "Grace Hopper" });
    const any = mergeRoomRequest("egal, keine Präferenz", previous);
    const bothAreFine = mergeRoomRequest("Beides ist passend.", { ...previous, query: "Grace Hopper" });
    const bothFit = mergeRoomRequest("Beides passt!", previous);

    expect(single).toMatchObject({ ...previous, kind: "workplace", officeType: "single" });
    expect(single.query).toBeUndefined();
    expect(shared).toMatchObject({ ...previous, kind: "workplace", officeType: "shared" });
    expect(shared.query).toBeUndefined();
    expect(sharedAccepted).toMatchObject({ ...previous, query: "Grace Hopper", kind: "workplace", officeType: "shared" });
    expect(any).toMatchObject({ ...previous, kind: "workplace", officeType: "any" });
    expect(any.query).toBeUndefined();
    expect(bothAreFine).toMatchObject({ ...previous, query: "Grace Hopper", kind: "workplace", officeType: "any" });
    expect(bothFit).toMatchObject({ ...previous, kind: "workplace", officeType: "any" });
    expect(bothFit.query).toBeUndefined();
  });

  it("understands the offered office description without confusing it with requested desk quantity", () => {
    const previous: RoomRequest = { kind: "workplace", date: "2026-10-21", time: "10:00", durationMinutes: 120, location: "1J" };
    const single = mergeRoomRequest("Ein Büro mit einem Arbeitsplatz.", previous);
    expect(single).toEqual({ ...previous, officeType: "single" });
    expect(single.query).toBeUndefined();
    expect(mergeRoomRequest("Einen Platz in einem geteilten Büro.", previous)).toEqual({ ...previous, officeType: "shared" });
    for (const text of ["1 Arbeitsplatz", "Ein Arbeitsplatz", "Kein Büro mit einem Arbeitsplatz"]) {
      expect(mergeRoomRequest(text, previous).officeType).toBeUndefined();
    }
  });

  it("preserves a negated office-preference phrase instead of cleaning it as acceptance", () => {
    const now = new Date("2026-10-22T08:00:00.000Z");
    const request = mergeRoomRequest(
      "Ich suche morgen von 10 bis 16 Uhr einen Arbeitsplatz im Gebäude 1J. Kein Einzelbüro ist okay.",
      {},
      now,
    );

    expect(request).toMatchObject({ kind: "workplace", date: "2026-10-23", time: "10:00", durationMinutes: 360, location: "1J" });
    expect(request.officeType).toBeUndefined();
    expect(request.query).toBe("kein einzelburo ist okay");
    expect(matchingResources(hshDemoCatalog.resources, request)).toEqual([]);
  });

  it("removes a positive office-preference tail from an otherwise complete workplace request", () => {
    const now = new Date("2026-10-22T08:00:00.000Z");
    const request = mergeRoomRequest(
      "Ich suche morgen von 10 bis 16 Uhr einen Arbeitsplatz im Gebäude 1J. Ein geteiltes Büro ist okay.",
      {},
      now,
    );

    expect(request).toMatchObject({
      kind: "workplace",
      officeType: "shared",
      date: "2026-10-23",
      time: "10:00",
      durationMinutes: 360,
      location: "1J",
    });
    expect(request.query).toBeUndefined();
    expect(matchingResources(hshDemoCatalog.resources, request)).toHaveLength(14);

    const quotedAcceptance = mergeRoomRequest(
      'Ich suche morgen von 10 bis 16 Uhr einen Arbeitsplatz im Gebäude 1J. "Ein geteiltes Büro ist okay".',
      {},
      now,
    );
    expect(quotedAcceptance.query).toBe("ein geteiltes buro ist okay");
  });

  it("filters only explicitly named single or shared offices and requests clarification for broad catalogs", () => {
    const workplaces: Resource[] = [
      { ...required(rooms[0]), id: "single", kind: "workplace", name: "Arbeitsplatz 1", parentName: "Einzelbüro 1.01" },
      { ...required(rooms[0]), id: "two", kind: "workplace", name: "Arbeitsplatz 2", parentName: "2er Büro 1.02" },
      { ...required(rooms[0]), id: "three", kind: "workplace", name: "Arbeitsplatz 3", parentName: "3er Büro 1.03" },
      { ...required(rooms[0]), id: "shared", kind: "workplace", name: "Arbeitsplatz 4", parentName: "Shared Office 1.04" },
      { ...required(rooms[0]), id: "unknown", kind: "workplace", name: "Arbeitsplatz 5", parentName: "Büro 1.05" },
      { ...required(rooms[0]), id: "one-desk", kind: "workplace", name: "Einzelarbeitsplatz", parentName: "Büro 1.06" },
    ];
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "single" }).map(({ id }) => id)).toEqual(["single"]);
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "shared" }).map(({ id }) => id)).toEqual(["two", "three", "shared"]);
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "any" })).toEqual(workplaces);
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "single" })).not.toContain(workplaces[5]);

    const many = Array.from({ length: 9 }, (_, index) => ({
      ...required(workplaces[index % workplaces.length]),
      id: `workplace-${String(index)}`,
      parentName: index === 0 ? "1er Büro A" : index === 1 ? "3er Büro B" : `Büro ${String(index)}`,
    }));
    const refinement = workplaceRefinementQuestion(many, { kind: "workplace" });
    expect(refinement).toMatchObject({
      candidateCount: 9,
      counts: { single: 1, shared: 1, unknown: 7 },
    });
    expect(refinement?.question).toContain("Arbeitsplätze");
    expect(refinement?.question).toContain("geteilten Büro");
    expect(workplaceRefinementQuestion(many, { kind: "workplace", officeType: "any" })).toBeNull();
    expect(workplaceRefinementQuestion(many, { kind: "workplace", query: "Amrum" })).toBeNull();
    expect(workplaceRefinementQuestion(hshDemoCatalog.resources, { kind: "workplace", location: "Gebäude 1J" })).toMatchObject({
      candidateCount: 27,
      counts: { single: 7, shared: 14, unknown: 6 },
    });
  });
  it("uses the complete catalog office count as authoritative and leaves standalone desks unknown", () => {
    const workplaces: Resource[] = [
      { ...required(rooms[0]), id: "count-one", kind: "workplace", name: "Arbeitsplatz", parentName: "2er Büro", officeWorkplaceCount: 1 },
      { ...required(rooms[0]), id: "count-many", kind: "workplace", name: "Arbeitsplatz", parentName: "Einzelbüro", officeWorkplaceCount: 2 },
      { ...required(rooms[0]), id: "standalone", kind: "workplace", name: "Einzelarbeitsplatz", parentName: null, officeWorkplaceCount: null },
    ];
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "single" }).map(({ id }) => id)).toEqual(["count-one"]);
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "shared" }).map(({ id }) => id)).toEqual(["count-many"]);
    expect(matchingResources(workplaces, { kind: "workplace", officeType: "any" })).toEqual(workplaces);

    const fixtureWorkplaces = hshDemoCatalog.resources.filter((resource) => resource.kind === "workplace");
    expect(workplaceOfficeTypeCounts(fixtureWorkplaces)).toEqual({ single: 8, shared: 23, unknown: 6 });
  });
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

  it("parses a coming weekday in the Berlin calendar and keeps ambiguity fail-safe", () => {
    const now = new Date("2026-10-17T09:30:00.000Z");
    const request = mergeRoomRequest(
      "Ich brauche am kommenden Montag ein Büro im Gebäude 1J von 8-16 Uhr",
      {},
      now,
    );

    expect(request).toMatchObject({
      kind: "workplace",
      location: "1J",
      date: "2026-10-19",
      time: "08:00",
      durationMinutes: 480,
    });
    expect(request.query).toBeUndefined();
    expect(mergeRoomRequest("am Montag oder Dienstag", {}, now).date).toBe("__invalid__");
    expect(mergeRoomRequest("nicht am kommenden Montag", {}, now).date).toBe("__invalid__");
    expect(mergeRoomRequest("am vergangenen Montag", {}, now).date).toBe("__invalid__");
    const monday = new Date("2026-10-19T09:00:00.000Z");
    expect(mergeRoomRequest("am Montag", {}, monday).date).toBe("__invalid__");
    expect(mergeRoomRequest("am kommenden Montag", {}, monday).date).toBe("2026-10-26");
    expect(mergeRoomRequest("im Gebäude 1J.1.02", {}, now).location).toBe("1J.1.02");
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

  it("normalizes building wording and searches workplace location metadata without dropping other filters", () => {
    const workplaces = hshDemoCatalog.resources;
    const buildingQuery = { kind: "workplace" as const, query: "Büro im Gebäude 1J" };

    expect(matchingResources(workplaces, { kind: "workplace", location: "Gebäude 1J" })).toHaveLength(27);
    expect(matchingResources(workplaces, { kind: "workplace", location: "Geb. 1J" })).toHaveLength(27);
    expect(matchingResources(workplaces, { kind: "workplace", location: "Building 1J" })).toHaveLength(27);
    expect(matchingResources(workplaces, { kind: "workplace", location: "Gebäude 1" })).toEqual([]);
    expect(matchingResources([{ ...required(rooms[0]), kind: "workplace", name: "Desk", location: "11J", parentName: "Office 11J.1.03" }], { kind: "workplace", location: "Gebäude 1J" })).toEqual([]);
    expect(matchingResources(workplaces, buildingQuery)).toHaveLength(27);
    expect(matchingResources(workplaces, { kind: "workplace", query: "Schreibtischarbeitsplatz im Gebäude 1J" })).toHaveLength(27);
    expect(matchingResources(workplaces, { kind: "workplace", query: "J1" })).toHaveLength(17);

    expect(matchingResources(workplaces, { kind: "workplace", query: "Büro Gebäude 99Z" })).toEqual([]);
    expect(matchingResources(workplaces, { ...buildingQuery, location: "Gebäude 1K" })).toEqual([]);
    expect(matchingResources(workplaces, { ...buildingQuery, location: "Expo Plaza" })).toEqual([]);
    expect(matchingResources(workplaces, { ...buildingQuery, features: ["Whiteboard"] })).toEqual([]);
    expect(matchingResources(workplaces, { ...buildingQuery, features: ["Kinderspielzeug"] })).toHaveLength(1);
  });

  it("classifies focused intents and sends unrelated follow-ups to help", () => {
    expect(classifyIntent("Raum suchen", false)).toBe("rooms");
    expect(classifyIntent("Zeig mir Räume", false)).toBe("rooms");
    expect(classifyIntent("Ich möchte einen Raum buchen", false)).toBe("rooms");
    expect(classifyIntent("meine Buchungen anzeigen", false)).toBe("bookings");
    expect(classifyIntent("Wie richte ich eduroam ein?", false)).toBe("knowledge");
    expect(classifyIntent("Guten Morgen", false)).toBe("greeting");
    expect(classifyIntent("Hallo HASI!", false)).toBe("greeting");
    expect(classifyIntent("morgen um 14 Uhr", true)).toBe("rooms");
    expect(classifyIntent("mit Beamer", true)).toBe("rooms");
    expect(classifyIntent("Erkläre mir das Intranet", true)).toBe("knowledge");
    expect(classifyIntent("Kannst du meine Steuererklärung ausfüllen?", true)).toBe("help");
  });
});
