import "server-only";

import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@hasi/plugin-sdk";
import type { JsonStore } from "@hasi/state";
import { z } from "zod";
import { expectedModelToolName } from "./authorized-tools";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 1_024;
const MAX_ARGUMENT_BYTES = 16 * 1_024;
const MAX_RESULT_BYTES = 32 * 1_024;
const MAX_RESULT_CHARS = 8_000;
const MAX_CONTEXT_IDS = 32;
const SIGNING_DOMAIN = "hasi-plugin-result-context-record-v1";
const KEY_INFO = "hasi-plugin-result-context-hmac-key-v1";
const SAFE_INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const DATA_CLASSES = ["synthetic_demo", "public", "internal", "confidential"] as const;
const INPUT_FIELDS = ["conversationId", "callId", "pluginId", "toolName", "title", "arguments", "result", "authorityDigest", "dataClasses"] as const;
const STORED_FIELDS = ["id", "ownerId", "scope", "conversationId", "callId", "pluginId", "modelName", "toolName", "title", "arguments", "result", "authorityDigest", "dataClasses", "issuedAt", "expiresAt", "signature"] as const;
const STORE_ENTRY_FIELDS = ["revision", "value"] as const;

const nonemptyBoundedString = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0 && !CONTROL_CHARACTERS.test(value));

const inputSchema = z.strictObject({
  conversationId: z.uuid(),
  callId: nonemptyBoundedString(128),
  pluginId: z.string().regex(SAFE_INSTALLATION_ID),
  toolName: nonemptyBoundedString(256),
  title: nonemptyBoundedString(256),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  dataClasses: z.array(z.enum(DATA_CLASSES)).min(1).max(4)
    .refine(values => new Set(values).size === values.length),
});

const storedRecordSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.string().min(1).max(256),
  scope: z.string().min(1).max(512),
  conversationId: z.uuid(),
  callId: nonemptyBoundedString(128),
  pluginId: z.string().regex(SAFE_INSTALLATION_ID),
  modelName: z.string().regex(/^hasi_[a-f0-9]{24}$/u),
  toolName: nonemptyBoundedString(256),
  title: nonemptyBoundedString(256),
  arguments: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  dataClasses: z.array(z.enum(DATA_CLASSES)).min(1).max(4)
    .refine(values => new Set(values).size === values.length),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

type StoredRecord = z.infer<typeof storedRecordSchema>;
export type PluginResultContext = Omit<StoredRecord, "id" | "ownerId" | "scope" | "signature"> & {
  readonly contextId: string;
};

export interface PluginResultContextInput {
  readonly conversationId: string;
  readonly callId: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly title: string;
  readonly arguments: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly authorityDigest: string;
  readonly dataClasses: readonly (typeof DATA_CLASSES)[number][];
}

export interface PluginResultContextStoreOptions {
  readonly store: Pick<JsonStore, "read" | "compareAndSet">;
  readonly ownerId: string;
  readonly scope: string;
  readonly secret: string;
  readonly clock?: () => number;
}

export type PluginResultResolution =
  | { readonly contextId: string; readonly status: "valid"; readonly context: PluginResultContext }
  | { readonly contextId: string; readonly status: "unavailable" };

export class PluginResultContextError extends Error {
  constructor() {
    super("The plugin result context is unavailable.");
    this.name = "PluginResultContextError";
  }
}

interface JsonBudget {
  nodes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly ancestors: Set<object>;
}

interface JsonMetrics {
  readonly bytes: number;
  readonly chars: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function budget(maxNodes = MAX_JSON_NODES, maxDepth = MAX_JSON_DEPTH): JsonBudget {
  return { nodes: 0, maxNodes, maxDepth, ancestors: new Set<object>() };
}

/** Reads a strict record through property descriptors; accessors are never evaluated. */
function ownDataRecord(value: unknown, expectedFields: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedFields.length || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const expected = new Set(expectedFields);
    const result = Object.create(null) as Record<string, unknown>;
    for (const name of names) {
      if (!expected.has(name)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function validBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim().length > 0 && !CONTROL_CHARACTERS.test(value);
}

function validUuidText(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && z.uuid().safeParse(value).success;
}

function validPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && SAFE_INSTALLATION_ID.test(value);
}

function validAuthorityDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/iu.test(value);
}

function validDataClasses(value: unknown): value is (typeof DATA_CLASSES)[number][] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > DATA_CLASSES.length) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names.at(-1) !== "length" || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string"
      || !DATA_CLASSES.includes(descriptor.value as (typeof DATA_CLASSES)[number])
      || seen.has(descriptor.value)) return false;
    seen.add(descriptor.value);
  }
  return true;
}

