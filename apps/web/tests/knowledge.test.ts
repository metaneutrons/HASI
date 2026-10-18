import { knowledgeManifest } from "@hasi/knowledge-plugin";
import { isBoundedJsonSchema } from "../src/lib/plugin-tools";
import { describe, expect, it } from "vitest";
import { knowledgeDocumentHref, knowledgeDocumentSchema, knowledgeModelDocuments, searchKnowledge } from "../src/lib/knowledge";

const document = { updatedAt: "2026-10-16T00:00:00Z", fetchedAt: "2026-10-16T00:00:00Z", authorityRevision: "a".repeat(64), corpusRevision: "b".repeat(64), dataClass: "synthetic_demo", images: [], id: "svc-001", citationId: "knowledge:service_it:svc-001:1", title: "Demo: WLAN", sourceSystem: "service_it", language: "de", revision: 1, synthetic: true, text: "SYNTHETISCHES DEMO-BEISISPIEL: Testdaten." };

function parseRequestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  const parsed: unknown = JSON.parse(init.body);
  return parsed;
}

describe("authenticated knowledge bridge", () => {
  it("keeps the current MCP manifest inside the web host schema dialect", () => {
    for (const tool of knowledgeManifest.tools) {
      expect(isBoundedJsonSchema(tool.inputSchema)).toBe(true);
      expect(isBoundedJsonSchema(tool.outputSchema)).toBe(true);
    }
    expect(knowledgeManifest.manifestVersion).toBe(2);
    expect(knowledgeManifest.tools.find(tool => tool.name === "knowledge.get_document")?.visibility).toEqual(["app"]);
  });
  it("bounds model evidence without truncating provenance records or citations", () => {
    const docs = Array.from({ length: 3 }, () => ({ ...document, text: "\u0000".repeat(4000), images: [{ alt: "\u0000".repeat(500), transcript: "\u0000".repeat(1000) }] }));
    const projected = knowledgeModelDocuments(docs);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(7000);
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.every(item => item.citationId === document.citationId)).toBe(true);
  });
  it("calls the registered MCP tool and never accepts a source URL from the tool", async () => {
    const requests: unknown[] = [];
    const request = <T>(path: string, init?: RequestInit) => { requests.push({ path, body: parseRequestBody(init) }); return Promise.resolve({ documents: [document] } as T); };
    expect((await searchKnowledge(request, { query: "WLAN", limit: 5 })).documents[0]?.id).toBe("svc-001");
    expect(requests).toEqual([{ path: "/api/tools/call", body: { pluginId: "de.hsh.hasi.knowledge", name: "knowledge.search", arguments: { query: "WLAN", limit: 3 } } }]);
    const forged = <T>() => Promise.resolve({ documents: [{ ...document, url: "https://example.invalid/export" }] } as T);
    await expect(searchKnowledge(forged, { query: "WLAN" })).rejects.toThrow();
    expect(knowledgeDocumentSchema.safeParse({ ...document, citationId: "knowledge:intranet:int-001:1" }).success).toBe(false);
  });
  it("builds links from strict document IDs only", () => {
    expect(knowledgeDocumentHref("int-013")).toBe("/sources/int-013");
    for (const id of ["javascript:alert(1)", "//example.invalid", "svc-001/../../admin"]) expect(() => knowledgeDocumentHref(id)).toThrow();
  });
});
