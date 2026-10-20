import "server-only";

import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { digest } from "@hasi/plugin-sdk";
import { z } from "zod";
import { normalizeRoomRequest, roomRequestSchema } from "../chat-sessions";
import { hostDialogueMessageSchema, staticHostDialogue, type HostDialogueCode, type HostDialogueMessage } from "../host-dialogue";
import { planRoomDialogue } from "../room-dialogue";
import type { Resource } from "../types";

const RETENTION = 30 * 24 * 60 * 60 * 1000;
const authoritySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const staticCodeSchema = z.enum(["greeting", "capabilities", "request_retry", "confirmation_guidance"]);
const inputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("static"), conversationId: z.uuid(), code: staticCodeSchema }),
  z.strictObject({ kind: z.literal("rooms"), conversationId: z.uuid(), request: roomRequestSchema,
    selectedResourceId: z.string().min(1).max(128).optional() }),
  z.strictObject({ kind: z.literal("bookings_empty"), conversationId: z.uuid() }),
]);
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export function resourceCatalogueDigest(resources: readonly Resource[]): string {
  return digest([...resources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Domain-separated display evidence; never accepted as model/source/action evidence. */
export function createHostDialogueSigner(secret: string, scope: string, clock: () => number = Date.now) {
  if (!secret || !scope) throw new TypeError("Host dialogue needs a subject scope and secret");
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "hasi-host-dialogue-display-v1", 32));
  const proof = (conversationId: string, message: Omit<HostDialogueMessage, "hostDialogue">,
    receipt: Omit<HostDialogueMessage["hostDialogue"], "receipt">) =>
    createHmac("sha256", key).update(digest({ scope, conversationId, message, receipt })).digest();
  return {
    issue(conversationId: string, text: string, code: HostDialogueCode, authorityDigest: string,
      resources?: readonly Resource[], resourceIds: readonly string[] = []): HostDialogueMessage {
      z.uuid().parse(conversationId); authoritySchema.parse(authorityDigest);
      const message = { id: randomUUID(), role: "assistant" as const, text };
      const receipt = { version: 1 as const, code, authorityDigest, resourceIds: [...resourceIds],
        ...(resources === undefined ? {} : { resourceDigest: resourceCatalogueDigest(resources) }),
        expiresAt: new Date(clock() + RETENTION).toISOString() };
      return hostDialogueMessageSchema.parse({ ...message, hostDialogue: { ...receipt,
        receipt: proof(conversationId, message, receipt).toString("base64url") } });
    },
    verify(conversationId: string, value: unknown, current: { authorityDigest: string; resources: readonly Resource[]; resourcesAvailable?: boolean }): HostDialogueMessage | undefined {
      try {
        z.uuid().parse(conversationId);
        const message = hostDialogueMessageSchema.parse(value);
        const { receipt, ...metadata } = message.hostDialogue;
        if (!authoritySchema.safeParse(current.authorityDigest).success || metadata.authorityDigest !== current.authorityDigest
          || Date.parse(metadata.expiresAt) <= clock() || Date.parse(metadata.expiresAt) > clock() + RETENTION
          || new Set(metadata.resourceIds).size !== metadata.resourceIds.length
          || metadata.resourceIds.length > 0 && metadata.resourceDigest === undefined
          || metadata.resourceDigest !== undefined && (current.resourcesAvailable !== true
            || metadata.resourceDigest !== resourceCatalogueDigest(current.resources))) return undefined;
        const actual = Buffer.from(receipt, "base64url");
        const expected = proof(conversationId, { id: message.id, role: message.role, text: message.text }, metadata);
        return actual.length === expected.length && timingSafeEqual(actual, expected) ? message : undefined;
      } catch { return undefined; }
    },
  };
}

interface DialogueDependencies {
  allowedOrigins: readonly string[];
  signer: ReturnType<typeof createHostDialogueSigner>;
  authority: () => Promise<string>;
  resources: () => Promise<Resource[]>;
  bookingsEmpty: () => Promise<boolean>;
}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 8_192)) throw new Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 8_192) throw new Error("size");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Closed operations generate their own display copy. There is no sign-client-text operation. */
export async function handleHostDialoguePost(request: Request, dependencies: DialogueDependencies): Promise<Response> {
  const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
  const origin = request.headers.get("origin");
  if (!origin || !dependencies.allowedOrigins.includes(origin) || origin !== new URL(request.url).origin
    || request.headers.get("sec-fetch-site") === "cross-site") return failure("Unzulässiger Anfrageursprung.", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return failure("Die Anfrage muss JSON enthalten.", 415);
  let input: z.infer<typeof inputSchema>;
  try { input = inputSchema.parse(await readBody(request)); }
  catch { return failure("Ungültige Dialoganfrage.", 400); }
  try {
    const authority = authoritySchema.parse(await dependencies.authority());
    let result: Record<string, unknown>;
    if (input.kind === "static") {
      result = { message: dependencies.signer.issue(input.conversationId, staticHostDialogue[input.code], input.code, authority) };
    } else if (input.kind === "bookings_empty") {
      if (!await dependencies.bookingsEmpty()) return failure("Bitte lade die vorhandenen Buchungen erneut.", 409);
      result = { message: dependencies.signer.issue(input.conversationId,
        "Bei dieser Abfrage wurden keine eigenen Buchungen gefunden. Du kannst deine Buchungen erneut laden oder einen Raum suchen.", "bookings_empty", authority) };
    } else {
      // Input-only clarifications need no catalogue, but every result claim is
      // derived from the authenticated server read, never submitted counts/cards.
      const roomRequest = normalizeRoomRequest(input.request);
      const preliminary = planRoomDialogue(roomRequest, [], input.selectedResourceId);
      const resources = preliminary.catalogDependent ? await dependencies.resources() : undefined;
      const plan = resources ? planRoomDialogue(roomRequest, resources, input.selectedResourceId) : preliminary;
      result = { plan, ...(plan.code ? { message: dependencies.signer.issue(input.conversationId, plan.text, plan.code, authority,
        resources, plan.resources.map(resource => resource.id)) } : {}) };
    }
    if (await dependencies.authority() !== authority) return failure("Die Freigaben haben sich geändert. Bitte versuche es erneut.", 409);
    return Response.json(result, { headers });
  } catch { return failure("Der Dialoghinweis konnte nicht sicher erstellt werden. Bitte prüfe deine Dienstverbindung und versuche es erneut.", 503); }
}
