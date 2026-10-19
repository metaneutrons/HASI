import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/components/chat-markdown";

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
});
