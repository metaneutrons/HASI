import { describe, expect, it } from "vitest";
import type { ActionPreview } from "../src/lib/action-preview";
import type { AnnyChatProposal, ChatProposal } from "../src/lib/chat-sessions";
import type { PluginToolProposal } from "../src/lib/plugin-tools";
import {
  forwardProposalStatus,
  proposalPresentation,
  readProposalSnapshot,
  sameProposalDetails,
} from "../src/lib/proposal-presentation";

const preview: ActionPreview = {
  instance: "Anny Demo",
  account: "Fabian",
  effect: "Raum buchen",
  consequences: ["Der Raum wird reserviert."],
  costs: "Keine",
};

function annyProposal(overrides: Partial<AnnyChatProposal> = {}): AnnyChatProposal {
  return {
    action: "book",
    id: "proposal-1",
    preview,
    resourceName: "Raum 1",
    startDate: "2030-05-01T10:00:00Z",
    endDate: "2030-05-01T11:00:00Z",
    expiresAt: "2030-05-01T09:05:00Z",
    status: "pending",
    ...overrides,
  };
}

function pluginProposal(overrides: Partial<PluginToolProposal> = {}): PluginToolProposal {
  return {
    action: "execute_tool",
    id: "5f891aac-81c0-4c7e-9a89-aed77396eea9",
    pluginId: "example.plugin",
    executionTool: "delete_member",
    executionTitle: "Mitglied löschen",
    executionDescription: "Entfernt das ausgewählte Mitglied.",
    toolName: "proposal.prepare",
    title: "Vorschau prüfen",
    arguments: { target: "resource-1" },
    preview,
    resourceName: "Objekt 1",
    startDate: "",
    endDate: "",
    expiresAt: "2030-05-01T09:05:00Z",
    status: "pending",
    ...overrides,
  };
}

describe("proposal receipt presentation and identity", () => {
  it("uses fixed confirmed copy and only links Anny actions to bookings", () => {
    expect(proposalPresentation(annyProposal({ status: "confirmed" }))).toEqual({
      label: "Buchung bestätigt",
      summary: "Die Buchung wurde bestätigt.",
      bookingsLink: true,
    });
    expect(proposalPresentation(annyProposal({ action: "cancel_booking", status: "confirmed" }))).toMatchObject({
      label: "Stornierung bestätigt",
      summary: "Die Stornierung wurde bestätigt.",
      bookingsLink: true,
    });
    expect(proposalPresentation(pluginProposal({ status: "confirmed" }))).toMatchObject({
      label: "Aktion bestätigt",
      bookingsLink: false,
    });
  });

  it("rejects malformed Anny snapshots and unknown statuses", () => {
    const proposal = annyProposal();
    expect(readProposalSnapshot({ proposal: { ...proposal, status: "successful" } }, proposal)).toBeNull();
    expect(readProposalSnapshot({ proposal: { ...proposal, action: "approve_anything" } }, proposal)).toBeNull();
    expect(readProposalSnapshot({ proposal: { ...proposal, startDate: "not-a-date" } }, proposal)).toBeNull();
    expect(readProposalSnapshot({ proposal: { ...proposal, preview: { instance: "Only one field" } } }, proposal)).toBeNull();
  });

  it("invalidates expired pending reads but retains completed receipts after the confirmation deadline", () => {
    const anny = annyProposal();
    const plugin = pluginProposal();
    const now = Date.parse(anny.expiresAt);
    for (const proposal of [anny, plugin]) {
      const wire = proposal.action === "execute_tool"
        ? Object.fromEntries(Object.entries(proposal).filter(([key]) => !["toolName", "title"].includes(key))) : proposal;
      expect(readProposalSnapshot({ proposal: wire }, proposal, now)?.status).toBe("invalidated");
      expect(readProposalSnapshot({ proposal: wire }, proposal, now - 1)?.status).toBe("pending");
      expect(readProposalSnapshot({ proposal: { ...wire, status: "confirmed" } }, proposal, now)?.status).toBe("confirmed");
    }
  });

  it("binds an Anny snapshot to its ID, action, preview, interval, and expiry", () => {
    const proposal = annyProposal();
    expect(sameProposalDetails(proposal, { ...proposal, status: "confirmed" })).toBe(true);
    expect(sameProposalDetails(proposal, { ...proposal, id: "proposal-2" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, action: "cancel_booking" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, preview: { ...preview, costs: "Gebühren möglich" } })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, resourceName: "Raum 2" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, startDate: "2030-05-01T10:15:00Z" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, endDate: "2030-05-01T11:15:00Z" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, expiresAt: "2030-05-01T09:06:00Z" })).toBe(false);
  });

  it("binds generic plugin snapshots to the exact action arguments and presentation", () => {
    const proposal = pluginProposal();
    expect(sameProposalDetails(proposal, { ...proposal, status: "confirmed" })).toBe(true);
    expect(sameProposalDetails(proposal, { ...proposal, id: "5f891aac-81c0-4c7e-9a89-aed77396eea8" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, arguments: { target: "resource-2" } })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, executionTool: "archive_member" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, pluginId: "other.plugin" })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, preview: { ...preview, effect: "Mitglied archivieren" } })).toBe(false);
    expect(sameProposalDetails(proposal, { ...proposal, expiresAt: "2030-05-01T09:06:00Z" })).toBe(false);
  });

  it("accepts forward status progress and rejects reversal", () => {
    const forward: [ChatProposal["status"], ChatProposal["status"]][] = [
      ["pending", "executing"], ["pending", "confirmed"], ["pending", "outcome_unknown"], ["pending", "failed"],
      ["executing", "confirmed"], ["executing", "outcome_unknown"], ["executing", "failed"],
      ["outcome_unknown", "confirmed"], ["outcome_unknown", "failed"], ["confirmed", "confirmed"],
    ];
    const reversals: [ChatProposal["status"], ChatProposal["status"]][] = [
      ["executing", "pending"], ["confirmed", "pending"], ["failed", "outcome_unknown"],
      ["outcome_unknown", "executing"], ["invalidated", "confirmed"], ["pending", "invalidated"],
    ];
    for (const [before, after] of forward) expect(forwardProposalStatus(before, after), `${before} -> ${after}`).toBe(true);
    for (const [before, after] of reversals) expect(forwardProposalStatus(before, after), `${before} -> ${after}`).toBe(false);
  });
});
