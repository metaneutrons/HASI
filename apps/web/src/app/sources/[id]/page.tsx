import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/app-shell";
import { KnowledgeDocumentPage } from "@/components/knowledge-document";
import { knowledgeDocumentId } from "@/lib/knowledge";

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const result = knowledgeDocumentId.safeParse((await params).id);
  if (!result.success) notFound();
  return <WorkspaceShell><KnowledgeDocumentPage documentId={result.data} /></WorkspaceShell>;
}
