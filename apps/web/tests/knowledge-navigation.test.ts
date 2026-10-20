import { describe, expect, it } from "vitest";
import { knowledgeChatReturnHref, knowledgeOrigin, knowledgeReturnLocation } from "../src/lib/knowledge-navigation";

const sessionId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const messageId = "6ba7b810-9dad-41d1-80b4-00c04fd430c9";

describe("knowledge reader return navigation", () => {
  it("builds a fixed local return route and recovers both identifiers", () => {
    const origin = knowledgeOrigin(sessionId, messageId);
    const href = knowledgeChatReturnHref(origin);
    expect(href).toBe(`/?chat=${sessionId}#message-${messageId}`);
    expect(knowledgeReturnLocation(new URL(href, "https://hasi.example.invalid"))).toEqual(origin);
  });

  it("uses the chat root for direct visits and rejects URL-shaped or ambiguous metadata", () => {
    expect(knowledgeChatReturnHref()).toBe("/");
    for (const value of ["https://attacker.example", "//attacker.example", "../admin", `${sessionId}&next=/admin`, [sessionId]]) {
      expect(knowledgeOrigin(value, messageId)).toBeUndefined();
      expect(knowledgeOrigin(sessionId, value)).toBeUndefined();
    }
    expect(knowledgeReturnLocation({ search: `?chat=${sessionId}&chat=${sessionId}`, hash: `#message-${messageId}` })).toBeUndefined();
    expect(knowledgeReturnLocation({ search: `?chat=${sessionId}`, hash: `#message-${messageId}/admin` })).toBeUndefined();
    expect(knowledgeReturnLocation({ search: `?chat=${sessionId}`, hash: "#other" })).toBeUndefined();
  });
});
