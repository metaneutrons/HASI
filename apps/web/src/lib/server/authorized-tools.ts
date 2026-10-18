import "server-only";

import { createHash } from "node:crypto";
import { testSafeJsonSchemaPattern } from "@hasi/plugin-sdk/schema-pattern";
import { canonicalDemoRequest, getDemoRuntime } from "./demo-runtime";
import { ModelRouterError } from "./model-router-error";
import {
  isBoundedJsonSchema,
  isObjectSchema,
  parsePluginTools,
  type PluginToolDescriptor,
} from "../plugin-tools";

export type { PluginToolDescriptor } from "../plugin-tools";

const MAX_TOOL_RESPONSE_BYTES = 128 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
const MAX_JSON_NODES = 512;

const KNOWN_TOOL_ALIASES = new Map<string, string>([
  ["de.hsh.hasi.knowledge\u0000knowledge.search", "knowledge_search"],
  ["de.hsh.hasi.anny\u0000anny.search_resources", "anny_search_resources"],
  ["de.hsh.hasi.anny\u0000anny.get_availability", "anny_get_availability"],
  ["de.hsh.hasi.anny\u0000anny.list_my_bookings", "anny_list_my_bookings"],
  ["de.hsh.hasi.anny\u0000anny.propose_booking", "anny_propose_booking"],
  ["de.hsh.hasi.anny\u0000anny.propose_cancellation", "anny_propose_cancellation"],
]);

export function knownToolAlias(tool: Pick<PluginToolDescriptor, "pluginId" | "name">): string | undefined {
  return KNOWN_TOOL_ALIASES.get(`${tool.pluginId}\u0000${tool.name}`);
}

export function expectedModelToolName(pluginId: string, name: string): string {
  const digest = createHash("sha256").update(pluginId).update("\u0000").update(name).digest("hex").slice(0, 24);
  return `hasi_${digest}`;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TOOL_RESPONSE_BYTES) throw new Error("size");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_TOOL_RESPONSE_BYTES) throw new Error("size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function toolsUnavailable(): ModelRouterError {
  return new ModelRouterError("tools_unavailable", "Authorized model tools could not be verified.");
}

/** Fetch the current authenticated registry view using only the server-owned API destination. */
export async function loadAuthorizedModelTools(request: Request): Promise<PluginToolDescriptor[]> {
  try {
    let response: Response;
    if (process.env.HASI_DEMO_MODE === "1") {
      const canonical = canonicalDemoRequest(new Request(request.url, { method: "GET", headers: request.headers }));
      if (!canonical) throw toolsUnavailable();
      const url = new URL("/api/tools", canonical.url);
      const headers = new Headers();
      const cookie = canonical.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
      response = await (await getDemoRuntime()).handleCore(new Request(url, { method: "GET", headers }));
    } else {
      const headers = new Headers();
      const cookie = request.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
      response = await fetch("http://127.0.0.1:4100/api/tools", {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
    }
    if (!response.ok) throw toolsUnavailable();
    const parsed = parsePluginTools(await readJsonBounded(response));
    if (!parsed || parsed.some(tool => tool.modelName !== expectedModelToolName(tool.pluginId, tool.name))) throw toolsUnavailable();
    return parsed;
  } catch (cause) {
    if (cause instanceof ModelRouterError) throw cause;
    throw toolsUnavailable();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValueWithinBounds(value: unknown): boolean {
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    count += 1;
    if (count > MAX_JSON_NODES || depth > 12) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 8_000;
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => visit(child, depth + 1));
    if (!isRecord(item)) return false;
    const entries = Object.entries(item);
    return entries.length <= 128 && entries.every(([key, child]) => key.length <= 256 && key !== "__proto__" && visit(child, depth + 1));
  };
  return visit(value, 0);
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]));
}

function matchesSchema(schema: Record<string, unknown>, value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  const type = schema.type;
  if (typeof type === "string") {
    const matchesType = type === "object" ? isRecord(value)
      : type === "array" ? Array.isArray(value)
        : type === "string" ? typeof value === "string"
          : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
            : type === "number" ? typeof value === "number" && Number.isFinite(value)
              : type === "boolean" ? typeof value === "boolean"
                : type === "null" ? value === null
                  : false;
    if (!matchesType) return false;
  } else if (Array.isArray(type)) {
    if (!type.some(candidate => typeof candidate === "string" && matchesSchema({ ...schema, type: candidate }, value, depth + 1))) return false;
  }

  if ("const" in schema && !equalJson(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => equalJson(value, candidate))) return false;

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const entries = schema[keyword];
    if (!Array.isArray(entries) || entries.length > 32) continue;
    const count = entries.filter(candidate => isRecord(candidate) && matchesSchema(candidate, value, depth + 1)).length;
    if (keyword === "allOf" && count !== entries.length) return false;
    if (keyword === "anyOf" && count < 1) return false;
    if (keyword === "oneOf" && count !== 1) return false;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && Array.from(value).length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && Array.from(value).length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      if (!testSafeJsonSchemaPattern(schema.pattern, value)) return false;
    }
    if (schema.format === "date-time" && (!Number.isFinite(Date.parse(value)) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value))) return false;
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (isRecord(schema.items) && !value.every(item => matchesSchema(schema.items as Record<string, unknown>, item, depth + 1))) return false;
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(index + 1).some(other => equalJson(item, other)))) return false;
  }
  if (isRecord(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") return false;
      if (Object.hasOwn(properties, key)) {
        const childSchema = properties[key];
        if (!isRecord(childSchema) || !matchesSchema(childSchema, child, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (isRecord(schema.additionalProperties) && !matchesSchema(schema.additionalProperties, child, depth + 1)) return false;
    }
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return false;
  }
  return true;
}

export function validatePluginToolArguments(tool: PluginToolDescriptor, input: unknown): input is Record<string, unknown> {
  if (!isRecord(input) || !jsonValueWithinBounds(input) || !isBoundedJsonSchema(tool.inputSchema) || !isObjectSchema(tool.inputSchema)) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_TOOL_ARGUMENT_BYTES) return false;
  } catch { return false; }
  return matchesSchema(tool.inputSchema, input);
}
