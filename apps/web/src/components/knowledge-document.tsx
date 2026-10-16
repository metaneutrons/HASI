"use client";

import Link from "next/link";
import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { knowledgeDocumentSchema, knowledgeSourceLabel, type KnowledgeDocument } from "@/lib/knowledge";
import { useSession } from "./session-provider";

export function KnowledgeDocumentPage({ documentId }: { documentId: string }) {
  const { user } = useSession();
  return user ? <DocumentReader key={`${user.id}:${documentId}`} documentId={documentId} /> : null;
}

function DocumentReader({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ document: unknown }>(`/api/knowledge/documents/${encodeURIComponent(documentId)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setDocument(knowledgeDocumentSchema.parse(result.document)); })
      .catch(() => { if (!controller.signal.aborted) setError("Dieses Dokument ist nicht verfügbar oder für dein Testkonto nicht freigegeben."); });
    return () => controller.abort();
  }, [documentId]);
  return <section className="knowledge-reader">
    <Link className="knowledge-back" href="/"><ArrowLeft size={18} aria-hidden="true" /> Zum Chat</Link>
    <div className="knowledge-demo-label"><BookOpen size={18} aria-hidden="true" /> Synthetisches Demo-Dokument</div>
    {error ? <p role="alert">{error}</p> : !document ? <p role="status">Dokument wird geladen …</p> : <article>
      <p className="knowledge-meta">{knowledgeSourceLabel(document.sourceSystem)} · Fassung {document.revision} · {document.language.toUpperCase()}</p>
      <h1>{document.title}</h1>
      <p className="knowledge-disclaimer">Dieser Text ist vollständig erfunden. Er beschreibt keine tatsächlichen HsH-Dienste, Fristen oder Verfahren.</p>
      <p className="knowledge-body">{document.text}</p>
      <footer><span>Quellenkennung</span><code>{document.citationId}</code></footer>
    </article>}
  </section>;
}
