import type { Booking, Persona, Plugin, PluginTool, Resource, Role, TimeInterval } from "@/lib/types";

export const PUBLIC_DEMO_STORAGE_KEY = "hasi:public-browser-demo:v1";
const STORAGE_VERSION = 1;
const MAX_STORAGE_CHARS = 128_000;
const MAX_BOOKINGS_PER_PERSONA = 50;
const MAX_PROPOSALS = 40;
const PROPOSAL_LIFETIME_MS = 5 * 60_000;
const MAX_BOOKING_DAYS_AHEAD = 365;

const ROLES: readonly Role[] = ["student", "employee", "admin"];
const RESOURCE_IDS = {
  seminarRoom: "00000000-0000-4000-8000-000000000101",
  projectRoom: "00000000-0000-4000-8000-000000000102",
  mediaStudio: "00000000-0000-4000-8000-000000000103",
  computerLab: "00000000-0000-4000-8000-000000000104",
} as const;
const SERVICE_IDS = {
  studentRooms: "00000000-0000-4000-8000-000000000201",
  staffStudio: "00000000-0000-4000-8000-000000000202",
  computerLab: "00000000-0000-4000-8000-000000000203",
} as const;
const PLUGIN_ID = "de.hsh.hasi.anny";
const PLUGIN_VERSION = "0.1.0";

const PERSONAS: Persona[] = [
  { id: "student", displayName: "Lea · Studentin", role: "student" },
  { id: "employee", displayName: "Alex · Beschäftigter", role: "employee" },
  { id: "admin", displayName: "Fabian · Administration", role: "admin" },
];
const PERSONAS_BY_ROLE = new Map(PERSONAS.map((persona) => [persona.role, persona]));

const RESOURCE_ACCESS: Record<Role, readonly string[]> = {
  student: [RESOURCE_IDS.seminarRoom, RESOURCE_IDS.projectRoom],
  employee: Object.values(RESOURCE_IDS),
  admin: Object.values(RESOURCE_IDS),
};

const RESOURCES: Resource[] = [
  {
    id: RESOURCE_IDS.seminarRoom,
    name: "Seminarraum 101",
    description: "Heller Seminarraum für gemeinsame Projekte und Workshops.",
    capacity: 12,
    location: "Campus Linden · Gebäude 1",
    features: ["Display", "Whiteboard"],
    serviceId: SERVICE_IDS.studentRooms,
  },
  {
    id: RESOURCE_IDS.projectRoom,
    name: "Projektraum 202",
    description: "Ruhiger Projektraum für Gruppenarbeit und Besprechungen.",
    capacity: 6,
    location: "Campus Linden · Gebäude 2",
    features: ["Videokonferenz", "Whiteboard"],
    serviceId: SERVICE_IDS.studentRooms,
  },
  {
    id: RESOURCE_IDS.mediaStudio,
    name: "Medienstudio",
    description: "Studio für Audioaufnahmen und kleinere Produktionen.",
    capacity: 4,
    location: "Campus Expo Plaza · Studio",
    features: ["Audio", "Produktion"],
    serviceId: SERVICE_IDS.staffStudio,
  },
  {
    id: RESOURCE_IDS.computerLab,
    name: "Computerraum 3",
    description: "Computerraum mit Arbeitsplätzen für Lehrveranstaltungen.",
    capacity: 24,
    location: "Campus Linden · Lab",
    features: ["Arbeitsplätze", "Display"],
    serviceId: SERVICE_IDS.computerLab,
  },
];
const RESOURCE_BY_ID = new Map(RESOURCES.map((resource) => [resource.id, resource]));

const PLUGIN_TOOLS: PluginTool[] = [
  { name: "anny.search_resources", title: "Räume suchen", effect: "read" },
  { name: "anny.get_availability", title: "Verfügbarkeit prüfen", effect: "read" },
  { name: "anny.list_my_bookings", title: "Eigene Buchungen", effect: "read" },
  { name: "anny.propose_booking", title: "Buchung vorbereiten", effect: "prepare" },
  { name: "anny.execute_booking", title: "Bestätigte Buchung ausführen", effect: "execute" },
];

