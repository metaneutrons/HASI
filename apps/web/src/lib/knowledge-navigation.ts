import { z } from "zod";

const originSchema = z.strictObject({ sessionId: z.uuid(), messageId: z.uuid() });
export type KnowledgeOrigin = z.infer<typeof originSchema>;

/** Navigation metadata never grants access to a document or conversation. */
export function knowledgeOrigin(chat: unknown, message: unknown): KnowledgeOrigin | undefined {
  const result = originSchema.safeParse({ sessionId: chat, messageId: message });
  return result.success ? result.data : undefined;
}

export function knowledgeChatReturnHref(origin?: KnowledgeOrigin): string {
  const valid = originSchema.safeParse(origin);
  return valid.success ? `/?chat=${valid.data.sessionId}#message-${valid.data.messageId}` : "/";
}

export function knowledgeReturnLocation(location: Pick<Location, "search" | "hash">): KnowledgeOrigin | undefined {
  if (location.search.length > 512 || location.hash.length > 128) return undefined;
  const query = new URLSearchParams(location.search);
  if (query.getAll("chat").length !== 1 || !location.hash.startsWith("#message-")) return undefined;
  return knowledgeOrigin(query.get("chat"), location.hash.slice("#message-".length));
}
