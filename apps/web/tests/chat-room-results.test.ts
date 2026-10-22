import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatRoomResults } from "../src/components/chat-room-results";
import type { ChatRoomOption } from "../src/lib/chat-sessions";

const startDate = "2030-01-03T08:00:00Z";
const endDate = "2030-01-03T14:00:00Z";
function room(name: string, overrides: Partial<ChatRoomOption> = {}): ChatRoomOption {
  return { resource: { id: name, name, description: "", capacity: 1, kind: "workplace", location: "1J", serviceId: "desks", features: [] },
    checked: true, requestedStartDate: startDate, requestedEndDate: endDate,
    intervals: [{ startDate, endDate, available: true }], ...overrides };
}
const render = (rooms: ChatRoomOption[]) => renderToStaticMarkup(createElement(ChatRoomResults, {
  rooms, disabled: false, onChooseRoom: vi.fn(), onChooseSlot: vi.fn(), onRecheck: vi.fn(),
}));

describe("available room result presentation", () => {
  it("renders only exact verified vacancies, even when mixed with legacy or busy results", () => {
    const html = render([
      room("FreeDesk"), room("UncheckedDesk", { checked: false }), room("BusyDesk", { intervals: [] }),
      room("AlternativeDesk", { intervals: [{ startDate: "2030-01-03T09:00:00Z", endDate: "2030-01-03T15:00:00Z", available: true }] }),
      room("FalseDesk", { intervals: [{ startDate, endDate, available: false }] }),
    ]);
    expect(html).toContain("FreeDesk");
    for (const hidden of ["UncheckedDesk", "BusyDesk", "AlternativeDesk", "FalseDesk", "ungeprüft", "Andere freie Zeiten"]) expect(html).not.toContain(hidden);
    expect(html).toContain("Im gewünschten Zeitraum verfügbar");
  });

  it("replaces reloaded unverified cards with one recheck control", () => {
    const html = render([room("OldDeskA", { checked: false, intervals: [] }), room("OldDeskB", { checked: false, intervals: [] })]);
    expect(html.match(/Verfügbarkeit erneut prüfen/gu)).toHaveLength(1);
    expect(html).not.toContain("OldDesk");
    expect(html).not.toContain("chat-room-result__heading");
  });

  it("does not render cards or a recheck action for checked occupied rooms", () => {
    expect(render([room("BusyDesk", { intervals: [] })])).toBe("");
  });
  it("asks for a new search when historical candidates have no saved time window", () => {
    const legacy = room("OldDesk", { checked: false, intervals: [] });
    delete legacy.requestedEndDate;
    const html = render([legacy]);
    expect(html).toContain("Starte eine neue Suche mit Datum, Uhrzeit und Dauer.");
    expect(html).not.toContain("Verfügbarkeit erneut prüfen");
    expect(html).not.toContain("OldDesk");
  });

  it("counts and paginates available results rather than hidden catalog candidates", () => {
    const html = render([room("BusyDesk", { intervals: [] }), ...Array.from({ length: 5 }, (_, i) => room(`Free${String(i)}`))]);
    expect(html).toContain("Weitere 1 anzeigen");
    expect(html).not.toContain("Weitere 2 anzeigen");
    expect(html).not.toContain("Free4");
  });
});
