import { describe, expect, it } from "vitest";
import { mergeRoomRequest } from "../src/lib/chat-demo";
import { planRoomDialogue } from "../src/lib/room-dialogue";
import type { Resource } from "../src/lib/types";

function resource(
  id: string,
  kind: Resource["kind"] = "meeting_room",
  name = id,
  officeWorkplaceCount?: number,
): Resource {
  return {
    id,
    kind,
    name,
    description: "",
    capacity: 12,
    location: "1J",
    features: [],
    serviceId: "rooms",
    ...(officeWorkplaceCount === undefined ? {} : { officeWorkplaceCount }),
  };
}

describe("planRoomDialogue", () => {
  it("honors an explicit neutral choice between single and shared offices in the original request", () => {
    const request = mergeRoomRequest("Ich brauche morgen im Gebäude 1J ein Büro von 10 bis 16 Uhr, Einzelbüro oder geteiltes Büro ist mir egal.", {}, new Date("2026-10-20T08:00:00Z"));
    expect(request.officeType).toBe("any");
    expect(request.query).toBeUndefined();
    const plan = planRoomDialogue(request, [resource("single", "workplace", "Desk A", 1), resource("shared", "workplace", "Desk B", 2)]);
    expect(plan.needsAvailability).toBe(true);
    expect(plan.resources.map(item => item.id)).toEqual(["single", "shared"]);
  });
  it("plans the complete workplace search after the standalone ‘both are suitable’ refinement", () => {
    const now = new Date("2026-10-20T08:00:00Z");
    const initial = mergeRoomRequest(
      "Ich brauche morgen einen Arbeitsplatz in 1J von 10 bis 16 Uhr.",
      {},
      now,
    );
    const refined = mergeRoomRequest("Beides ist passend.", initial, now);

    expect(initial).toMatchObject({
      kind: "workplace",
      date: "2026-10-21",
      time: "10:00",
      durationMinutes: 360,
      location: "1J",
    });
    expect(initial.query).toBeUndefined();
    expect(refined).toMatchObject({ ...initial, officeType: "any" });
    expect(refined.query).toBeUndefined();

    const plan = planRoomDialogue(refined, [
      resource("single", "workplace", "Desk A", 1),
      resource("shared", "workplace", "Desk B", 2),
    ]);
    expect(plan.needsAvailability).toBe(true);
    expect(plan.resources.map(item => item.id)).toEqual(["single", "shared"]);
  });
  it("answers group and invalid questions before consulting the catalog", () => {
    const group = planRoomDialogue(
      { kind: "workplace", capacity: 3 },
      [],
    );
    expect(group).toMatchObject({
      code: "room_group",
      catalogDependent: false,
      resources: [],
      total: 0,
    });

    const invalid = planRoomDialogue(
      { kind: "meeting_room", date: "__invalid__", time: "14:00", durationMinutes: 60 },
      [resource("room")],
    );
    expect(invalid).toMatchObject({
      code: "room_invalid",
      catalogDependent: false,
      resources: [],
    });
    expect(invalid.text).toContain("Datum");
  });

  it("asks for workplace refinement when an unselected search has many matches", () => {
    const catalog = Array.from({ length: 9 }, (_, index) =>
      resource(`desk-${String(index)}`, "workplace", `Arbeitsplatz ${String(index)}`, 2),
    );

    const plan = planRoomDialogue({ kind: "workplace" }, catalog);

    expect(plan).toMatchObject({
      code: "room_refine",
      total: 9,
      resources: [],
      needsAvailability: false,
      catalogDependent: true,
    });
    expect(plan.text).toContain("Möchtest du");
  });

  it("asks for missing fields without presenting unchecked catalog candidates", () => {
    const catalog = Array.from({ length: 10 }, (_, index) =>
      resource(`room-${String(index)}`),
    );

    const plan = planRoomDialogue({ kind: "meeting_room" }, catalog);

    expect(plan.code).toBe("room_details");
    expect(plan.resources).toEqual([]);
    expect(plan.total).toBe(10);
    expect(plan.text).toContain("Datum (heute, morgen oder TT.MM.JJJJ)");
    expect(plan.text).toContain("Uhrzeit (z. B. 14:30)");
    expect(plan.text).toContain("Dauer (15 Minuten bis 24 Stunden)");
  });

  it("does not substitute a different resource when the selected ID is inaccessible", () => {
    const catalog = [resource("authorized-room")];

    const plan = planRoomDialogue(
      { kind: "meeting_room" },
      catalog,
      "outside-catalog-room",
    );

    expect(plan).toMatchObject({
      code: "room_empty",
      resources: [],
      total: 0,
      needsAvailability: false,
      catalogDependent: true,
    });
    expect(plan.text).not.toContain("authorized-room");
  });

  it("explains unknown office records without making an availability claim", () => {
    const catalog = [
      resource("desk-1", "workplace", "Arbeitsplatz", 0),
      resource("desk-2", "workplace", "Arbeitsplatz", 0),
    ];

    const plan = planRoomDialogue(
      { kind: "workplace", officeType: "single" },
      catalog,
    );

    expect(plan).toMatchObject({
      code: "room_unknown_office",
      resources: [],
      total: 0,
      catalogDependent: true,
    });
    expect(plan.text).toContain("2 passenden Arbeitsplätzen");
    expect(plan.text).not.toContain("Verfügbarkeit");
  });

  it("hands complete searches off for availability without claiming a result", () => {
    const room = resource("room");
    const plan = planRoomDialogue(
      {
        kind: "meeting_room",
        date: "2026-10-21",
        time: "14:00",
        durationMinutes: 60,
      },
      [room],
    );

    expect(plan).toEqual({
      code: null,
      text: "",
      resources: [room],
      total: 1,
      needsAvailability: true,
      catalogDependent: true,
    });
  });
});