type StoredBooking = Booking & { resourceId: string };
type IntervalArguments = {
  resourceId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
};
type StoredProposal = {
  id: string;
  personaId: Role;
  resourceName: string;
  arguments: IntervalArguments;
  expiresAt: string;
  createdAt: string;
  status: "pending" | "confirmed";
  bookingId?: string;
};
type DemoState = {
  version: typeof STORAGE_VERSION;
  sessionPersonaId: Role | null;
  bookings: Record<Role, StoredBooking[]>;
  proposals: StoredProposal[];
  pluginEnabled: boolean;
};

export interface PublicDemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PublicDemoOptions {
  storage: PublicDemoStorage;
  now?: () => Date;
}

export interface PublicDemoTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.includes(value as Role);
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isBoundedString(value: unknown, maxLength = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function isStoredBooking(value: unknown): value is StoredBooking {
  return isRecord(value)
    && exactKeys(value, ["id", "resourceId", "resourceName", "startDate", "endDate", "status"])
    && isBoundedString(value.id, 160)
    && typeof value.resourceId === "string"
    && RESOURCE_BY_ID.has(value.resourceId)
    && isBoundedString(value.resourceName)
    && isIsoDateTime(value.startDate)
    && isIsoDateTime(value.endDate)
    && Date.parse(value.endDate) > Date.parse(value.startDate)
    && isBoundedString(value.status, 40);
}

function isIntervalArguments(value: unknown): value is IntervalArguments {
  if (!isRecord(value)) return false;
  return exactKeys(value, ["resourceId", "serviceId", "startDate", "endDate"])
    && typeof value.resourceId === "string"
    && RESOURCE_BY_ID.has(value.resourceId)
    && typeof value.serviceId === "string"
    && RESOURCE_BY_ID.get(value.resourceId)?.serviceId === value.serviceId
    && isIsoDateTime(value.startDate)
    && isIsoDateTime(value.endDate)
    && isValidDuration(value.startDate, value.endDate);
}

function isStoredProposal(value: unknown): value is StoredProposal {
  if (!isRecord(value)) return false;
  const shapeIsValid = value.status === "confirmed"
    ? exactKeys(value, ["id", "personaId", "resourceName", "arguments", "expiresAt", "createdAt", "status", "bookingId"])
    : exactKeys(value, ["id", "personaId", "resourceName", "arguments", "expiresAt", "createdAt", "status"]);
  return shapeIsValid
    && isBoundedString(value.id, 200)
    && isRole(value.personaId)
    && isBoundedString(value.resourceName)
    && isIntervalArguments(value.arguments)
    && isIsoDateTime(value.expiresAt)
    && isIsoDateTime(value.createdAt)
    && (value.status === "pending" || (value.status === "confirmed" && isBoundedString(value.bookingId, 200)));
}

function isValidState(value: unknown): value is DemoState {
  if (!isRecord(value) || !exactKeys(value, ["version", "sessionPersonaId", "bookings", "proposals", "pluginEnabled"]) || value.version !== STORAGE_VERSION) return false;
  if (value.sessionPersonaId !== null && !isRole(value.sessionPersonaId)) return false;
  if (!isRecord(value.bookings) || !exactKeys(value.bookings, ROLES) || !Array.isArray(value.proposals) || typeof value.pluginEnabled !== "boolean") return false;
  for (const role of ROLES) {
    const bookings = value.bookings[role];
    if (!Array.isArray(bookings) || bookings.length > MAX_BOOKINGS_PER_PERSONA || !bookings.every(isStoredBooking)) return false;
  }
  return value.proposals.length <= MAX_PROPOSALS && value.proposals.every(isStoredProposal);
}

function utcDayOffset(now: Date, dayOffset: number, hour: number): string {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + dayOffset,
    hour,
  )).toISOString();
}

