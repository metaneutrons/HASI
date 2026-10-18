/** Allowlisted, content-free provider quota diagnostics for server telemetry. */
export const GROQ_RATE_LIMIT_DIMENSIONS = ["TPM", "RPM", "TPD", "RPD"] as const;

export type GroqRateLimitDimension = (typeof GROQ_RATE_LIMIT_DIMENSIONS)[number];

export type GroqRateLimitDiagnostics = {
  tokenLimit?: number;
  tokenRemaining?: number;
  requestLimit?: number;
  requestRemaining?: number;
  retryAfterSeconds?: number;
  dimension?: GroqRateLimitDimension;
};

const MAX_COUNTER = 1_000_000_000_000;
const MAX_ERROR_BODY_CHARS = 8_192;
const MAX_ERROR_MESSAGE_CHARS = 2_048;
const MAX_RETRY_AFTER_CHARS = 128;
const MAX_DELTA_SECONDS_DIGITS = 15;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const COUNTER_HEADERS = {
  tokenLimit: "x-ratelimit-limit-tokens",
  tokenRemaining: "x-ratelimit-remaining-tokens",
  requestLimit: "x-ratelimit-limit-requests",
  requestRemaining: "x-ratelimit-remaining-requests",
} as const;

const DIMENSION_PATTERNS: ReadonlyArray<{
  dimension: GroqRateLimitDimension;
  patterns: readonly RegExp[];
}> = [
  { dimension: "TPM", patterns: [/\btokens\s+per\s+minute\b/iu, /\bTPM\b/iu] },
  { dimension: "RPM", patterns: [/\brequests\s+per\s+minute\b/iu, /\bRPM\b/iu] },
  { dimension: "TPD", patterns: [/\btokens\s+per\s+day\b/iu, /\bTPD\b/iu] },
  { dimension: "RPD", patterns: [/\brequests\s+per\s+day\b/iu, /\bRPD\b/iu] },
];

function parseCounter(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d{0,12})$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_COUNTER ? parsed : undefined;
}

function classifyDimension(errorBody: string | undefined): GroqRateLimitDimension | undefined {
  if (errorBody === undefined || errorBody.length === 0 || errorBody.length > MAX_ERROR_BODY_CHARS) return undefined;
  if (new TextEncoder().encode(errorBody).byteLength > MAX_ERROR_BODY_CHARS) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(errorBody);
  } catch {
    return undefined;
  }

  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.message !== "string") return undefined;
  const message = payload.error.message;
  if (message.length === 0 || message.length > MAX_ERROR_MESSAGE_CHARS) return undefined;

  const matches = DIMENSION_PATTERNS.filter(({ patterns }) => patterns.some((pattern) => pattern.test(message)));
  return matches.length === 1 ? matches[0]?.dimension : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null || value.length === 0 || value.length > MAX_RETRY_AFTER_CHARS) return undefined;

  if (/^\d+$/u.test(value)) {
    if (value.length > MAX_DELTA_SECONDS_DIGITS) return undefined;
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, seconds));
  }

  // Accept the canonical HTTP-date form. Requiring round-trip equality avoids
  // Date.parse accepting locale-specific or otherwise ambiguous date strings.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) return undefined;
  const targetTime = Date.parse(value);
  if (!Number.isFinite(targetTime) || new Date(targetTime).toUTCString() !== value || !Number.isFinite(now.getTime())) return undefined;
  const seconds = Math.ceil((targetTime - now.getTime()) / 1_000);
  return Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, seconds));
}

/**
 * Extract only quota counters, a bounded Retry-After delay, and a fixed quota
 * dimension enum. Provider error text and unknown response headers are dropped.
 */
export function parseGroqRateLimitDiagnostics(
  headers: HeadersInit,
  errorBody?: string,
  now: Date = new Date(),
): GroqRateLimitDiagnostics {
  let responseHeaders: Headers;
  try {
    responseHeaders = new Headers(headers);
  } catch {
    responseHeaders = new Headers();
  }

  const result: GroqRateLimitDiagnostics = {};
  for (const [field, header] of Object.entries(COUNTER_HEADERS) as Array<[keyof typeof COUNTER_HEADERS, string]>) {
    const count = parseCounter(responseHeaders.get(header));
    if (count !== undefined) result[field] = count;
  }

  const retryAfterSeconds = parseRetryAfter(responseHeaders.get("retry-after"), now);
  if (retryAfterSeconds !== undefined) result.retryAfterSeconds = retryAfterSeconds;

  const dimension = classifyDimension(errorBody);
  if (dimension !== undefined) result.dimension = dimension;

  return result;
}
