import { z } from "zod";
import { knowledgeDocumentHref, knowledgeDocumentSchema, knowledgeSourceLabel, type KnowledgeDocument } from "./knowledge";

export type KnowledgeCitation = Readonly<{
  citationId: string;
  id: string;
  title: string;
  sourceLabel: string;
  revision: number;
  href: string;
  number: number;
}>;

export type KnowledgeCitationOrigin = Readonly<{
  sessionId: string;
  messageId: string;
}>;

const citationIdentityPattern = /^knowledge:(service_it|intranet):((?:svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}):([1-9][0-9]*)$/u;
const originSchema = z.strictObject({ sessionId: z.uuid(), messageId: z.uuid() });
const citationShapeSchema = z.object({
  citationId: z.string().min(1).max(300),
  id: z.string().min(1).max(140),
  title: z.string().min(1).max(200),
  sourceLabel: z.string().min(1).max(100),
  revision: z.number(),
  number: z.number(),
  // Read and discard any supplied URL. Every accepted mapping gets a fresh host URL.
  href: z.unknown().optional(),
});

function citationBaseHref(citationId: string, id: string, revision: number): string | undefined {
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  const match = citationIdentityPattern.exec(citationId);
  if (match?.[2] !== id) return undefined;
  if (match[3] !== String(revision)) return undefined;
  const expectedPrefix = match[1] === "service_it" ? "svc-" : "int-";
  if (!id.startsWith(expectedPrefix)) return undefined;

  try {
    return knowledgeDocumentHref(id, revision);
  } catch {
    return undefined;
  }
}

/** Build source links only from a fully validated, host-owned document. */
export function knowledgeCitationFromDocument(document: KnowledgeDocument, number: number): KnowledgeCitation | undefined {
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const result = knowledgeDocumentSchema.safeParse(document);
  if (!result.success) return undefined;
  const source = result.data;
  const href = knowledgeCitationHref(source, undefined);
  if (!href) return undefined;

  return {
    citationId: source.citationId,
    id: source.id,
    title: source.title,
    sourceLabel: knowledgeSourceLabel(source.sourceSystem),
    revision: source.revision,
    href,
    number,
  };
}

/** Derive a same-origin reader route; invalid chat context is omitted. */
export function knowledgeCitationHref(
  citation: Pick<KnowledgeCitation, "citationId" | "id" | "revision">,
  origin?: KnowledgeCitationOrigin,
): string | undefined {
  const href = citationBaseHref(citation.citationId, citation.id, citation.revision);
  if (!href || !origin) return href;

  const parsedOrigin = originSchema.safeParse(origin);
  if (!parsedOrigin.success) return href;
  const query = new URLSearchParams({
    chat: parsedOrigin.data.sessionId,
    message: parsedOrigin.data.messageId,
  });
  return `${href}&${query.toString()}`;
}

/** Rebuild a runtime renderer mapping from its identity; never trust its href. */
export function normalizeKnowledgeCitation(value: unknown, origin?: KnowledgeCitationOrigin): KnowledgeCitation | undefined {
  const parsed = citationShapeSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(parsed.data.revision) || !Number.isSafeInteger(parsed.data.number) || parsed.data.number < 1) {
    return undefined;
  }

  const href = knowledgeCitationHref(parsed.data, origin);
  if (!href) return undefined;
  return {
    citationId: parsed.data.citationId,
    id: parsed.data.id,
    title: parsed.data.title,
    sourceLabel: parsed.data.sourceLabel,
    revision: parsed.data.revision,
    href,
    number: parsed.data.number,
  };
}