function seedBookings(now: Date): Record<Role, StoredBooking[]> {
  const seed = (
    id: string,
    resourceId: string,
    dayOffset: number,
    status = "confirmed",
  ): StoredBooking => {
    const resource = RESOURCE_BY_ID.get(resourceId);
    if (!resource) throw new Error("Unbekannter Demo-Raum.");
    return {
      id,
      resourceId,
      resourceName: resource.name,
      startDate: utcDayOffset(now, dayOffset, 10),
      endDate: utcDayOffset(now, dayOffset, 11),
      status,
    };
  };

  return {
    student: [
      seed("demo-seed-student-a", RESOURCE_IDS.seminarRoom, 2),
      seed("demo-seed-student-b", RESOURCE_IDS.projectRoom, 4, "requested"),
    ],
    employee: [seed("demo-seed-employee-a", RESOURCE_IDS.mediaStudio, 3)],
    admin: [seed("demo-seed-admin-a", RESOURCE_IDS.computerLab, 5)],
  };
}

function createInitialState(now: Date): DemoState {
  return {
    version: STORAGE_VERSION,
    sessionPersonaId: null,
    bookings: seedBookings(now),
    proposals: [],
    pluginEnabled: true,
  };
}

function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function badRequest(message = "Bitte prüfe die eingegebenen Daten."): never {
  throw apiError(400, message);
}

function parseBody(init: RequestInit): Record<string, unknown> {
  if (init.body === undefined || init.body === null || init.body === "") return {};
  if (typeof init.body !== "string") return badRequest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return badRequest();
  }
  if (!isRecord(parsed)) return badRequest();
  return parsed;
}

function parseMethodAndPath(path: string, init: RequestInit): { method: string; path: string } {
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    throw apiError(404, "Die angefragte Funktion wurde nicht gefunden.");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") throw apiError(405, "Diese Anfrageart wird nicht unterstützt.");
  const normalizedPath = path.split("?", 1)[0] ?? path;
  return { method, path: normalizedPath };
}

function requirePersona(state: DemoState): Role {
  if (!state.sessionPersonaId) throw apiError(401, "Bitte wähle zuerst ein Testkonto.");
  return state.sessionPersonaId;
}

function requireAdmin(state: DemoState): void {
  if (requirePersona(state) !== "admin") {
    throw apiError(403, "Diese Funktion ist der Administration vorbehalten.");
  }
}

function requirePluginEnabled(state: DemoState): void {
  if (!state.pluginEnabled) throw apiError(409, "Das Demo-Plug-in ist deaktiviert.");
}

function getResourceForRole(resourceId: unknown, serviceId: unknown, role: Role): Resource {
  if (typeof resourceId !== "string" || !RESOURCE_ACCESS[role].includes(resourceId)) {
    throw apiError(403, "Dieser Raum ist für das Testkonto nicht freigegeben.");
  }
  const resource = RESOURCE_BY_ID.get(resourceId);
  if (!resource || resource.serviceId !== serviceId) {
    throw apiError(400, "Der Raum und der Service passen nicht zusammen.");
  }
  return resource;
}

function isValidDuration(startDate: string, endDate: string): boolean {
  const duration = (Date.parse(endDate) - Date.parse(startDate)) / 60_000;
  return Number.isInteger(duration) && duration >= 15 && duration <= 1440;
}

function parseAvailabilityArguments(body: Record<string, unknown>, role: Role): {
  resource: Resource;
  startDate: string;
  durationMinutes: number;
} {
  if (!exactKeys(body, ["resourceId", "serviceId", "startDate", "durationMinutes"])) return badRequest();
  const resource = getResourceForRole(body.resourceId, body.serviceId, role);
  if (!isIsoDateTime(body.startDate)) return badRequest();
  if (typeof body.durationMinutes !== "number" || !Number.isInteger(body.durationMinutes) || body.durationMinutes < 15 || body.durationMinutes > 1440) {
    return badRequest();
  }
  return { resource, startDate: body.startDate, durationMinutes: body.durationMinutes };
}

function parseIntervalArguments(body: Record<string, unknown>, role: Role): { resource: Resource; args: IntervalArguments } {
  if (!exactKeys(body, ["resourceId", "serviceId", "startDate", "endDate"])) return badRequest();
  const resource = getResourceForRole(body.resourceId, body.serviceId, role);
  if (!isIsoDateTime(body.startDate) || !isIsoDateTime(body.endDate) || !isValidDuration(body.startDate, body.endDate)) {
    return badRequest("Die Buchungsdauer muss zwischen 15 Minuten und 24 Stunden liegen.");
  }
  return {
    resource,
    args: {
      resourceId: body.resourceId as string,
      serviceId: body.serviceId as string,
      startDate: body.startDate,
      endDate: body.endDate,
    },
  };
}

