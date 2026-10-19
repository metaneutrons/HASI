import { required } from "./test-utils";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/server/core-api", () => ({ productionCoreRequest: vi.fn() }));
import { productionCoreRequest } from "../src/lib/server/core-api";
import { productionNativeHistoryResolver } from "../src/lib/server/native-history";
import { createChatWorkspace } from "../src/lib/chat-sessions";

const request = new Request("https://hasi.example.edu/api/chat/workspace");
const resource = { id: "desk", serviceId: "service", name: "Current desk", description: "", capacity: 1, location: "1J", features: [] };
const booking = { id: "booking", resourceName: "Current desk", startDate: "2026-10-20T08:00:00Z", endDate: "2026-10-20T10:00:00Z", status: "cancelled" };
afterEach(() => vi.resetAllMocks());
function workspace() {
  const value = createChatWorkspace("owner");
  required(value.sessions[0]).snapshot.messages = [{ id: randomUUID(), role: "assistant", text: "old", rooms: [{ resource, intervals: [], checked: false }], bookings: [booking] }];
  return value;
}
describe("native history reconstruction", () => {
  it("only GETs pinned authenticated read paths and refetches on each workspace read", async () => {
    const core = vi.mocked(productionCoreRequest).mockImplementation(path => Promise.resolve(Response.json(path === "/api/resources" ? { resources: [resource], _hasi: {} } : { bookings: [booking] })));
    const resolve = productionNativeHistoryResolver(request);
    expect(await resolve(workspace())).toEqual({ resources: [resource], bookings: [booking], proposals: new Map() });
    expect(core.mock.calls.map(([path, original, method]) => [path, original === request, method])).toEqual([
      ["/api/resources", true, "GET"], ["/api/bookings", true, "GET"],
    ]);
    core.mockResolvedValue(new Response(null, { status: 403 }));
    expect(await resolve(workspace())).toEqual({ resources: [], bookings: [], proposals: new Map() });
    expect(core).toHaveBeenCalledTimes(4);
  });
  it("rejects duplicate and malformed current identities and bounds source output", async () => {
    const core = vi.mocked(productionCoreRequest).mockImplementation(path => Promise.resolve(path === "/api/resources"
      ? Response.json({ resources: [resource, resource] }) : new Response('x'.repeat(2_000_001))));
    expect(await productionNativeHistoryResolver(request)(workspace())).toEqual({ resources: [], bookings: [], proposals: new Map() });
    expect(core).toHaveBeenCalledTimes(2);
  });
  it("uses subject-authorized proposal GETs, rejects another proposal ID and never POSTs", async () => {
    const value = createChatWorkspace("owner");
    const proposal = { id: randomUUID(), action: "book" as const, resourceName: "Current desk", startDate: booking.startDate,
      endDate: booking.endDate, expiresAt: "2099-10-20T08:05:00Z", status: "pending" as const };
    required(value.sessions[0]).snapshot.messages = [{ id: randomUUID(), role: "assistant", text: "old", proposal }];
    const core = vi.mocked(productionCoreRequest).mockResolvedValue(Response.json({ proposal: { ...proposal, arguments: {}, pluginId: "de.hsh.hasi.anny", executionTool: "anny.execute_booking" } }));
    expect((await productionNativeHistoryResolver(request)(value)).proposals.get(proposal.id)).toEqual(proposal);
    expect(core.mock.calls[0]).toEqual([`/api/proposals/${proposal.id}`, request, "GET"]);
    core.mockResolvedValue(Response.json({ proposal: { ...proposal, expiresAt: "2000-01-01T00:00:00Z" } }));
    expect((await productionNativeHistoryResolver(request)(value)).proposals.get(proposal.id)?.status).toBe("invalidated");
    core.mockResolvedValue(Response.json({ proposal: { ...proposal, id: randomUUID() } }));
    expect((await productionNativeHistoryResolver(request)(value)).proposals.size).toBe(0);
  });
  it("caps proposal reads across the whole workspace and does not query malformed IDs", async () => {
    const value = createChatWorkspace("owner");
    required(value.sessions[0]).snapshot.messages = Array.from({ length: 33 }, () => ({ id: randomUUID(), role: "assistant", text: "old",
      proposal: { id: randomUUID(), resourceName: "desk", startDate: booking.startDate, endDate: booking.endDate, expiresAt: "2026-10-20T08:05:00Z", status: "pending" } }));
    expect((await productionNativeHistoryResolver(request)(value)).proposals.size).toBe(0);
    expect(productionCoreRequest).not.toHaveBeenCalled();
  });
});
