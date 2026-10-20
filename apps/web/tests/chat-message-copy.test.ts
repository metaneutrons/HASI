import { describe, expect, it } from "vitest";
import { chatMessageCopyText, chatMessageMarkdownSource } from "../src/lib/chat-message-copy";
import type { ChatMessage } from "../src/lib/chat-sessions";
import { knowledgeCitationFromDocument } from "../src/lib/knowledge-citations";

const origin = "https://hasi.example";
const message: ChatMessage = { id: "internal-message-id", role: "assistant", text: "Deine Ergebnisse.", model: "internal-model", interactionId: "internal-interaction" };
const sourceDocument = {
  updatedAt: "2026-10-16T00:00:00Z", fetchedAt: "2026-10-16T00:00:00Z",
  authorityRevision: "a".repeat(64), corpusRevision: "b".repeat(64), dataClass: "synthetic_demo" as const,
  images: [], id: "svc-001", title: "WLAN", citationId: "knowledge:service_it:svc-001:1",
  sourceSystem: "service_it" as const, language: "de" as const, revision: 1, synthetic: true,
  text: "Hidden retrieval context",
};
const citation = knowledgeCitationFromDocument(sourceDocument, 1);
if (!citation) throw new Error("Expected a valid knowledge citation.");

describe("message clipboard content", () => {
  it("returns exact Markdown source with leading, trailing and line-ending whitespace preserved", () => {
    const source = "    const ready = true;\n\nEin Satz.  \nFortsetzung.\r\n";
    expect(chatMessageMarkdownSource({ ...message, text: source })).toBe(source);
    expect(chatMessageCopyText({ ...message, text: source }, origin)).toBe(source);
  });

  it("copies plain text without message, model or interaction metadata", () => {
    expect(chatMessageCopyText({ ...message, text: "Hallo\n\nZweite Zeile." }, origin)).toBe("Hallo\n\nZweite Zeile.");
  });

  it("includes useful booking content without action labels or internal IDs", () => {
    const text = chatMessageCopyText({ ...message, bookings: [{ id: "private-booking-id", resourceName: "Grace Hopper", startDate: "2026-10-19T06:00:00Z", endDate: "2026-10-19T14:00:00Z", status: "canceled" }] }, origin);
    expect(text).toContain("Grace Hopper");
    expect(text).toContain("08:00 bis 16:00 Uhr");
    expect(text).toContain("Storniert");
    expect(text).not.toMatch(/private-booking-id|Stornierung beginnen|internal-/u);
  });

  it("includes source citations and navigable document links, not hidden source text", () => {
    const text = chatMessageCopyText({ ...message, sources: [sourceDocument] }, origin);
    expect(text).toContain("WLAN\nService IT · Demo · Fassung 1\nhttps://hasi.example/sources/svc-001?revision=1");
    expect(text).not.toContain(sourceDocument.citationId);
    expect(text).not.toContain("Hidden retrieval context");
  });

  it("copies authorized citation tokens as readable same-origin links and ignores supplied hrefs", () => {
    const source = `Die Anleitung erklärt den Zugang [${sourceDocument.citationId}].`;
    const text = chatMessageCopyText({ ...message, text: source }, origin, [{ ...citation, href: "https://attacker.example/redirect" }]);
    expect(text).toBe("Die Anleitung erklärt den Zugang [Quelle 1](https://hasi.example/sources/svc-001?revision=1).");
    expect(text).not.toContain(sourceDocument.citationId);
    expect(text).not.toContain("attacker.example");
  });

  it("replaces unmapped canonical citation tokens without linking or exposing their IDs", () => {
    const unknown = "[knowledge:service_it:svc-other:2]";
    const text = chatMessageCopyText({ ...message, text: `Prüfe die Quelle ${unknown}.` }, origin, [citation]);
    expect(text).toBe("Prüfe die Quelle [Quelle nicht zugeordnet].");
    expect(text).not.toContain(unknown);
  });

  it("leaves user-entered citation-looking text untouched", () => {
    const typed = `[${sourceDocument.citationId}]`;
    const text = chatMessageCopyText({ ...message, role: "user", text: typed }, origin, [citation]);
    expect(text).toBe(typed);
  });

  it("keeps caller-assigned duplicate citation numbers in copied Markdown links", () => {
    const second = knowledgeCitationFromDocument({
      ...sourceDocument,
      id: "svc-002", title: "VPN", citationId: "knowledge:service_it:svc-002:1", text: "Other hidden context",
    }, 1);
    if (!second) throw new Error("Expected a valid second knowledge citation.");
    const text = chatMessageCopyText({ ...message, text: `[${sourceDocument.citationId}] and [${second.citationId}]` }, origin, [citation, second]);
    expect(text).toBe("[Quelle 1](https://hasi.example/sources/svc-001?revision=1) and [Quelle 1](https://hasi.example/sources/svc-002?revision=1)");
  });

  it("does not copy source-card metadata from a citation that does not match the source revision", () => {
    const wrongRevision = { ...citation, revision: 2, citationId: "knowledge:service_it:svc-001:2" };
    const text = chatMessageCopyText({ ...message, sources: [sourceDocument] }, origin, [wrongRevision]);
    expect(text).not.toContain("WLAN\nService IT");
    expect(text).not.toContain(sourceDocument.citationId);
  });

  it("preserves raw Markdown source for the explicit source-view and Markdown-copy options", () => {
    const raw = `Anleitung [${sourceDocument.citationId}]`;
    expect(chatMessageMarkdownSource({ ...message, text: raw })).toBe(raw);
    expect(chatMessageCopyText({ ...message, text: raw }, origin, [citation])).toBe("Anleitung [Quelle 1](https://hasi.example/sources/svc-001?revision=1)");
  });

  it("copies an authorized completed card as a receipt, without stale preparation text or internal IDs", () => {
    const receipt: ChatMessage = { ...message, text: "STALE PREPARATION TEXT", proposal: {
      action: "cancel_booking", id: "private-proposal-id", resourceName: "Tisch 1",
      startDate: "2026-10-19T06:00:00Z", endDate: "2026-10-19T14:00:00Z",
      status: "confirmed", expiresAt: "2026-10-17T16:00:00Z",
    } };
    expect(chatMessageMarkdownSource(receipt)).toBe("Die Stornierung wurde bestätigt.");
    const text = chatMessageCopyText(receipt, origin);
    expect(text).toContain("Stornierung bestätigt\nTisch 1");
    expect(text).toContain("08:00 bis 16:00 Uhr");
    expect(text).not.toMatch(/STALE|private-|Bestätigung erforderlich|Stornierungsvorschlag/u);
  });

  it("distinguishes unchecked candidates from checked availability and pending proposals", () => {
    const resource = { id: "internal-resource", serviceId: "internal-service", name: "Tisch 1", description: "", location: "1J", features: [], capacity: null, kind: "workplace" as const, parentName: "Büro 1", officeWorkplaceCount: 2 };
    const candidate = chatMessageCopyText({ ...message, rooms: [{ resource, checked: false, intervals: [] }] }, origin);
    expect(candidate).toContain("Büro mit 2 Arbeitsplätzen");
    expect(candidate).toContain("Verfügbarkeit ungeprüft");
    expect(candidate).not.toMatch(/Freie Zeit|internal-/u);
    const proposal = chatMessageCopyText({ ...message, proposal: { action: "cancel_booking", id: "internal-proposal", resourceName: "Tisch 1", startDate: "2026-10-19T06:00:00Z", endDate: "2026-10-19T14:00:00Z", status: "pending", expiresAt: "2026-10-17T16:00:00Z" } }, origin);
    expect(proposal).toContain("Stornierungsvorschlag");
    expect(proposal).toContain("Bestätigung erforderlich");
    expect(proposal).not.toContain("Stornierung bestätigen");
  });
});