function assertFutureInterval(startDate: string, now: Date): void {
  const start = Date.parse(startDate);
  if (start <= now.getTime()) throw apiError(400, "Der Beginn muss in der Zukunft liegen.");
  if (start > now.getTime() + MAX_BOOKING_DAYS_AHEAD * 24 * 60 * 60_000) {
    throw apiError(400, "Buchungen sind höchstens ein Jahr im Voraus möglich.");
  }
}

function assertWithinSearchWindow(startDate: string, now: Date): void {
  if (Date.parse(startDate) > now.getTime() + MAX_BOOKING_DAYS_AHEAD * 24 * 60 * 60_000) {
    throw apiError(400, "Die Verfügbarkeit kann höchstens ein Jahr im Voraus geprüft werden.");
  }
}

function overlaps(firstStart: string, firstEnd: string, secondStart: string, secondEnd: string): boolean {
  return Date.parse(firstStart) < Date.parse(secondEnd) && Date.parse(secondStart) < Date.parse(firstEnd);
}

function hasBookingConflict(bookings: StoredBooking[], resourceId: string, startDate: string, endDate: string): boolean {
  return bookings.some((booking) => booking.resourceId === resourceId
    && overlaps(startDate, endDate, booking.startDate, booking.endDate));
}

function availabilityIntervals(
  state: DemoState,
  role: Role,
  resource: Resource,
  requestStart: string,
  durationMinutes: number,
  now: Date,
): TimeInterval[] {
  const startMs = Date.parse(requestStart);
  // Select the requested campus calendar day, including when its first hours
  // still fall on the preceding UTC date. The two synthetic slots remain UTC.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(startMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)?.value);
  const year = part("year");
  const month = part("month") - 1;
  const day = part("day");
  const intervals: TimeInterval[] = [];

  for (const hour of [9, 13]) {
    const start = new Date(Date.UTC(year, month, day, hour));
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    if (start.getTime() < startMs || start.getTime() <= now.getTime()) continue;
    intervals.push({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      available: !hasBookingConflict(state.bookings[role], resource.id, start.toISOString(), end.toISOString()),
    });
  }
  return intervals;
}

function publicProposal(proposal: StoredProposal) {
  return {
    id: proposal.id,
    resourceName: proposal.resourceName,
    startDate: proposal.arguments.startDate,
    endDate: proposal.arguments.endDate,
    expiresAt: proposal.expiresAt,
    status: proposal.status,
    arguments: { ...proposal.arguments },
  };
}

function createPlugin(state: DemoState): Plugin {
  return {
    id: PLUGIN_ID,
    name: "anny",
    version: PLUGIN_VERSION,
    description: "Lokale Simulation der Raum- und Buchungsfunktionen.",
    enabled: state.pluginEnabled,
    healthy: false,
    tools: PLUGIN_TOOLS.map((tool) => ({ ...tool })),
  };
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return badRequest("Die Anfrage enthält einen ungültigen Pfad.");
  }
}

function compactState(state: DemoState): void {
  for (const role of ROLES) {
    state.bookings[role] = state.bookings[role]
      .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
      .slice(-MAX_BOOKINGS_PER_PERSONA);
  }
  state.proposals = state.proposals.slice(-MAX_PROPOSALS);
}

