import { actionPreviewSchema, type ActionPreview } from "./action-preview";
import { z } from "zod";
import { isSafeJsonSchemaPattern } from "@hasi/plugin-sdk/schema-pattern";

export const MODEL_PLUGIN_TOOL_NAME = /^hasi_[a-f0-9]{24}$/u;
export const MAX_PLUGIN_MODEL_TOOLS = 32;
export const MAX_PLUGIN_TOOL_CONTEXT_BYTES = 32 * 1024;
export const MAX_PLUGIN_TOOL_RESULT_CHARS = 8_000;
export const MAX_PLUGIN_TOOL_DISPLAY_CHARS = 1_200;

const instanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const toolIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const schemaObject = z.record(z.string(), z.unknown());

export const pluginToolDescriptorSchema = z.strictObject({
  pluginId: instanceIdSchema,
  name: toolIdSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(4_096),
  inputSchema: schemaObject,
  outputSchema: schemaObject,
  effect: z.enum(["read", "prepare"]),
  requiredPermissions: z.array(z.string().trim().min(1).max(256)).max(32),
  visibility: z.array(z.enum(["model", "app"])).min(1).max(2).optional(),
  presentationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).optional(),
  resultSemantics: z.strictObject({ kind: z.enum(["generic", "resources", "bookings", "knowledge", "proposal"]) }).optional(),
  modelName: z.string().regex(MODEL_PLUGIN_TOOL_NAME),
});

export type PluginToolDescriptor = z.infer<typeof pluginToolDescriptorSchema>;

export const pluginToolsResponseSchema = z.strictObject({
  tools: z.array(pluginToolDescriptorSchema).max(MAX_PLUGIN_MODEL_TOOLS),
}).superRefine(({ tools }, context) => {
  const modelNames = new Set<string>();
  const identities = new Set<string>();
  let schemaBytes = 0;

  tools.forEach((descriptor, index) => {
    if (!isBoundedJsonSchema(descriptor.inputSchema) || !isObjectSchema(descriptor.inputSchema)) {
      context.addIssue({ code: "custom", path: ["tools", index, "inputSchema"], message: "Tool input schema is invalid or exceeds its bounds." });
    }
    if (!isBoundedJsonSchema(descriptor.outputSchema) || !isObjectSchema(descriptor.outputSchema)) {
      context.addIssue({ code: "custom", path: ["tools", index, "outputSchema"], message: "Tool output schema is invalid or exceeds its bounds." });
    }
    if (modelNames.has(descriptor.modelName)) {
      context.addIssue({ code: "custom", path: ["tools", index, "modelName"], message: "Tool model names must be unique." });
    }
    modelNames.add(descriptor.modelName);
    const identity = `${descriptor.pluginId}\u0000${descriptor.name}`;
    if (identities.has(identity)) {
      context.addIssue({ code: "custom", path: ["tools", index], message: "Tool installation and name pairs must be unique." });
    }
    identities.add(identity);
    try {
      schemaBytes += new TextEncoder().encode(JSON.stringify({
        name: descriptor.name,
        modelName: descriptor.modelName,
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema,
      })).byteLength;
    } catch {
      schemaBytes = Number.POSITIVE_INFINITY;
    }
  });

  if (schemaBytes > MAX_PLUGIN_TOOL_CONTEXT_BYTES) {
    context.addIssue({ code: "custom", path: ["tools"], message: "Authorized tool definitions exceed the context size limit." });
  }
});

export interface PluginToolProposal {
  preview?: ActionPreview | undefined;
  action: "execute_tool";
  id: string;
  pluginId: string;
  executionTool: string;
  executionTitle?: string;
  executionDescription?: string;
  toolName: string;
  title: string;
  arguments: Record<string, unknown>;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "confirmed" | "outcome_unknown" | "failed";
  expiresAt: string;
}

const genericProposalSchema = z.strictObject({
  preview: actionPreviewSchema.optional(),
  action: z.literal("execute_tool"),
  id: z.uuid(),
  pluginId: instanceIdSchema,
  executionTool: toolIdSchema,
  executionTitle: z.string().trim().min(1).max(256).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Execution title contains unsupported control characters.",
  ).optional(),
  executionDescription: z.string().max(4_096).refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Execution description contains unsupported control characters.",
  ).optional(),
  arguments: schemaObject,
  resourceName: z.string().max(200),
  startDate: z.string().max(64),
  endDate: z.string().max(64),
  status: z.enum(["pending", "confirmed", "outcome_unknown", "failed"]),
  expiresAt: z.iso.datetime(),
});

