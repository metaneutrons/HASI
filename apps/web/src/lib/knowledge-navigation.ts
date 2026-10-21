import { z } from "zod";
import { knowledgeDocumentId } from "./knowledge";

const originSchema = z.strictObject({ sessionId: z.uuid(), messageId: z.uuid() });
const revisionSchema = z.number().int().positive();
const revisionQuerySchema = z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(revisionSchema);
export type KnowledgeOrigin = z.infer<typeof originSchema>;

export interface KnowledgeRevisionQuery {
  revision?: number;
  fromRevision?: number;
}

/** Navigation metadata never grants access to a document or conversation. */
export function knowledgeOrigin(chat: unknown, message: unknown): KnowledgeOrigin | undefined {
  const result = originSchema.safeParse({ sessionId: chat, messageId: message });
  return result.success ? result.data : undefined;
}

export function knowledgeChatReturnHref(origin?: KnowledgeOrigin): string {
  const valid = originSchema.safeParse(origin);
  return valid.success ? `/?chat=${valid.data.sessionId}#message-${valid.data.messageId}` : "/";
}

/**
 * Parses the mutually exclusive source revision query parameters. Next.js
 * represents duplicate search parameters as arrays, which are rejected here.
 */
export function knowledgeRevisionQuery(query: Record<string, string | string[] | undefined>): KnowledgeRevisionQuery | undefined {
  const revisionValue = query.revision;
  const fromRevisionValue = query.fromRevision;
  if (revisionValue !== undefined && fromRevisionValue !== undefined) return undefined;

  if (revisionValue !== undefined) {
    if (typeof revisionValue !== "string") return undefined;
    const result = revisionQuerySchema.safeParse(revisionValue);
    return result.success ? { revision: result.data } : undefined;
  }

  if (fromRevisionValue !== undefined) {
    if (typeof fromRevisionValue !== "string") return undefined;
    const result = revisionQuerySchema.safeParse(fromRevisionValue);
    return result.success ? { fromRevision: result.data } : undefined;
  }

  return {};
}

/** Builds a same-origin route to check the current authorized version. */
export function knowledgeCurrentRevisionHref(documentId: unknown, fromRevision: unknown, origin?: unknown): string | undefined {
  const validDocumentId = knowledgeDocumentId.safeParse(documentId);
  const validRevision = revisionSchema.safeParse(fromRevision);
  if (!validDocumentId.success || !validRevision.success) return undefined;

  const validOrigin = originSchema.safeParse(origin);
  const query = new URLSearchParams({ fromRevision: String(validRevision.data) });
  if (validOrigin.success) {
    query.set("chat", validOrigin.data.sessionId);
    query.set("message", validOrigin.data.messageId);
  }
  return `/sources/${encodeURIComponent(validDocumentId.data)}?${query.toString()}`;
}

export function knowledgeReturnLocation(location: Pick<Location, "search" | "hash">): KnowledgeOrigin | undefined {
  if (location.search.length > 512 || location.hash.length > 128) return undefined;
  const query = new URLSearchParams(location.search);
  if (query.getAll("chat").length !== 1 || !location.hash.startsWith("#message-")) return undefined;
  return knowledgeOrigin(query.get("chat"), location.hash.slice("#message-".length));
}