export function createPublicDemoTransport(options: PublicDemoOptions): PublicDemoTransport {
  const now = options.now ?? (() => new Date());
  let memoryOnlyState: DemoState | null = null;
  let storageUnavailable = false;

  function writeState(state: DemoState): void {
    compactState(state);
    const serialized = JSON.stringify(state);
    if (storageUnavailable || serialized.length > MAX_STORAGE_CHARS) {
      memoryOnlyState = state;
      return;
    }
    try {
      options.storage.setItem(PUBLIC_DEMO_STORAGE_KEY, serialized);
      memoryOnlyState = null;
    } catch {
      storageUnavailable = true;
      memoryOnlyState = state;
    }
  }

  function resetStorage(): DemoState {
    const state = createInitialState(now());
    try {
      options.storage.removeItem(PUBLIC_DEMO_STORAGE_KEY);
    } catch {
      storageUnavailable = true;
    }
    writeState(state);
    return state;
  }

  function readState(): DemoState {
    if (memoryOnlyState) return memoryOnlyState;
    if (storageUnavailable) {
      memoryOnlyState = createInitialState(now());
      return memoryOnlyState;
    }
    let serialized: string | null;
    try {
      serialized = options.storage.getItem(PUBLIC_DEMO_STORAGE_KEY);
    } catch {
      storageUnavailable = true;
      memoryOnlyState = createInitialState(now());
      return memoryOnlyState;
    }
    if (serialized === null) return resetStorage();
    if (serialized.length > MAX_STORAGE_CHARS) return resetStorage();
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isValidState(parsed)) return parsed;
    } catch {
      // Invalid data is replaced with a bounded fresh demo state below.
    }
    return resetStorage();
  }

  function requireAvailablePlugin(state: DemoState): void {
    requirePluginEnabled(state);
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { method, path: requestPath } = parseMethodAndPath(path, init);
    const body = method === "POST" ? parseBody(init) : {};
    const state = readState();
    const timestamp = now();

    if (method === "GET" && requestPath === "/api/session") {
      const persona = state.sessionPersonaId ? PERSONAS_BY_ROLE.get(state.sessionPersonaId) ?? null : null;
      return { mode: "public-demo", user: persona } as T;
    }
    if (method === "GET" && requestPath === "/api/dev/personas") return { personas: PERSONAS.map((persona) => ({ ...persona })) } as T;
    if (method === "POST" && requestPath === "/api/dev/login") {
      if (!exactKeys(body, ["personaId"]) || !isRole(body.personaId)) return badRequest("Unbekanntes Testkonto.");
      state.sessionPersonaId = body.personaId;
      writeState(state);
      const persona = PERSONAS_BY_ROLE.get(body.personaId);
      if (!persona) return badRequest("Unbekanntes Testkonto.");
      return { mode: "public-demo", user: { ...persona } } as T;
    }
    if (method === "POST" && requestPath === "/api/logout") {
      if (!exactKeys(body, [])) return badRequest();
      state.sessionPersonaId = null;
      writeState(state);
      return { ok: true } as T;
    }

    if (method === "GET" && requestPath === "/api/resources") {
      const role = requirePersona(state);
      requireAvailablePlugin(state);
      return {
        resources: RESOURCES
          .filter((resource) => RESOURCE_ACCESS[role].includes(resource.id))
          .map((resource) => ({ ...resource, features: [...resource.features] })),
      } as T;
    }
    if (method === "POST" && requestPath === "/api/availability") {
      const role = requirePersona(state);
      requireAvailablePlugin(state);
      const args = parseAvailabilityArguments(body, role);
      assertWithinSearchWindow(args.startDate, timestamp);
      return {
        intervals: availabilityIntervals(state, role, args.resource, args.startDate, args.durationMinutes, timestamp),
      } as T;
    }
    if (method === "GET" && requestPath === "/api/bookings") {
      const role = requirePersona(state);
      requireAvailablePlugin(state);
      return {
        bookings: [...state.bookings[role]]
          .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
          .map((booking) => ({
            id: booking.id,
            resourceName: booking.resourceName,
            startDate: booking.startDate,
            endDate: booking.endDate,
            status: booking.status,
          })),
      } as T;
    }
    if (method === "POST" && requestPath === "/api/proposals") {
      const role = requirePersona(state);
      requireAvailablePlugin(state);
      const { resource, args } = parseIntervalArguments(body, role);
      assertFutureInterval(args.startDate, timestamp);
      if (hasBookingConflict(state.bookings[role], resource.id, args.startDate, args.endDate)) {
        throw apiError(409, "Der Zeitraum ist nicht mehr verfügbar. Bitte prüfe die Verfügbarkeit erneut.");
      }
      const proposal: StoredProposal = {
        id: makeId("demo-proposal"),
        personaId: role,
        resourceName: resource.name,
        arguments: args,
        expiresAt: new Date(timestamp.getTime() + PROPOSAL_LIFETIME_MS).toISOString(),
        createdAt: timestamp.toISOString(),
        status: "pending",
      };
      state.proposals.push(proposal);
      writeState(state);
      return { proposal: publicProposal(proposal) } as T;
    }
    const confirmMatch = requestPath.match(/^\/api\/proposals\/([^/]+)\/confirm$/);
    if (method === "POST" && confirmMatch) {
      if (!exactKeys(body, [])) return badRequest();
      const role = requirePersona(state);
      requireAvailablePlugin(state);
      const proposalId = decodePathPart(confirmMatch[1] ?? "");
      const proposal = state.proposals.find((item) => item.id === proposalId && item.personaId === role);
      if (!proposal) throw apiError(404, "Vorschlag nicht gefunden.");
      if (proposal.status === "confirmed") {
        return { bookingId: proposal.bookingId, proposal: publicProposal(proposal) } as T;
      }
      if (Date.parse(proposal.expiresAt) <= timestamp.getTime()) {
        throw apiError(409, "Der Vorschlag ist abgelaufen. Bitte prüfe die Verfügbarkeit erneut.");
      }
      if (Date.parse(proposal.arguments.startDate) <= timestamp.getTime()) {
        throw apiError(409, "Der Buchungszeitraum liegt inzwischen in der Vergangenheit.");
      }
      if (hasBookingConflict(
        state.bookings[role],
        proposal.arguments.resourceId,
        proposal.arguments.startDate,
        proposal.arguments.endDate,
      )) {
        throw apiError(409, "Der Zeitraum ist nicht mehr verfügbar. Bitte prüfe die Verfügbarkeit erneut.");
      }
      const bookingId = makeId("demo-booking");
      const resource = RESOURCE_BY_ID.get(proposal.arguments.resourceId);
      if (!resource) throw apiError(400, "Der Raum ist in der Browser-Demo nicht verfügbar.");
      state.bookings[role].push({
        id: bookingId,
        resourceId: resource.id,
        resourceName: resource.name,
        startDate: proposal.arguments.startDate,
        endDate: proposal.arguments.endDate,
        status: "confirmed",
      });
      proposal.bookingId = bookingId;
      proposal.status = "confirmed";
      writeState(state);
      return { bookingId, proposal: publicProposal(proposal) } as T;
    }

    if (method === "GET" && requestPath === "/api/admin/plugins") {
      requireAdmin(state);
      return { plugins: [createPlugin(state)] } as T;
    }
    const adminPluginMatch = requestPath.match(/^\/api\/admin\/plugins\/([^/]+)\/(enabled|check-update|activate-update)$/);
    if (method === "POST" && adminPluginMatch) {
      requireAdmin(state);
      if (decodePathPart(adminPluginMatch[1] ?? "") !== PLUGIN_ID) throw apiError(404, "Plugin nicht gefunden.");
      const action = adminPluginMatch[2];
      if (action === "enabled") {
        if (!exactKeys(body, ["enabled"]) || typeof body.enabled !== "boolean") return badRequest();
        state.pluginEnabled = body.enabled;
        writeState(state);
        return { ok: true } as T;
      }
      if (!exactKeys(body, [])) return badRequest();
      if (action === "check-update") {
        return {
          status: "current",
          message: "Die Browser-Demo verwendet Version 0.1.0. Es wird kein Update-Server abgefragt.",
        } as T;
      }
      throw apiError(409, "Die Browser-Demo führt keine Plugin-Updates durch.");
    }

    throw apiError(404, "Die angefragte Funktion wurde nicht gefunden.");
  }

  return { request };
}

function makeId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return `${prefix}-${randomUUID.call(globalThis.crypto)}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

class MemoryStorage implements PublicDemoStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const fallbackStorage = new MemoryStorage();
let browserTransport: PublicDemoTransport | null = null;

function browserStorage(): PublicDemoStorage {
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    // Private browsing and hardened contexts may block localStorage.
  }
  return fallbackStorage;
}

export function requestPublicDemo<T>(path: string, init: RequestInit = {}): Promise<T> {
  browserTransport ??= createPublicDemoTransport({ storage: browserStorage() });
  return browserTransport.request<T>(path, init);
}
