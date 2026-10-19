import { describe, expect, it } from "vitest";
import { chatMessageCopyText, chatMessageMarkdownSource } from "../src/lib/chat-message-copy";
import type { ChatMessage } from "../src/lib/chat-sessions";

const origin = "https://hasi.example";
const message: ChatMessage = { id: "internal-message-id", role: "assistant", text: "Deine Ergebnisse.", model: "internal-model", interactionId: "internal-interaction" };

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
    const text = chatMessageCopyText({ ...message, sources: [{ updatedAt: "2026-10-16T00:00:00Z", fetchedAt: "2026-10-16T00:00:00Z", authorityRevision: "a".repeat(64), corpusRevision: "b".repeat(64), dataClass: "synthetic_demo", images: [], id: "svc-001", title: "WLAN", citationId: "knowledge:service_it:svc-001:1", sourceSystem: "service_it", language: "de", revision: 1, synthetic: true, text: "Hidden retrieval context" }] }, origin);
    expect(text).toContain("WLAN\nknowledge:service_it:svc-001:1\nhttps://hasi.example/sources/svc-001?revision=1");
    expect(text).not.toContain("Hidden retrieval context");
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
