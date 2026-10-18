import type { ApiError } from "@/lib/types";

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw Object.assign(new Error("Der HASI-Dienst ist gerade nicht erreichbar."), {
      status: 0,
    }) as ApiError;
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "Die Anfrage konnte nicht verarbeitet werden.";
    const diagnostics = typeof payload === "object" && payload !== null && "code" in payload && payload.code === "configuration_invalid" && "errors" in payload && Array.isArray(payload.errors)
      ? payload.errors.slice(0, 32).flatMap((issue: unknown) => typeof issue === "object" && issue !== null && "path" in issue && typeof issue.path === "string" && "message" in issue && typeof issue.message === "string" ? [{ path: issue.path.slice(0, 512), message: issue.message.slice(0, 256) }] : [])
      : undefined;
    throw Object.assign(new Error(message), { status: response.status, ...(diagnostics ? { code: "configuration_invalid", errors: diagnostics } : {}) }) as ApiError;
  }
  return payload as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function getLocalDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toOffsetIso(localValue: string): string {
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) throw new Error("Bitte wähle eine gültige Uhrzeit.");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${localValue}:00${offset}`;
}

export function addMinutesToLocalValue(localValue: string, minutes: number): string {
  const date = new Date(localValue);
  date.setMinutes(date.getMinutes() + minutes);
  return getLocalDateTimeValue(date);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(date);
}
