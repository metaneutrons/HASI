import { describe, expect, it } from "vitest";
import {
  createMessageClock,
  type TimestampMessage,
} from "../src/lib/server/message-timestamps";

const FIXED_NOW = new Date("2026-10-17T10:11:12.123Z");
const SECRET = "test-only-message-timestamp-key";
const SCOPE = "account-session-hash:workspace-hash";

function makeMessage(overrides: Partial<TimestampMessage> = {}): TimestampMessage {
  return {
    id: "b1bf3dad-4d4d-4a67-9d98-aebca134f2ed",
    role: "user",
    content: "Find a room tomorrow",
    ...overrides,
  };
}

describe("message timestamp receipts", () => {
  it("verifies a UTC receipt from a fresh clock with the same key and scope", () => {
    const message = makeMessage();
    const receipt = createMessageClock(SECRET, SCOPE, () => FIXED_NOW).stamp(message);
    const verifier = createMessageClock(SECRET, SCOPE, () => FIXED_NOW);

    expect(receipt.createdAt).toBe("2026-10-17T10:11:12.123Z");
    expect(receipt.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier.verify(message, receipt)).toBe(receipt.createdAt);
    expect(verifier.verify(message, undefined)).toBeNull();
  });

  it("rejects messages or timestamps changed after signing", () => {
    const message = makeMessage({ id: "b1bf3dad-4d4d-4a67-9d98-aebca134f2ed" });
    const clock = createMessageClock(SECRET, SCOPE, () => FIXED_NOW);
    const receipt = clock.stamp(message);

    expect(clock.verify({ ...message, content: "Different content" }, receipt)).toBeNull();
    expect(clock.verify({ ...message, id: "b1bf3dad-4d4d-4a67-9d98-aebca134f2ee" }, receipt)).toBeNull();
    expect(clock.verify(message, { ...receipt, createdAt: "2026-10-17T12:11:12.123+02:00" })).toBeNull();
    expect(clock.verify(message, { ...receipt, createdAt: "2026-10-17T10:11:12.124Z" })).toBeNull();
    expect(clock.verify(message, { ...receipt, receipt: `${receipt.receipt.slice(0, -1)}!` })).toBeNull();
  });

  it("rejects future receipts and UUID-less messages", () => {
    const message = makeMessage();
    const futureReceipt = createMessageClock(
      SECRET,
      SCOPE,
      () => new Date("2026-10-17T10:11:13.000Z"),
    ).stamp(message);
    const currentClock = createMessageClock(SECRET, SCOPE, () => FIXED_NOW);

    expect(currentClock.verify(message, futureReceipt)).toBeNull();
    expect(() => currentClock.stamp({ ...message, id: undefined })).toThrow();
  });

  it("rejects receipts issued for another account or workspace scope", () => {
    const message = makeMessage();
    const receipt = createMessageClock(SECRET, SCOPE, () => FIXED_NOW).stamp(message);

    expect(createMessageClock(SECRET, "another-account:workspace-hash", () => FIXED_NOW).verify(message, receipt)).toBeNull();
    expect(createMessageClock("different-test-key", SCOPE, () => FIXED_NOW).verify(message, receipt)).toBeNull();
  });

  it("canonicalizes nested tool arguments regardless of object key order", () => {
    const message = makeMessage({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "anny_search_resources",
        arguments: { query: "seminar", filters: { capacity: 4, building: "A" } },
      }],
    });
    const reorderedMessage = makeMessage({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "anny_search_resources",
        arguments: { filters: { building: "A", capacity: 4 }, query: "seminar" },
      }],
    });
    const clock = createMessageClock(SECRET, SCOPE, () => FIXED_NOW);
    const receipt = clock.stamp(message);

    expect(clock.verify(reorderedMessage, receipt)).toBe(receipt.createdAt);
    expect(clock.verify({
      ...reorderedMessage,
      toolCalls: [{ ...reorderedMessage.toolCalls![0]!, arguments: { query: "seminar", filters: { capacity: 5, building: "A" } } }],
    }, receipt)).toBeNull();
  });
});