function ownStringArray(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names.at(-1) !== "length" || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function boundedJsonString(value: string, maxBytes: number, maxChars: number): JsonMetrics | undefined {
  let bytes = 2;
  let chars = 2;
  if (bytes > maxBytes || chars > maxChars) return undefined;
  const add = (characterCount: number, byteCount: number): boolean => {
    chars += characterCount;
    bytes += byteCount;
    return chars <= maxChars && bytes <= maxBytes;
  };

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      if (!add(2, 2)) return undefined;
    } else if (code <= 0x1f) {
      if ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) {
        if (!add(2, 2)) return undefined;
      } else if (!add(6, 6)) return undefined;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        if (!add(2, 4)) return undefined;
      } else if (!add(6, 6)) return undefined;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (!add(6, 6)) return undefined;
    } else if (!add(1, code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3)) return undefined;
  }
  return { bytes, chars };
}

/** Measures canonical JSON without constructing the serialized string. */
function measureCanonicalJson(
  value: unknown,
  depth: number,
  budget: JsonBudget,
  maxBytes: number,
  maxChars: number,
): JsonMetrics | undefined {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes || depth > budget.maxDepth) return undefined;
  if (value === null) return { bytes: 4, chars: 4 };
  if (value === true) return { bytes: 4, chars: 4 };
  if (value === false) return { bytes: 5, chars: 5 };
  if (typeof value === "string") return boundedJsonString(value, maxBytes, maxChars);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const numberJson = JSON.stringify(value);
    return numberJson.length <= maxChars && numberJson.length <= maxBytes
      ? { bytes: numberJson.length, chars: numberJson.length }
      : undefined;
  }
  if (typeof value !== "object" || budget.ancestors.has(value)) return undefined;

  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > budget.maxNodes - budget.nodes) return undefined;
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || names.at(-1) !== "length" || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
      let chars = 2 + Math.max(0, value.length - 1);
      let bytes = chars;
      if (chars > maxChars || bytes > maxBytes) return undefined;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
        const child = measureCanonicalJson(descriptor.value, depth + 1, budget, maxBytes - bytes, maxChars - chars);
        if (!child) return undefined;
        chars += child.chars;
        bytes += child.bytes;
      }
      return { bytes, chars };
    }

    if (!isPlainRecord(value)) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length > budget.maxNodes - budget.nodes || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    let chars = 2 + Math.max(0, names.length - 1) + names.length;
    let bytes = chars;
    if (chars > maxChars || bytes > maxBytes) return undefined;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      const key = boundedJsonString(name, maxBytes - bytes, maxChars - chars);
      if (!key) return undefined;
      chars += key.chars;
      bytes += key.bytes;
      const child = measureCanonicalJson(descriptor.value, depth + 1, budget, maxBytes - bytes, maxChars - chars);
      if (!child) return undefined;
      chars += child.chars;
      bytes += child.bytes;
    }
    return { bytes, chars };
  } finally {
    budget.ancestors.delete(value);
  }
}

function preflightInput(fields: Record<string, unknown>): boolean {
  if (!validUuidText(fields.conversationId)
    || !validBoundedText(fields.callId, 128)
    || !validPluginId(fields.pluginId)
    || !validBoundedText(fields.toolName, 256)
    || !validBoundedText(fields.title, 256)
    || !validAuthorityDigest(fields.authorityDigest)
    || !validDataClasses(fields.dataClasses)
    || !isPlainRecord(fields.arguments) || !isPlainRecord(fields.result)) return false;

  const payloadBudget = budget();
  if (!measureCanonicalJson(fields.arguments, 0, payloadBudget, MAX_ARGUMENT_BYTES, Number.MAX_SAFE_INTEGER)
    || !measureCanonicalJson(fields.result, 0, payloadBudget, MAX_RESULT_BYTES, MAX_RESULT_CHARS)) return false;
  return payloadBudget.nodes + INPUT_FIELDS.length - 1 <= MAX_JSON_NODES;
}

