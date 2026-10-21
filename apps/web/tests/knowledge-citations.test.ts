import { describe, expect, it } from "vitest";
import { knowledgeCitationFromDocument, knowledgeCitationHref, normalizeKnowledgeCitation } from "../src/lib/knowledge-citations";
import { knowledgeDocumentSchema } from "../src/lib/knowledge";

const document = knowledgeDocumentSchema.parse({
  updatedAt: "2026-10-16T00:00:00Z",
  fetchedAt: "2026-10-16T00:00:00Z",
  authorityRevision: "a".repeat(64),
  corpusRevision: "b".repeat(64),
  dataClass: "synthetic_demo",
  images: [],
  id: "svc-001",
  citationId: "knowledge:service_it:svc-001:1",
  title: "Demo: WLAN",
  sourceSystem: "service_it",
  language: "de",
  revision: 1,
  synthetic: true,
  text: "SYNTHETISCHES DEMO-BEISPIEL: Testdaten.",
});

const uuid = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

describe("knowledge citation mappings", () => {
  it("builds a citation only from a schema-valid document and host ordinal", () => {
    expect(knowledgeCitationFromDocument(document, 2)).toEqual({
      citationId: "knowledge:service_it:svc-001:1",
      id: "svc-001",
      title: "Demo: WLAN",
      sourceLabel: "Service IT",
      revision: 1,
      href: "/sources/svc-001?revision=1",
      number: 2,
    });
    expect(knowledgeCitationFromDocument({ ...document, citationId: "knowledge:service_it:svc-001:2" }, 2)).toBeUndefined();
    expect(knowledgeCitationFromDocument(document, 0)).toBeUndefined();
  });

  it("adds chat return context only when both supplied identifiers are UUIDs", () => {
    const citation = knowledgeCitationFromDocument(document, 1);
    expect(citation).toBeDefined();
    if (!citation) throw new Error("Expected the valid knowledge document to produce a citation.");
    expect(knowledgeCitationHref(citation, { sessionId: uuid, messageId: uuid })).toBe(
      `/sources/svc-001?revision=1&chat=${uuid}&message=${uuid}`,
    );
    expect(knowledgeCitationHref(citation, { sessionId: "../admin", messageId: uuid })).toBe("/sources/svc-001?revision=1");
  });

  it("ignores injected URLs and rejects invalid identity, ID, or revision", () => {
    const citation = knowledgeCitationFromDocument(document, 1);
    expect(citation).toBeDefined();
    if (!citation) throw new Error("Expected the valid knowledge document to produce a citation.");
    expect(normalizeKnowledgeCitation({ ...citation, href: "https://attacker.example/source" })).toMatchObject({
      href: "/sources/svc-001?revision=1",
    });
    expect(normalizeKnowledgeCitation({ ...citation, href: "/attacker", id: "/sources/svc-001" })).toBeUndefined();
    expect(normalizeKnowledgeCitation({ ...citation, citationId: "knowledge:service_it:svc-001:2" })).toBeUndefined();
    expect(normalizeKnowledgeCitation({ ...citation, revision: 0 })).toBeUndefined();
  });
});
