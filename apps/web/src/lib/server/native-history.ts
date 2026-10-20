import "server-only";

import { z } from "zod";
import { bookingSchema, proposalSchema, resourceSchema, normalizeResource, type ChatProposal, type ChatWorkspace } from "../chat-sessions";
import { parsePluginProposalSnapshot } from "../plugin-tools";
import type { Booking, Resource } from "../types";
import { protectedCoreRequest } from "./core-api";

export interface NativeHistoryAccess {
  readonly resources: readonly Resource[];
  readonly resourcesAvailable?: boolean;
  readonly bookings: readonly Booking[];
  readonly proposals: ReadonlyMap<string, ChatProposal>;
}
export type NativeHistoryResolver = (workspace: ChatWorkspace, recoveryProposalIds?: readonly string[]) => Promise<NativeHistoryAccess>;

async function readNativeJson(request: Request, path: "/api/resources" | "/api/bookings" | `/api/proposals/${string}`): Promise<unknown> {
  const response = await protectedCoreRequest(path, request, "GET");
  if (!response.ok) { await response.body?.cancel(); throw new Error("History access unavailable"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("History access unavailable");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 2_000_000) throw new Error("History response exceeds bounds");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

export async function readNativeResources(request: Request): Promise<Resource[]> {
  const resources = z.object({ resources: z.array(resourceSchema).max(1_000) }).parse(await readNativeJson(request, "/api/resources")).resources.map(normalizeResource);
  if (new Set(resources.map(resource => resource.id)).size !== resources.length) throw new Error("Duplicate resource identity");
  return resources;
}

export async function readNativeBookings(request: Request): Promise<Booking[]> {
  const bookings = z.object({ bookings: z.array(bookingSchema).max(1_000) }).parse(await readNativeJson(request, "/api/bookings")).bookings;
  if (new Set(bookings.map(booking => booking.id)).size !== bookings.length) throw new Error("Duplicate booking identity");
  return bookings;
}

/** Display reconstruction only: fixed authenticated GETs, never prepare/confirm/reconcile. */
export function productionNativeHistoryResolver(request: Request): NativeHistoryResolver {
  return async (workspace, recoveryProposalIds = []) => {
    const messages = workspace.sessions.flatMap(session => session.snapshot.messages);
    const proposalIds = [...new Set([...messages.flatMap(message => message.proposal ? [message.proposal.id] : []), ...recoveryProposalIds])];
    const needsResources = messages.some(message => message.rooms !== undefined || message.hostDialogue?.resourceDigest !== undefined)
      || workspace.sessions.some(session => session.snapshot.chosenRoom !== null);
    const needsBookings = messages.some(message => message.bookings !== undefined);
    const result: { resources: Resource[]; resourcesAvailable?: boolean; bookings: Booking[]; proposals: Map<string, ChatProposal> } = {
      resources: [], bookings: [], proposals: new Map(),
    };
    if (needsResources) {
      try {
        result.resources = await readNativeResources(request);
        result.resourcesAvailable = true;
      } catch { /* A denied or unavailable source never returns cached cards. */ }
    }
    if (needsBookings) {
      try {
        result.bookings = await readNativeBookings(request);
      } catch { /* Keep unrelated source reconstruction available. */ }
    }
    // Bounded across all sessions, not one unbounded request per stored message.
    if (proposalIds.length > 32) return result;
    for (const id of proposalIds) {
      if (!z.uuid().safeParse(id).success) continue;
      try {
        const payload = z.object({ proposal: z.record(z.string(), z.unknown()) }).parse(await readNativeJson(request, `/api/proposals/${encodeURIComponent(id)}`));
        const raw = payload.proposal;
        if (raw.id !== id) continue;
        if (raw.action === "execute_tool") {
          if (typeof raw.pluginId !== "string" || typeof raw.executionTool !== "string") continue;
          const proposal = parsePluginProposalSnapshot(payload, { pluginId: raw.pluginId, toolName: raw.executionTool,
            title: typeof raw.executionTitle === "string" ? raw.executionTitle : "Aktion" });
          if (proposal) result.proposals.set(id, proposal.status === "pending" && Date.parse(proposal.expiresAt) <= Date.now()
            ? { ...proposal, status: "invalidated" } : proposal);
        } else if (raw.action === "book" || raw.action === "cancel_booking") {
          // Strip server bookkeeping fields, retain only the authoritative display schema.
          const proposal = proposalSchema.parse(Object.fromEntries(Object.entries(raw).filter(([key]) =>
            ["preview", "action", "id", "resourceName", "startDate", "endDate", "status", "expiresAt"].includes(key))));
          result.proposals.set(id, { ...proposal, action: raw.action,
            status: proposal.status === "pending" && Date.parse(proposal.expiresAt) <= Date.now() ? "invalidated" : proposal.status });
        }
      } catch { /* Foreign, stale, expired and unavailable proposals stay unreadable. */ }
    }
    return result;
  };
}
