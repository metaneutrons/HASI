"use client";

import Link from "next/link";
import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";
import { knowledgeDocumentSchema, knowledgeSourceLabel, type KnowledgeDocument } from "@/lib/knowledge";
import { knowledgeChatReturnHref, type KnowledgeOrigin } from "@/lib/knowledge-navigation";
import { useSession } from "./session-provider";

const REVALIDATE_INTERVAL_MS = 30_000;
const UNAVAILABLE_MESSAGE = "Dieses Dokument ist nicht verfügbar, wurde geändert oder ist nicht für dein Konto freigegeben.";

function requestCanUpdate(mounted: boolean, controller: AbortController): boolean {
  return mounted && !controller.signal.aborted;
}

export function KnowledgeDocumentPage({ documentId, revision, origin }: { documentId: string; revision?: number; origin?: KnowledgeOrigin }) {
  const { user } = useSession();
  return user
    ? <DocumentReader key={`${user.id}:${documentId}:${revision === undefined ? "latest" : String(revision)}`} documentId={documentId} {...(revision === undefined ? {} : { revision })} {...(origin ? { origin } : {})} />
    : null;
}

function formatKnowledgeDate(value: string, language: KnowledgeDocument["language"]): string {
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function documentRequestPath(documentId: string, revision?: number): string {
  const path = `/api/knowledge/documents/${encodeURIComponent(documentId)}`;
  return revision === undefined ? path : `${path}?revision=${String(revision)}`;
}

function DocumentReader({ documentId, revision, origin }: { documentId: string; revision?: number; origin?: KnowledgeOrigin }) {
  const [activeDocument, setActiveDocument] = useState<KnowledgeDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let requestRunning = false;
    let activeController: AbortController | null = null;

    const revalidate = async () => {
      if (!mounted || requestRunning) return;
      requestRunning = true;
      setActiveDocument(null);
      setError(null);
      setLoading(true);

      const controller = new AbortController();
      activeController = controller;
      try {
        const result = await apiRequest<{ document: unknown }>(documentRequestPath(documentId, revision), {
          signal: controller.signal,
        });
        if (!requestCanUpdate(mounted, controller)) return;

        const parsed = knowledgeDocumentSchema.parse(result.document);
        if (parsed.id !== documentId || (revision !== undefined && parsed.revision !== revision)) {
          throw new Error("Document identity or revision changed.");
        }
        setActiveDocument(parsed);
      } catch {
        if (!requestCanUpdate(mounted, controller)) return;
        setError(UNAVAILABLE_MESSAGE);
      } finally {
        if (requestCanUpdate(mounted, controller) && activeController === controller) {
          activeController = null;
          requestRunning = false;
          setLoading(false);
        }
      }
    };

    const revalidateWhenVisible = () => {
      if (window.document.visibilityState === "visible") void revalidate();
    };

    void revalidate();
    const interval = window.setInterval(revalidateWhenVisible, REVALIDATE_INTERVAL_MS);
    window.addEventListener("focus", revalidateWhenVisible);
    window.document.addEventListener("visibilitychange", revalidateWhenVisible);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidateWhenVisible);
      window.document.removeEventListener("visibilitychange", revalidateWhenVisible);
      activeController?.abort();
    };
  }, [documentId, revision]);

  return <section className="knowledge-reader" aria-label="Wissensdokument">
    <Link className="knowledge-back" href={knowledgeChatReturnHref(origin)}><ArrowLeft size={18} aria-hidden="true" /> {origin ? "Zurück zur Nachricht" : "Zum Chat"}</Link>
    {error ? <p className="knowledge-reader__status knowledge-reader__status--error" role="alert">{error}</p>
      : !activeDocument ? <p className="knowledge-reader__status" role="status">{loading ? "Dokument und Zugriffsrecht werden geprüft …" : UNAVAILABLE_MESSAGE}</p>
        : <DocumentArticle document={activeDocument} />}
  </section>;
}

