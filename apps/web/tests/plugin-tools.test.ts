import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundedPluginToolResult,
  compactPluginToolResult,
  parsePluginProposal,
  parsePluginProposalSnapshot,
  parsePluginTools,
  pluginToolProposalPresentation,
  samePluginProposalSnapshot,
  type PluginToolDescriptor,
} from "../src/lib/plugin-tools";

function descriptor(pluginId: string, name: string, extra: Partial<PluginToolDescriptor> = {}): PluginToolDescriptor {
  return {
    pluginId,
    name,
    title: "Status",
    description: "Liest einen freigegebenen Status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    effect: "read",
    requiredPermissions: ["status:read"],
    modelName: `hasi_${createHash("sha256").update(pluginId).update("\u0000").update(name).digest("hex").slice(0, 24)}`,
    ...extra,
  };
}

describe("registry-backed plugin tools", () => {
  it("accepts v2 visibility and presentation metadata within SDK field bounds", () => {
    const item = descriptor("example.plugin", "status.read", {
      title: "T".repeat(256),
      description: "D".repeat(4_096),
      requiredPermissions: ["p".repeat(256)],
      visibility: ["model", "app"],
      presentationId: "dashboard",
      resultSemantics: { kind: "generic" },
    });
    expect(parsePluginTools({ tools: [item] })).toEqual([item]);
  });

  it("rejects unsupported references, forged names, and overlarge tool context", () => {
    const valid = descriptor("example.plugin", "status.read");
    expect(parsePluginTools({ tools: [{ ...valid, inputSchema: { type: "object", $ref: "https://attacker.test/schema" } }] })).toBeNull();
    expect(parsePluginTools({ tools: [{ ...valid, modelName: "hasi_not-a-digest" }] })).toBeNull();

    const large = Array.from({ length: 9 }, (_, index) => descriptor("example.plugin", `tool.${String(index)}`, {
      description: "x".repeat(4_000),
      inputSchema: { type: "object", properties: { value: { type: "string", description: "x".repeat(3_000) } } },
    }));
    expect(parsePluginTools({ tools: large })).toBeNull();
    expect(parsePluginTools({ tools: Array.from({ length: 33 }, (_, index) => descriptor("example.plugin", `tool.${String(index)}`)) })).toBeNull();
  });

  it("bounds untrusted tool results, strips prototype keys, and displays compact plain text", () => {
    const payload: unknown = JSON.parse('{"safe":"value","__proto__":{"polluted":true},"html":"<img src=x onerror=alert(1)>"}') as unknown;
    const bounded = boundedPluginToolResult(payload);
    expect(Object.hasOwn(bounded, "__proto__")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(compactPluginToolResult(bounded, 100)).toContain("<img src=x onerror=alert(1)>");
    expect(compactPluginToolResult({ large: "x".repeat(2_000) }, 80)).toHaveLength(80);
  });

  it("keeps escaped truncation previews inside the serialized result limit", () => {
    for (const character of ['"', "\\", "x", "界"]) {
      const result = boundedPluginToolResult(Object.fromEntries(Array.from({ length: 24 }, (_, index) => [String(index), character.repeat(1_200)])));
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it("shows and binds the immutable execute action separately from the preparation tool", () => {
    const tool = descriptor("example.plugin", "proposal.prepare", { title: "Vorschau prüfen" });
    const raw = {
      proposal: {
        action: "execute_tool",
        id: "5f891aac-81c0-4c7e-9a89-aed77396eea9",
        pluginId: tool.pluginId,
        executionTool: "delete_member",
        executionTitle: "Mitglied löschen",
        executionDescription: "Entfernt das ausgewählte Mitglied.",
        arguments: { target: "resource-1" },
        resourceName: "Objekt 1",
        startDate: "",
        endDate: "",
        status: "pending",
        expiresAt: "2026-10-18T12:00:00.000Z",
      },
    };
    const displayed = parsePluginProposal(raw, tool);
    const identity = { pluginId: tool.pluginId, toolName: tool.name, title: tool.title };
    const authoritative = parsePluginProposalSnapshot(raw, identity, true);
    const presentation = displayed && pluginToolProposalPresentation(displayed);
    expect(displayed?.startDate).toBe("");
    expect(presentation).toEqual({
      actionTitle: "Mitglied löschen",
      executionTool: "delete_member",
      pluginId: "example.plugin",
      executionDescription: "Entfernt das ausgewählte Mitglied.",
      preparationTitle: "Vorschau prüfen",
      confirmLabel: "Mitglied löschen bestätigen",
    });
    expect(displayed && authoritative && samePluginProposalSnapshot(displayed, authoritative)).toBe(true);
    const confirmed = parsePluginProposalSnapshot({ proposal: { ...raw.proposal, status: "confirmed" } }, identity);
    expect(displayed && confirmed && samePluginProposalSnapshot(displayed, confirmed)).toBe(true);

    const changed = parsePluginProposalSnapshot({ proposal: { ...raw.proposal, arguments: { target: "resource-2" } } }, identity, true);
    expect(displayed && changed && samePluginProposalSnapshot(displayed, changed)).toBe(false);
    const changedExecutionTitle = parsePluginProposalSnapshot({ proposal: { ...raw.proposal, executionTitle: "Mitglied archivieren" } }, identity, true);
    expect(displayed && changedExecutionTitle && samePluginProposalSnapshot(displayed, changedExecutionTitle)).toBe(false);
    const changedExecutionDescription = parsePluginProposalSnapshot({ proposal: { ...raw.proposal, executionDescription: "Anderer Vorgang." } }, identity, true);
    expect(displayed && changedExecutionDescription && samePluginProposalSnapshot(displayed, changedExecutionDescription)).toBe(false);
  });

  it("keeps legacy proposals clear and uses a generic button for long action names", () => {
    const tool = descriptor("example.plugin", "proposal.prepare", { title: "Vorschau prüfen" });
    const legacyProposal = {
      action: "execute_tool",
      id: "5f891aac-81c0-4c7e-9a89-aed77396eea9",
      pluginId: tool.pluginId,
      executionTool: "delete_member",
      arguments: { target: "resource-1" },
      resourceName: "Objekt 1",
      startDate: "",
      endDate: "",
      status: "pending",
      expiresAt: "2026-10-18T12:00:00.000Z",
    };
    const legacy = parsePluginProposal({ proposal: legacyProposal }, tool);
    expect(legacy && pluginToolProposalPresentation(legacy)).toMatchObject({
      actionTitle: "delete_member",
      executionTool: "delete_member",
      preparationTitle: "Vorschau prüfen",
      confirmLabel: "delete_member bestätigen",
    });

    const longTitle = parsePluginProposal({
      proposal: { ...legacyProposal, executionTitle: "Eine sehr lange Aktion, deren vollständiger Name nicht auf die Bestätigungsschaltfläche passt" },
    }, tool);
    expect(longTitle && pluginToolProposalPresentation(longTitle).confirmLabel).toBe("Aktion bestätigen");
  });
});
