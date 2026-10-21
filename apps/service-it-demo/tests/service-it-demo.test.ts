import { afterEach, describe, expect, it } from 'vitest';
import { knowledgeDocuments } from '@hasi/demo-fixtures/knowledge-catalog';
import {
  createServiceItDemo,
  SERVICE_IT_CANONICAL_ORIGIN,
  serviceItDocuments,
  type ServiceItDocument,
} from '../src/index.js';

const apps: ReturnType<typeof createServiceItDemo>[] = [];

function makeApp(documents?: readonly ServiceItDocument[]) {
  const app = createServiceItDemo(documents === undefined ? {} : { documents });
  apps.push(app);
  return app;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixtureDocument(id: string): ServiceItDocument {
  const document = serviceItDocuments.find((candidate) => candidate.id === id) ?? serviceItDocuments[0];
  if (!document) throw new Error('Expected at least one synthetic service IT document.');
  return document;
}

function topicKeys(documents: readonly ServiceItDocument[]): string[] {
  return [...new Set(documents.flatMap((document) => {
    const explicitTopic = document.tags.find((tag) => tag.startsWith('topic:'));
    const topic = explicitTopic?.slice('topic:'.length)
      ?? document.tags.find((tag) => !tag.includes(':'));
    return topic ? [topic] : [];
  }))];
}

describe('synthetic Service IT portal', () => {
  it('loads all and only synthetic Service IT documents from the shared fixture', () => {
    const expectedIds = knowledgeDocuments
      .filter((document) => document.sourceSystem === 'service_it')
      .map((document) => document.id);
    expect(serviceItDocuments.map((document) => document.id)).toEqual(expectedIds);
    expect(serviceItDocuments.map((document) => document.id)).toContain('svc-001');
  });

  it('serves a responsive, self-contained portal with searchable topics and dynamic fixture entries', async () => {
    const app = makeApp();
    const [services, faqs, news, filtered] = await Promise.all([
      app.inject({ method: 'GET', url: '/de/services/' }),
      app.inject({ method: 'GET', url: '/de/faqs/' }),
      app.inject({ method: 'GET', url: '/de/meldungen/' }),
      app.inject({ method: 'GET', url: '/de/faqs/?q=VPN' }),
    ]);
    expect(services.statusCode).toBe(200);
    expect(services.body).toContain('Wobei brauchst du Hilfe?');
    expect(services.body).toContain('/de/faqs/?thema=wlan');
    expect(services.body).not.toContain('Sämtliche Inhalte sind erfunden.');
    expect(services.body).toContain('@media(max-width:560px)');
    expect(services.body).toContain('@media(prefers-color-scheme:dark)');
    expect(services.body).not.toMatch(/<script|<img|fonts\.googleapis\.com/i);
    expect(services.body.match(/class="topic-card"/g) ?? []).toHaveLength(topicKeys(serviceItDocuments).length);
    for (const document of serviceItDocuments.filter((candidate) => candidate.tags.includes('kind:service'))) {
      expect(services.body).toContain(`href="/de/faqs/${document.id}/"`);
    }
    expect(faqs.statusCode).toBe(200);
    expect(faqs.body).toContain('Suchen');
    expect(faqs.body).toContain('/de/faqs/svc-001/');
    for (const document of serviceItDocuments) expect(faqs.body).toContain(`href="/de/faqs/${document.id}/"`);
    expect(news.statusCode).toBe(200);
    expect(news.body).not.toContain('Rollenangaben sind Testdaten');
    const newsDocuments = serviceItDocuments.filter((document) => document.tags.includes('kind:news'));
    for (const document of newsDocuments) expect(news.body).toContain(`href="/de/faqs/${document.id}/"`);
    expect(news.body).not.toContain('href="/de/faqs/svc-001/"');
    const specialDocument = serviceItDocuments.find((document) => (
      ['kind:link', 'kind:form'].some((kind) => document.tags.includes(kind))
    ));
    if (specialDocument) {
      const specialSearch = await app.inject({ method: 'GET', url: `/de/faqs/?q=${encodeURIComponent(specialDocument.id)}` });
      expect(specialSearch.body).toContain(`href="/de/faqs/${specialDocument.id}/"`);
    }
    expect(filtered.body).toContain('name="q" type="search" value="VPN"');
    expect(filtered.body).toContain(fixtureDocument('svc-006').title);
    expect(services.headers['cache-control']).toContain('private, no-store');
    expect(services.headers['x-robots-tag']).toContain('noindex');
    expect(services.headers['content-security-policy']).toContain("default-src 'none'");
    expect(SERVICE_IT_CANONICAL_ORIGIN).toBe('https://service-it.hasi.metaneutrons.cc');
  });

  it('keeps each article adapter body to one title and paragraph-separated source text', async () => {
    const app = makeApp();
    const document = fixtureDocument('svc-001');
    const reply = await app.inject({ method: 'GET', url: `/de/faqs/${document.id}/` });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toContain('text/html');
    expect(reply.body).toContain(`<title>${document.title}</title>`);
    expect(reply.body).toContain(`<link rel="canonical" href="${SERVICE_IT_CANONICAL_ORIGIN}/de/faqs/${document.id}/">`);
    expect(reply.body).toContain("<main id='service-it-document'>");
    const main = /<main id='service-it-document'>([\s\S]*?)<\/main>/.exec(reply.body)?.[1];
    expect(main).toBeDefined();
    expect(main).toMatch(/^<h1>[\s\S]*?<\/h1>\s*(?:<p>[\s\S]*?<\/p>\s*)+$/);
    expect(main).toContain(`<h1>${document.title}</h1>`);
    expect(main).toContain(`<p>${document.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`);
    const normalizedArticleText = decodeHtmlText((main ?? '')
      .replace(/<\/h1>\s*/, '\n')
      .replace(/<\/p>\s*<p>/g, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    expect(normalizedArticleText).toBe(`${document.title} ${document.text}`.replace(/\s+/g, ' ').trim());
    expect(main).not.toContain('Demo-Zielgruppe');
    expect(main).not.toContain('synthetisch');
    expect(reply.body).toContain('<strong>Zielgruppe</strong>');
    expect(reply.body).not.toContain('keine reale Berechtigung');
    expect(reply.body).not.toContain('Synthetische Demo');
    expect(reply.body).toContain('Quelle:');
  });

  it('escapes fixture content and search input before placing them in HTML', async () => {
    const base = fixtureDocument('svc-001');
    const maliciousDocument: ServiceItDocument = {
      ...base,
      id: 'svc-xss',
      title: '<img src=x onerror="alert(1)">',
      text: '<script>alert("fixture")</script> & sample',
    };
    const app = makeApp([maliciousDocument]);
    const [article, search] = await Promise.all([
      app.inject({ method: 'GET', url: '/de/faqs/svc-xss/' }),
      app.inject({ method: 'GET', url: '/de/faqs/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E' }),
    ]);
    expect(article.statusCode).toBe(200);
    expect(article.body).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(article.body).toContain('&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt; &amp; sample');
    expect(article.body).not.toContain('<script>alert');
    expect(article.body).not.toContain('<img src=x');
    expect(search.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(search.body).not.toContain('<script>alert(1)</script>');
  });

  it('keeps robot directives, supports HEAD, redirects the root, and rejects unknown paths', async () => {
    const app = makeApp();
    const [robots, head, root, missingArticle, missingPath, post] = await Promise.all([
      app.inject({ method: 'GET', url: '/robots.txt' }),
      app.inject({ method: 'HEAD', url: '/de/services/' }),
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/de/faqs/unknown-id/' }),
      app.inject({ method: 'GET', url: '/elsewhere/' }),
      app.inject({ method: 'POST', url: '/de/faqs/' }),
    ]);
    expect(robots.statusCode).toBe(200);
    expect(robots.body).toContain('Disallow: /');
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['cache-control']).toContain('private, no-store');
    expect(root.statusCode).toBe(308);
    expect(root.headers.location).toBe('/de/services/');
    expect(missingArticle.statusCode).toBe(404);
    expect(missingPath.statusCode).toBe(404);
    expect(post.statusCode).toBe(404);
  });

  it('uses additional synthetic Service IT fixture rows without a fixed catalog count in the UI', async () => {
    const document = fixtureDocument('svc-001');
    const expanded = Array.from({ length: 31 }, (_, index) => ({ ...document, id: `svc-added-${String(index + 1)}` }));
    const app = makeApp(expanded);
    const reply = await app.inject({ method: 'GET', url: '/de/faqs/' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('/de/faqs/svc-added-31/');
    expect(reply.body).not.toContain('30 Beiträge');
  });
});
