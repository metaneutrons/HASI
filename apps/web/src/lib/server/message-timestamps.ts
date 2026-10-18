import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const KEY_INFO = "hasi-chat-message-times-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TimestampMessage {
  id?: string | undefined;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
}

export interface MessageTimestamp {
  createdAt: string;
  receipt: string;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Message contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Message contains a non-plain object");
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new TypeError("Message contains a non-JSON value");
}

function canonicalMessage(scope: string, message: TimestampMessage, createdAt: string): string {
  if (!UUID_PATTERN.test(message.id ?? "")) throw new TypeError("Message id must be a UUID");
  if (!["user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string") {
    throw new TypeError("Message is malformed");
  }
  if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) {
    throw new TypeError("Message tool calls are malformed");
  }
  if (message.toolCalls?.some((call) =>
    typeof call.id !== "string" || typeof call.name !== "string" ||
    !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)
  )) {
    throw new TypeError("Message tool calls are malformed");
  }
  if (message.toolCallId !== undefined && typeof message.toolCallId !== "string") {
    throw new TypeError("Message tool call id is malformed");
  }
  if (message.name !== undefined && typeof message.name !== "string") {
    throw new TypeError("Message name is malformed");
  }

  return JSON.stringify([
    scope,
    message.id,
    message.role,
    message.content,
    canonicalize(message.toolCalls ?? null),
    message.toolCallId ?? null,
    message.name ?? null,
    createdAt,
  ]);
}

function canonicalUtcTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function decodeReceipt(receipt: string): Buffer | null {
  if (typeof receipt !== "string" || !RECEIPT_PATTERN.test(receipt)) return null;
  const decoded = Buffer.from(receipt, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === receipt ? decoded : null;
}

export function createMessageClock(
  secret: string,
  scope: string,
  now: () => Date = () => new Date(),
): {
  stamp(message: TimestampMessage): MessageTimestamp;
  verify(message: TimestampMessage, timestamp: MessageTimestamp | undefined): string | null;
} {
  if (typeof secret !== "string" || secret.length === 0) throw new TypeError("Message timestamp secret is required");
  if (typeof scope !== "string" || scope.length === 0) throw new TypeError("Message timestamp scope is required");

  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from(KEY_INFO, "utf8"),
    32,
  ));
  const receiptFor = (message: TimestampMessage, createdAt: string): string =>
    createHmac("sha256", key).update(canonicalMessage(scope, message, createdAt), "utf8").digest("base64url");

  return {
    stamp(message) {
      const date = now();
      if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError("Clock returned an invalid date");
      const createdAt = date.toISOString();
      return { createdAt, receipt: receiptFor(message, createdAt) };
    },
    verify(message, timestamp) {
      try {
        if (!timestamp || !canonicalUtcTimestamp(timestamp.createdAt)) return null;
        const decodedReceipt = decodeReceipt(timestamp.receipt);
        if (!decodedReceipt) return null;
        const timestampMs = Date.parse(timestamp.createdAt);
        const currentDate = now();
        if (!(currentDate instanceof Date) || !Number.isFinite(currentDate.getTime()) || timestampMs > currentDate.getTime()) {
          return null;
        }
        const expectedReceipt = Buffer.from(receiptFor(message, timestamp.createdAt), "base64url");
        return timingSafeEqual(decodedReceipt, expectedReceipt) ? timestamp.createdAt : null;
      } catch {
        return null;
      }
    },
  };
}
