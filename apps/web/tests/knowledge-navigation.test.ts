import { describe, expect, it } from "vitest";
import { knowledgeChatReturnHref, knowledgeCurrentRevisionHref, knowledgeOrigin, knowledgeRevisionQuery, knowledgeReturnLocation } from "../src/lib/knowledge-navigation";

const sessionId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const messageId = "6ba7b810-9dad-41d1-80b4-00c04fd430c9";
const documentId = "svc-exams-calendar";

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

describe("current source revision recovery navigation", () => {
  it("builds a same-origin current-version route and preserves validated chat return context", () => {
    const origin = knowledgeOrigin(sessionId, messageId);
    expect(knowledgeCurrentRevisionHref(documentId, 1, origin)).toBe(
      `/sources/${documentId}?fromRevision=1&chat=${sessionId}&message=${messageId}`,
    );
    expect(knowledgeCurrentRevisionHref(documentId, 1)).toBe(`/sources/${documentId}?fromRevision=1`);
  });

  it("rejects invalid document paths and non-positive or unsafe revisions", () => {
    for (const id of ["/admin", "../admin", "//attacker.example", "https://attacker.example", [documentId]]) {
      expect(knowledgeCurrentRevisionHref(id, 1)).toBeUndefined();
    }
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", [1]]) {
      expect(knowledgeCurrentRevisionHref(documentId, revision)).toBeUndefined();
    }
  });

  it("omits malformed origin metadata without accepting an external target", () => {
    for (const origin of [
      { sessionId: "https://attacker.example", messageId },
      { sessionId, messageId: "//attacker.example" },
      { sessionId, messageId, next: "/admin" },
      [sessionId, messageId],
    ]) {
      expect(knowledgeCurrentRevisionHref(documentId, 3, origin)).toBe(`/sources/${documentId}?fromRevision=3`);
    }
  });

  it("accepts only one positive safe-integer version parameter and rejects duplicate or ambiguous values", () => {
    expect(knowledgeRevisionQuery({})).toEqual({});
    expect(knowledgeRevisionQuery({ revision: "2" })).toEqual({ revision: 2 });
    expect(knowledgeRevisionQuery({ fromRevision: "2" })).toEqual({ fromRevision: 2 });

    for (const value of ["0", "-1", "1.5", "9007199254740992", ["2", "3"]]) {
      expect(knowledgeRevisionQuery({ revision: value })).toBeUndefined();
      expect(knowledgeRevisionQuery({ fromRevision: value })).toBeUndefined();
    }
    expect(knowledgeRevisionQuery({ revision: "2", fromRevision: "1" })).toBeUndefined();
  });
});
