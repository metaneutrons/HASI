import { CHAT_TOOL_NAMES, chatToolSchemas } from "../chat-contract";

const CODES = ["tool_use_failed", "json_validate_failed", "invalid_api_key", "model_not_found", "rate_limit_exceeded", "context_length_exceeded"] as const;
const FIELDS = ["capacity", "features", "location", "query", "resourceId", "date", "time", "durationMinutes", "startDate", "endDate"] as const;
type ProviderCode = typeof CODES[number];
export interface GroqErrorDiagnostics { providerCode?: ProviderCode; tool?: typeof CHAT_TOOL_NAMES[number]; format?: "json" | "tagged" | "unknown"; argumentIssues?: { code: string; fields: string[] }[] }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Return only allowlisted metadata. Never return response text or argument values. */
export function groqErrorDiagnostics(responseBody: string | undefined): GroqErrorDiagnostics {
  if (!responseBody || responseBody.length > 64_000) return {};
  try {
    const payload: unknown = JSON.parse(responseBody);
    if (!record(payload) || !record(payload.error)) return {};
    const error = payload.error;
    const result: GroqErrorDiagnostics = {};
    if (CODES.includes(error.code as ProviderCode)) result.providerCode = error.code as ProviderCode;
    const generated = typeof error.failed_generation === "string"
      ? error.failed_generation
      : record(error.failed_generation) ? JSON.stringify(error.failed_generation) : undefined;
    if (!generated || generated.length > 20_000) return result;
    const tool = CHAT_TOOL_NAMES.find((name) => generated.includes(name));
    if (tool !== undefined) result.tool = tool;
    const first = generated.indexOf("{");
    const last = generated.lastIndexOf("}");
    if (first < 0 || last < first) { result.format = "unknown"; return result; }
    let body: unknown;
    try { body = JSON.parse(generated.slice(first, last + 1)); }
    catch { result.format = "unknown"; return result; }
    result.format = first === 0 ? "json" : "tagged";
    if (!result.tool || !record(body)) return result;
    const callable = record(body.function) ? body.function : body;
    let args: unknown = callable.arguments ?? callable.parameters ?? callable.attempted_arguments ?? body;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { return result; } }
    const checked = chatToolSchemas[result.tool].safeParse(args);
    if (!checked.success) result.argumentIssues = checked.error.issues.slice(0, 10).map((issue) => ({
      code: issue.code,
      fields: FIELDS.filter((field) => issue.path.includes(field) || issue.code === "unrecognized_keys" && issue.keys.includes(field)),
    }));
    return result;
  } catch { return {}; }
}
