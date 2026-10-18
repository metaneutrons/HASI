import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/app-shell";
import { KnowledgeDocumentPage } from "@/components/knowledge-document";
import { knowledgeDocumentId } from "@/lib/knowledge";

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

  const revisionValue = query.revision;
  if (revisionValue !== undefined && (typeof revisionValue !== "string" || !/^[1-9]\d*$/.test(revisionValue))) notFound();
  const revision = revisionValue === undefined ? undefined : Number(revisionValue);
  if (revision !== undefined && !Number.isSafeInteger(revision)) notFound();

  return <WorkspaceShell><KnowledgeDocumentPage documentId={result.data} {...(revision === undefined ? {} : { revision })} /></WorkspaceShell>;
}
