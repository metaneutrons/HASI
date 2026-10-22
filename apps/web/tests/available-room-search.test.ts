import { describe, expect, it } from "vitest";
import {
  availableRoomOptions,
  availableRoomSearchText,
  checkAvailableRooms,
  MAX_AVAILABILITY_CANDIDATES,
} from "../src/lib/available-room-search";
import type { ChatRoomOption } from "../src/lib/chat-sessions";
import type { Resource, TimeInterval } from "../src/lib/types";

const START = "2026-11-03T09:00:00.000Z";
const END = "2026-11-03T10:00:00.000Z";
const EXACT_SLOT: TimeInterval = { startDate: START, endDate: END, available: true };

function resource(index = 0): Resource {
  return {
    id: `office-${String(index)}`,
    name: `Office ${String(index)}`,
    description: "Synthetic office",
    capacity: 1,
    location: "1J",
    features: [],
    serviceId: "anny",
    kind: "workplace",
  };
}

function room(overrides: Partial<ChatRoomOption> = {}): ChatRoomOption {
  return {
    resource: resource(),
    requestedStartDate: START,
    requestedEndDate: END,
    intervals: [EXACT_SLOT],
    checked: true,
    ...overrides,
  };
}

describe("availableRoomOptions", () => {
  it("keeps only checked rooms with an available interval matching both requested endpoints", () => {
    const longer = { ...EXACT_SLOT, endDate: "2026-11-03T10:30:00.000Z" };
    const shorter = { ...EXACT_SLOT, endDate: "2026-11-03T09:30:00.000Z" };
    const alternate = { ...EXACT_SLOT, startDate: "2026-11-03T11:00:00.000Z", endDate: "2026-11-03T12:00:00.000Z" };
    const results = availableRoomOptions([
      room({ resource: resource(0) }),
      room({ resource: resource(1), checked: false }),
      room({ resource: resource(2), intervals: [{ ...EXACT_SLOT, available: false }] }),
      room({ resource: resource(3), intervals: [alternate] }),
      room({ resource: resource(4), intervals: [shorter] }),
      room({ resource: resource(5), intervals: [longer] }),
    ]);

    expect(results.map(item => item.resource.id)).toEqual(["office-0"]);
    expect(results[0]?.intervals).toEqual([EXACT_SLOT]);
  });

  it("excludes rooms whose requested endpoints are missing", () => {
    const missingStart = room();
    delete missingStart.requestedStartDate;
    const missingEnd = room();
    delete missingEnd.requestedEndDate;

    expect(availableRoomOptions([missingStart, missingEnd])).toEqual([]);
  });

  const malformedCases: { label: string; overrides: Partial<ChatRoomOption> }[] = [
    { label: "an invalid requested start", overrides: { requestedStartDate: "unknown" } },
    { label: "an invalid requested end", overrides: { requestedEndDate: "unknown" } },
    { label: "a reversed requested interval", overrides: { requestedEndDate: "2026-11-03T08:00:00.000Z" } },
    { label: "an empty interval list", overrides: { intervals: [] } },
  ];
  it.each(malformedCases)("excludes a room with $label", ({ overrides }) => {
    expect(availableRoomOptions([room(overrides)])).toEqual([]);
  });

  it("selects an available exact interval even when an unavailable duplicate comes first", () => {
    const unavailable = { ...EXACT_SLOT, available: false };
    expect(availableRoomOptions([room({ intervals: [unavailable, EXACT_SLOT] })])[0]?.intervals).toEqual([EXACT_SLOT]);
  });
});

describe("checkAvailableRooms", () => {
  it("checks at most eight resources in batches of three and retains candidate order", async () => {
    const resources = Array.from({ length: MAX_AVAILABILITY_CANDIDATES + 2 }, (_, index) => resource(index));
    const checkedIds: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const results = await checkAvailableRooms(resources, { startDate: START, endDate: END }, async item => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      checkedIds.push(item.id);
      await Promise.resolve();
      active -= 1;
      return [EXACT_SLOT];
    });

    const expectedIds = resources.slice(0, MAX_AVAILABILITY_CANDIDATES).map(item => item.id);
    expect(checkedIds).toEqual(expectedIds);
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(results.map(item => item.resource.id)).toEqual(expectedIds);
    expect(results.every(item => item.checked && item.intervals.length === 1)).toBe(true);
  });

  it("propagates a failed availability read instead of reporting no vacancy", async () => {
    await expect(checkAvailableRooms([resource()], { startDate: START, endDate: END }, () =>
      Promise.reject(new Error("availability service unavailable")))).rejects.toThrow("availability service unavailable");
  });
});

describe("availableRoomSearchText", () => {
  it("limits truncated-result claims to the checked catalog candidates and suggests narrowing the search", () => {
    const text = availableRoomSearchText(0, true, MAX_AVAILABILITY_CANDIDATES);

    expect(text).toContain("Unter den geprüften Räumen ist im gewünschten Zeitraum kein passender Platz frei.");
    expect(text).toContain("Geprüft wurden die ersten 8 passenden Katalogtreffer.");
    expect(text).toContain("Bürotyp oder Büronamen weiter ein");
    expect(text).not.toContain("Alle Räume");
  });
});
