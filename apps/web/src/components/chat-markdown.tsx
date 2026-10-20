import ReactMarkdown, { type Components } from "react-markdown";
import Link from "next/link";
import remarkGfm from "remark-gfm";
import { knowledgeCitationHref, normalizeKnowledgeCitation, type KnowledgeCitation, type KnowledgeCitationOrigin } from "@/lib/knowledge-citations";
import styles from "./chat-markdown.module.css";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
  url?: string;
}

type CitationRender = KnowledgeCitation & { accessibleLabel: string };

const excludedNodeTypes = new Set(["code", "inlineCode", "link", "linkReference", "image", "imageReference", "html"]);
const citationTokenPattern = /\[knowledge:(?:service_it|intranet):(?:svc|int)-[A-Za-z0-9][A-Za-z0-9._~-]{0,127}:[1-9][0-9]*\]/gu;

function validatedHttpUrl(value: string): string | undefined {
  if (!/^https?:\/\//iu.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value)) return undefined;

  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function citationAccessibleLabel(citation: KnowledgeCitation): string {
  return `Quelle ${String(citation.number)}: ${citation.title}; ${citation.sourceLabel}; Fassung ${String(citation.revision)}`;
}

function splitCitationText(value: string, citations: ReadonlyMap<string, CitationRender>): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(citationTokenPattern)) {
    const token = match[0];
    const position = match.index;
    const citation = citations.get(token.slice(1, -1));
    if (position > cursor) nodes.push({ type: "text", value: value.slice(cursor, position) });
    nodes.push(citation
      ? {
        type: "link",
        url: citation.href,
        data: { hProperties: { "data-knowledge-citation": citation.citationId } },
        children: [{ type: "text", value: `[${String(citation.number)}]` }],
      }
      : {
        type: "link",
        url: "#",
        data: { hProperties: { "data-knowledge-citation-unavailable": "true" } },
        children: [{ type: "text", value: "[?]" }],
      });
    cursor = position + token.length;
  }

  if (cursor === 0) return [{ type: "text", value }];
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function transformTextNodes(node: MarkdownNode, citations: ReadonlyMap<string, CitationRender>): void {
  if (excludedNodeTypes.has(node.type) || !node.children) return;

  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (excludedNodeTypes.has(child.type)) {
      children.push(child);
    } else if (child.type === "text" && typeof child.value === "string") {
      children.push(...splitCitationText(child.value, citations));
    } else {
      transformTextNodes(child, citations);
      children.push(child);
    }
  }
  node.children = children;
}

function remarkKnowledgeCitations(citations: ReadonlyMap<string, CitationRender>) {
  return () => (tree: MarkdownNode) => {
    transformTextNodes(tree, citations);
  };
}

function markdownComponents(citations: ReadonlyMap<string, CitationRender>, onCitationOpen?: (citation: KnowledgeCitation) => void): Components {
  return {
    a({ children, href, node }) {
      const properties = node?.properties as Record<string, unknown> | undefined;
      if (properties?.["data-knowledge-citation-unavailable"] === "true") {
        return <span className={styles.citationUnavailable} role="note" aria-label="Quelle nicht zugeordnet" title="Quelle nicht zugeordnet">[?]</span>;
      }
      const marker = properties?.["data-knowledge-citation"];
      const citation = typeof marker === "string" ? citations.get(marker) : undefined;
      if (citation && href === citation.href) {
        return <Link
          className={styles.citation}
          href={citation.href}
          prefetch={false}
          aria-label={citation.accessibleLabel}
          title={citation.accessibleLabel}
          onClick={(event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            onCitationOpen?.(citation);
          }}
        >{children}</Link>;
      }

      const safeHref = href ? validatedHttpUrl(href) : undefined;
      return safeHref
        ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>;
    },
    img: () => null,
    table({ children }) {
      return <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Markdown-Tabelle, horizontal scrollbar"><table>{children}</table></div>;
    },
  };
}

/** Render Markdown as safe, local chat content. The original source remains the caller's data. */
export function ChatMarkdown({
  source,
  citations,
  origin,
  onCitationOpen,
}: {
  source: string;
  citations?: readonly KnowledgeCitation[];
  origin?: KnowledgeCitationOrigin;
  onCitationOpen?: (citation: KnowledgeCitation) => void;
}) {
  const citationsById = new Map<string, CitationRender>();
  const citationsByHref = new Map<string, CitationRender>();
  for (const mapping of citations ?? []) {
    const citation = normalizeKnowledgeCitation(mapping, origin);
    if (!citation || citationsById.has(citation.citationId)) continue;
    const href = knowledgeCitationHref(citation, origin);
    if (!href) continue;
    const renderCitation: CitationRender = { ...citation, href, accessibleLabel: citationAccessibleLabel(citation) };
    citationsById.set(renderCitation.citationId, renderCitation);
    citationsByHref.set(renderCitation.href, renderCitation);
  }

  const urlTransform = (value: string) => citationsByHref.has(value) ? value : validatedHttpUrl(value);
  return <div className={styles.markdown}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkKnowledgeCitations(citationsById)]} components={markdownComponents(citationsById, onCitationOpen)} skipHtml urlTransform={urlTransform}>
      {source}
    </ReactMarkdown>
  </div>;
}
