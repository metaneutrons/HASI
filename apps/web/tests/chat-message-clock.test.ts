import { describe, expect, it, vi } from "vitest";
import { createChatMessageClock } from "../src/lib/chat-message-clock";
import type { MessageTimestamp, WireMessage } from "../src/lib/chat-contract";

const SERVER_TIME = "2026-10-17T11:22:33.456Z";
const RECEIPT = "R".repeat(43);
const SERVER_TIMESTAMP: MessageTimestamp = { createdAt: SERVER_TIME, receipt: RECEIPT };

function responseFor(messages: WireMessage[]) {
  return {
    timestamps: messages.map((message) => ({ id: message.id!, timestamp: SERVER_TIMESTAMP })),
  };
}

describe("chat message clock", () => {
  it("stamps only tracked fresh events and keeps generated IDs on the tracked objects", async () => {
    const request = vi.fn(async (messages: WireMessage[]) => responseFor(messages));
    const clock = createChatMessageClock(request);
    const priorTimestamp = { createdAt: "2026-10-16T09:00:00.000Z", receipt: "P".repeat(43) };
    const existing: WireMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      role: "user",
      content: "Already recorded",
      timestamp: priorTimestamp,
    };
    const legacyHistory: WireMessage[] = [{ role: "user", content: "Legacy message" }];
    const fresh: WireMessage = { role: "user", content: "New message" };
    const untracked: WireMessage = { role: "assistant", content: "Untracked response" };

    clock.track(existing);
    clock.track(fresh);
    const generatedId = fresh.id;
    expect(generatedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(clock.track(fresh)).toBe(fresh);
    expect(fresh.id).toBe(generatedId);

    const stamped = await clock.flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0].map((message) => message.id)).toEqual([generatedId]);
    expect(stamped.get(generatedId!)).toEqual(SERVER_TIMESTAMP);
    expect(fresh.timestamp).toEqual(SERVER_TIMESTAMP);
    expect(existing.timestamp).toEqual(priorTimestamp);
    expect(legacyHistory[0]!.timestamp).toBeUndefined();
    expect(untracked.timestamp).toBeUndefined();
  });

  it("sends timestamp requests in batches of at most sixteen", async () => {
    const request = vi.fn(async (messages: WireMessage[]) => responseFor(messages));
    const clock = createChatMessageClock(request);
    const messages = Array.from({ length: 33 }, (_, index) =>
      clock.track<WireMessage>({ role: "user", content: `Message ${index}` }),
    );

    const stamped = await clock.flush();

    expect(request.mock.calls.map(([batch]) => batch.length)).toEqual([16, 16, 1]);
    expect(stamped.size).toBe(33);
    expect(messages.every((message) => message.timestamp?.createdAt === SERVER_TIME)).toBe(true);
  });

  it("bounds UTF-8 bytes and removes a stale pending key after coalescing", async () => {
    const request = vi.fn(async (messages: WireMessage[]) => responseFor(messages));
    const clock = createChatMessageClock(request);
    for (let index = 0; index < 5; index++) clock.track<WireMessage>({ role: "tool", name: "knowledge_search", toolCallId: `tool-${index}`, content: "界".repeat(8000) });
    await clock.flush();
    expect(request.mock.calls.map(([batch]) => batch.length)).toEqual([2, 2, 1]);
    expect(request.mock.calls.every(([batch]) => new TextEncoder().encode(JSON.stringify({ messages: batch })).byteLength < 60_000)).toBe(true);
    request.mockClear();
    const combined: WireMessage = { role: "assistant", content: "First" };
    clock.track(combined);
    combined.id = "55555555-5555-4555-8555-555555555555";
    combined.content += " Second";
    clock.track(combined);
    await clock.flush();
    expect(request.mock.calls[0]![0]).toHaveLength(1);
    expect(request.mock.calls[0]![0][0]!.id).toBe(combined.id);
  });

  it.each(["mismatched", "duplicate"] as const)("rejects %s response IDs", async (kind) => {
    const firstId = "22222222-2222-4222-8222-222222222222";
    const secondId = "33333333-3333-4333-8333-333333333333";
    const otherId = "44444444-4444-4444-8444-444444444444";
    const request = vi.fn(async () => ({
      timestamps: kind === "mismatched"
        ? [
            { id: firstId, timestamp: SERVER_TIMESTAMP },
            { id: otherId, timestamp: SERVER_TIMESTAMP },
          ]
        : [
            { id: firstId, timestamp: SERVER_TIMESTAMP },
            { id: firstId, timestamp: SERVER_TIMESTAMP },
            { id: secondId, timestamp: SERVER_TIMESTAMP },
          ],
    }));
    const clock = createChatMessageClock(request);
    const first: WireMessage = { id: firstId, role: "user", content: "First" };
    const second: WireMessage = { id: secondId, role: "user", content: "Second" };
    clock.track(first);
    clock.track(second);

    await expect(clock.flush()).rejects.toThrow();
    expect(first.timestamp).toBeUndefined();
    expect(second.timestamp).toBeUndefined();
  });

  it("leaves events unstamped when the service is unavailable and drops them from the next flush", async () => {
    const request = vi.fn(async () => {
      throw new Error("timestamp service unavailable");
    });
    const clock = createChatMessageClock(request);
    const message: WireMessage = { role: "user", content: "Pending timestamp" };
    clock.track(message);

    await expect(clock.flush()).rejects.toThrow("timestamp service unavailable");
    expect(message.timestamp).toBeUndefined();

    expect(await clock.flush()).toEqual(new Map());
    expect(request).toHaveBeenCalledTimes(1);
    expect(message.timestamp).toBeUndefined();
  });
});
