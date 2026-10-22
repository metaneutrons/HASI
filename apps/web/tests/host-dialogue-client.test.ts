import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseRoomDialogueResponse } from "../src/lib/host-dialogue-client";
import { createHostDialogueSigner, handleHostDialoguePost } from "../src/lib/server/host-dialogue";

const origin = "https://hasi.example.edu";
const desk = { id: "desk", serviceId: "synthetic-anny", name: "Synthetic desk", capacity: 1, location: "1J", description: "", features: [] };
async function response() {
  const conversationId = randomUUID();
  const result = await handleHostDialoguePost(new Request(origin + "/api/chat/dialogue", { method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "rooms", conversationId, request: { location: "1J" } }) }), {
    allowedOrigins: [origin], signer: createHostDialogueSigner("synthetic-only-secret", "synthetic-owner"),
    authority: () => Promise.resolve("a".repeat(64)), bookingsEmpty: () => Promise.resolve(true),
    resources: () => Promise.resolve([desk]),
  });
  expect(result.status).toBe(200);
  return await result.json() as { plan: { code: string | null; text: string; resources: unknown[]; total: number; needsAvailability: boolean }; message: { text: string; hostDialogue: { code: string; resourceIds: string[] } } };
}

describe("host dialogue response boundary", () => {
  it("reads the real server result and rejects mixed text, candidate IDs, codes and invalid availability handoffs", async () => {
    const result = await response();
    expect(parseRoomDialogueResponse(result).plan.code).toBe("room_details");
    expect(parseRoomDialogueResponse(result).plan.resources).toEqual([]);
    expect(result.message.hostDialogue.resourceIds).toEqual([]);
    expect(() => parseRoomDialogueResponse({ ...result, message: { ...result.message, text: "FORGED" } })).toThrow();
    expect(() => parseRoomDialogueResponse({ ...result, message: { ...result.message,
      hostDialogue: { ...result.message.hostDialogue, resourceIds: ["another-desk"] } } })).toThrow();
    expect(() => parseRoomDialogueResponse({ ...result, plan: { ...result.plan, code: "greeting" } })).toThrow();
    expect(() => parseRoomDialogueResponse({ plan: { ...result.plan, code: null, resources: [], total: 0, needsAvailability: true } })).toThrow();
    expect(() => parseRoomDialogueResponse({ ...result, plan: { ...result.plan, resources: [desk, desk], total: 2 } })).toThrow();
  });
});
