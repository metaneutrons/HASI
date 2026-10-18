import type { Resource, ResourceKind } from "./types";

export type OfficeType = "single" | "shared" | "any";
export type WorkplaceOfficeTypeCounts = { single: number; shared: number; unknown: number };
export type WorkplaceRefinement = {
  question: string;
  counts: WorkplaceOfficeTypeCounts;
  candidateCount: number;
};

export type RoomRequest = {
  kind?: ResourceKind;
  officeType?: OfficeType;
  date?: string;
  time?: string;
  durationMinutes?: number;
  capacity?: number;
  features?: string[];
  location?: string;
  query?: string;
};

export function workplaceGroupQuestion(request: RoomRequest): string | null {
  return request.kind === 'workplace' && request.capacity !== undefined && request.capacity > 1
    ? 'Möchtest du einzelne Arbeitsplätze für mehrere Personen oder einen gemeinsamen Besprechungsraum? Arbeitsplätze werden einzeln ausgewählt und bestätigt.'
    : null;
}

const TIME_ZONE = "Europe/Berlin";
const INVALID = "__invalid__";
const WORD_NUMBERS: Record<string, number> = {
  null: 0,
  ein: 1,
  eine: 1,
  einen: 1,
  einem: 1,
  einer: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwolf: 12,
  dreizehn: 13,
  vierzehn: 14,
  fünfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
  zwanzig: 20,
};

const ZU_CAPACITY: Record<string, number> = {
  zweit: 2,
  dritt: 3,
  viert: 4,
  funft: 5,
  sechst: 6,
  siebt: 7,
  acht: 8,
  neunt: 9,
  zehnt: 10,
  elft: 11,
  zwolft: 12,
};

const FEATURES = ["Display", "Beamer", "Whiteboard", "Videokonferenz", "WLAN"] as const;
const WEEKDAY_DATE_PATTERN = /(?<![\p{L}\p{N}_])(?:(?:am|zum)\s+)?(?:(?:kommend(?:e|en|er|es)?|nächste(?:n|r|s)?|naechste(?:n|r|s)?|next|coming)\s+)?(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)(?![\p{L}\p{N}_])/giu;
const WEEKDAY_NUMBERS: Record<string, number> = {
  sonntag: 0,
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
};

type DateCandidate = { value: string; start: number; end: number };

