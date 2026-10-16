import { z } from "zod";

export const knowledgeDocumentId = z.string().regex(/^(svc|int)-[0-9]{3}$/u);
export const knowledgeDocumentSchema = z.strictObject({
  id: knowledgeDocumentId,
  citationId: z.string().regex(/^demo:knowledge:(service-it|intranet):[0-9]{3}$/u),
  title: z.string().min(1).max(200),
  sourceSystem: z.enum(["service_it", "intranet"]),
  language: z.enum(["de", "en"]),
  revision: z.number().int().positive(),
  synthetic: z.literal(true),
  text: z.string().min(1).max(4000),
}).refine((doc) => doc.citationId === `demo:knowledge:${doc.sourceSystem === "service_it" ? "service-it" : "intranet"}:${doc.id.slice(4)}`
  && doc.id.startsWith(doc.sourceSystem === "service_it" ? "svc-" : "int-"));
export const knowledgeSearchResultSchema = z.strictObject({ documents: z.array(knowledgeDocumentSchema).max(5) });
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export function knowledgeDocumentHref(id: string) { return `/sources/${knowledgeDocumentId.parse(id)}`; }
export function knowledgeSourceLabel(source: KnowledgeDocument["sourceSystem"]) { return source === "service_it" ? "Service IT · Demo" : "Intranet · Demo"; }

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;
export async function searchKnowledge(request: Requester, args: { query: string; sourceSystem?: "service_it" | "intranet"; limit?: number }) {
  const raw = await request<unknown>("/api/tools/call", { method: "POST", body: JSON.stringify({ pluginId: "de.hsh.hasi.knowledge", name: "knowledge.search", arguments: { ...args, limit: Math.min(args.limit ?? 3, 3) } }) });
  const result = knowledgeSearchResultSchema.parse(raw);
  if (JSON.stringify(result).length > 8000) throw new Error("Die Wissensantwort überschreitet die zulässige Größe.");
  return result;
}
