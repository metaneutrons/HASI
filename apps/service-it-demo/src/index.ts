import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  knowledgeDocuments,
  SERVICE_IT_DEMO_ORIGIN,
  type KnowledgeDemoDocument,
} from '@hasi/demo-fixtures/knowledge-catalog';

export const SERVICE_IT_CANONICAL_ORIGIN = SERVICE_IT_DEMO_ORIGIN;

export interface ServiceItDocument extends Omit<KnowledgeDemoDocument, 'sourceSystem'> {
  sourceSystem: 'service_it';
}

/** Synthetic service IT pages from the shared knowledge catalog. */
export const serviceItDocuments: readonly ServiceItDocument[] = Object.freeze(
  knowledgeDocuments.filter((document): document is ServiceItDocument => document.sourceSystem === 'service_it')
);

export interface CreateServiceItDemoOptions {
  /** Trusted fixture override for focused tests or alternate synthetic snapshots. */
  documents?: readonly ServiceItDocument[];
}

const audienceLabels: Record<string, string> = {
  student: 'Studierende',
  employee: 'Mitarbeitende',
  admin: 'Administration',
};

const styles = `
:root{color-scheme:light dark;--ink:#202b27;--muted:#66716d;--paper:#f5f7f4;--surface:#fff;--line:#dce4df;--green:#246b4d;--green-soft:#e8f2eb;--orange:#e87531;--orange-soft:#fff0e5;--shadow:0 14px 38px rgba(31,56,43,.08)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:1.6}
a{color:var(--green);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
.skip-link{position:absolute;left:1rem;top:-5rem;z-index:5;padding:.7rem 1rem;border-radius:.5rem;background:var(--surface);color:var(--ink)}
.skip-link:focus{top:1rem}
.site-header{background:var(--surface);border-bottom:1px solid var(--line)}
.header-inner,.page-shell,.site-footer-inner{width:min(1160px,calc(100% - 40px));margin:0 auto}
.header-inner{min-height:78px;display:flex;align-items:center;justify-content:space-between;gap:2rem}
.brand{display:flex;align-items:center;gap:.8rem;color:var(--ink);font-weight:800;text-decoration:none;letter-spacing:-.035em}
.brand-mark{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:var(--green);color:#fff;font-size:1rem;letter-spacing:-.06em}
.brand-copy{display:grid;line-height:1.12}
.brand-copy small{margin-top:.25rem;color:var(--muted);font-size:.66rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.primary-nav{display:flex;align-items:center;gap:.35rem}
.primary-nav a{padding:.58rem .85rem;border-radius:999px;color:var(--muted);font-size:.94rem;font-weight:650;text-decoration:none;white-space:nowrap}
.primary-nav a[aria-current=page],.primary-nav a:hover{background:var(--green-soft);color:var(--green)}
.demo-banner{width:min(1160px,calc(100% - 40px));margin:1.25rem auto 0;padding:1rem 1.2rem;display:flex;align-items:flex-start;gap:.9rem;border:1px solid #f0c7a8;border-radius:14px;background:var(--orange-soft);color:var(--ink)}
.demo-symbol{flex:none;width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:var(--orange);color:white;font-size:.85rem;font-weight:900}
.demo-banner strong{display:block;margin-bottom:.12rem;color:#8e461d;font-size:.78rem;letter-spacing:.09em;text-transform:uppercase}
.demo-banner p{margin:0;font-size:.9rem}
.page-shell{min-height:calc(100vh - 260px);padding:2.6rem 0 4rem}
.eyebrow{margin:0 0 .55rem;color:var(--green);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
h1,h2,h3,p{overflow-wrap:anywhere}
h1{max-width:820px;margin:.1rem 0 1rem;font-size:clamp(2rem,4.2vw,3.6rem);line-height:1.08;letter-spacing:-.055em}
h2{margin:0;font-size:1.28rem;line-height:1.3;letter-spacing:-.025em}
.lede{max-width:760px;margin:0;color:var(--muted);font-size:1.08rem}
.hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(230px,.8fr);gap:2rem;align-items:center;padding:clamp(1.7rem,4vw,3rem);border:1px solid var(--line);border-radius:24px;background:var(--surface);box-shadow:var(--shadow)}
.hero:after{position:absolute;right:-92px;top:-135px;width:320px;height:320px;border:42px solid rgba(232,117,49,.12);border-radius:50%;content:"";pointer-events:none}
.hero-copy{position:relative;z-index:1}
.hero h1{margin-bottom:1rem}
.hero-aside{position:relative;z-index:1;padding:1.35rem;border-radius:17px;background:var(--green-soft)}
.hero-aside strong{display:block;margin-bottom:.45rem;color:var(--green)}
.hero-aside p{margin:0;color:var(--muted);font-size:.94rem}
.section-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:3rem 0 1.05rem}
.section-heading p{margin:0;color:var(--muted);font-size:.92rem}
.topic-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}
.topic-card,.article-card,.notice-card{border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:0 7px 20px rgba(31,56,43,.035)}
.topic-card{min-height:154px;padding:1.25rem;display:flex;flex-direction:column;justify-content:space-between;text-decoration:none;color:var(--ink);transition:transform .16s ease,border-color .16s ease}
.topic-card:hover{transform:translateY(-2px);border-color:var(--green)}
.topic-card h2{font-size:1.15rem}
.topic-card span{color:var(--muted);font-size:.88rem}
.topic-count{display:inline-flex;align-items:center;gap:.4rem;color:var(--green)!important;font-weight:750}
.search-panel{display:flex;gap:.65rem;align-items:end;padding:1rem;border:1px solid var(--line);border-radius:16px;background:var(--surface)}
.search-field{flex:1;display:grid;gap:.35rem}
.search-field label{font-size:.8rem;font-weight:750;color:var(--muted)}
.search-field input{width:100%;min-height:46px;padding:.65rem .85rem;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit}
.search-field input:focus{outline:3px solid rgba(36,107,77,.2);border-color:var(--green)}
.button{min-height:46px;padding:.65rem 1.05rem;border:0;border-radius:10px;background:var(--green);color:white;font:inherit;font-weight:750;cursor:pointer}
.button:hover{filter:brightness(1.08)}
.filter-row{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem;margin:1rem 0 1.3rem}
.filter-chip,.tag{display:inline-flex;align-items:center;min-height:28px;padding:.2rem .65rem;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.79rem;text-decoration:none}
.filter-chip[aria-current=true]{border-color:var(--green);background:var(--green-soft);color:var(--green);font-weight:750}
.article-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;padding:0;margin:0;list-style:none}
.article-card{height:100%;padding:1.2rem}
.article-card h2{font-size:1.1rem}
.article-card h2 a{color:var(--ink);text-decoration:none}
.article-card h2 a:hover{color:var(--green);text-decoration:underline}
.article-card p{margin:.65rem 0 0;color:var(--muted);font-size:.91rem}
.tag-row{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}
.tag{min-height:24px;padding:.12rem .55rem;background:var(--green-soft);border:0;color:var(--green);font-size:.72rem;font-weight:700}
.result-note{margin:1rem 0;color:var(--muted);font-size:.92rem}
.empty-state{padding:1.4rem;border:1px dashed var(--line);border-radius:14px;background:var(--surface);color:var(--muted)}
.notice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1.5rem 0 2rem}
.notice-card{padding:1.2rem}
.notice-card h2{margin-bottom:.35rem;font-size:1rem}
.notice-card p{margin:0;color:var(--muted);font-size:.9rem}
.breadcrumbs{margin:0 0 1rem;color:var(--muted);font-size:.88rem}
.breadcrumbs a{color:var(--green)}
.article-heading{margin-bottom:1.1rem}
.article-heading h1{font-size:clamp(2rem,4vw,3.15rem)}
.article-audience{margin:0 0 1.5rem;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.article-audience strong{display:block;margin-bottom:.2rem;font-size:.83rem}
.article-audience p{margin:0;color:var(--muted);font-size:.9rem}
#service-it-document{max-width:820px;margin:0 auto;padding:clamp(1.5rem,4vw,3rem);border:1px solid var(--line);border-radius:22px;background:var(--surface);box-shadow:var(--shadow)}
#service-it-document h1{margin:0 0 1.6rem;font-size:clamp(1.9rem,4vw,3rem)}
#service-it-document p{margin:0 0 1.15rem;font-size:1.05rem;line-height:1.85}
#service-it-document p:last-child{margin-bottom:0}
.article-source{max-width:820px;margin:1rem auto 0;color:var(--muted);font-size:.82rem}
.site-footer{border-top:1px solid var(--line);background:var(--surface)}
.site-footer-inner{min-height:104px;display:flex;align-items:center;justify-content:space-between;gap:1rem;color:var(--muted);font-size:.84rem}
.site-footer-inner p{margin:0}
.footer-brand{color:var(--green);font-weight:800;letter-spacing:.02em}
@media(max-width:800px){.header-inner{align-items:flex-start;flex-direction:column;gap:.7rem;padding:1rem 0}.primary-nav{width:100%;overflow-x:auto;padding-bottom:.15rem}.primary-nav a{padding:.48rem .7rem}.hero{grid-template-columns:1fr}.hero-aside{max-width:500px}.topic-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.header-inner,.page-shell,.site-footer-inner,.demo-banner{width:min(100% - 28px,1160px)}.header-inner{gap:.55rem}.brand-mark{width:34px;height:34px}.primary-nav{gap:.1rem}.primary-nav a{font-size:.83rem}.demo-banner{margin-top:.85rem;padding:.85rem}.page-shell{padding:1.6rem 0 2.7rem}.hero{padding:1.35rem;border-radius:18px}.topic-grid,.article-list,.notice-grid{grid-template-columns:1fr}.topic-card{min-height:125px}.section-heading{align-items:flex-start;flex-direction:column;margin-top:2.2rem}.search-panel{align-items:stretch;flex-direction:column}.button{width:100%}.site-footer-inner{align-items:flex-start;flex-direction:column;justify-content:center;padding:1.3rem 0}.article-audience{margin-bottom:1rem}#service-it-document{padding:1.3rem;border-radius:17px}#service-it-document p{font-size:1rem}}
@media(prefers-color-scheme:dark){:root{--ink:#e9efeb;--muted:#a5b2aa;--paper:#101714;--surface:#19221e;--line:#33423a;--green:#89c5a2;--green-soft:#203b2d;--orange:#f49a5f;--orange-soft:#3b291e;--shadow:0 14px 38px rgba(0,0,0,.22)}.demo-banner{border-color:#6c4932}.demo-banner strong{color:#ffb886}.hero:after{border-color:rgba(244,154,95,.1)}.button{color:#102016}.filter-chip,.tag{color:var(--muted)}.tag{color:#a8d8bb}.primary-nav a[aria-current=page],.primary-nav a:hover{color:#a8d8bb}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{transition:none!important}}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function labelForTag(tag: string): string {
  const labelTag = tag.replace(/^(?:topic|kind):/, '');
  const labels: Record<string, string> = {
    wlan: 'WLAN',
    vpn: 'VPN',
    mfa: 'MFA',
    it: 'IT',
    software: 'Software',
    faq: 'FAQ',
    news: 'Meldungen',
    service: 'Service',
    link: 'Link',
    form: 'Formular',
  };
  return labels[labelTag] ?? labelTag.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('de-DE'));
}

function articlePath(id: string): string {
  return `/de/faqs/${encodeURIComponent(id)}/`;
}

function canonical(path: string): string {
  return `${SERVICE_IT_CANONICAL_ORIGIN}${path}`;
}

function readSearchQuery(request: FastifyRequest): string {
  const query = request.query as Record<string, unknown>;
  const value = query.q;
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function readTopicQuery(request: FastifyRequest): string {
  const query = request.query as Record<string, unknown>;
  const value = query.thema;
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('de-DE');
}

function matchingDocuments(documents: readonly ServiceItDocument[], query: string, topic = ''): ServiceItDocument[] {
  const normalizedQuery = normalizeSearch(query);
  return documents.filter((document) => {
    if (topic && topicForDocument(document) !== topic) return false;
    if (!normalizedQuery) return true;
    return normalizeSearch([document.id, document.title, document.text, ...document.tags].join(' ')).includes(normalizedQuery);
  });
}

function topicForDocument(document: ServiceItDocument): string | undefined {
  const explicitTopic = document.tags.find((tag) => tag.startsWith('topic:'));
  if (explicitTopic !== undefined) {
    const topic = explicitTopic.slice('topic:'.length);
    return topic.length > 0 ? topic : undefined;
  }
  return document.tags.find((tag) => !tag.includes(':'));
}

function hasKind(document: ServiceItDocument, kind: string): boolean {
  return document.tags.includes(`kind:${kind}`);
}

function uniqueTopics(documents: readonly ServiceItDocument[]): string[] {
  return [...new Set(documents.flatMap((document) => {
    const topic = topicForDocument(document);
    return topic ? [topic] : [];
  }))].sort((left, right) => (
    labelForTag(left).localeCompare(labelForTag(right), 'de-DE')
  ));
}

function renderNav(active: 'services' | 'faqs' | 'meldungen'): string {
  const entries = [
    ['services', '/de/services/', 'Services'],
    ['faqs', '/de/faqs/', 'FAQs'],
    ['meldungen', '/de/meldungen/', 'Meldungen'],
  ] as const;
  return `<nav class="primary-nav" aria-label="Hauptnavigation">${entries.map(([key, href, label]) => (
    `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('')}</nav>`;
}

function renderDocument(options: {
  title: string;
  description: string;
  path: string;
  active: 'services' | 'faqs' | 'meldungen';
  main: string;
  article?: boolean;
}): string {
  const skipTarget = options.article ? '#service-it-document' : '#main-content';
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, noarchive, nosnippet, nofollow">
  <meta name="description" content="${escapeHtml(options.description)}">
  <title>${escapeHtml(options.title)}</title>
  <link rel="canonical" href="${escapeHtml(canonical(options.path))}">
  <style>${styles}</style>
</head>
<body>
  <a class="skip-link" href="${skipTarget}">Zum Inhalt springen</a>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="/de/services/" aria-label="HASI Service IT Startseite">
        <span class="brand-mark" aria-hidden="true">H</span>
        <span class="brand-copy">HASI<small>Service IT · Demo</small></span>
      </a>
      ${renderNav(options.active)}
    </div>
  </header>
  <aside class="demo-banner" role="note" aria-label="Synthetische Demo">
    <span class="demo-symbol" aria-hidden="true">!</span>
    <div><strong>Synthetische Demo</strong><p>Sämtliche Inhalte sind erfunden. Auch Mitarbeitenden- und Admin-Beispiele sowie Rollenangaben sind reine Testdaten und begründen keine Berechtigungen oder realen Zugänge.</p></div>
  </aside>
  ${options.main}
  <footer class="site-footer">
    <div class="site-footer-inner"><p><span class="footer-brand">HASI Service IT</span> · Ausschließlich synthetische Inhalte</p><p>Diese Demo ersetzt keine reale Service- oder Zugriffsregelung.</p></div>
  </footer>
</body>
</html>`;
}

function renderArticleList(documents: readonly ServiceItDocument[]): string {
  if (documents.length === 0) {
    return '<p class="empty-state">Zu dieser Suche wurden keine synthetischen Service-IT-Beiträge gefunden.</p>';
  }
  return `<ul class="article-list">${documents.map((document) => {
    const title = escapeHtml(document.title);
    const normalizedText = document.text.replace(/\s+/g, ' ').trim();
    const excerpt = normalizedText.length > 260 ? `${normalizedText.slice(0, 257).trimEnd()}…` : normalizedText;
    const text = escapeHtml(excerpt);
    const displayTags = [
      topicForDocument(document),
      ...document.tags.filter((tag) => tag.startsWith('kind:')).map((tag) => tag.slice('kind:'.length)),
    ].filter((tag): tag is string => Boolean(tag));
    return `<li><article class="article-card"><h2><a href="${articlePath(document.id)}">${title}</a></h2><p>${text}</p><div class="tag-row">${[...new Set(displayTags)].map((tag) => `<span class="tag">${escapeHtml(labelForTag(tag))}</span>`).join('')}</div></article></li>`;
  }).join('')}</ul>`;
}

function renderSearchForm(path: string, query: string, label = 'Service-IT-Beiträge durchsuchen'): string {
  return `<form class="search-panel" method="get" action="${path}"><div class="search-field"><label for="service-search">${label}</label><input id="service-search" name="q" type="search" value="${escapeHtml(query)}" autocomplete="off" maxlength="120" placeholder="Zum Beispiel WLAN oder VPN"></div><button class="button" type="submit">Suchen</button></form>`;
}

function renderServicePage(documents: readonly ServiceItDocument[]): string {
  const topics = uniqueTopics(documents);
  const topicCounts = new Map(topics.map((topic) => [topic, documents.filter((document) => topicForDocument(document) === topic).length]));
  const topicCards = topics.map((topic) => `<a class="topic-card" href="/de/faqs/?thema=${encodeURIComponent(topic)}"><h2>${escapeHtml(labelForTag(topic))}</h2><span class="topic-count">${String(topicCounts.get(topic) ?? 0)} Beiträge ansehen <span aria-hidden="true">→</span></span></a>`).join('');
  const serviceDocuments = documents.filter((document) => hasKind(document, 'service'));
  const serviceSection = serviceDocuments.length
    ? `<div class="section-heading"><div><p class="eyebrow">Service-Übersicht</p><h2>Services im Demo-Katalog</h2></div></div>${renderArticleList(serviceDocuments)}`
    : '';
  const main = `<main id="main-content" class="page-shell">
    <section class="hero" aria-labelledby="home-title">
      <div class="hero-copy"><p class="eyebrow">HASI · Service IT</p><h1 id="home-title">Digitale Hilfe, klar und nah.</h1><p class="lede">Finde Antworten zu typischen IT-Fragen und orientiere dich in den Themen der synthetischen Service-IT-Demo.</p></div>
      <aside class="hero-aside"><strong>Ein ruhiger Startpunkt</strong><p>Suche nach einem Stichwort oder öffne ein Thema. Jeder Beitrag ist ausdrücklich ein fiktives Beispiel.</p></aside>
    </section>
    <div class="section-heading"><div><p class="eyebrow">Themen entdecken</p><h2>Wobei brauchst du Hilfe?</h2></div><p>Alle Themen führen zu den passenden Demo-Beiträgen.</p></div>
    <div class="topic-grid">${topicCards.length > 0 ? topicCards : '<p class="empty-state">Noch keine Themen verfügbar.</p>'}</div>
    <div class="section-heading"><div><p class="eyebrow">Schnellsuche</p><h2>Direkt zum passenden Beitrag</h2></div></div>
    ${renderSearchForm('/de/faqs/', '')}
    ${serviceSection}
    <p class="result-note">Die angezeigten Inhalte und Rollenhinweise sind synthetische Testdaten.</p>
  </main>`;
  return renderDocument({
    title: 'Service IT',
    description: 'Themen und synthetische Service-IT-Beiträge in der HASI Demo.',
    path: '/de/services/',
    active: 'services',
    main,
  });
}

function renderFaqPage(documents: readonly ServiceItDocument[], query: string, selectedTopic: string): string {
  const topics = uniqueTopics(documents);
  const filtered = matchingDocuments(documents, query, selectedTopic);
  const topicLinks = [
    `<a class="filter-chip${selectedTopic ? '' : '" aria-current="true'}" href="/de/faqs/">Alle Themen</a>`,
    ...topics.map((topic) => `<a class="filter-chip${selectedTopic === topic ? '" aria-current="true' : ''}" href="/de/faqs/?thema=${encodeURIComponent(topic)}">${escapeHtml(labelForTag(topic))}</a>`),
  ].join('');
  const heading = selectedTopic ? `Beiträge: ${labelForTag(selectedTopic)}` : 'Häufige Fragen';
  const main = `<main id="main-content" class="page-shell">
    <p class="eyebrow">Antworten finden</p><h1>${escapeHtml(heading)}</h1><p class="lede">Durchsuche die fiktiven Service-IT-Informationen. Rollen- und Zielgruppenangaben sind Testmetadaten ohne Berechtigungswirkung.</p>
    <div style="height:1.4rem"></div>${renderSearchForm('/de/faqs/', query)}
    <div class="filter-row" aria-label="Themenfilter">${topicLinks}</div>
    <p class="result-note">${filtered.length === 1 ? 'Ein synthetischer Beitrag gefunden.' : `${String(filtered.length)} synthetische Beiträge gefunden.`}</p>
    ${renderArticleList(filtered)}
  </main>`;
  return renderDocument({
    title: heading,
    description: 'Suche in synthetischen Service-IT-FAQs der HASI Demo.',
    path: '/de/faqs/',
    active: 'faqs',
    main,
  });
}

function renderNewsPage(documents: readonly ServiceItDocument[], query: string): string {
  const newsDocuments = documents.filter((document) => hasKind(document, 'news'));
  const filtered = matchingDocuments(newsDocuments, query);
  const main = `<main id="main-content" class="page-shell">
    <p class="eyebrow">Service IT · Demo-Stand</p><h1>Meldungen</h1><p class="lede">Alle Meldungen aus dem synthetischen Service-IT-Bestand.</p>
    <div class="notice-grid"><article class="notice-card"><h2>Fiktiver Beispielbestand</h2><p>Die Einträge zeigen erfundene Situationen. Namen, Zeiten, Portale und Abläufe sind keine realen Serviceinformationen.</p></article><article class="notice-card"><h2>Rollenangaben sind Testdaten</h2><p>Beispiele für Mitarbeitende oder Administration steuern keine Zugriffsrechte und erlauben keine realen Handlungen.</p></article></div>
    ${renderSearchForm('/de/meldungen/', query, 'Meldungen und Beiträge durchsuchen')}
    <div class="section-heading"><div><p class="eyebrow">Aus dem Demo-Katalog</p><h2>Alle Demo-Meldungen</h2></div></div>
    ${renderArticleList(filtered)}
  </main>`;
  return renderDocument({
    title: 'Meldungen',
    description: 'Synthetische Hinweise und Beiträge aus dem HASI Service-IT-Demo-Katalog.',
    path: '/de/meldungen/',
    active: 'meldungen',
    main,
  });
}

function audienceText(document: ServiceItDocument): string {
  const labels = document.demoAudience.map((audience) => audienceLabels[audience] ?? audience);
  return labels.length ? labels.join(' · ') : 'Keine Zielgruppe angegeben';
}

function renderArticle(document: ServiceItDocument): string {
  const paragraphs = document.text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const contentParagraphs = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.replace(/\n/g, ' '))}</p>`).join('\n');
  const path = articlePath(document.id);
  const articleMain = `<main id='service-it-document'><h1>${escapeHtml(document.title)}</h1>\n${contentParagraphs}</main>`;
  const main = `<div class="page-shell">
    <nav class="breadcrumbs" aria-label="Brotkrumennavigation"><a href="/de/services/">Services</a> / <a href="/de/faqs/">FAQs</a> / ${escapeHtml(document.id)}</nav>
    <header class="article-heading"><p class="eyebrow">Synthetischer Service-IT-Beitrag</p></header>
    <aside class="article-audience"><strong>Demo-Zielgruppe</strong><p>${escapeHtml(audienceText(document))}. Diese Rollenmetadaten sind fiktiv und geben keine reale Berechtigung an.</p></aside>
    ${articleMain}
    <p class="article-source">Stabile Demo-Quelle: <a href="${escapeHtml(canonical(path))}">${escapeHtml(canonical(path))}</a></p>
  </div>`;
  return renderDocument({
    title: document.title,
    description: `Synthetischer Service-IT-Demo-Beitrag: ${document.title}`,
    path,
    active: 'faqs',
    main,
    article: true,
  });
}

function setPrivateDemoHeaders(reply: FastifyReply): void {
  reply
    .header('Cache-Control', 'private, no-store, max-age=0')
    .header('Pragma', 'no-cache')
    .header('Expires', '0')
    .header('X-Robots-Tag', 'noindex, noarchive, nosnippet, nofollow')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer')
    .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

export function createServiceItDemo(options: CreateServiceItDemoOptions = {}): FastifyInstance {
  const documents = options.documents ?? serviceItDocuments;
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  if (documentsById.size !== documents.length) throw new TypeError('Service IT demo document IDs must be unique.');

  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (_request, reply) => {
    setPrivateDemoHeaders(reply);
  });

  app.get('/', async (_request, reply) => reply.redirect('/de/services/', 308));
  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'));
  app.get('/de/services/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderServicePage(documents)));
  app.get('/de/faqs/', async (request, reply) => {
    const query = readSearchQuery(request);
    const topic = readTopicQuery(request);
    return reply.type('text/html; charset=utf-8').send(renderFaqPage(documents, query, topic));
  });
  app.get('/de/meldungen/', async (request, reply) => (
    reply.type('text/html; charset=utf-8').send(renderNewsPage(documents, readSearchQuery(request)))
  ));
  app.get<{ Params: { id: string } }>('/de/faqs/:id/', async (request, reply) => {
    const document = documentsById.get(request.params.id);
    if (!document) return reply.code(404).type('text/html; charset=utf-8').send(renderNotFound());
    return reply.type('text/html; charset=utf-8').send(renderArticle(document));
  });
  app.setNotFoundHandler(async (_request, reply) => (
    reply.code(404).type('text/html; charset=utf-8').send(renderNotFound())
  ));

  return app;
}

function renderNotFound(): string {
  const main = `<main id="main-content" class="page-shell"><p class="eyebrow">Service IT · Demo</p><h1>Diese Seite wurde nicht gefunden.</h1><p class="lede">Der gewünschte synthetische Beitrag ist nicht verfügbar.</p><p style="margin-top:1.4rem"><a class="button" href="/de/services/">Zur Übersicht</a></p></main>`;
  return renderDocument({
    title: 'Seite nicht gefunden',
    description: 'Die gesuchte Seite ist in dieser synthetischen Demo nicht verfügbar.',
    path: '/de/services/',
    active: 'services',
    main,
  });
}