function preflightStoredRecord(
  fields: Record<string, unknown>,
  expected: { readonly ownerId: string; readonly scope: string; readonly conversationId: string; readonly contextId: string; readonly authorityDigest: string },
): boolean {
  if (!validUuidText(fields.id) || fields.id.toLowerCase() !== expected.contextId
    || !validBoundedText(fields.ownerId, 256) || fields.ownerId !== expected.ownerId
    || !validBoundedText(fields.scope, 512) || fields.scope !== expected.scope
    || !validUuidText(fields.conversationId) || fields.conversationId.toLowerCase() !== expected.conversationId
    || !validBoundedText(fields.callId, 128)
    || !validPluginId(fields.pluginId)
    || typeof fields.modelName !== "string" || fields.modelName.length !== 29 || !/^hasi_[a-f0-9]{24}$/u.test(fields.modelName)
    || !validBoundedText(fields.toolName, 256)
    || !validBoundedText(fields.title, 256)
    || !validAuthorityDigest(fields.authorityDigest)
    || normalizedDigest(fields.authorityDigest) !== expected.authorityDigest
    || !validDataClasses(fields.dataClasses)
    || typeof fields.issuedAt !== "number" || !Number.isSafeInteger(fields.issuedAt) || fields.issuedAt < 0
    || typeof fields.expiresAt !== "number" || !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt < 1
    || typeof fields.signature !== "string" || fields.signature.length !== 43 || !/^[A-Za-z0-9_-]{43}$/u.test(fields.signature)
    || !isPlainRecord(fields.arguments) || !isPlainRecord(fields.result)
    || fields.modelName !== expectedModelToolName(fields.pluginId, fields.toolName)) return false;

  const payloadBudget = budget();
  if (!measureCanonicalJson(fields.arguments, 0, payloadBudget, MAX_ARGUMENT_BYTES, Number.MAX_SAFE_INTEGER)
    || !measureCanonicalJson(fields.result, 0, payloadBudget, MAX_RESULT_BYTES, MAX_RESULT_CHARS)) return false;
  return payloadBudget.nodes + STORED_FIELDS.length - 1 <= MAX_JSON_NODES;
}

function canonicalRecord(value: unknown): { readonly record: Record<string, unknown>; readonly json: string } | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const json = canonicalJson(value);
    const parsed: unknown = JSON.parse(json);
    if (!isPlainRecord(parsed)) return undefined;
    return { record: parsed, json };
  } catch {
    return undefined;
  }
}

function cloneRecord<T extends object>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function normalizedDigest(value: string): string {
  return value.toLowerCase();
}

function unsigned(record: StoredRecord): Omit<StoredRecord, "signature"> {
  const fields: Record<string, unknown> = { ...record };
  delete fields.signature;
  return fields as Omit<StoredRecord, "signature">;
}

/**
 * Stores signed snapshots of already-authorized read-tool results. This class
 * records context only; callers must perform read authorization and all current
 * host authority checks before calling create.
 */
export class PluginResultContextStore {
  private readonly key: Buffer;
  private readonly clock: () => number;

  constructor(options: PluginResultContextStoreOptions) {
    try {
      if (typeof options.ownerId !== "string" || options.ownerId.length < 1 || options.ownerId.length > 256
        || options.ownerId.trim().length === 0 || CONTROL_CHARACTERS.test(options.ownerId)
        || typeof options.scope !== "string" || options.scope.length < 1 || options.scope.length > 512
        || options.scope.trim().length === 0 || CONTROL_CHARACTERS.test(options.scope)
        || typeof options.secret !== "string" || options.secret.length < 1 || options.secret.length > 4_096
        || options.secret.trim().length === 0) throw new PluginResultContextError();
      this.clock = options.clock ?? Date.now;
      const salt = canonicalJson([options.ownerId, options.scope]);
      this.key = Buffer.from(hkdfSync(
        "sha256",
        Buffer.from(options.secret, "utf8"),
        Buffer.from(salt, "utf8"),
        Buffer.from(KEY_INFO, "utf8"),
        32,
      ));
      this.store = options.store;
      this.ownerId = options.ownerId;
      this.scope = options.scope;
    } catch {
      throw new PluginResultContextError();
    }
  }

  private readonly store: Pick<JsonStore, "read" | "compareAndSet">;
  private readonly ownerId: string;
  private readonly scope: string;

  async create(input: PluginResultContextInput): Promise<{ readonly contextId: string }> {
    try {
      const rawFields = ownDataRecord(input, INPUT_FIELDS);
      if (!rawFields || !preflightInput(rawFields)) throw new PluginResultContextError();
      const source = canonicalRecord(rawFields);
      if (!source) throw new PluginResultContextError();
      const parsed = inputSchema.safeParse(source.record);
      if (!parsed.success) throw new PluginResultContextError();

      const issuedAt = this.clock();
      const expiresAt = issuedAt + RETENTION_MS;
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)) throw new PluginResultContextError();

