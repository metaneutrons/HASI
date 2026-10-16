import { describe, expect, it } from "vitest";
import { appendChatText } from "../src/lib/chat-history";
import { chatRequestSchema, type WireMessage } from "../src/lib/chat-contract";

describe("chat history across UI actions and model switches", () => {
  it("keeps manual proposal and confirmation events valid for the next model turn", () => {
    const history: WireMessage[] = [
      { role: "user", content: "Suche einen Raum" },
      { role: "assistant", content: "Wähle eine Zeit auf der Karte." },
    ];
    appendChatText(history, "user", "Diesen Zeitraum vorbereiten");
    history.push(
      { role: "assistant", content: "", toolCalls: [{ id: "proposal-call", name: "anny_propose_booking", arguments: { resourceId: "abc00000-0000-4000-8000-000000000001", startDate: "2030-01-02T12:00:00Z", endDate: "2030-01-02T13:00:00Z" } }] },
      { role: "tool", toolCallId: "proposal-call", name: "anny_propose_booking", content: '{"status":"pending"}' },
    );
    appendChatText(history, "user", "Ich habe die Bestätigungsschaltfläche betätigt.");
    appendChatText(history, "assistant", "Die Oberfläche meldet eine bestätigte Testbuchung.");
    appendChatText(history, "user", "Zeige meine Buchungen");
    expect(chatRequestSchema.safeParse({ profileId: "groq-oss-120b", messages: history }).success).toBe(true);
  });

  it("coalesces multiple offline status messages before switching to Groq", () => {
    const history: WireMessage[] = [];
    appendChatText(history, "user", "Hallo");
    appendChatText(history, "assistant", "Hallo Fabian");
    appendChatText(history, "assistant", "Die Buchung ist bestätigt.");
    appendChatText(history, "user", "Was kannst du sonst?");
    expect(history).toHaveLength(3);
    expect(chatRequestSchema.safeParse({ profileId: "groq-oss-20b", messages: history }).success).toBe(true);
  });

  it("preserves completed tool results when recording an interrupted generation and a follow-up", () => {
    const history: WireMessage[] = [
      { role: "user", content: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde." },
      { role: "assistant", content: "", toolCalls: [{ id: "search-1", name: "anny_search_resources", arguments: { capacity: 4 } }] },
      { role: "tool", toolCallId: "search-1", name: "anny_search_resources", content: '{"resources":[]}' },
    ];
    appendChatText(history, "assistant", "Die Verarbeitung wurde durch einen technischen Fehler unterbrochen.");
    appendChatText(history, "user", "gugu");
    expect(history[2]).toMatchObject({ role: "tool", toolCallId: "search-1" });
    expect(history.slice(-2).map(({ role }) => role)).toEqual(["assistant", "user"]);
    expect(chatRequestSchema.safeParse({ profileId: "groq-oss-120b", messages: history }).success).toBe(true);
  });
});
