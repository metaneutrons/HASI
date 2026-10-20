import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../apps/web/node_modules/server-only", () => ({}));
const canonicalJsonSpy = vi.hoisted(() => vi.fn<(value: unknown) => void>());
vi.mock("@hasi/plugin-sdk", async importOriginal => {
  const original = await importOriginal<typeof import("@hasi/plugin-sdk")>();
  return {
    ...original,
    canonicalJson: (value: unknown) => {
      canonicalJsonSpy(value);
      return original.canonicalJson(value);
    },
  };
});

import { MemoryJsonStore, type JsonStore } from "@hasi/state";

interface PluginResultContextInput {
  readonly conversationId: string;
  readonly callId: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly title: string;
  readonly arguments: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly authorityDigest: string;
  readonly dataClasses: ("synthetic_demo" | "public" | "internal" | "confidential")[];
}

interface ResolvedContext {
  readonly contextId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly pluginId: string;
  readonly modelName: string;
  readonly toolName: string;
  readonly title: string;
  readonly arguments: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly authorityDigest: string;
  readonly dataClasses: ("synthetic_demo" | "public" | "internal" | "confidential")[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

type Resolution =
  | { readonly contextId: string; readonly status: "valid"; readonly context: ResolvedContext }
  | { readonly contextId: string; readonly status: "unavailable" };

interface TestStoreOptions {
  readonly store: Pick<JsonStore, "read" | "compareAndSet">;
  readonly ownerId: string;
  readonly scope: string;
  readonly secret: string;
  readonly clock?: () => number;
}

interface ContextStoreInstance {
  create(input: PluginResultContextInput): Promise<{ readonly contextId: string }>;
  resolve(conversationId: string, contextIds: readonly string[], currentAuthorityDigest: string): Promise<readonly Resolution[]>;
}

interface ContextStoreModule {
  readonly PluginResultContextError: new () => Error;
  readonly PluginResultContextStore: new (options: TestStoreOptions) => ContextStoreInstance;
}

const contextStoreModuleUrl = new URL("../apps/web/src/lib/server/plugin-result-context.ts", import.meta.url).href;
const { PluginResultContextError, PluginResultContextStore } = await import(contextStoreModuleUrl) as unknown as ContextStoreModule;

const OWNER = "user:fabian@example.invalid";
const SCOPE = "production:" + OWNER;
const SECRET = "test-only-plugin-result-context-secret";
const CONVERSATION_ID = "c8e19d86-02e7-45d6-bc3a-f71a488b18a1";
const AUTHORITY = "a".repeat(64);
const OTHER_AUTHORITY = "b".repeat(64);
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function expectedModelToolName(pluginId: string, name: string): string {
  const digest = createHash("sha256").update(pluginId).update("\u0000").update(name).digest("hex").slice(0, 24);
  return `hasi_${digest}`;
}

function makeInput(overrides: Partial<PluginResultContextInput> = {}): PluginResultContextInput {
  return {
    conversationId: CONVERSATION_ID,
    callId: "tool-call-7",
    pluginId: "de.hsh.hasi.anny",
    toolName: "search_resources",
    title: "Search resources",
    arguments: { query: "available rooms", filters: { capacity: 6 } },
    result: { resources: [{ id: "room-a", name: "Raum A" }] },
    authorityDigest: AUTHORITY,
    dataClasses: ["public"],
    ...overrides,
  };
}

function makeStoreOptions(store: Pick<JsonStore, "read" | "compareAndSet">, overrides: Partial<{
  ownerId: string;
  scope: string;
  secret: string;
  clock: () => number;
}> = {}) {
  return {
    store,
    ownerId: OWNER,
    scope: SCOPE,
    secret: SECRET,
    clock: () => NOW,
    ...overrides,
  };
}

interface StoreOptions {
  readonly namespace?: string;
  readonly clock?: () => number;
}

function createMemoryStore(options: StoreOptions = {}) {
  return new MemoryJsonStore(options.namespace ?? "plugin-result-context-tests", { clock: options.clock ?? (() => NOW) });
}

class TransformingStore implements Pick<JsonStore, "read" | "compareAndSet"> {
  transform: ((value: unknown) => unknown) | undefined;

  constructor(readonly backing: MemoryJsonStore) {}

  async read(key: string) {
    const value = await this.backing.read(key);
    if (!value || !this.transform) return value;
    return { ...value, value: this.transform(value.value) };
  }

  compareAndSet(key: string, expectedRevision: string | null, value: unknown, expiresAt?: number) {
    return this.backing.compareAndSet(key, expectedRevision, value, expiresAt);
  }
}

function recordWith(value: unknown, change: (record: Record<string, unknown>) => void): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  change(record);
  return record;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

describe("PluginResultContextStore", () => {
  let now: number;
  let backing: MemoryJsonStore;

  beforeEach(() => {
    now = NOW;
    backing = createMemoryStore({ clock: () => now });
  });

  it("resolves an immutable signed result across instances sharing owner, scope, secret, and store", async () => {
    const first = new PluginResultContextStore(makeStoreOptions(backing));
    const second = new PluginResultContextStore(makeStoreOptions(backing));
    const input = makeInput();
    const { contextId } = await first.create(input);

    const resolution = required((await second.resolve(CONVERSATION_ID, [contextId], AUTHORITY))[0]);
    expect(resolution.status).toBe("valid");
    if (resolution.status !== "valid") throw new Error("Expected a valid signed context.");
    expect(resolution.context).toMatchObject({
      contextId,
      conversationId: CONVERSATION_ID,
      callId: input.callId,
      pluginId: input.pluginId,
      modelName: expectedModelToolName(input.pluginId, input.toolName),
      toolName: input.toolName,
      title: input.title,
      arguments: input.arguments,
      result: input.result,
      authorityDigest: AUTHORITY,
      dataClasses: ["public"],
      issuedAt: NOW,
      expiresAt: NOW + RETENTION_MS,
    });
    expect("ownerId" in resolution.context).toBe(false);
    expect("scope" in resolution.context).toBe(false);

    resolution.context.result.resources = [{ id: "mutated", name: "Mutated" }];
    const reread = required((await first.resolve(CONVERSATION_ID, [contextId], AUTHORITY))[0]);
    expect(reread.status).toBe("valid");
    if (reread.status === "valid") expect(reread.context.result).toEqual(input.result);
  });

  it("isolates contexts by owner, scope, conversation, and signing secret", async () => {
    const creator = new PluginResultContextStore(makeStoreOptions(backing));
    const { contextId } = await creator.create(makeInput());
    const otherOwner = new PluginResultContextStore(makeStoreOptions(backing, { ownerId: "user:other@example.invalid" }));
    const otherScope = new PluginResultContextStore(makeStoreOptions(backing, { scope: "production:other" }));
    const otherKey = new PluginResultContextStore(makeStoreOptions(backing, { secret: "another-separate-test-secret" }));
    const otherConversation = randomUUID();

    for (const store of [otherOwner, otherScope, otherKey]) {
      expect(await store.resolve(CONVERSATION_ID, [contextId], AUTHORITY)).toEqual([{ contextId, status: "unavailable" }]);
    }
    expect(await creator.resolve(otherConversation, [contextId], AUTHORITY)).toEqual([{ contextId, status: "unavailable" }]);
  });

  it("returns unavailable for payload or signature tampering without exposing the result", async () => {
    const transforming = new TransformingStore(backing);
    const store = new PluginResultContextStore(makeStoreOptions(transforming));
    const sensitiveFixture = "sensitive-result-fixture-4a732d";
    const { contextId } = await store.create(makeInput({ result: { answer: sensitiveFixture } }));

    transforming.transform = value => recordWith(value, record => {
      record.result = { answer: "changed-payload" };
    });
    const payloadTampered = await store.resolve(CONVERSATION_ID, [contextId], AUTHORITY);
    expect(payloadTampered).toEqual([{ contextId, status: "unavailable" }]);
    expect(JSON.stringify(payloadTampered)).not.toContain(sensitiveFixture);

    transforming.transform = value => recordWith(value, record => {
      record.signature = "A".repeat(43);
    });
    const signatureTampered = await store.resolve(CONVERSATION_ID, [contextId], AUTHORITY);
    expect(signatureTampered).toEqual([{ contextId, status: "unavailable" }]);
    expect(JSON.stringify(signatureTampered)).not.toContain(sensitiveFixture);
  });

  it("returns unavailable after authority changes or the retention window expires", async () => {
    const store = new PluginResultContextStore(makeStoreOptions(backing, { clock: () => now }));
    const { contextId } = await store.create(makeInput());

    expect(await store.resolve(CONVERSATION_ID, [contextId], OTHER_AUTHORITY)).toEqual([{ contextId, status: "unavailable" }]);
    now += RETENTION_MS;
    expect(await store.resolve(CONVERSATION_ID, [contextId], AUTHORITY)).toEqual([{ contextId, status: "unavailable" }]);
  });

  it("rejects malformed constructor, create, and resolve inputs with one static error", async () => {
    expect(() => new PluginResultContextStore(makeStoreOptions(backing, { ownerId: " " }))).toThrow(
      "The plugin result context is unavailable.",
    );
    expect(() => new PluginResultContextStore(makeStoreOptions(backing, { scope: "x".repeat(513) }))).toThrow(
      PluginResultContextError,
    );

    const store = new PluginResultContextStore(makeStoreOptions(backing));
    const invalidInputs = [
      makeInput({ conversationId: "not-a-uuid" }),
      makeInput({ callId: "invalid\u0000call" }),
      makeInput({ pluginId: "unsafe/plugin" }),
      makeInput({ authorityDigest: "not-a-digest" }),
      makeInput({ dataClasses: ["public", "public"] }),
      { ...makeInput(), unexpected: true } as PluginResultContextInput,
    ];
    for (const input of invalidInputs) {
      await expect(store.create(input)).rejects.toMatchObject({
        name: "PluginResultContextError",
        message: "The plugin result context is unavailable.",
      });
    }
    await expect(store.resolve("bad-conversation", [], AUTHORITY)).rejects.toBeInstanceOf(PluginResultContextError);
    const duplicateId = randomUUID();
    await expect(store.resolve(CONVERSATION_ID, [duplicateId, duplicateId], AUTHORITY)).rejects.toBeInstanceOf(PluginResultContextError);
    await expect(store.resolve(CONVERSATION_ID, [], "bad-authority")).rejects.toBeInstanceOf(PluginResultContextError);
  });

  it("rejects oversize arguments, oversize results, and JSON deeper than the bounded walk", async () => {
    const store = new PluginResultContextStore(makeStoreOptions(backing));
    canonicalJsonSpy.mockClear();
    await expect(store.create(makeInput({ arguments: { value: "a".repeat(16 * 1_024) } }))).rejects.toBeInstanceOf(PluginResultContextError);
    expect(canonicalJsonSpy).not.toHaveBeenCalled();
    canonicalJsonSpy.mockClear();
    await expect(store.create(makeInput({ result: { value: "a".repeat(8_000) } }))).rejects.toBeInstanceOf(PluginResultContextError);
    expect(canonicalJsonSpy).not.toHaveBeenCalled();

    let nested: unknown = "leaf";
    for (let index = 0; index < 13; index += 1) nested = { child: nested };
    await expect(store.create(makeInput({ arguments: { nested } }))).rejects.toBeInstanceOf(PluginResultContextError);
    await expect(store.create(makeInput({ arguments: { nodes: Array.from({ length: 1_024 }, () => null) } })))
      .rejects.toBeInstanceOf(PluginResultContextError);
  });

  it("preflights raw objects before canonicalization without invoking getters or toJSON", async () => {
    const store = new PluginResultContextStore(makeStoreOptions(backing));
    let getterCalls = 0;
    let toJsonCalls = 0;

    const topLevelGetter = makeInput();
    Object.defineProperty(topLevelGetter, "title", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "getter title";
      },
    });
    canonicalJsonSpy.mockClear();
    await expect(store.create(topLevelGetter)).rejects.toBeInstanceOf(PluginResultContextError);
    expect(getterCalls).toBe(0);
    expect(canonicalJsonSpy).not.toHaveBeenCalled();

    const result = { answer: "safe" } as Record<string, unknown>;
    Object.defineProperty(result, "toJSON", {
      enumerable: true,
      value: () => {
        toJsonCalls += 1;
        return { answer: "unsafe" };
      },
    });
    canonicalJsonSpy.mockClear();
    await expect(store.create(makeInput({ result }))).rejects.toBeInstanceOf(PluginResultContextError);
    expect(toJsonCalls).toBe(0);
    expect(canonicalJsonSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized stored records before canonicalizing or exposing their payload", async () => {
    const creator = new PluginResultContextStore(makeStoreOptions(backing));
    const sensitiveFixture = "stored-sensitive-fixture-91b2";
    const { contextId } = await creator.create(makeInput({ result: { answer: sensitiveFixture } }));
    const transforming = new TransformingStore(backing);
    const resolver = new PluginResultContextStore(makeStoreOptions(transforming));
    let deeplyNested: unknown = "leaf";
    for (let index = 0; index < 13; index += 1) deeplyNested = { child: deeplyNested };
    const invalidResults = [
      { answer: "x".repeat(40 * 1_024) },
      { nested: deeplyNested },
      { values: Array.from({ length: 1_024 }, () => null) },
    ];

    for (const invalidResult of invalidResults) {
      transforming.transform = value => recordWith(value, record => {
        record.result = invalidResult;
      });
      canonicalJsonSpy.mockClear();
      const resolution = await resolver.resolve(CONVERSATION_ID, [contextId], AUTHORITY);
      expect(resolution).toEqual([{ contextId, status: "unavailable" }]);
      expect(JSON.stringify(resolution)).not.toContain(sensitiveFixture);
      // The only canonicalization here is the small, fixed-shape storage-key partition.
      expect(canonicalJsonSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects storage accessors without reading their values", async () => {
    const creator = new PluginResultContextStore(makeStoreOptions(backing));
    const { contextId } = await creator.create(makeInput());
    let getterCalls = 0;
    const accessorStore: Pick<JsonStore, "read" | "compareAndSet"> = {
      async read(key) {
        const entry = await backing.read(key);
        if (!entry) return undefined;
        const raw: { revision: string; value: unknown } = { revision: entry.revision, value: undefined };
        return Object.defineProperty(raw, "value", {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return entry.value;
          },
        });
      },
      compareAndSet: (...args) => backing.compareAndSet(...args),
    };
    const resolver = new PluginResultContextStore(makeStoreOptions(accessorStore));

    const resolution = await resolver.resolve(CONVERSATION_ID, [contextId], AUTHORITY);
    expect(resolution).toEqual([{ contextId, status: "unavailable" }]);
    expect(getterCalls).toBe(0);
  });

  it("turns storage failures into a static error without returning the storage error body", async () => {
    const privateError = "backend failure with sensitive fixture 82a91";
    const broken: Pick<JsonStore, "read" | "compareAndSet"> = {
      read: () => Promise.reject(new Error(privateError)),
      compareAndSet: () => Promise.reject(new Error(privateError)),
    };
    const store = new PluginResultContextStore(makeStoreOptions(broken));

    await expect(store.create(makeInput())).rejects.toMatchObject({
      message: "The plugin result context is unavailable.",
    });
    await expect(store.resolve(CONVERSATION_ID, [randomUUID()], AUTHORITY)).rejects.toMatchObject({
      message: "The plugin result context is unavailable.",
    });
    try {
      await store.resolve(CONVERSATION_ID, [randomUUID()], AUTHORITY);
    } catch (error) {
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain(privateError);
    }
  });
});