export function parsePluginTools(value: unknown): PluginToolDescriptor[] | null {
  const parsed = pluginToolsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data.tools : null;
}

export function isObjectSchema(value: Record<string, unknown>): boolean {
  const type = value.type;
  return type === "object" || Array.isArray(type) && type.includes("object");
}

export function isBoundedJsonSchema(value: Record<string, unknown>): boolean {
  const schemaKeywords = new Set([
    "title", "description", "type", "properties", "required", "additionalProperties", "items",
    "enum", "const", "allOf", "anyOf", "oneOf", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
    "uniqueItems", "minProperties", "maxProperties", "default", "examples", "deprecated",
    "readOnly", "writeOnly",
  ]);
  const allowedTypes = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
  let visited = 0;
  const visitValue = (node: unknown, depth: number): boolean => {
    visited += 1;
    if (visited > 512 || depth > 12) return false;
    if (node === null || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node === "string") return node.length <= 16_384;
    if (Array.isArray(node)) return node.length <= 256 && node.every(item => visitValue(item, depth + 1));
    if (!isRecord(node)) return false;
    const entries = Object.entries(node);
    if (entries.length > 128) return false;
    return entries.every(([key, child]) => key.length <= 256 && visitValue(child, depth + 1));
  };
  const visitSchema = (node: unknown, depth: number): boolean => {
    visited += 1;
    if (visited > 512 || depth > 12 || !isRecord(node)) return false;
    const entries = Object.entries(node);
    if (entries.length > 128 || entries.some(([key]) => key.length > 256 || !schemaKeywords.has(key))) return false;

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.length === 0 || types.length > allowedTypes.size || types.some(type => typeof type !== "string" || !allowedTypes.has(type))) return false;
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 128 || node.required.some(name => typeof name !== "string" || name.length > 256))) return false;
    if (node.pattern !== undefined) {
      if (!isSafeJsonSchemaPattern(node.pattern)) return false;
    }
    if (node.format !== undefined && node.format !== "date" && node.format !== "date-time") return false;
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
      if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) return false;
    }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
      if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || Number(node[key]) < 0 || Number(node[key]) > 100_000)) return false;
    }
    if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") return false;
    for (const key of ["deprecated", "readOnly", "writeOnly"] as const) {
      if (node[key] !== undefined && typeof node[key] !== "boolean") return false;
    }
    for (const key of ["title", "description"] as const) {
      if (node[key] !== undefined && (typeof node[key] !== "string" || node[key].length > 4_096)) return false;
    }
    if (node.properties !== undefined) {
      if (!isRecord(node.properties) || Object.keys(node.properties).length > 128 || !Object.values(node.properties).every(child => visitSchema(child, depth + 1))) return false;
    }
    if (node.items !== undefined && !visitSchema(node.items, depth + 1)) return false;
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean" && !visitSchema(node.additionalProperties, depth + 1)) return false;
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length === 0 || node[key].length > 32 || !node[key].every(child => visitSchema(child, depth + 1)))) return false;
    }
    for (const key of ["enum", "examples"] as const) {
      if (node[key] !== undefined && (!Array.isArray(node[key]) || node[key].length > 128 || !node[key].every(child => visitValue(child, depth + 1)))) return false;
    }
    for (const key of ["const", "default"] as const) {
      if (node[key] !== undefined && !visitValue(node[key], depth + 1)) return false;
    }
    return true;
  };
  try {
    return visitSchema(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedString(value: string, maxLength: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}

interface JsonBounds {
  depth: number;
  nodes: number;
  stringLength: number;
  arrayLength: number;
  objectKeys: number;
}

function boundJson(value: unknown, bounds: JsonBounds, state = { nodes: 0 }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > bounds.nodes || depth >= bounds.depth) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return sanitizedString(value, bounds.stringLength);
  if (Array.isArray(value)) return value.slice(0, bounds.arrayLength).map(item => boundJson(item, bounds, state, depth + 1));
  if (!isRecord(value)) return "[unsupported]";
  const entries = Object.entries(value).slice(0, bounds.objectKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of entries) {
    const safeKey = sanitizedString(key, 96);
    if (safeKey === "__proto__" || safeKey === "constructor" || safeKey === "prototype") continue;
    result[safeKey] = boundJson(item, bounds, state, depth + 1);
  }
  if (Object.keys(value).length > entries.length) result.truncated = true;
  return result;
}

export function boundedPluginToolResult(value: unknown): Record<string, unknown> {
  const bounded = boundJson(value, { depth: 6, nodes: 240, stringLength: 1_200, arrayLength: 24, objectKeys: 32 });
  const result = isRecord(bounded) ? bounded : { value: bounded };
  let serialized = JSON.stringify(result);
  if (serialized.length > MAX_PLUGIN_TOOL_RESULT_CHARS) {
    serialized = JSON.stringify({ truncated: true, preview: serialized.slice(0, MAX_PLUGIN_TOOL_RESULT_CHARS - 96) });
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { truncated: true, preview: "Tool result exceeded the permitted size." };
  }
}

export function compactPluginToolResult(value: unknown, maximum = MAX_PLUGIN_TOOL_DISPLAY_CHARS): string {
  const result = boundedPluginToolResult(value);
  const serialized = JSON.stringify(result);
  return serialized.length <= maximum ? serialized : `${serialized.slice(0, maximum - 1)}…`;
}

export function parsePluginProposal(value: unknown, descriptor: PluginToolDescriptor): PluginToolProposal | null {
  return parsePluginProposalSnapshot(value, { pluginId: descriptor.pluginId, toolName: descriptor.name, title: descriptor.title }, true);
}

export function parsePluginProposalSnapshot(
  value: unknown,
  identity: Pick<PluginToolProposal, "pluginId" | "toolName" | "title">,
  pendingOnly = false,
): PluginToolProposal | null {
  if (!isRecord(value)) return null;
  const parsed = genericProposalSchema.safeParse(value.proposal);
  if (!parsed.success || parsed.data.pluginId !== identity.pluginId || pendingOnly && parsed.data.status !== "pending") return null;
  const arguments_ = boundedPluginToolResult(parsed.data.arguments);
  const argsText = JSON.stringify(arguments_);
  if (argsText.length > 8_000) return null;
  const { executionTitle, executionDescription, ...proposal } = parsed.data;
  return {
    ...proposal,
    ...(executionTitle === undefined ? {} : { executionTitle }),
    ...(executionDescription === undefined ? {} : { executionDescription }),
    arguments: arguments_,
    toolName: identity.toolName,
    title: identity.title,
  };
}

export interface PluginToolProposalPresentation {
  actionTitle: string;
  executionTool: string;
  pluginId: string;
  executionDescription?: string;
  preparationTitle: string;
  confirmLabel: string;
}

export function pluginToolProposalPresentation(proposal: PluginToolProposal): PluginToolProposalPresentation {
  const actionTitle = sanitizedString(proposal.executionTitle ?? proposal.executionTool, 256) || proposal.executionTool;
  return {
    actionTitle,
    executionTool: proposal.executionTool,
    pluginId: proposal.pluginId,
    ...(proposal.executionDescription === undefined
      ? {}
      : { executionDescription: sanitizedString(proposal.executionDescription, 800) }),
    preparationTitle: sanitizedString(proposal.title, 256),
    confirmLabel: actionTitle.length <= 48 ? `${actionTitle} bestätigen` : "Aktion bestätigen",
  };
}

function canonicalJson(value: unknown): string | null {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (Array.isArray(item)) return item.map(visit);
    if (!isRecord(item)) return null;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key])]));
  };
  try { return JSON.stringify(visit(value)); } catch { return null; }
}

export function samePluginProposalSnapshot(displayed: PluginToolProposal, authoritative: PluginToolProposal): boolean {
  return displayed.id === authoritative.id
    && displayed.pluginId === authoritative.pluginId
    && displayed.executionTool === authoritative.executionTool
    && displayed.executionTitle === authoritative.executionTitle
    && displayed.executionDescription === authoritative.executionDescription
    && JSON.stringify(displayed.preview ?? null) === JSON.stringify(authoritative.preview ?? null)
    && displayed.resourceName === authoritative.resourceName
    && displayed.startDate === authoritative.startDate
    && displayed.endDate === authoritative.endDate
    && displayed.expiresAt === authoritative.expiresAt
    && canonicalJson(displayed.arguments) !== null
    && canonicalJson(displayed.arguments) === canonicalJson(authoritative.arguments);
}
