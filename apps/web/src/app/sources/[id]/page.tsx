import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/app-shell";
import { KnowledgeDocumentPage } from "@/components/knowledge-document";
import { knowledgeDocumentId } from "@/lib/knowledge";
import { knowledgeOrigin, knowledgeRevisionQuery } from "@/lib/knowledge-navigation";

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [routeParams, query] = await Promise.all([params, searchParams]);
  const result = knowledgeDocumentId.safeParse(routeParams.id);
  if (!result.success) notFound();

  const revisions = knowledgeRevisionQuery(query);
  if (!revisions) notFound();

  const origin = knowledgeOrigin(query.chat, query.message);
  return <WorkspaceShell><KnowledgeDocumentPage documentId={result.data} {...revisions} {...(origin ? { origin } : {})} /></WorkspaceShell>;
}