function DocumentArticle({ document }: { document: KnowledgeDocument }) {
  const synthetic = document.synthetic;
  const english = document.language === "en";
  const incident = document.incident;
  const originalHref = !document.synthetic
    ? `/api/knowledge/documents/${encodeURIComponent(document.id)}/original?revision=${String(document.revision)}`
    : undefined;
  const demoHref = document.synthetic && document.sourceSystem === 'service_it' && document.acquisition?.adapter === 'web'
    ? `/api/knowledge/documents/${encodeURIComponent(document.id)}/demo-source?revision=${String(document.revision)}`
    : undefined;

  return <article className="knowledge-reader__article">
    {synthetic && <div className="knowledge-demo-label"><BookOpen size={18} aria-hidden="true" /> Synthetisches Demo-Dokument</div>}
    <dl className="knowledge-reader__facts">
      <div><dt>Quelle</dt><dd>{knowledgeSourceLabel(document.sourceSystem, synthetic)}</dd></div>
      <div><dt>{english ? "Revision" : "Fassung"}</dt><dd>{document.revision}</dd></div>
      <div><dt>Sprache</dt><dd>{document.language.toUpperCase()}</dd></div>
    </dl>
    <h1>{document.title}</h1>

    {synthetic && <p className="knowledge-disclaimer">Dieser Text ist vollständig synthetisch. Er beschreibt keine tatsächlichen HsH-Dienste, Fristen oder Verfahren.</p>}
    <dl className="knowledge-reader__facts knowledge-reader__facts--dates">
      <div>
        <dt>{document.acquisition ? (english ? "Indexed" : "Im Index aktualisiert") : (english ? "Updated" : "Aktualisiert")}</dt>
        <dd><time dateTime={document.updatedAt}>{formatKnowledgeDate(document.updatedAt, document.language)}</time></dd>
      </div>
      <div>
        <dt>{english ? "Retrieved" : "Abgerufen"}</dt>
        <dd><time dateTime={document.fetchedAt}>{formatKnowledgeDate(document.fetchedAt, document.language)}</time></dd>
      </div>
    </dl>
    {document.acquisition && <p className="knowledge-disclaimer">{english ? "Source updated: " : "Stand der Quelle: "}{document.acquisition.sourceUpdatedAt
      ? <time dateTime={document.acquisition.sourceUpdatedAt}>{formatKnowledgeDate(document.acquisition.sourceUpdatedAt, document.language)}</time>
      : (english ? "not provided by the source" : "von der Quelle nicht angegeben")}</p>}
    {incident && <aside className={`knowledge-reader__incident knowledge-reader__incident--${incident.status}`}>
      <strong>{incident.status === "active"
        ? (english ? "Active incident" : "Aktuelle Störung")
        : (english ? "Resolved incident" : "Behobene Störung")}</strong>
      <p>{english ? "Valid until" : "Gültig bis"}: <time dateTime={incident.validUntil}>{formatKnowledgeDate(incident.validUntil, document.language)}</time></p>
    </aside>}

    <div className="knowledge-body">{document.text}</div>

    {document.images.length > 0 && <section className="knowledge-reader__images" aria-label={english ? "Reviewed image descriptions" : "Geprüfte Bildbeschreibungen"}>
      <h2>{english ? "Images and transcripts" : "Bilder und Transkripte"}</h2>
      <div className="knowledge-reader__image-list">
        {document.images.map((image) => <figure className="knowledge-reader__image" key={image.id}>
          <figcaption>
            <strong>{image.alt}</strong>
            <p>{image.transcript}</p>
          </figcaption>
        </figure>)}
      </div>
    </section>}

    <footer>
      <details className="knowledge-source-details"><summary>Quellendetails</summary><span>Quellenkennung</span><code>{document.citationId}</code></details>
      {originalHref && <a className="knowledge-reader__original" href={originalHref} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={16} aria-hidden="true" /> {english ? "Open authorized original" : "Autorisierte Originalquelle öffnen"}
      </a>}
      {demoHref && <a className="knowledge-reader__original" href={demoHref} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={16} aria-hidden="true" /> Demoquelle öffnen · HsH-Netz
      </a>}
    </footer>
  </article>;
}
