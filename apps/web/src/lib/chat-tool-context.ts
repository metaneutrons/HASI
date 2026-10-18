import type { WireMessage } from "./chat-contract";
import { boundedPluginToolResult, MODEL_PLUGIN_TOOL_NAME } from "./plugin-tools";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const fields = (value: unknown, keys: readonly string[]) => {
  if (!record(value)) return {};
  return Object.fromEntries(keys.filter(key => typeof value[key] === "string" || typeof value[key] === "boolean" || typeof value[key] === "number" || value[key] === null).map(key => [key, typeof value[key] === "string" ? value[key].slice(0, 400) : value[key]]));
};

/** Provider-only projection. The original history/receipts, UI cards and policy checks stay intact. */
export function modelToolContent(message: Extract<WireMessage, { role: "tool" }>, retainDetails: boolean): string {
  if (message.name === "knowledge_search") return message.content;
  const omitted = JSON.stringify({ historyDetailsOmitted: true, requiresFreshRead: true });
  if (!retainDetails) return omitted;
  try {
    const value: unknown = JSON.parse(message.content);
    if (!record(value)) return omitted;
    if (MODEL_PLUGIN_TOOL_NAME.test(message.name)) {
      const providerValue = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_hasi"));
      return JSON.stringify({
        untrustedPluginToolResult: boundedPluginToolResult(providerValue),
        historyDetailsOmitted: false,
        requiresFreshRead: true,
      });
    }
    const output: Record<string, unknown> = fields(value, ["error", "notice", "returned", "truncated", "availabilityChecked", "refinementRequired", "refinementQuestion", "clarificationRequired", "catalogCandidates", "bookingUnit", "parentName", "requestedStartDate", "durationMinutes"]);
    if (Array.isArray(value.resources)) output.resources = value.resources.slice(0, 8).map(resource => ({
      ...fields(resource, ["id", "name", "kind", "bookingUnit", "parentName", "officeWorkplaceCount", "capacity", "location"]),
      ...(record(resource) && Array.isArray(resource.features) ? { features: resource.features.filter(f => typeof f === "string").slice(0, 6).map(f => f.slice(0, 48)) } : {}),
    }));
    if (record(value.resource)) output.resource = fields(value.resource, ["id", "name"]);
    if (Array.isArray(value.intervals)) {
      const intervals: unknown[] = value.intervals;
      const available = intervals.filter((slot): slot is Record<string, unknown> => record(slot) && slot.available === true);
      const exact = available.find(slot => slot.startDate === value.requestedStartDate);
      output.intervals = (exact ? [exact] : available.slice(0, 3)).map(slot => fields(slot, ["startDate", "endDate", "available"]));
    }
    if (Array.isArray(value.bookings)) output.bookings = value.bookings.slice(0, 10).map(booking => fields(booking, ["id", "resourceName", "startDate", "endDate", "status"]));
    if (record(value.proposal)) output.proposal = fields(value.proposal, ["id", "action", "resourceName", "startDate", "endDate", "status", "expiresAt"]);
    if (record(value.requestedInterval)) output.requestedInterval = fields(value.requestedInterval, ["startDate", "endDate", "durationMinutes"]);
    output.requiresFreshRead = true;
    return JSON.stringify(output);
  } catch { return omitted; }
}

export function retainedAnnyResultIndices(messages: WireMessage[]): Set<number> {
  return new Set(messages.flatMap((message, index) => message.role === "tool" && message.name !== "knowledge_search" ? [index] : []).slice(-2));
}
