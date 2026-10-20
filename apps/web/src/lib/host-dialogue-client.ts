import { z } from "zod";
import { normalizeResource, resourceSchema } from "./chat-sessions";
import { hostDialogueCodeSchema, hostDialogueMessageSchema, type HostDialogueMessage } from "./host-dialogue";
import type { RoomDialoguePlan } from "./room-dialogue";

const responseSchema = z.strictObject({
  plan: z.strictObject({ code: hostDialogueCodeSchema.extract(["room_group", "room_invalid", "room_refine", "room_unknown_office", "room_empty", "room_details"]).nullable(), text: z.string().max(8_000),
    resources: z.array(resourceSchema).max(8), total: z.number().int().min(0).max(1_000),
    needsAvailability: z.boolean(), catalogDependent: z.boolean() }),
  message: hostDialogueMessageSchema.optional(),
});

export function parseRoomDialogueResponse(value: unknown): { plan: RoomDialoguePlan; message?: HostDialogueMessage } {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Der Dialoghinweis konnte nicht sicher gelesen werden.");
  const { plan, message } = parsed.data;
  const fail = (): never => { throw new Error("Der Dialoghinweis passt nicht zu den angezeigten Suchergebnissen."); };
  if (plan.resources.length > plan.total || new Set(plan.resources.map(resource => resource.id)).size !== plan.resources.length) fail();
  if (plan.code === null) {
    if (message || !plan.needsAvailability || plan.resources.length === 0) fail();
  } else {
    if (!message) return fail();
    if (plan.needsAvailability || message.hostDialogue.code !== plan.code || message.text !== plan.text
      || JSON.stringify(message.hostDialogue.resourceIds) !== JSON.stringify(plan.resources.map(resource => resource.id))) fail();
  }
  return { plan: { ...plan, resources: plan.resources.map(normalizeResource) }, ...(message ? { message } : {}) };
}
