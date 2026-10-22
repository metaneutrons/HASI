import type { ChatRoomOption } from "./chat-sessions";
import type { Resource, TimeInterval } from "./types";

export const MAX_AVAILABILITY_CANDIDATES = 8;
const AVAILABILITY_CONCURRENCY = 3;

/** Only a verified, complete match belongs in a time-bound result list. */
export function availableRoomOptions(rooms: readonly ChatRoomOption[]): ChatRoomOption[] {
  return rooms.flatMap(room => {
    if (!room.checked || !room.requestedStartDate || !room.requestedEndDate) return [];
    const start = Date.parse(room.requestedStartDate);
    const end = Date.parse(room.requestedEndDate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const exact = room.intervals.find(slot => slot.available
      && Date.parse(slot.startDate) === start && Date.parse(slot.endDate) === end);
    return exact ? [{ ...room, intervals: [exact] }] : [];
  });
}

/** Native reads only; failures reject the search, never imply no vacancies. */
export async function checkAvailableRooms(
  resources: readonly Resource[],
  interval: { startDate: string; endDate: string },
  check: (resource: Resource) => Promise<TimeInterval[]>,
): Promise<ChatRoomOption[]> {
  const candidates = resources.slice(0, MAX_AVAILABILITY_CANDIDATES);
  const checked: ChatRoomOption[] = [];
  for (let offset = 0; offset < candidates.length; offset += AVAILABILITY_CONCURRENCY) {
    const batch = await Promise.all(candidates.slice(offset, offset + AVAILABILITY_CONCURRENCY).map(async resource => ({
      resource, requestedStartDate: interval.startDate, requestedEndDate: interval.endDate,
      checked: true, intervals: await check(resource),
    })));
    checked.push(...batch);
  }
  return availableRoomOptions(checked);
}

export function availableRoomSearchText(count: number, truncated = false, checkedCount = MAX_AVAILABILITY_CANDIDATES): string {
  const result = count
    ? `Im gewünschten Zeitraum ${count === 1 ? "ist ein passender Platz frei" : `sind ${String(count)} passende Plätze frei`}. Wähle eine Zeit, um die Buchung vorzubereiten.`
    : "Unter den geprüften Räumen ist im gewünschten Zeitraum kein passender Platz frei.";
  return truncated
    ? `${result} Geprüft wurden die ersten ${String(checkedCount)} passenden Katalogtreffer. Grenze die Suche mit einem Bürotyp oder Büronamen weiter ein.`
    : result;
}
