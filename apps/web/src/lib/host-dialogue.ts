import { z } from "zod";

export const hostDialogueCodeSchema = z.enum([
  "greeting", "capabilities", "request_retry", "confirmation_guidance", "bookings_empty",
  "room_group", "room_invalid", "room_refine", "room_unknown_office", "room_empty", "room_details",
]);
export type HostDialogueCode = z.infer<typeof hostDialogueCodeSchema>;

/** Display-only proof. It grants no model, source, tool or action authority. */
export const hostDialogueReceiptSchema = z.strictObject({
  version: z.literal(1),
  code: hostDialogueCodeSchema,
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  resourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  resourceIds: z.array(z.string().min(1).max(128)).max(8),
  expiresAt: z.iso.datetime(),
  receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type HostDialogueReceipt = z.infer<typeof hostDialogueReceiptSchema>;

export const hostDialogueMessageSchema = z.strictObject({
  id: z.uuid(), role: z.literal("assistant"), text: z.string().min(1).max(8_000),
  hostDialogue: hostDialogueReceiptSchema,
});
export type HostDialogueMessage = z.infer<typeof hostDialogueMessageSchema>;

export const staticHostDialogue = {
  greeting: "Hallo. Was möchtest du erledigen? Ich kann Räume suchen, Buchungen vorbereiten und deine Reservierungen anzeigen.",
  capabilities: "Ich kann in dieser Dialog-Demo Räume suchen und buchen sowie deine Buchungen anzeigen. Schreib zum Beispiel: „Morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.“ Zu IT- und Intranet-Fragen kann ich außerdem freigegebene Quellen suchen.",
  request_retry: "Bitte versuche die Anfrage erneut. Bei einer begonnenen Buchung oder Stornierung prüfe zuerst den Aktionsstatus, bevor du eine neue Aktion vorbereitest.",
  confirmation_guidance: "Prüfe die Angaben auf der Vorschlagskarte und bestätige die Aktion dort ausdrücklich. Eine Chatnachricht ersetzt diese Bestätigung nicht.",
} as const;
export type StaticHostDialogueCode = keyof typeof staticHostDialogue;
