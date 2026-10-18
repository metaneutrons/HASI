import { describe, expect, it } from "vitest";
import { modelToolContent, retainedAnnyResultIndices } from "../src/lib/chat-tool-context";
import type { WireMessage } from "../src/lib/chat-contract";

const result = (name: Extract<WireMessage, { role: "tool" }>["name"], value: unknown): Extract<WireMessage, { role: "tool" }> => ({ role: "tool", name, content: JSON.stringify(value), toolCallId: "c1" });

describe("provider-only tool context projection", () => {
  it("cuts old details without rewriting stored messages, knowledge evidence or tool-call associations", () => {
    const tool = result("anny_search_resources", { resources: [{ id: "r1", name: "Desk", description: "unneeded description" }] });
    const knowledge = result("knowledge_search", { documents: [{ citationId: "demo:knowledge:service-it:001", text: "Needed evidence" }] });
    const history: WireMessage[] = [{ role: "user", content: "Original user constraint" }, tool, knowledge, result("anny_get_availability", {}), result("anny_list_my_bookings", {})];
    const before = JSON.stringify(history);
    const retained = retainedAnnyResultIndices(history);
    expect([...retained]).toEqual([3, 4]);
    expect(JSON.parse(modelToolContent(tool, false))).toEqual({ historyDetailsOmitted: true, requiresFreshRead: true });
    expect(modelToolContent(knowledge, false)).toBe(knowledge.content);
    expect(JSON.stringify(history)).toBe(before);
  });
  it("retains resource IDs, office counts, capacity and features while excluding unknown payload fields", () => {
    const tool = result("anny_search_resources", { resources: [{ id: "r1", name: "Desk", parentName: "Office", officeWorkplaceCount: 2, capacity: null, features: ["Monitor"], description: "not forwarded", serviceId: "internal", arbitrary: "not forwarded" }], returned: 1, availabilityChecked: false });
    const output = JSON.parse(modelToolContent(tool, true));
    expect(output.resources[0]).toMatchObject({ id: "r1", name: "Desk", parentName: "Office", officeWorkplaceCount: 2, capacity: null, features: ["Monitor"] });
    expect(output.availabilityChecked).toBe(false);
    expect(modelToolContent(tool, true)).not.toContain("not forwarded");
  });
  it("retains exact requested availability only, or at most three alternatives", () => {
    const slots = Array.from({ length: 8 }, (_, hour) => ({ startDate: `2030-01-01T${String(hour + 8).padStart(2, "0")}:00:00Z`, endDate: `2030-01-01T${String(hour + 9).padStart(2, "0")}:00:00Z`, available: true }));
    const exact = result("anny_get_availability", { requestedStartDate: slots[5]!.startDate, intervals: slots });
    expect(JSON.parse(modelToolContent(exact, true)).intervals).toEqual([slots[5]]);
    const alternate = result("anny_get_availability", { requestedStartDate: "2030-01-01T06:00:00Z", intervals: slots });
    expect(JSON.parse(modelToolContent(alternate, true)).intervals).toHaveLength(3);
  });
  it("does not invent details for malformed or omitted data", () => {
    const malformed = { ...result("anny_get_availability", {}), content: "unparsed instructions" };
    expect(JSON.parse(modelToolContent(malformed, true))).toEqual({ historyDetailsOmitted: true, requiresFreshRead: true });
  });
});