function isNegatedNear(text: string, start: number, end: number): boolean {
  const before = normalize(text.slice(Math.max(0, start - 40), start));
  const after = normalize(text.slice(end, Math.min(text.length, end + 24)));
  return /\b(?:nicht|kein|keine|keinen|keinem|keiner|ohne|ausser)\s+(?:(?:mit|in|am|um|fur)\s+)?$/u.test(before)
    || /^\s*(?:(?:ist|sind|war|waere)\s+)?(?:nicht|kein|keine|keinen|keinem|keiner|fehlt|fehlen)\b/u.test(after);
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

const SINGLE_OFFICE_PATTERN = /\b(?:einzelburos?|1er|single[- ]?offices?)\b/u;
const SHARED_OFFICE_PATTERN = /\b(?:2|3)(?:er)?\s*(?:buros?|offices?)\b|\b(?:geteilte[nrsm]?|gemeinsame[nrsm]?|gemeinschafts)\s*(?:buros?|offices?)\b|\bshared(?:\s*(?:buros?|offices?))?\b/u;
const ANY_OFFICE_PATTERN = /\b(?:egal|gleich|beides|keine?\s+pr(?:ae|a)ferenz|ohne\s+pr(?:ae|a)ferenz|keine?\s+bevorzugung)\b/u;
const OFFICE_TYPE_QUERY_PATTERN = /\b(?:einzelb[uü]ros?|1er|single[- ]?offices?|(?:2|3)(?:er)?\s*(?:b[uü]ros?|offices?)|(?:geteilte[nrsm]?|gemeinsame[nrsm]?|gemeinschafts)\s*(?:b[uü]ros?|offices?)|shared(?:\s*(?:b[uü]ros?|offices?))?|egal|gleich|beides|keine?\s+(?:praeferenz|präferenz|bevorzugung)|ohne\s+(?:praeferenz|präferenz))\b/giu;

/** Prefer the complete-catalog office count; otherwise use only explicit office labels. */
export function classifyWorkplaceOfficeType(resource: Resource): Exclude<OfficeType, "any"> | "unknown" {
  const workplaceCount = resource.officeWorkplaceCount;
  if (typeof workplaceCount === "number" && Number.isInteger(workplaceCount) && workplaceCount > 0) {
    return workplaceCount === 1 ? "single" : "shared";
  }
  // Keep each source label separate: concatenating a desk name like
  // "Arbeitsplatz 2" with "Büro 1J" could falsely create a "2 Büro" label.
  const labels = [resource.name, resource.parentName ?? ""].map(normalize);
  const single = labels.some((label) => SINGLE_OFFICE_PATTERN.test(label));
  const shared = labels.some((label) => SHARED_OFFICE_PATTERN.test(label));
  if (single === shared) return "unknown";
  return single ? "single" : "shared";
}

function berlinParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextBerlinWeekday(now: Date, weekday: string): string | undefined {
  const targetWeekday = WEEKDAY_NUMBERS[normalize(weekday)];
  if (targetWeekday === undefined) return undefined;
  const today = berlinParts(now);
  const localDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const daysUntil = (targetWeekday - localDate.getUTCDay() + 7) % 7 || 7;
  const targetDate = new Date(Date.UTC(today.year, today.month - 1, today.day + daysUntil));
  return formatDate(targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, targetDate.getUTCDate());
}

function dateIsValid(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDateCandidates(text: string, now: Date): { candidates: DateCandidate[]; invalid: boolean } {
  const candidates: DateCandidate[] = [];
  const berlinToday = berlinParts(now);

  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])(übermorgen|morgen|heute)(?![\p{L}\p{N}_])/giu)) {
    const offset = match[1]?.toLocaleLowerCase("de-DE") === "heute"
      ? 0
      : match[1]?.toLocaleLowerCase("de-DE") === "morgen" ? 1 : 2;
    const localDay = new Date(Date.UTC(berlinToday.year, berlinToday.month - 1, berlinToday.day + offset));
    candidates.push({
      value: formatDate(localDay.getUTCFullYear(), localDay.getUTCMonth() + 1, localDay.getUTCDate()),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  for (const match of text.matchAll(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/gu)) {
    const value = formatDate(Number(match[1]), Number(match[2]), Number(match[3]));
    candidates.push({ value: dateIsValid(value) ? value : INVALID, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }

  for (const match of text.matchAll(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?(?!\d)/gu)) {
    const value = formatDate(Number(match[3] ?? berlinToday.year), Number(match[2]), Number(match[1]));
    candidates.push({ value: dateIsValid(value) ? value : INVALID, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }

  for (const match of text.matchAll(new RegExp(WEEKDAY_DATE_PATTERN.source, WEEKDAY_DATE_PATTERN.flags))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    candidates.push({
      value: (() => {
        const today = new Date(Date.UTC(berlinToday.year, berlinToday.month - 1, berlinToday.day)).getUTCDay();
        const explicitFuture = /\b(?:kommend\w*|nächst\w*|naechst\w*|next|coming)\b/iu.test(match[0]);
        if (WEEKDAY_NUMBERS[normalize(match[1] ?? "")] === today && !explicitFuture) return INVALID;
        return nextBerlinWeekday(now, match[1] ?? "") ?? INVALID;
      })(),
      start,
      end,
    });
  }

  const unsupportedDate = /\b(?:nächste[nrms]?\s+woche|kommende[rn]?\s+woche|next\s+week|(?:letzte[nrms]?|vergangene[nrms]?|vorige[nrms]?|diese[nrms]?)\s+(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\b/iu.test(text);
  const distinct = [...new Set(candidates.map(({ value }) => value))];
  const negatedDate = candidates.some((candidate) => isNegatedNear(text, candidate.start, candidate.end));
  return { candidates, invalid: unsupportedDate || negatedDate || distinct.length > 1 || distinct.includes(INVALID) };
}

function maskRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  const chars = text.split("");
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

function numberValue(value: string): number | null {
  const normalized = normalize(value.trim());
  if (/^\d+(?:[,.]\d+)?$/.test(normalized)) return Number(normalized.replace(",", "."));
  return WORD_NUMBERS[normalized] ?? null;
}

type TimeParse = { found: boolean; value?: string; durationMinutes?: number; invalid: boolean };

function parseTime(text: string, dateCandidates: DateCandidate[]): TimeParse {
  const dateMasked = maskRanges(text, dateCandidates);
  const durationMasked = dateMasked.replace(/\b(?:\d+(?:[,.]\d+)?|ein(?:e|en|em|er)?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn)\s*(?:minuten?|stunden?)\b/giu, (match) => " ".repeat(match.length));
  const ranges: Array<{ start: number; end: number }> = [];
  const values: string[] = [];
  const rangeDurations: number[] = [];
  let invalid = false;

  const rangePattern = /\b(\d{1,2})(?::(\d{2}))?\s*(?:bis|–|—|-)\s*(\d{1,2})(?::(\d{2}))?\s*(Uhr\b)?/giu;
  for (const match of durationMasked.matchAll(rangePattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const startHour = Number(match[1]);
    const startMinute = Number(match[2] ?? 0);
    const endHour = Number(match[3]);
    const endMinute = Number(match[4] ?? 0);
    const hasExplicitClock = Boolean(match[2] || match[4] || match[5]);
    ranges.push({ start, end });
    if (!hasExplicitClock || isNegatedNear(durationMasked, start, end)) {
      invalid = true;
      continue;
    }
    const startTotal = startHour * 60 + startMinute;
    const endTotal = endHour * 60 + endMinute;
    if (startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59 || endTotal <= startTotal) {
      invalid = true;
      continue;
    }
    values.push(`${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`);
    rangeDurations.push(endTotal - startTotal);
  }

  const singleTimeText = maskRanges(durationMasked, ranges);
  const singlePattern = /\b(?:um\s*)?(\d{1,2}):(\d{2})\b|\b(?:um\s*)?(\d{1,2})\s*Uhr\b/giu;
  for (const match of singleTimeText.matchAll(singlePattern)) {
    const hour = Number(match[1] ?? match[3]);
    const minute = Number(match[2] ?? 0);
    if (hour > 23 || minute > 59 || isNegatedNear(singleTimeText, match.index ?? 0, (match.index ?? 0) + match[0].length)) {
      invalid = true;
      continue;
    }
    values.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }

  const ambiguousClock = /\b(?:halb\s+(?:\w+)|viertel\s+(?:vor|nach)\s+\w+|gegen\s+(?:\w+|\d+)|(?:ca\.?|circa|ungefähr|ungefaehr)\s+(?:\w+|\d+))\b/iu.test(dateMasked)
    || /\b(?:um|gegen|ca\.?|circa|ungefähr|ungefaehr)\s+(?:\d{1,2}(?::\d{2})?|\w+)\b/iu.test(dateMasked) && values.length === 0;
  const invalidClockToken = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*Uhr\b|\b\d{1,2}\s*(?:bis|–|—|-)\s*\d{1,2}\b/iu.test(durationMasked);
  if (ambiguousClock || (invalidClockToken && values.length === 0)) invalid = true;

  const distinctValues = [...new Set(values)];
  const distinctDurations = [...new Set(rangeDurations)];
  if (distinctValues.length > 1 || distinctDurations.length > 1) invalid = true;
  if (distinctDurations.some((duration) => duration < 15 || duration > 1440)) invalid = true;
  return {
    found: values.length > 0 || invalid,
    value: invalid ? INVALID : distinctValues[0],
    durationMinutes: invalid ? undefined : distinctDurations[0],
    invalid,
  };
}

type DurationParse = { found: boolean; value?: number };

function parseDuration(text: string): DurationParse {
  const values: number[] = [];
  let found = false;
  for (const match of text.matchAll(/\b(\d+(?:[,.]\d+)?|ein(?:e|en|em|er)?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s*(Minute(?:n)?|Stunde(?:n)?)\b/giu)) {
    found = true;
    const amount = numberValue(match[1] ?? "");
    if (amount === null || isNegatedNear(text, match.index ?? 0, (match.index ?? 0) + match[0].length)) {
      values.push(0);
      continue;
    }
    const minutes = normalize(match[2] ?? "").startsWith("stunde") ? amount * 60 : amount;
    values.push(Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440 ? minutes : 0);
  }
  const halfHour = /\b(?:eine?\s+halbe|halb)\s+stunden?\b/iu.exec(text);
  if (halfHour) {
    found = true;
    values.push(isNegatedNear(text, halfHour.index, halfHour.index + halfHour[0].length) ? 0 : 30);
  }
  if (!found) return { found: false };
  const distinct = [...new Set(values)];
  return { found: true, value: distinct.length === 1 ? distinct[0] : 0 };
}

type CapacityParse = { found: boolean; value?: number };

function parseCapacity(text: string): CapacityParse {
  const values: number[] = [];
  const amountPattern = "(\\d+(?:[,.]\\d+)?|ein(?:e|en|em|er)?|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|hundert|tausend)";
  const groupPattern = new RegExp(`\\b${amountPattern}\\s+(?:person(?:en)?|leute|teilnehmende(?:n)?)\\b`, "giu");
  for (const match of text.matchAll(groupPattern)) {
    const value = numberValue(match[1] ?? "");
    const negated = isNegatedNear(text, match.index ?? 0, (match.index ?? 0) + match[0].length);
    values.push(!negated && value !== null && Number.isInteger(value) && value > 0 ? value : 0);
  }
  for (const match of text.matchAll(/\bwir\s+sind\s+zu\s+(zweit|dritt|viert|fünft|sechst|siebt|acht|neunt|zehnt|elft|zwölft)\b/giu)) {
    const value = ZU_CAPACITY[normalize(match[1] ?? "")];
    const negated = isNegatedNear(text, match.index ?? 0, (match.index ?? 0) + match[0].length);
    values.push(!negated ? value ?? 0 : 0);
  }
  if (/\b(?:nicht|kein(?:e|en)?|ohne)\s+(?:(?:für|fur)\s+)?(?:\d+(?:[,.]\d+)?|ein(?:e|en|em|er)?|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zu\s+(?:zweit|dritt|viert|fünft|sechst|siebt|acht|neunt|zehnt|elft|zwölft))\s+(?:person(?:en)?|leute)\b/iu.test(text)
    || /\b(?:nicht|kein(?:e|en)?)\s+zu\s+(?:zweit|dritt|viert|fünft|sechst|siebt|acht|neunt|zehnt|elft|zwölft)\b/iu.test(text)) {
    values.push(0);
  }
  if (!values.length) return { found: false };
  const distinct = [...new Set(values)];
  return { found: true, value: distinct.length === 1 ? distinct[0] : 0 };
}

function parseFeatures(text: string): string[] {
  const normalized = normalize(text);
  const found: string[] = [];
  for (const feature of FEATURES) {
    const pattern = new RegExp(`\\b${normalize(feature)}\\b`, "gu");
    let hasPositiveMention = false;
    for (const match of normalized.matchAll(pattern)) {
      if (match.index === undefined) continue;
      if (isNegatedNear(normalized, match.index, match.index + match[0].length)) return [INVALID];
      hasPositiveMention = true;
    }
    if (hasPositiveMention) found.push(feature);
  }
  return found;
}

function parseLocation(text: string): { found: boolean; value?: string } {
  const normalized = normalize(text);
  const found: string[] = [];
  const buildingPattern = /\b(?:gebaude|geb\.?|building)\s+(?:nr\.?\s*)?([a-z]?\d+[a-z0-9]*(?:[.-]\d+)*)\b/giu;
  for (const match of normalized.matchAll(buildingPattern)) {
    const code = match[1]?.toLocaleUpperCase("de-DE");
    if (code) found.push(isNegatedNear(normalized, match.index ?? 0, (match.index ?? 0) + match[0].length) ? INVALID : code);
  }
  for (const match of normalized.matchAll(/\bexpo[\s-]*plaza\b/gu)) {
    found.push(isNegatedNear(normalized, match.index ?? 0, (match.index ?? 0) + match[0].length) ? INVALID : "Expo Plaza");
  }
  for (const match of normalized.matchAll(/\blinden\b/gu)) {
    found.push(isNegatedNear(normalized, match.index ?? 0, (match.index ?? 0) + match[0].length) ? INVALID : "Linden");
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) return { found: true, value: INVALID };
  return distinct.length ? { found: true, value: distinct[0] } : { found: false };
}

function parseQuery(text: string): string | undefined {
  let residual = text;
  const patterns = [
    new RegExp(OFFICE_TYPE_QUERY_PATTERN.source, OFFICE_TYPE_QUERY_PATTERN.flags),
    /\b(?:\d+|ein(?:e|en|em|er)?|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+(?:arbeitsplätz(?:e|en)|arbeitsplaetz(?:e|en)|schreibtisch(?:e|en)|desks?)\b/giu,
    /\b(?:arbeitsplätz(?:e|en)?|arbeitsplatz|schreibtisch(?:e|en)?|büros?|bueros?|büroraum|büroräume|bueroraum|bueroraeume|flex[-\s]?büros?|flex[-\s]?bueros?|desks?|besprechungsräum(?:e|en)|besprechungsraum|meetingräum(?:e|en)|meetingraum|hörsäle|hörsaal|hoersaele|hoersaal)\b/giu,
    /(?<![\p{L}\p{N}_])(?:übermorgen|morgen|heute)(?![\p{L}\p{N}_])/giu,
    new RegExp(WEEKDAY_DATE_PATTERN.source, WEEKDAY_DATE_PATTERN.flags),
    /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/gu,
    /(?<!\d)\d{1,2}\.\d{1,2}\.(?:\d{4})?(?!\d)/gu,
    /\b(?:(?:im|in|at)\s+)?(?:gebäude|gebaeude|gebaude|geb\.?|building)\s+(?:nr\.?\s*)?[a-z]?\d+[a-z0-9]*(?:[.-]\d+)*\b/giu,
    /\b\d{1,2}(?::\d{2})?\s*(?:bis|–|—|-)\s*\d{1,2}(?::\d{2})?\s*(?:Uhr)?\b/giu,
    /\b(?:um\s*)?\d{1,2}:\d{2}\b|\b(?:um\s*)?\d{1,2}\s*Uhr\b/giu,
    /\b(?:\d+(?:[,.]\d+)?|ein(?:e|en|em|er)?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s*(?:minuten?|stunden?)\b/giu,
    /\b(?:\d+(?:[,.]\d+)?|ein(?:e|en|em|er)?|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig)\s+(?:person(?:en)?|leute|teilnehmende(?:n)?)\b/giu,
    /\bwir\s+sind\s+zu\s+(?:zweit|dritt|viert|fünft|sechst|siebt|acht|neunt|zehnt|elft|zwölft)\b/giu,
    /\b(?:display|beamer|whiteboard|videokonferenz|wlan)\b/giu,
    /\b(?:expo[\s-]*plaza|linden)\b/giu,
    /\b(?:ich\s+)?(?:such(?:e|en)?|brauche|benötige|benoetige|möchte|moechte|hätte\s+gern|haette\s+gern|finde|finden|reserviere|buch(?:e|en)?|gibt\s+es|haben\s+sie)\b/giu,
    /\b(?:kannst|kann|können|koennen|könnt|koennt|du|mir|mich|uns|ihnen|zeig|zeige|zeigen|gib|gibt|einmal|mal|ein(?:e|en|em|er)?|der|die|das|welche|welcher|welchen|was|nach|einzeln(?:e|en|er)?|bitte|doch|lieber|stattdessen|campus|raumbuchung(?:en)?|raum|räume|raeume|zimmer|für|fuer|mit|ohne|am|im|in|und|oder|wir|sind|zu|von|person(?:en)?|leute|gruppe|morgen|heute|übermorgen|uebermorgen)\b/giu,
  ];
  for (const pattern of patterns) residual = residual.replace(pattern, " ");
  const words = normalize(residual).match(/[a-z0-9]+/gu)?.filter((word) => word.length > 2) ?? [];
  return words.length ? words.join(" ") : undefined;
}

function matchesUnnegated(text: string, pattern: RegExp): boolean {
  const globalPattern = new RegExp(pattern.source, "gu");
  for (const match of text.matchAll(globalPattern)) {
    const start = match.index ?? 0;
    if (!isNegatedNear(text, start, start + match[0].length)) return true;
  }
  return false;
}

function parseOfficeType(text: string): OfficeType | undefined {
  const normalized = normalize(text);
  const single = matchesUnnegated(normalized, SINGLE_OFFICE_PATTERN);
  const shared = matchesUnnegated(normalized, SHARED_OFFICE_PATTERN);
  const any = matchesUnnegated(normalized, ANY_OFFICE_PATTERN);
  if (any && !single && !shared) return "any";
  if (single === shared) return undefined;
  return single ? "single" : "shared";
}

export function mergeRoomRequest(text: string, previous: RoomRequest, now = new Date()): RoomRequest {
  const boundedText = text.slice(0, 2_000);
  const next: RoomRequest = { ...previous };
  const normalized = normalize(boundedText);
  const officeType = parseOfficeType(boundedText);
  const kind: ResourceKind | undefined = officeType !== undefined ? 'workplace'
    : /\b(?:arbeitsplatz|arbeitsplatz(?:e|en)?|buros?|flex[-\s]?buros?|buroraum|buroraume|bueroraum|bueroraeume|schreibtisch(?:e|en)?|desks?)\b/u.test(normalized) ? 'workplace'
    : /\b(?:besprechungsraum|besprechungsraume|meetingraum|meetingraume)\b/u.test(normalized) ? 'meeting_room'
      : /\b(?:horsaal|horsale|hoersaal|hoersaele)\b/u.test(normalized) ? 'lecture_hall'
        : /\b(?:raum|raume|raeume|raumbuchung(?:en)?)\b/u.test(normalized) ? 'room' : undefined;
  if (kind) {
    if (kind === 'workplace' && (previous.kind !== kind || /\b(?:einzelne|einzelnen)\s+arbeitsplatz(?:e|en)?\b/u.test(normalized))) next.capacity = undefined;
    if (kind !== 'workplace') next.officeType = undefined;
    next.kind = kind;
  }
  if (officeType !== undefined) {
    next.kind = 'workplace';
    next.officeType = officeType;
  }
  const dates = parseDateCandidates(boundedText, now);
  if (dates.candidates.length || dates.invalid) {
    next.date = dates.invalid ? INVALID : dates.candidates[0]?.value;
  }

  const time = parseTime(boundedText, dates.candidates);
  if (time.found) next.time = time.value ?? INVALID;

  const explicitDuration = parseDuration(boundedText);
  if (explicitDuration.found) {
    next.durationMinutes = explicitDuration.value ?? 0;
  } else if (time.durationMinutes !== undefined) {
    next.durationMinutes = time.durationMinutes;
  }
  if (time.invalid && !explicitDuration.found) next.durationMinutes = next.durationMinutes === undefined ? 0 : next.durationMinutes;
  if (time.durationMinutes !== undefined && explicitDuration.found && explicitDuration.value !== time.durationMinutes) next.durationMinutes = 0;

  const capacity = parseCapacity(boundedText);
  if (capacity.found) next.capacity = capacity.value ?? 0;

  const features = parseFeatures(boundedText);
  if (features.length) next.features = features;

  const location = parseLocation(boundedText);
  if (location.found) next.location = location.value;

  const query = parseQuery(boundedText);
  if (query) next.query = query;
  return next;
}

export function classifyIntent(text: string, hasRoomContext: boolean): "rooms" | "bookings" | "knowledge" | "greeting" | "help" {
  const normalized = normalize(text).trim();
  if (/\b(?:meine|eigene)\s+buchungen?\b|\bbuchungen?\s+(?:anzeigen|auflisten|zeigen)\b|\bwas\s+habe\s+ich\s+gebucht\b|\bmy\s+bookings\b/iu.test(normalized)) return "bookings";

  const hasRoomWording = /\b(?:raum|raume|raeume|raumbuchung|raumbuchungen|zimmer|seminarraum|projektraum|medienstudio|computerraum|reservier\w*|raumplanung|arbeitsplatz|arbeitsplatz(?:e|en)?|buros?|flex[-\s]?buros?|buroraum|buroraume|bueroraum|bueroraeume|schreibtisch(?:e|en)?|besprechungsraum|besprechungsraume|horsaal|horsale|hoersaal|hoersaele)\b/iu.test(normalized);
  const officeType = parseOfficeType(text);
  if (hasRoomWording || officeType !== undefined && (officeType !== "any" || hasRoomContext)) return "rooms";

  const knowledgeTerms = /\b(?:eduroam|wlan|vpn|intranet|service[-\s]*it|it[-\s]*service|passwort|multifaktor|mfa|account|zugangsdaten|softwareportal|zeiterfassung|urlaub|fortbildung|bibliothek|campuscard)\b/iu;
  if (knowledgeTerms.test(normalized)) return "knowledge";

  const greetingOnly = /^(?:(?:hallo|hi|hey|guten\s+(?:morgen|tag|abend)|moin|servus|gruss\s+gott)[!,.:;\s]*)+$/iu.test(normalized);
  if (greetingOnly) return "greeting";

  if (hasRoomContext) {
    const date = parseDateCandidates(text, new Date());
    const time = parseTime(text, date.candidates);
    const duration = parseDuration(text);
    const capacity = parseCapacity(text);
    const location = parseLocation(text);
    if (date.candidates.length || date.invalid || time.found || duration.found || capacity.found || parseFeatures(text).length || location.found) return "rooms";
  }

  return "help";
}

function queryTokens(query: string): string[] {
  return normalize(query).match(/[a-z0-9]+/gu) ?? [];
}

function canonicalLocation(value: string): string {
  return normalize(value)
    .trim()
    .replace(/^(?:(?:im|in|at)\s+)?(?:gebaude|geb\.?|building)\s+(?:nr\.?\s*)?/u, "")
    .trim();
}

const GENERIC_WORKPLACE_QUERY_TOKENS = new Set([
  "buro", "buros", "buroraum", "buroraume", "arbeitsplatz", "arbeitsplatze",
  "schreibtisch", "schreibtische", "schreibtischarbeitsplatz", "schreibtischarbeitsplatze",
  "office", "offices", "workplace", "workplaces", "desk", "desks",
  "gebaude", "geb", "building", "buildings", "im", "in", "at",
]);

function stemGermanWord(word: string): string {
  if (word.length > 5 && /(?:en|er|es|em|e|n|s)$/u.test(word)) return word.replace(/(?:en|er|es|em|e|n|s)$/u, "");
  return word;
}

export function matchingResources(resources: Resource[], request: RoomRequest): Resource[] {
  if (request.capacity !== undefined && (!Number.isInteger(request.capacity) || request.capacity < 1)) return [];
  if (request.location === INVALID) return [];
  if (request.officeType !== undefined && request.kind !== undefined && request.kind !== "workplace") return [];
  const requestedKind = request.officeType === undefined ? request.kind : "workplace";
  const requiredFeatures = request.features ?? [];
  const requiredQuery = queryTokens(request.query ?? "")
    .filter((token) => !(requestedKind === "workplace" && GENERIC_WORKPLACE_QUERY_TOKENS.has(token)))
    .map(stemGermanWord)
    .filter(Boolean);
  return resources.filter((resource) => {
    const kind = resource.kind ?? 'room';
    if (requestedKind === 'room' ? kind === 'workplace' : requestedKind && kind !== requestedKind) return false;
      if (request.officeType !== undefined && request.officeType !== "any"
        && classifyWorkplaceOfficeType(resource) !== request.officeType) return false;
    if (request.capacity !== undefined) {
      if (kind === 'workplace') {
        if (request.kind !== 'workplace' || request.capacity !== 1) return false;
      } else if (resource.capacity === null || resource.capacity < request.capacity) return false;
    }
    const features = new Set(resource.features.map(normalize));
    if (!requiredFeatures.every((feature) => features.has(normalize(feature)))) return false;
    const location = kind === 'workplace' ? `${resource.location} ${resource.parentName ?? resource.name}` : resource.location;
    if (request.location) {
      const requestedLocation = canonicalLocation(request.location);
      if (!requestedLocation) return false;
      const identifier = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(requestedLocation) && /\d/u.test(requestedLocation);
      if (identifier) {
        // Building/room codes are identifiers, never substrings of another code
        // or a room's floor number. Keep legacy location aliases and source room
        // codes searchable without changing the imported catalog.
        const locationCodes = normalize(resource.location).match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/gu) ?? [];
        const roomCodes = normalize(`${resource.name} ${resource.parentName ?? ""}`).match(/\b(?:[a-z]?\d+[a-z][a-z0-9]*|[a-z]\d+)(?:[.-]\d+)+\b/gu) ?? [];
        if (![...locationCodes, ...roomCodes].some(code => code === requestedLocation || code.startsWith(`${requestedLocation}.`) || code.startsWith(`${requestedLocation}-`))) return false;
      } else if (!normalize(location).includes(requestedLocation)) return false;
    }
    const searchable = normalize(`${resource.name} ${resource.location} ${resource.parentName ?? ''} ${resource.description} ${resource.features.join(" ")}`);
    if (!requiredQuery.every((token) => searchable.split(/[^a-z0-9]+/u).some((candidate) => stemGermanWord(candidate) === token))) return false;
    return true;
  });
}

export function workplaceOfficeTypeCounts(resources: Resource[]): WorkplaceOfficeTypeCounts {
  const counts: WorkplaceOfficeTypeCounts = { single: 0, shared: 0, unknown: 0 };
  for (const resource of resources) {
    if ((resource.kind ?? "room") !== "workplace") continue;
    counts[classifyWorkplaceOfficeType(resource)] += 1;
  }
  return counts;
}

export function workplaceRefinementQuestion(resources: Resource[], request: RoomRequest): WorkplaceRefinement | null {
  if (request.kind !== "workplace" || request.officeType !== undefined || request.query?.trim()) return null;
  const matches = matchingResources(resources, request);
  if (matches.length <= 8) return null;
  const counts = workplaceOfficeTypeCounts(matches);
  return {
    question: "Es gibt viele passende Arbeitsplätze. Möchtest du ein Büro mit einem Arbeitsplatz oder einen Platz in einem geteilten Büro – oder ist beides passend? Den gewünschten Zeitraum prüfe ich anschließend.",
    counts,
    candidateCount: matches.length,
  };
}

function validTime(value: string | undefined): value is string {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}

export function missingRoomDetails(request: RoomRequest): string[] {
  const missing: string[] = [];
  if (!dateIsValid(request.date)) missing.push("Datum (heute, morgen oder TT.MM.JJJJ)");
  if (!validTime(request.time)) missing.push("Uhrzeit (z. B. 14:30)");
  if (request.durationMinutes === undefined || !Number.isInteger(request.durationMinutes) || request.durationMinutes < 15 || request.durationMinutes > 1440) {
    missing.push("Dauer (15 Minuten bis 24 Stunden)");
  }
  if (request.capacity !== undefined && (!Number.isInteger(request.capacity) || request.capacity < 1)) missing.push("Personenzahl");
  if (request.location === INVALID) missing.push("Standort (Linden oder Expo Plaza)");
  if (request.features?.includes(INVALID)) missing.push("Ausstattung (bitte eindeutig angeben)");
  return missing;
}

function localPartsAt(instant: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  return berlinParts(instant);
}

function offsetAt(instant: Date): number {
  const local = localPartsAt(instant);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return (localAsUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000;
}

export function requestStartDate(request: RoomRequest): string | null {
  if (!dateIsValid(request.date) || !validTime(request.time)) return null;
  const [year, month, day] = request.date.split("-").map(Number);
  const [hour, minute] = request.time.split(":").map(Number);
  const targetWallClock = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (let deltaHours = -36; deltaHours <= 36; deltaHours += 6) {
    offsets.add(offsetAt(new Date(targetWallClock + deltaHours * 60 * 60_000)));
  }

  const matches: Array<{ instant: Date; offsetMinutes: number }> = [];
  for (const offsetMinutes of offsets) {
    const instant = new Date(targetWallClock - offsetMinutes * 60_000);
    const local = localPartsAt(instant);
    if (local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute) {
      matches.push({ instant, offsetMinutes });
    }
  }
  if (matches.length !== 1) return null;

  const offsetMinutes = matches[0]?.offsetMinutes;
  const instant = matches[0]?.instant;
  if (offsetMinutes === undefined || !instant) return null;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  const localDate = `${formatDate(year, month, day)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  return `${localDate}${offset}`;
}

export function roomRequestSummary(request: RoomRequest): string {
  const parts: string[] = [];
  if (dateIsValid(request.date)) {
    const [year, month, day] = request.date.split("-");
    parts.push(`am ${day}.${month}.${year}`);
  } else if (request.date) {
    parts.push("mit ungeklärtem Datum");
  }
  if (validTime(request.time)) parts.push(`um ${request.time} Uhr`);
  else if (request.time) parts.push("mit ungeklärter Uhrzeit");
  if (request.durationMinutes && request.durationMinutes > 0) parts.push(`für ${request.durationMinutes} Minuten`);
  else if (request.durationMinutes !== undefined) parts.push("mit ungeklärter Dauer");
  if (request.capacity && request.capacity > 0) parts.push(`für ${request.capacity} Personen`);
  else if (request.capacity !== undefined) parts.push("mit ungeklärter Personenzahl");
  if (request.features?.includes(INVALID)) parts.push("mit ungeklärter Ausstattung");
  else if (request.features?.length) parts.push(`mit ${request.features.join(" und ")}`);
  if (request.location) parts.push(`in ${request.location === INVALID ? "ungeklärtem Standort" : request.location}`);
  if (request.query) parts.push(`für „${request.query}“`);
  const label = request.kind === 'workplace' ? 'Arbeitsplatzsuche' : request.kind === 'lecture_hall' ? 'Hörsaalsuche' : request.kind === 'meeting_room' ? 'Besprechungsraumsuche' : 'Raumsuche';
  const summary = parts.length ? `${label} ${parts.join(", ")}.` : `${label}: Nenne mir den gewünschten Zeitraum.`;
  return request.kind === 'workplace' ? `${summary} Jede Buchung reserviert genau einen Arbeitsplatz; weitere Plätze wählst und bestätigst du separat.` : summary;
}
