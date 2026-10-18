import { describe, expect, it } from 'vitest';
import { extractContentHtml } from '../apps/knowledge-plugin/src/content/html.js';

const ERROR = 'Content HTML extraction failed';

describe('extractContentHtml', () => {
  it('extracts decoded article text and bounded image and link metadata', () => {
    const result = extractContentHtml(`<!doctype html>
      <html lang="de-DE"><head>
        <title> H&amp;SI&nbsp;Leitfäden </title>
        <meta property="article:modified_time" content="2026-10-18T12:30:45+02:00">
      </head><body>
        <nav>Navigation contamination</nav>
        <main>
          <header>Site header contamination</header>
          <h1>Hauptthema</h1>
          <p>Ein &amp; zwei &lt; drei.</p>
          <ul><li>Erster Punkt</li><li>Zweiter Punkt</li></ul>
          <table><tr><th>Ort</th><th>Zeit</th></tr><tr><td>Hannover</td><td>09:00</td></tr></table>
          <p><a href="/wissen?a=1&amp;b=2">Weiterlesen</a></p>
          <img alt="Raum &amp; Gebäude" src="/images/raum.png">
          <img alt="Ohne Quelle">
        </main>
        <footer>Footer contamination</footer>
      </body></html>`);

    expect(result).toMatchObject({
      title: 'H&SI Leitfäden',
      language: 'de',
      sourceUpdatedAt: '2026-10-18T12:30:45+02:00',
      images: [
        { alt: 'Raum & Gebäude', sourceUrl: '/images/raum.png' },
        { alt: 'Ohne Quelle', sourceUrl: null },
      ],
      links: ['/wissen?a=1&b=2'],
    });
    expect(result.text).toContain('Hauptthema');
    expect(result.text).toContain('Ein & zwei < drei.');
    expect(result.text).toContain('- Erster Punkt\n- Zweiter Punkt');
    expect(result.text).toContain('Ort | Zeit\nHannover | 09:00');
    expect(result.text).not.toMatch(/Navigation|Site header|Footer/);
  });

  it('supports an explicitly selected container and MediaWiki fragments without a document title', () => {
    const result = extractContentHtml(
      '<div class="mw-parser-output"><p>Text&nbsp;aus dem Artikel</p><aside>Andere Hinweise</aside></div>',
      { container: { kind: 'class', value: 'mw-parser-output' }, fragment: true },
    );

    expect(result.title).toBe('');
    expect(result.text).toContain('Text aus dem Artikel');
    expect(result.text).toContain('Andere Hinweise');
  });

  it('drops navigation, executable and hidden content while preserving visible text', () => {
    const result = extractContentHtml(`<!doctype html><html><head><title>Test</title></head><body>
      <main>
        <nav>Nav</nav><header>Header</header><footer>Footer</footer>
        <script>document.write('executed')</script><style>.x { color: red }</style>
        <p hidden>Hidden attribute</p><p aria-hidden="true">ARIA hidden</p>
        <p style="display: none !important">CSS hidden</p>
        <form action="/search"><button>Search</button></form>
        <p>Visible text</p>
      </main></body></html>`);

    expect(result.text).toBe('Visible text');
    expect(result.links).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it('rejects login and authentication forms anywhere in the parsed input', () => {
    const pages = [
      '<!doctype html><title>Page</title><main><p>Content</p></main><aside><form><input type="password"></form></aside>',
      '<!doctype html><title>Page</title><main><p>Content</p></main><form action="/auth/sso"><input type="text"></form>',
      '<div><form action="/saml/consume"><button>Continue</button></form></div>',
    ];

    for (const page of pages) expect(() => extractContentHtml(page, { fragment: page.startsWith('<div>') })).toThrow(ERROR);
  });

  it('rejects missing or ambiguous containers and document titles', () => {
    expect(() => extractContentHtml('<!doctype html><title>T</title><main>A</main><main>B</main>')).toThrow(ERROR);
    expect(() => extractContentHtml('<!doctype html><title>T</title><div>No main</div>')).toThrow(ERROR);
    expect(() => extractContentHtml('<!doctype html><title>T</title><main><div id="pick">A</div><div id="pick">B</div></main>', {
      container: { kind: 'id', value: 'pick' },
    })).toThrow(ERROR);
    expect(() => extractContentHtml('<main>Missing title</main>')).toThrow(ERROR);
  });

  it('omits invalid modified times and rejects oversized extracted fields', () => {
    const invalidTimestamp = extractContentHtml(`<!doctype html><html><head><title>T</title>
      <meta property="article:modified_time" content="2026-02-30T12:00:00Z"></head><body><article>Body</article></body></html>`);
    expect(invalidTimestamp.sourceUpdatedAt).toBeUndefined();

    expect(() => extractContentHtml(`<!doctype html><title>${'t'.repeat(201)}</title><main>Body</main>`)).toThrow(ERROR);
    expect(() => extractContentHtml(`<!doctype html><title>T</title><main>${'x'.repeat(200_001)}</main>`)).toThrow(ERROR);
    expect(() => extractContentHtml(`<!doctype html><title>T</title><main>${'<img>'.repeat(201)}</main>`)).toThrow(ERROR);
    expect(() => extractContentHtml(`<!doctype html><title>T</title><main>${'<a href="/x">x</a>'.repeat(2_001)}</main>`)).toThrow(ERROR);
    expect(() => extractContentHtml(`<main>${'x'.repeat(2 * 1024 * 1024)}</main>`)).toThrow(ERROR);
  });
});
