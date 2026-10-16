import { describe, expect, it } from "vitest";
import { knowledgeDocumentHref, knowledgeDocumentSchema, searchKnowledge } from "../src/lib/knowledge";

const document = { id: "svc-001", citationId: "demo:knowledge:service-it:001", title: "Demo: WLAN", sourceSystem: "service_it", language: "de", revision: 1, synthetic: true, text: "SYNTHETISCHES DEMO-BEISISPIEL: Testdaten." };
describe("authenticated knowledge bridge", () => {
  it("calls the registered MCP tool and never accepts a source URL from the tool", async () => {
    const requests: unknown[] = [];
    const request = <T>(path: string, init?: RequestInit) => { requests.push({ path, body: JSON.parse(String(init?.body)) as unknown }); return Promise.resolve({ documents: [document] } as T); };
    expect((await searchKnowledge(request, { query: "WLAN", limit: 5 })).documents[0]?.id).toBe("svc-001");
    expect(requests).toEqual([{ path: "/api/tools/call", body: { pluginId: "de.hsh.hasi.knowledge", name: "knowledge.search", arguments: { query: "WLAN", limit: 3 } } }]);
    const forged = <T>() => Promise.resolve({ documents: [{ ...document, url: "https://example.invalid/export" }] } as T);
    await expect(searchKnowledge(forged, { query: "WLAN" })).rejects.toThrow();
    expect(knowledgeDocumentSchema.safeParse({ ...document, citationId: "demo:knowledge:intranet:001" }).success).toBe(false);
  });
  it("builds links from strict document IDs only", () => {
    expect(knowledgeDocumentHref("int-013")).toBe("/sources/int-013");
    for (const id of ["javascript:alert(1)", "//example.invalid", "svc-001/../../admin"]) expect(() => knowledgeDocumentHref(id)).toThrow();
  });
});