      const id = randomUUID();
      const recordFields = {
        id,
        ownerId: this.ownerId,
        scope: this.scope,
        conversationId: parsed.data.conversationId.toLowerCase(),
        callId: parsed.data.callId,
        pluginId: parsed.data.pluginId,
        modelName: expectedModelToolName(parsed.data.pluginId, parsed.data.toolName),
        toolName: parsed.data.toolName,
        title: parsed.data.title,
        arguments: cloneRecord(parsed.data.arguments),
        result: cloneRecord(parsed.data.result),
        authorityDigest: normalizedDigest(parsed.data.authorityDigest),
        dataClasses: [...parsed.data.dataClasses],
        issuedAt,
        expiresAt,
      };
      const record: StoredRecord = { ...recordFields, signature: this.signature(recordFields) };
      const committed = await this.store.compareAndSet(this.storageKey(record.conversationId, id), null, cloneRecord(record), expiresAt);
      if (!committed) throw new PluginResultContextError();
      return { contextId: id };
    } catch {
      throw new PluginResultContextError();
    }
  }

  async resolve(
    conversationId: string,
    contextIds: readonly string[],
    currentAuthorityDigest: string,
  ): Promise<readonly PluginResultResolution[]> {
    try {
      const rawContextIds: unknown = contextIds;
      const rawAuthorityDigest: unknown = currentAuthorityDigest;
      const contextIdsCopy = ownStringArray(rawContextIds, MAX_CONTEXT_IDS);
      if (!validUuidText(conversationId) || !contextIdsCopy || contextIdsCopy.some(id => !validUuidText(id))
        || typeof rawAuthorityDigest !== "string" || rawAuthorityDigest.length !== 64 || !/^[a-f0-9]{64}$/iu.test(rawAuthorityDigest)) {
        throw new PluginResultContextError();
      }
      const normalizedContextIds = contextIdsCopy.map(contextId => contextId.toLowerCase());
      if (new Set(normalizedContextIds).size !== normalizedContextIds.length) throw new PluginResultContextError();

      const normalizedConversationId = conversationId.toLowerCase();
      const authorityDigest = normalizedDigest(rawAuthorityDigest);
      const records = await Promise.all(normalizedContextIds.map(async id => {
        const stored = await this.store.read(this.storageKey(normalizedConversationId, id));
        if (!stored) return { contextId: id, record: undefined };
        const storeEntry = ownDataRecord(stored, STORE_ENTRY_FIELDS);
        if (!storeEntry || !validBoundedText(storeEntry.revision, 128)) return { contextId: id, record: undefined };
        const rawRecord = ownDataRecord(storeEntry.value, STORED_FIELDS);
        if (!rawRecord || !preflightStoredRecord(rawRecord, {
          ownerId: this.ownerId,
          scope: this.scope,
          conversationId: normalizedConversationId,
          contextId: id,
          authorityDigest,
        })) return { contextId: id, record: undefined };
        const source = canonicalRecord(rawRecord);
        const parsed = source ? storedRecordSchema.safeParse(source.record) : undefined;
        return { contextId: id, record: parsed?.success ? parsed.data : undefined };
      }));

      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new PluginResultContextError();
      return records.map(({ contextId, record }) => {
        if (record?.id.toLowerCase() !== contextId
          || record.ownerId !== this.ownerId || record.scope !== this.scope
          || record.conversationId.toLowerCase() !== normalizedConversationId
          || record.authorityDigest !== authorityDigest
          || record.issuedAt > now || record.expiresAt <= now
          || record.expiresAt <= record.issuedAt || record.expiresAt - record.issuedAt > RETENTION_MS
          || record.modelName !== expectedModelToolName(record.pluginId, record.toolName)
          || !this.verify(record)) return { contextId, status: "unavailable" } as const;

        const contextFields: Record<string, unknown> = { ...record };
        const id = contextFields.id;
        delete contextFields.id;
        delete contextFields.ownerId;
        delete contextFields.scope;
        delete contextFields.signature;
        if (typeof id !== "string") return { contextId, status: "unavailable" } as const;
        const context = { contextId: id, ...contextFields } as PluginResultContext;
        return { contextId, status: "valid", context: cloneRecord(context) } as const;
      });
    } catch {
      throw new PluginResultContextError();
    }
  }

  private signature(fields: Omit<StoredRecord, "signature">): string {
    return createHmac("sha256", this.key)
      .update(canonicalJson({ domain: SIGNING_DOMAIN, record: fields }), "utf8")
      .digest("base64url");
  }

  private verify(record: StoredRecord): boolean {
    try {
      const actual = Buffer.from(record.signature, "base64url");
      const expected = Buffer.from(this.signature(unsigned(record)), "base64url");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private storageKey(conversationId: string, contextId: string): string {
    const partition = createHmac("sha256", this.key)
      .update(canonicalJson({ domain: "hasi-plugin-result-context-storage-v1", conversationId }), "utf8")
      .digest("hex");
    return `plugin-result-context:v1:${partition}:${contextId}`;
  }
}
