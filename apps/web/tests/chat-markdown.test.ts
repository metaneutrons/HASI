import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/components/chat-markdown";
import { knowledgeCitationFromDocument } from "../src/lib/knowledge-citations";
import { knowledgeDocumentSchema } from "../src/lib/knowledge";

const document = knowledgeDocumentSchema.parse({
  updatedAt: "2026-10-16T00:00:00Z",
  fetchedAt: "2026-10-16T00:00:00Z",
  authorityRevision: "a".repeat(64),
  corpusRevision: "b".repeat(64),
  dataClass: "synthetic_demo",
  images: [],
  id: "svc-001",
  citationId: "knowledge:service_it:svc-001:1",
  title: "Demo: WLAN",
  sourceSystem: "service_it",
  language: "de",
  revision: 1,
  synthetic: true,
  text: "SYNTHETISCHES DEMO-BEISPIEL: Testdaten.",
});
const citation = knowledgeCitationFromDocument(document, 1);
if (!citation) throw new Error("Expected the valid knowledge document to produce a citation.");
const token = "[knowledge:service_it:svc-001:1]";

describe("chat Markdown renderer", () => {
  it("renders headings, lists, tables, code, quotes and safe external links", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { source: [
      "# Antwort",
      "",
      "> Ein kurzer Hinweis.",
      "",
      "- eins",
      "- zwei",
      "- [x] erledigt",
      "",
      "`inline` und ~~durchgestrichen~~ und [Quelle](https://example.org/info)",
      "",
      "    const indented = true;",
      "",
      "Hard line  ",
      "next line",
      "",
      "```ts",
      "const count = 2;",
      "```",
      "",
      "| Raum | Plätze |",
      "| --- | ---: |",
      "| A | 4 |",
    ].join("\n") }));

    expect(html).toContain("<h1>Antwort</h1>");
    expect(html).toContain("<blockquote>");
    expect(html).toMatch(/<ul(?:\s[^>]*)?>/u);
    expect(html).toContain("<del>durchgestrichen</del>");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/u);
    expect(html).toContain("<pre><code>const indented = true;");
    expect(html).toContain("Hard line<br/>\nnext line");
    expect(html).toContain("<pre><code class=\"language-ts\">");
    expect(html).toContain("<div class=");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Raum</th>");
    expect(html).toContain("<a href=\"https://example.org/info\" target=\"_blank\" rel=\"noopener noreferrer\">Quelle</a>");
  });

  it("renders only exact authorized citation text as an accessible same-tab source link", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: `${token} [knowledge:service_it:svc-001:2] [knowledge:intranet:int-002:1]`,
      citations: [citation],
    }));
    expect(html).toMatch(/<a\b[^>]*class="[^"]+"[^>]*>/u);
    expect(html).toContain(`href=\"/sources/svc-001?revision=1\"`);
    expect(html).toContain("aria-label=\"Quelle 1: Demo: WLAN; Service IT; Fassung 1\"");
    expect(html).toContain(">[1]</a>");
    expect(html).not.toContain("target=\"_blank\"");
    expect(html).not.toContain("[knowledge:service_it:svc-001:2]");
    expect(html).not.toContain("[knowledge:intranet:int-002:1]");
    expect((html.match(/aria-label="Quelle nicht zugeordnet"/gu) ?? []).length).toBe(2);
    expect((html.match(/<a\b/gu) ?? []).length).toBe(1);
    expect((html.match(/<span class="[^"]*citationUnavailable/gu) ?? []).length).toBe(2);
    expect((html.match(/data-knowledge-citation=/gu) ?? []).length).toBe(0);
  });

  it("does not rewrite citation-looking tokens in code, authored links, images or raw HTML", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: [
        `Inline \`${token}\``,
        "",
        "```text",
        token,
        "```",
        "",
        `[\\${token.slice(1, -1)}\\](https://example.org/path/${encodeURIComponent(token)})`,
        "",
        "[fake](hasi-citation:knowledge:service_it:svc-001:1)",
        "",
        "[route](/sources/svc-001?revision=1)",
        "",
        "[knowledge:service_it:svc-001:1]: https://example.org/reference",
        "",
        "[knowledge:service_it:svc-001:1]",
        "",
        `![${token}](https://example.org/pixel.png)`,
        "",
        `<span>${token}</span>`,
      ].join("\n"),
      citations: [citation],
    }));
    expect(html).toContain(`<code>${token}</code>`);
    expect(html).toContain(`<pre><code class=\"language-text\">${token}`);
    expect(html).toContain("https://example.org/path/%5Bknowledge%3Aservice_it%3Asvc-001%3A1%5D");
    expect(html).toContain("href=\"https://example.org/reference\" target=\"_blank\"");
    expect(html).toContain("<span>fake</span>");
    expect(html).toContain("<span>route</span>");
    expect(html).not.toContain("hasi-citation:");
    expect(html).not.toContain("href=\"/sources/svc-001?revision=1\"");
    expect(html).not.toContain("<img");
    expect((html.match(/aria-label="Quelle 1:/gu) ?? []).length).toBe(0);
  });

  it("does not accept citation markers from raw HTML attributes or an HTML block", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: `<a data-knowledge-citation="${citation.citationId}" href="${citation.href}">forged badge</a>\n\n<div>\n${token}\n</div>`,
      citations: [citation],
    }));
    expect(html).not.toContain("<a");
    expect(html).not.toContain("data-knowledge-citation");
    expect(html).not.toContain("aria-label=\"Quelle 1:");
  });

  it("ignores an injected href and keeps malformed mapping IDs inert", () => {
    const injected = { ...citation, href: "https://attacker.example/source" };
    const invalidId = { ...citation, id: "../admin" };
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: token,
      citations: [injected, invalidId],
    }));
    expect(html).toContain(`href=\"/sources/svc-001?revision=1\"`);
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("target=\"_blank\"");

    const malformed = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: token,
      citations: [{ ...citation, id: "../admin" }],
    }));
    expect(malformed).not.toContain("<a");
    expect(malformed).toContain("[?]");
    expect(malformed).toContain("aria-label=\"Quelle nicht zugeordnet\"");
    expect(malformed).not.toContain(token);
  });

  it("adds valid return context to citation links and omits invalid context", () => {
    const valid = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: token,
      citations: [citation],
      origin: { sessionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", messageId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" },
    }));
    expect(valid).toContain("href=\"/sources/svc-001?revision=1&amp;chat=6ba7b810-9dad-41d1-80b4-00c04fd430c8&amp;message=6ba7b810-9dad-41d1-80b4-00c04fd430c8\"");

    const invalid = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: token,
      citations: [citation],
      origin: { sessionId: "../admin", messageId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" },
    }));
    expect(invalid).toContain("href=\"/sources/svc-001?revision=1\"");
  });

  it("drops raw HTML and images and rejects unsafe or credential-bearing links", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { source: [
      "<script>alert(1)</script>",
      "",
      "<img src=\"https://tracker.example/pixel\" onerror=\"alert(1)\">",
      "",
      "![remote pixel](https://tracker.example/markdown.png)",
      "",
      "[run](javascript:alert%281%29)",
      "",
      "[credential](https://user:pass@account.example/path)",
      "",
      "[safe](https://safe.example/path)",
      "",
      "<iframe src=\"https://tracker.example/embed\"></iframe>",
    ].join("\n") }));

    expect(html).not.toMatch(/<script|<img|<iframe|onerror=|javascript:|user:pass|tracker\.example/u);
    expect(html).toContain("<a href=\"https://safe.example/path\" target=\"_blank\" rel=\"noopener noreferrer\">safe</a>");
  });

  it("lists only actually rendered authorized references below the answer, without duplicates", () => {
    const unused = { ...citation, id: "svc-002", citationId: "knowledge:service_it:svc-002:1", title: "Unused result", number: 2 };
    const origin = { sessionId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", messageId: "6ba7b810-9dad-41d1-80b4-00c04fd430c9" };
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: `First ${token}, again ${token}.`, citations: [unused, citation], origin, showSources: true,
    }));
    expect(html.indexOf("Quellen dieser Antwort")).toBeGreaterThan(html.indexOf("again"));
    expect(html).toContain('<ul class="');
    expect(html).toContain('aria-label="Quellen dieser Antwort"');
    expect(html).toContain('>[1] Demo: WLAN<br/>\n<small>Service IT · Fassung 1</small></a>');
    expect(html).not.toContain("Unused result");
    expect(html).not.toContain("svc-002");
    expect((html.match(/href="\/sources\/svc-001\?revision=1&amp;chat=/gu) ?? []).length).toBe(3);
    expect((html.match(/<li>/gu) ?? []).length).toBe(1);
    expect(html).not.toContain('target="_blank"');
  });

  it("does not promote code, authored links, HTML, unavailable or GFM autolink tokens into answer references", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: [
        `\`${token}\``, "", "```text", token, "```", "",
        `[${token}](https://example.org)`, "",
        `https://example.org/${token}`, "",
        `<div>\n${token}\n</div>`, "",
        "[knowledge:service_it:svc-001:2]",
      ].join("\n"), citations: [citation], showSources: true,
    }));
    expect(html).not.toContain("Quellen dieser Antwort");
    expect(html).not.toContain('href="/sources/');
    expect(html).toContain('aria-label="Quelle nicht zugeordnet"');
  });

  it("keeps the source list opt-in and omits it without a matching authorization map", () => {
    const noList = renderToStaticMarkup(createElement(ChatMarkdown, { source: token, citations: [citation] }));
    const noProof = renderToStaticMarkup(createElement(ChatMarkdown, { source: token, showSources: true }));
    expect(noList).not.toContain("Quellen dieser Antwort");
    expect(noProof).not.toContain("Quellen dieser Antwort");
    expect(noProof).not.toContain('<a');
  });

  it("uses first-citation order in the appendix even when mappings have another order", () => {
    const second = { ...citation, id: "svc-002", citationId: "knowledge:service_it:svc-002:1", title: "Second source", number: 2 };
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      source: `| Source |\n| --- |\n| [${second.citationId}] |\n\nThen ${token}.`,
      citations: [citation, second], showSources: true,
    }));
    const appendix = html.slice(html.indexOf('aria-label="Quellen dieser Antwort"'));
    expect(appendix).toContain('>[2] Second source');
    expect(appendix.indexOf('>[2] Second source')).toBeLessThan(appendix.indexOf('>[1] Demo: WLAN'));
    expect((appendix.match(/<li>/gu) ?? []).length).toBe(2);
  });
});
