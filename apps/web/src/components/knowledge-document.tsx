"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import { knowledgeDocumentSchema, knowledgeSourceLabel, type KnowledgeDocument } from "@/lib/knowledge";
import { knowledgeChatReturnHref, knowledgeCurrentRevisionHref, type KnowledgeOrigin } from "@/lib/knowledge-navigation";
import { useSession } from "./session-provider";

const REVALIDATE_INTERVAL_MS = 30_000;
const UNAVAILABLE_MESSAGE = "Dieses Dokument ist nicht verfügbar, wurde geändert oder ist nicht für dein Konto freigegeben.";

function requestCanUpdate(mounted: boolean, controller: AbortController): boolean {
  return mounted && !controller.signal.aborted;
}

export function KnowledgeDocumentPage({ documentId, revision, fromRevision, origin }: { documentId: string; revision?: number; fromRevision?: number; origin?: KnowledgeOrigin }) {
  const { user } = useSession();
  return user
    ? <DocumentReader key={`${user.id}:${documentId}:${revision === undefined ? "latest" : String(revision)}:${fromRevision === undefined ? "" : String(fromRevision)}`} documentId={documentId} {...(revision === undefined ? {} : { revision })} {...(fromRevision === undefined ? {} : { fromRevision })} {...(origin ? { origin } : {})} />
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

function DocumentReader({ documentId, revision, fromRevision, origin }: { documentId: string; revision?: number; fromRevision?: number; origin?: KnowledgeOrigin }) {
  const [activeDocument, setActiveDocument] = useState<KnowledgeDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceDetailsOpen, setSourceDetailsOpen] = useState(false);
  const readerRef = useRef<HTMLElement>(null);
  const restoreDetailsFocus = useRef(false);
  const [revalidationHeight, setRevalidationHeight] = useState<number | null>(null);
  const recoveryHref = revision === undefined ? undefined : knowledgeCurrentRevisionHref(documentId, revision, origin);

  useEffect(() => {
    let mounted = true;
    let requestRunning = false;
    let activeController: AbortController | null = null;

    const revalidate = async () => {
      if (!mounted || requestRunning) return;
      requestRunning = true;
      // Remove stale content during the rights check without collapsing the
      // reader and resetting the browser's current scroll position.
      setRevalidationHeight(readerRef.current?.getBoundingClientRect().height ?? null);
      restoreDetailsFocus.current = readerRef.current?.querySelector(".knowledge-source-details > summary") === window.document.activeElement;
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
        restoreDetailsFocus.current = false;
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

  useEffect(() => {
    if (!activeDocument || !restoreDetailsFocus.current) return;
    restoreDetailsFocus.current = false;
    if (window.document.activeElement !== window.document.body) return;
    readerRef.current?.querySelector<HTMLElement>(".knowledge-source-details > summary")?.focus({ preventScroll: true });
  }, [activeDocument]);

  return <section ref={readerRef} className="knowledge-reader" aria-label="Wissensdokument" aria-busy={loading} style={{ overflowAnchor: "none", ...(loading && revalidationHeight !== null ? { minHeight: revalidationHeight } : {}) }}>
    <Link className="knowledge-back" href={knowledgeChatReturnHref(origin)}><ArrowLeft size={18} aria-hidden="true" /> {origin ? "Zurück zur Nachricht" : "Zum Chat"}</Link>
    {error ? <>
      <h1>Quelle nicht verfügbar</h1>
      <p className="knowledge-reader__status knowledge-reader__status--error" role="alert">{error}</p>
      {recoveryHref && <Link className="knowledge-reader__original" href={recoveryHref}>Aktuelle Fassung prüfen</Link>}
    </>
      : !activeDocument ? <p className="knowledge-reader__status" role="status">{loading ? "Dokument und Zugriffsrecht werden geprüft …" : UNAVAILABLE_MESSAGE}</p>
        : <DocumentArticle document={activeDocument} {...(fromRevision === undefined ? {} : { fromRevision })} detailsOpen={sourceDetailsOpen} onDetailsChange={setSourceDetailsOpen} />}
  </section>;
}

function DocumentArticle({ document, fromRevision, detailsOpen, onDetailsChange }: { document: KnowledgeDocument; fromRevision?: number; detailsOpen: boolean; onDetailsChange: (open: boolean) => void }) {
  const english = document.language === "en";
  const incident = document.incident;
  const originalHref = !document.synthetic
    ? `/api/knowledge/documents/${encodeURIComponent(document.id)}/original?revision=${String(document.revision)}`
    : undefined;
  const demoHref = document.synthetic && document.sourceSystem === 'service_it' && document.acquisition?.adapter === 'web'
    ? `/api/knowledge/documents/${encodeURIComponent(document.id)}/demo-source?revision=${String(document.revision)}`
    : undefined;

  return <article className="knowledge-reader__article">
    <dl className="knowledge-reader__facts">
      <div><dt>Quelle</dt><dd>{knowledgeSourceLabel(document.sourceSystem)}</dd></div>
      <div><dt>{english ? "Revision" : "Fassung"}</dt><dd>{document.revision}</dd></div>
      <div><dt>Sprache</dt><dd>{document.language.toUpperCase()}</dd></div>
    </dl>
    <h1>{document.title}</h1>

    {fromRevision !== undefined && <p className="knowledge-reader__status" role="status">
      {document.revision === fromRevision
        ? `Die angeforderte Fassung ${String(fromRevision)} wurde erneut geprüft und ist als aktuelle Fassung verfügbar. Die Quellenangabe in der Chatnachricht bleibt unverändert.`
        : `Du hast Fassung ${String(fromRevision)} angefordert. Angezeigt wird die aktuell verfügbare Fassung ${String(document.revision)}; sie kann vom damaligen Text abweichen. Die Quellenangabe in der Chatnachricht bleibt unverändert.`}
    </p>}

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
      <details className="knowledge-source-details" open={detailsOpen} onToggle={event => { onDetailsChange(event.currentTarget.open); }}>
        <summary>Quellendetails</summary>
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
        <span>Quellenkennung</span><code>{document.citationId}</code>
      </details>
      {originalHref && <a className="knowledge-reader__original" href={originalHref} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={16} aria-hidden="true" /> {english ? "Open authorized original" : "Autorisierte Originalquelle öffnen"}
      </a>}
      {demoHref && <div className="knowledge-replica-link">
        <a className="knowledge-reader__original" href={demoHref} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} aria-hidden="true" /> Quellwebsite öffnen
        </a>
        <p>Die Quellwebsite ist auf freigegebene Hochschuladressen beschränkt. Die freigegebene Dokumentfassung kannst du hier lesen.</p>
      </div>}
    </footer>
  </article>;
}
