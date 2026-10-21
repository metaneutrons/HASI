import { z } from "zod";

export const knowledgeDocumentId = z.string().regex(/^(svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u);
export { knowledgeDocumentV2Schema as knowledgeDocumentSchema } from '@hasi/knowledge-plugin/contracts';
import { knowledgeDocumentV2Schema as knowledgeDocumentSchema } from '@hasi/knowledge-plugin/contracts';
// Host transport/provenance metadata is not part of the document contract.
export const knowledgeSearchResultSchema = z.object({ documents: z.array(knowledgeDocumentSchema).max(5), contextId: z.uuid().optional() });
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;
export interface KnowledgeSourceMessage {
  sources: KnowledgeDocument[];
  sourceContextId?: string;
}

export function knowledgeSourceMessage(result: KnowledgeSearchResult): KnowledgeSourceMessage {
  return {
    sources: result.documents,
    ...(result.contextId ? { sourceContextId: result.contextId } : {}),
  };
}

export function knowledgeSourceSummary(documents: readonly Pick<KnowledgeDocument, "synthetic">[]): string {
  if (documents.length === 0) return "Keine passenden, aktuell freigegebenen Quellen gefunden.";
  return "Gefundene freigegebene Quellen.";
}

export function knowledgeDocumentHref(id: string, revision?: number) { return `/sources/${knowledgeDocumentId.parse(id)}${revision === undefined ? "" : `?revision=${String(z.number().int().positive().parse(revision))}`}`; }
export function knowledgeSourceLabel(source: KnowledgeDocument["sourceSystem"]) { return source === "service_it" ? "Service IT" : "Intranet"; }

/** Compact evidence for the model; full authorized text stays in the source reader. */
export function knowledgeModelDocuments(documents: readonly Record<string, unknown>[]) {
  const projected = documents.slice(0, 3).map(document => ({
    id: document.id, citationId: document.citationId, title: document.title,
    sourceSystem: document.sourceSystem, revision: document.revision, language: document.language,
    text: typeof document.text === "string" ? document.text.slice(0, 900) : "",
    synthetic: document.synthetic, updatedAt: document.updatedAt,
    ...(document.acquisition ? { acquisition: document.acquisition } : {}),
    ...(document.incident ? { incident: document.incident } : {}),
    images: Array.isArray(document.images) ? document.images.slice(0, 2).map((image: unknown) => {
      const value = image as Record<string, unknown>;
      return { alt: typeof value.alt === "string" ? value.alt.slice(0, 100) : "", transcript: typeof value.transcript === "string" ? value.transcript.slice(0, 300) : "" };
    }) : [],
  }));
  // Leave room for the host context ID/notice inside the 8,000-character tool envelope.
  // Never truncate a citation or emit a partially serialized record.
  while (JSON.stringify(projected).length > 7_000) {
    const longest = [...projected].sort((left, right) => right.text.length - left.text.length)[0];
    if (longest && longest.text.length > 100) longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
    else if (projected.some(document => document.images.length)) projected.forEach(document => { document.images = []; });
    else projected.pop();
  }
  return projected;
}

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;
export async function searchKnowledge(request: Requester, args: { query: string; sourceSystem?: "service_it" | "intranet"; limit?: number }) {
  const raw = await request<unknown>("/api/tools/call", { method: "POST", body: JSON.stringify({ pluginId: "de.hsh.hasi.knowledge", name: "knowledge.search", arguments: { ...args, limit: Math.min(args.limit ?? 3, 3) } }) });
  const result = knowledgeSearchResultSchema.parse(raw);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 60 * 1024) throw new Error("Die Wissensantwort überschreitet die zulässige Größe.");
  return result;
}
