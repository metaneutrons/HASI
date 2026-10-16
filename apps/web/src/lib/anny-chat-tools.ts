import { chatToolSchemas, type ChatToolName } from "./chat-contract";
import { matchingResources, requestStartDate, type RoomRequest } from "./chat-demo";
import type { Booking, Resource, TimeInterval } from "./types";

const ANNY_TOOL_NAMES = [
  "anny_search_resources",
  "anny_get_availability",
  "anny_list_my_bookings",
  "anny_propose_booking",
] as const satisfies readonly ChatToolName[];

type AnnyChatToolName = (typeof ANNY_TOOL_NAMES)[number];
type AnnyRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
type AnnyChatToolOptions = { now?: () => Date };
type RoomCard = { resource: Resource; intervals: TimeInterval[]; checked: boolean };

export type ChatProposal = {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "confirmed" | "outcome_unknown" | "failed";
  expiresAt: string;
};

/** Recheck a restored UI slot without persisting the bridge's availability cache. */
export function availabilityInputForSlot(resourceId: string, interval: TimeInterval) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(interval.startDate));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return chatToolSchemas.anny_get_availability.parse({ resourceId, date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}`, durationMinutes: (Date.parse(interval.endDate) - Date.parse(interval.startDate)) / 60_000 });
}

type AnnyChatToolResultBase = {
  output: Record<string, unknown>;
  rooms?: RoomCard[];
  bookings?: Booking[];
  proposal?: ChatProposal;
};

export type AnnyChatToolResult =
  | (AnnyChatToolResultBase & { name: "anny_search_resources" })
  | (AnnyChatToolResultBase & { name: "anny_get_availability" })
  | (AnnyChatToolResultBase & { name: "anny_list_my_bookings" })
  | (AnnyChatToolResultBase & { name: "anny_propose_booking" });

const MAX_MODEL_OUTPUT_CHARS = 8_000;
const MAX_RESOURCES = 8;
const MAX_INTERVALS = 8;
const MAX_BOOKINGS = 10;
const ANNY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const OFFSET_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

type CachedSlot = { startDate: string; endDate: string; serviceId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnnyId(value: unknown): value is string {
  return typeof value === "string" && ANNY_ID_PATTERN.test(value);
}

function isOffsetDateTime(value: unknown): value is string {
  return typeof value === "string"
    && OFFSET_DATE_TIME_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function intervalCacheKey(startDate: string, endDate: string): string | null {
  if (!isOffsetDateTime(startDate) || !isOffsetDateTime(endDate)) return null;
  return `${Date.parse(startDate)}\u0000${Date.parse(endDate)}`;
}

function isResource(value: unknown): value is Resource {
  return isRecord(value)
    && isAnnyId(value.id)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && (value.capacity === null || Number.isInteger(value.capacity) && Number(value.capacity) > 0)
    && typeof value.location === "string"
    && Array.isArray(value.features)
    && value.features.every((feature) => typeof feature === "string")
    && isAnnyId(value.serviceId);
}

function isTimeInterval(value: unknown): value is TimeInterval {
  return isRecord(value)
    && isOffsetDateTime(value.startDate)
    && isOffsetDateTime(value.endDate)
    && Date.parse(value.endDate) > Date.parse(value.startDate)
    && typeof value.available === "boolean";
}

function publicInterval(interval: TimeInterval): TimeInterval {
  return {
    startDate: interval.startDate,
    endDate: interval.endDate,
    available: interval.available,
  };
}

function isBooking(value: unknown): value is Booking {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.resourceName === "string"
    && isOffsetDateTime(value.startDate)
    && isOffsetDateTime(value.endDate)
    && Date.parse(value.endDate) > Date.parse(value.startDate)
    && typeof value.status === "string";
}

function cleanText(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

function toRoomCardResource(resource: Resource): Resource {
  return {
    id: resource.id,
    name: cleanText(resource.name, 160),
    description: cleanText(resource.description, 320),
    capacity: resource.capacity,
    location: cleanText(resource.location, 140),
    features: resource.features.slice(0, 12).map((feature) => cleanText(feature, 48)),
    serviceId: resource.serviceId,
  };
}

function toModelResource(resource: Resource): Record<string, unknown> {
  return {
    id: resource.id,
    name: cleanText(resource.name, 80),
    description: cleanText(resource.description, 80),
    capacity: resource.capacity,
    location: cleanText(resource.location, 60),
    features: resource.features.slice(0, 6).map((feature) => cleanText(feature, 20)),
  };
}

function boundedOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(output).length > MAX_MODEL_OUTPUT_CHARS) {
    throw new Error("Das Ergebnis überschreitet die zulässige Größe.");
  }
  return output;
}

function isAnnyToolName(name: string): name is AnnyChatToolName {
  return (ANNY_TOOL_NAMES as readonly string[]).includes(name);
}

function schemaInput(name: AnnyChatToolName, input: unknown): Record<string, unknown> {
  const result = chatToolSchemas[name].safeParse(input);
  if (!result.success || !isRecord(result.data)) {
    throw new Error("Die Argumente passen nicht zum freigegebenen Anny-Werkzeug.");
  }
  return result.data;
}

function postJson<T>(request: AnnyRequest, path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function modelBooking(booking: Booking): Record<string, unknown> {
  return {
    id: cleanText(booking.id, 100),
    resourceName: cleanText(booking.resourceName, 100),
    startDate: booking.startDate,
    endDate: booking.endDate,
    status: cleanText(booking.status, 40),
  };
}

function parseProposal(value: unknown): ChatProposal {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.resourceName !== "string"
    || !isOffsetDateTime(value.startDate)
    || !isOffsetDateTime(value.endDate)
    || !isOffsetDateTime(value.expiresAt)
    || value.status !== "pending") {
    throw new Error("Der Buchungsvorschlag wurde nicht als ausstehend zurückgegeben.");
  }
  return {
    id: cleanText(value.id, 160),
    resourceName: cleanText(value.resourceName, 160),
    startDate: value.startDate,
    endDate: value.endDate,
    status: "pending",
    expiresAt: value.expiresAt,
  };
}

export function createAnnyChatTools(request: AnnyRequest, options: AnnyChatToolOptions = {}) {
  const now = options.now ?? (() => new Date());
  const cachedSlots = new Map<string, Map<string, CachedSlot>>();

  async function loadAllowedResources(): Promise<Resource[]> {
    const response = await request<{ resources: unknown }>("/api/resources");
    if (!isRecord(response) || !Array.isArray(response.resources) || !response.resources.every(isResource)) {
      throw new Error("Die Ressourcenliste ist ungültig.");
    }
    return response.resources;
  }

  function requireAllowedResource(resources: Resource[], resourceId: string): Resource {
    const resource = resources.find((candidate) => candidate.id === resourceId);
    if (!resource) {
      cachedSlots.delete(resourceId);
      throw new Error("Dieser Raum ist in den aktuell zugänglichen Ressourcen nicht enthalten.");
    }
    return resource;
  }

  async function searchResources(input: Record<string, unknown>): Promise<AnnyChatToolResult> {
    const requestFilters: RoomRequest = {
      capacity: input.capacity as number | undefined,
      features: input.features as string[] | undefined,
      location: input.location as string | undefined,
      query: input.query as string | undefined,
    };
    const resources = await loadAllowedResources();
    const matches = matchingResources(resources, requestFilters);
    const shown = matches.slice(0, MAX_RESOURCES).map(toRoomCardResource);
    const modelResources = shown.map(toModelResource);
    const total = matches.length;

    while (modelResources.length > 0) {
      const output = {
        resources: modelResources,
        returned: modelResources.length,
        truncated: Math.max(0, total - modelResources.length),
      };
      if (JSON.stringify(output).length <= MAX_MODEL_OUTPUT_CHARS) {
        return {
          name: "anny_search_resources",
          output: boundedOutput(output),
          rooms: shown.slice(0, modelResources.length).map((resource) => ({ resource, intervals: [], checked: false })),
        };
      }
      modelResources.pop();
      shown.pop();
    }

    const output = boundedOutput({ resources: [], returned: 0, truncated: total });
    return { name: "anny_search_resources", output, rooms: [] };
  }

  async function getAvailability(input: Record<string, unknown>): Promise<AnnyChatToolResult> {
    const resourceId = input.resourceId as string;
    const date = input.date as string;
    const time = input.time as string;
    const durationMinutes = input.durationMinutes as number;
    const startDate = requestStartDate({ date, time, durationMinutes });
    if (!startDate) throw new Error("Datum und Uhrzeit ergeben in der Zeitzone Europe/Berlin keinen eindeutigen Zeitpunkt.");
    if (Date.parse(startDate) <= now().getTime()) throw new Error("Der angefragte Beginn liegt in der Vergangenheit.");

    const resources = await loadAllowedResources();
    const resource = requireAllowedResource(resources, resourceId);
    cachedSlots.delete(resourceId);

    const response = await postJson<{ intervals: unknown }>(request, "/api/availability", {
      resourceId: resource.id,
      serviceId: resource.serviceId,
      startDate,
      durationMinutes,
    });
    if (!isRecord(response) || !Array.isArray(response.intervals) || !response.intervals.every(isTimeInterval)) {
      throw new Error("Die Verfügbarkeitsantwort ist ungültig.");
    }

    const futureIntervals = response.intervals
      .filter((interval) => Date.parse(interval.startDate) > now().getTime()
        && (Date.parse(interval.endDate) - Date.parse(interval.startDate)) / 60_000 === durationMinutes)
      .map(publicInterval);
    const intervals = futureIntervals.slice(0, MAX_INTERVALS);
    const slotCache = new Map<string, CachedSlot>();
    for (const interval of intervals) {
      const key = intervalCacheKey(interval.startDate, interval.endDate);
      if (interval.available && key !== null) {
        slotCache.set(key, {
          startDate: interval.startDate,
          endDate: interval.endDate,
          serviceId: resource.serviceId,
        });
      }
    }
    cachedSlots.set(resource.id, slotCache);

    const output = boundedOutput({
      resource: { id: resource.id, name: cleanText(resource.name, 120) },
      requestedStartDate: startDate,
      durationMinutes,
      intervals,
      returned: intervals.length,
      truncated: Math.max(0, futureIntervals.length - intervals.length),
    });
    return {
      name: "anny_get_availability",
      output,
      rooms: [{ resource: toRoomCardResource(resource), intervals: intervals.filter(({ available }) => available), checked: true }],
    };
  }

  async function listMyBookings(): Promise<AnnyChatToolResult> {
    const response = await request<{ bookings: unknown }>("/api/bookings");
    if (!isRecord(response) || !Array.isArray(response.bookings) || !response.bookings.every(isBooking)) {
      throw new Error("Die Buchungsliste ist ungültig.");
    }
    const bookings = response.bookings.slice(0, MAX_BOOKINGS);
    const output = boundedOutput({
      bookings: bookings.map(modelBooking),
      returned: bookings.length,
      truncated: Math.max(0, response.bookings.length - bookings.length),
    });
    return {
      name: "anny_list_my_bookings",
      output,
      bookings: bookings.map((booking) => ({
        id: cleanText(booking.id, 160),
        resourceName: cleanText(booking.resourceName, 160),
        startDate: booking.startDate,
        endDate: booking.endDate,
        status: cleanText(booking.status, 60),
      })),
    };
  }

  async function proposeBooking(input: Record<string, unknown>): Promise<AnnyChatToolResult> {
    const resourceId = input.resourceId as string;
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
    const durationMinutes = (Date.parse(endDate) - Date.parse(startDate)) / 60_000;
    if (!isOffsetDateTime(startDate)
      || !isOffsetDateTime(endDate)
      || !Number.isInteger(durationMinutes)
      || durationMinutes < 15
      || durationMinutes > 1440
      || Date.parse(startDate) <= now().getTime()) {
      throw new Error("Der Zeitraum muss gültig, zukünftig und 15 Minuten bis 24 Stunden lang sein.");
    }

    const resources = await loadAllowedResources();
    const resource = requireAllowedResource(resources, resourceId);
    const cache = cachedSlots.get(resource.id);
    const key = intervalCacheKey(startDate, endDate);
    const slot = key === null ? undefined : cache?.get(key);
    if (!slot || slot.serviceId !== resource.serviceId) {
      throw new Error("Der Zeitraum wurde für diesen Raum nicht als verfügbar geprüft. Bitte prüfe die Verfügbarkeit erneut.");
    }

    try {
      const response = await postJson<{ proposal: unknown }>(request, "/api/proposals", {
        resourceId: resource.id,
        serviceId: resource.serviceId,
        startDate: slot.startDate,
        endDate: slot.endDate,
      });
      if (!isRecord(response)) throw new Error("Die Vorschlagsantwort ist ungültig.");
      const proposal = parseProposal(response.proposal);
      const output = boundedOutput({ proposal });
      return { name: "anny_propose_booking", output, proposal };
    } finally {
      cachedSlots.clear();
    }
  }

  async function run(name: string, args: unknown): Promise<AnnyChatToolResult> {
    if (!isAnnyToolName(name)) throw new Error("Dieses Anny-Werkzeug ist nicht freigegeben.");
    const input = schemaInput(name, args);
    switch (name) {
      case "anny_search_resources":
        return searchResources(input);
      case "anny_get_availability":
        return getAvailability(input);
      case "anny_list_my_bookings":
        return listMyBookings();
      case "anny_propose_booking":
        return proposeBooking(input);
    }
  }

  return {
    run,
    reset() {
      cachedSlots.clear();
    },
  };
}
