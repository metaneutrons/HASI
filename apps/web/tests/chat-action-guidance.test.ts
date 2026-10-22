import { describe, expect, it } from "vitest";
import { asksForActionControls, asksForActionStatus, currentActionControls } from "../src/lib/chat-action-guidance";

describe("bounded native action control help", () => {
  it.each(["ich sehe keine schaltfläche", "Ich finde keinen Button.", "Wo ist die Bestätigung?", "Ich will direkt von hier buchen!", "was soll das denn, ich will direkt von hier buchen", "Was soll das denn? Ich will hier buchen!", "Ich sehe keine Bestätigungsschaltfläche", "I don't see a button", "Where is the confirmation button?"])("recognizes %s", text => {
    expect(asksForActionControls(text)).toBe(true);
  });
  it.each(["Mein VPN funktioniert nicht", "Ich sehe keine Schaltfläche und mein VPN funktioniert nicht", "Bitte buche morgen 1J", "ja", "Wo ist mein Büro?", "was soll das denn, buche morgen einen Raum", "was soll das denn, ich will direkt von hier buchen und mein VPN geht nicht", "x".repeat(241)])("leaves other tasks to their workflow: %s", text => {
    expect(asksForActionControls(text)).toBe(false);
  });
});

const proposal = {
  action: "book" as const, id: "5f891aac-81c0-4c7e-9a89-aed77396eea9",
  status: "pending" as const, resourceName: "Max Planck 1J.1.02",
  startDate: "2030-05-01T10:00:00Z", endDate: "2030-05-01T12:00:00Z", expiresAt: "2030-05-01T09:05:00Z",
  preview: { instance: "Anny Demo", account: "Synthetic user", effect: "Book workplace", consequences: ["One reservation"], costs: "None" },
};
const now = Date.parse("2030-05-01T09:00:00Z");

it("restores only the identical current pending preview without executing anything", () => {
  expect(currentActionControls(proposal, { proposal }, now)).toEqual({ proposal, confirmable: true });
  expect(currentActionControls(proposal, { proposal: { ...proposal, resourceName: "Other room" } }, now)).toBeNull();
  expect(currentActionControls(proposal, { proposal: { ...proposal, preview: { ...proposal.preview, account: "Other user" } } }, now)).toBeNull();
  expect(currentActionControls(proposal, { error: "denied" }, now)).toBeNull();
});

it("never restores confirmation for expired, completed, invalidated or uncertain actions", () => {
  const expired = currentActionControls(proposal, { proposal }, Date.parse(proposal.expiresAt));
  expect(expired?.proposal.status).toBe("invalidated");
  expect(expired?.confirmable).toBe(false);
  for (const status of ["confirmed", "executing", "outcome_unknown", "failed", "invalidated"] as const) {
    expect(currentActionControls({ ...proposal, status }, { proposal }, now)).toBeNull();
    expect(currentActionControls(proposal, { proposal: { ...proposal, status } }, now)?.confirmable).toBe(false);
  }
});


describe("bounded action status replies", () => {
  it.each(["gibt es da keine Rückmeldung?", "Gibt es dazu eine Rückmeldung?", "Ich habe noch keine Rückmeldung.", "Hat das geklappt?", "Ist meine Buchung bestätigt?", "Did that go through?"])("reads current status for %s", text => {
    expect(asksForActionStatus(text)).toBe(true);
  });
  it.each(["Gibt es da keine Rückmeldung? Buche noch ein Büro.", "Hat das geklappt und storniere meine Buchung", "Bitte buche morgen 10–12 Uhr", "Bestätigt", "ja", "x".repeat(241)])("does not turn another request into a status reply: %s", text => {
    expect(asksForActionStatus(text)).toBe(false);
  });
});
