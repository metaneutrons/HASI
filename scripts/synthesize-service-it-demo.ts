import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSyntheticFaqTitle } from './synthetic-faq-titles.js';
import { syntheticVpnGuidance } from './synthetic-vpn-guidance.js';
import { serviceItArticleText, serviceItArticleTitle } from './service-it-article-text.js';

interface SourceEntry {
  readonly title: string;
  readonly url: string;
  readonly group?: string;
  readonly roles?: readonly string[];
}
interface PublicPage {
  readonly title?: string;
  readonly canonicalURL?: string;
  readonly kind?: string;
  readonly httpStatus?: number;
  readonly topicHeadings?: readonly { readonly role?: string; readonly text?: string }[];
}
interface SyntheticDocument {
  readonly id: string;
  readonly sourceSystem: 'service_it';
  readonly synthetic: true;
  readonly language: 'de';
  readonly title: string;
  readonly revision: number;
  readonly demoAudience: readonly ('student' | 'employee' | 'admin')[];
  readonly tags: readonly string[];
  readonly text: string;
  readonly citationId: string;
  readonly publicationStatus: 'syntheticdemo';
}

const FAQ_COUNT = 183;
const PUBLIC_FAQ_SUPPLEMENT_COUNT = 1;
const PUBLIC_FAQ_LANDING_COUNT = 1;
const SERVICE_COUNT = 22;
const NEWS_COUNT = 11;
const LINK_COUNT = 19;
const FORM_COUNT = 5;
const EXPECTED_TOTAL = FAQ_COUNT + PUBLIC_FAQ_SUPPLEMENT_COUNT + SERVICE_COUNT + NEWS_COUNT + LINK_COUNT + FORM_COUNT;
const AUDIENCE_ORDER = ['student', 'employee', 'admin'] as const;
const REPO_ROOT = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'fixtures/service-it-synthetic-v1.json');
const AUTH_ROLES = new Set(['HIT', 'Hiwi', 'Personal', 'Studierende', 'Gast', 'Schliesssystem']);

function fail(message: string): never {
  throw new Error(message);
}
function requiredArg(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) return fail(`Required input is missing: ${name}.`);
  return value;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name?.startsWith('--')) fail('Arguments must use named options.');
    const value = argv[i + 1];
    if (!value || value.startsWith('--') || args.has(name)) fail(`Missing or repeated value for ${name}.`);
    args.set(name, value);
    i += 1;
  }
  for (const required of ['--faq-index', '--service-catalog', '--public-inventory', '--links', '--forms']) {
    if (!args.has(required)) fail(`Required input is missing: ${required}.`);
  }
  for (const name of args.keys()) {
    if (!['--faq-index', '--service-catalog', '--public-inventory', '--links', '--forms', '--out'].includes(name)) fail(`Unknown option ${name}.`);
  }
  return args;
}

async function readPrivateJson(pathValue: string): Promise<unknown> {
  const absolute = resolve(pathValue);
  const actual = await realpath(absolute);
  const fromRepo = relative(REPO_ROOT, actual);
  if (fromRepo === '' || (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo))) {
    fail('Input metadata must be stored outside the repository.');
  }
  const raw = await readFile(actual, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024 * 1024) fail('Input metadata exceeds the size limit.');
  return JSON.parse(raw) as unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean) : [];
}
function requireEntries(root: unknown, key: string): Record<string, unknown>[] {
  const rows = object(root)?.[key];
  if (!Array.isArray(rows)) fail(`Input metadata is missing the ${key} list.`);
  return rows.map(object).filter((row): row is Record<string, unknown> => row !== undefined);
}
function sourceEntry(row: Record<string, unknown>, label: string): SourceEntry {
  const title = text(row.title);
  const url = text(row.url) ?? text(row.canonicalURL);
  if (!title || !url) fail(`${label} metadata must have a title and URL.`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail(`${label} metadata has an invalid URL.`); }
  if (parsed.protocol !== 'https:') fail(`${label} metadata must use HTTPS source URLs.`);
  const group = text(row.group) ?? text(row.category);
  return { title, url, ...(group ? { group } : {}), roles: stringArray(row.roles) };
}
function entriesFrom(root: unknown, keys: readonly string[], label: string): SourceEntry[] {
  const data = object(root);
  if (!data) return fail(`${label} input must be a JSON object.`);
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value.map(object).filter((row): row is Record<string, unknown> => row !== undefined).map(row => sourceEntry(row, label));
  }
  return fail(`${label} input does not contain a recognized metadata list.`);
}
function publicPages(root: unknown): PublicPage[] {
  const rows = requireEntries(root, 'pages');
  return rows.map(row => {
    const title = text(row.title);
    const canonicalURL = text(row.canonicalURL);
    const kind = text(row.kind);
    const httpStatus = typeof row.httpStatus === 'number' ? row.httpStatus : undefined;
    const topicHeadings = Array.isArray(row.topicHeadings) ? row.topicHeadings.map(object).filter((x): x is Record<string, unknown> => x !== undefined)
      .map(heading => {
        const role = text(heading.role);
        const headingText = text(heading.text);
        return { ...(role ? { role } : {}), ...(headingText ? { text: headingText } : {}) };
      }) : [];
    return {
      ...(title ? { title } : {}),
      ...(canonicalURL ? { canonicalURL } : {}),
      ...(kind ? { kind } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      topicHeadings,
    };
  });
}
function normalizeUrlKey(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  return parsed.href;
}
function uniqueEntries(entries: readonly SourceEntry[], label: string): SourceEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = normalizeUrlKey(entry.url);
    if (seen.has(key)) fail(`${label} metadata contains a duplicate source item.`);
    seen.add(key);
  }
  return [...entries];
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function metadataDigest(entries: readonly SourceEntry[]): string {
  const stable = [...entries].map(entry => [entry.url, entry.title, entry.group ?? '', [...(entry.roles ?? [])].sort()])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return sha256(JSON.stringify(stable));
}
function digestRows(rows: readonly unknown[]): string {
  const stable = [...rows].map(row => JSON.stringify(row)).sort();
  return sha256(JSON.stringify(stable));
}
function idFor(url: string): string {
  return `svc-catalog-${sha256(url).slice(0, 12)}`;
}
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLocaleLowerCase('de-DE');
}
function slug(value: string): string {
  return fold(value).replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'allgemein';
}
function redactTopic(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, 'Demo-Ziel')
    .replace(/\bservice\.it(?:\.hs-hannover)?\.de\b/giu, 'ServiceIT-Demo')
    .replace(/\bacademiccloud\.de\b/giu, 'Academic Cloud')
    .replace(/\baccounts\.hs-hannover\.de\b/giu, 'Account Manager')
    .replace(/\bwiso\.net\b/giu, 'Rechercheportal')
    .replace(/\bhochschule hannover\b/giu, 'Demo-Institution')
    .replace(/\bHSH\b/gu, 'Demo-Institution')
    .replace(/\basknet\b/giu, 'Softwarekatalog')
    .replace(/\bSuSe\b/gu, 'Campusprogramm')
    .replace(/\bCiatvi\b/giu, 'Citavi')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:de|com|net|org|edu|eu|io)\b/giu, 'Demo-Ziel')
    .replace(/\s+/gu, ' ').trim();
}
function deDuplicateRepeatedTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const words = normalized.split(' ');
  if (words.length % 2 === 0) {
    const middle = words.length / 2;
    if (words.slice(0, middle).join(' ').toLocaleLowerCase('de-DE') === words.slice(middle).join(' ').toLocaleLowerCase('de-DE')) {
      return words.slice(0, middle).join(' ');
    }
  }
  return normalized;
}
function cueFor(titleValue: string, kind: 'faq' | 'service' | 'news' | 'link' | 'form'): string {
  let value = redactTopic(titleValue)
    .replace(/\s*[|–-]\s*IT Services of Demo-Institution\s*$/iu, '')
    .replace(/\s*[|–-]\s*IT Services of HsH\s*$/iu, '')
    .replace(/^\d{1,2}\.\d{1,2}\.\d{2,4}\s*/u, '')
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/gu, '')
    .replace(/^[\s–—-]+/u, '')
    .replace(/\b(?:IT Services of HsH|IT Services)\b/giu, '')
    .replace(/\s+/gu, ' ').trim();
  if (kind === 'link') value = deDuplicateRepeatedTitle(value);
  const rules: readonly [RegExp, string][] = [
    [/^Wie kann ich (?:mir )?/iu, ''], [/^Wie richte ich /iu, 'Einrichtung: '], [/^Wie abonniere ich /iu, 'Abonnement: '], [/^Wie nutze ich /iu, 'Nutzung: '],
    [/^Wie benutze ich /iu, 'Nutzung: '], [/^Wie verwende ich /iu, 'Nutzung: '], [/^Wie erhalte ich /iu, 'Zugang: '],
    [/^Wie bekomme ich /iu, 'Zugang: '], [/^Wie erstelle ich /iu, 'Erstellung: '], [/^Wie ändere ich /iu, 'Änderung: '],
    [/^Wie aktualisiere ich /iu, 'Aktualisierung: '], [/^Wie gelange ich /iu, 'Zugang: '], [/^Wie teile ich /iu, 'Freigabe: '],
    [/^Wie melde ich mich /iu, 'Anmeldung: '], [/^Wie kann ich mich /iu, 'Anmeldung: '], [/^Wie binde ich /iu, 'Einbindung: '],
    [/^Wie /iu, 'Ablauf: '], [/^Welche Funktionen hat /iu, 'Funktionen von '], [/^Welche Funktionen /iu, 'Funktionen: '],
    [/^Welche /iu, 'Überblick: '], [/^Wo finde ich /iu, 'Orientierung: '], [/^Wo kann ich /iu, 'Orientierung: '],
    [/^Wo erhalte ich /iu, 'Orientierung: '], [/^Wo /iu, 'Orientierung: '], [/^Warum kann ich /iu, 'Fehlerbild: '],
    [/^Warum /iu, 'Hintergrund: '], [/^Wieso kann ich /iu, 'Fehlerbild: '], [/^Wieso /iu, 'Fehlersuche: '],
    [/^Was kann ich (?:machen|tun), wenn /iu, 'Fehlerfall: '], [/^Was mache ich, wenn /iu, 'Fehlerfall: '],
    [/^Was ist zu tun (?:bei|wenn) /iu, 'Vorfall: '], [/^Was ist /iu, 'Grundlage: '], [/^Kann man /iu, 'Möglichkeit: '],
    [/^Bekommen /iu, 'Information: '], [/^Gibt es /iu, 'Möglichkeit: '], [/^Allgemeine Informationen zu /iu, 'Überblick: '],
    [/^Mein(e|en|em) /iu, 'Fall: '], [/^Probleme /iu, 'Fehlersuche: '],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(value)) { value = value.replace(pattern, replacement); break; }
  }
  value = value.replace(/[?!.]+$/gu, '').replace(/\s+/gu, ' ').trim();
  if (!value) value = kind === 'news' ? 'Servicehinweis' : 'Themeneintrag';
  if (value.length > 116) value = `${value.slice(0, 113).trimEnd()}…`;
  const firstCharacter = value.charAt(0);
  return firstCharacter ? firstCharacter.toLocaleUpperCase('de-DE') + value.slice(1) : 'Themeneintrag';
}
function cleanTitle(entry: SourceEntry, kind: 'faq' | 'service' | 'news' | 'link' | 'form'): string {
  const prefix = kind === 'news' ? 'Demo-Meldung: ' : kind === 'service' ? 'Demo-Service: '
    : kind === 'link' ? 'Demo-Link: ' : kind === 'form' ? 'Demo-Formular: ' : 'Demo-FAQ: ';
  const title = `${prefix}${cueFor(entry.title, kind)}`;
  return title.length < 200 ? title : `${title.slice(0, 197).trimEnd()}…`;
}
function demoAudience(roles: readonly string[]): ('student' | 'employee' | 'admin')[] {
  if (roles.length === 0) return [...AUDIENCE_ORDER];
  if (roles.some(role => !AUTH_ROLES.has(role))) fail('A source audience label is not recognized.');
  const granted = new Set<'student' | 'employee' | 'admin'>(['admin']);
  if (roles.includes('Personal') || roles.includes('Hiwi')) granted.add('employee');
  if (roles.includes('Studierende')) granted.add('student');
  return AUDIENCE_ORDER.filter(value => granted.has(value));
}
function queryTags(group: string, title: string): string[] {
  const haystack = fold(`${group} ${title}`);
  const known: readonly [string, readonly string[]][] = [
    ['account', ['account', 'konto', 'anmeldung', 'passwort', 'sso']], ['mfa', ['mfa', 'multi-faktor', 'multifaktor', 'zweiter faktor', 'passkey', 'yubikey', 'totp']],
    ['campuscard', ['campuscard', 'studierendenausweis', 'dienstausweis', 'karte']], ['campusmanagement', ['campusmanagement', 'prufung', 'pruefung']],
    ['microsoft', ['microsoft', 'office', 'azure', 'visio', 'onedrive', 'windows']], ['teams', ['teams', 'videokonferenz', 'telefonie']],
    ['email', ['e-mail', 'mail', 'outlook', 'thunderbird', 'postfach', 'verteiler']], ['vpn', ['vpn', 'globalprotect']],
    ['wlan', ['wlan', 'eduroam', 'wifi']], ['netzlaufwerk', ['netzlaufwerk', 'laufwerk', 'home-laufwerk']],
    ['druck', ['druck', 'kopier', 'scanner', 'toner']], ['wagtail', ['wagtail', 'meldungsseite', 'snippet', 'redaktion']],
    ['webhosting', ['webspace', 'webhosting', 'wordpress', 'datenbank']], ['security', ['phishing', 'sicherheit', 'datenschutz', 'kompromittiert']],
    ['software', ['software', 'lizenz', 'citavi', 'matlab', 'simulink', 'adobe', 'zoom']], ['academic-cloud', ['academic cloud', 'academiccloud', 'rocket.chat', 'collaboard']],
    ['guest', ['gast', 'einladen', 'gäste']], ['short-url', ['kurzurl', 'domain', 'ziel']], ['form', ['formular', 'antrag', 'beantragen']],
  ];
  const tags: string[] = [];
  for (const [tag, variants] of known) if (variants.some(variant => haystack.includes(fold(variant)))) tags.push(tag);
  return tags;
}
function topicGroup(entry: SourceEntry, type: 'faq' | 'service' | 'news' | 'link' | 'form'): string {
  if (entry.group?.trim()) {
    const original = entry.group.trim();
    return fold(original) === 'acounteinrichtung' ? 'Accounteinrichtung' : original;
  }
  const key = fold(entry.title);
  if (type === 'news') {
    if (/druck|followme/u.test(key)) return 'Drucken Kopieren Scannen';
    if (/sms|mfa|sso|account/u.test(key)) return 'Multi-Faktor-Authentifizierung';
    if (/campusmanagement|prufung|pruefung/u.test(key)) return 'Campusmanagement';
    if (/moodle|lern/u.test(key)) return 'Lernplattform';
    if (/intranet|web/u.test(key)) return 'Webhosting';
    if (/harica|zertifikat|datenschutz/u.test(key)) return 'Informationssicherheit';
    if (key.includes('ticket')) return 'ServiceIT mit Wagtail';
    return 'Meldungen';
  }
  if (key.includes('campuscard')) return 'CampusCard';
  if (/academic.?cloud|collaboard|rocket/u.test(key)) return 'Academic Cloud';
  if (/webspace|webhosting/u.test(key)) return 'Webhosting';
  if (key.includes('vpn')) return 'VPN';
  if (/wlan|eduroam/u.test(key)) return 'WLAN';
  if (/microsoft|office|teams|azure/u.test(key)) return 'Microsoft';
  if (/mail|postfach|email|e-mail/u.test(key)) return 'E-Mail-Postfach';
  return type === 'link' ? 'Serviceverweise' : type === 'form' ? 'Formulare' : 'Allgemein';
}
function makeDocument(entry: SourceEntry, kind: 'faq' | 'service' | 'news' | 'link' | 'form'): SyntheticDocument {
  const id = idFor(entry.url);
  const group = topicGroup(entry, kind);
  const tags = [`topic:${slug(group)}`, `kind:${kind}`, ...queryTags(group, entry.title)].filter((tag, index, all) => all.indexOf(tag) === index).slice(0, 10);
  const title = cleanTitle(entry, kind);
  const vpnGuidance = syntheticVpnGuidance(group, cueFor(entry.title, kind), kind);
  const baseRevision = vpnGuidance?.revision ?? 1;
  const revised = kind === 'faq' ? formatSyntheticFaqTitle(id, title, baseRevision) : { title, revision: baseRevision };
  const articleTitle = serviceItArticleTitle(revised.title, id);
  const body = serviceItArticleText(group, revised.title, kind, id);
  // All published article text/labels changed once; retain the prior title migration.
  const revision = revised.revision + 1;
  if (revised.title.length >= 200 || body.length >= 4000) fail('A generated document exceeds a field limit.');
  return {
    id, sourceSystem: 'service_it', synthetic: true, language: 'de', title: articleTitle, revision,
    demoAudience: demoAudience(entry.roles ?? []), tags, text: body,
    citationId: `knowledge:service_it:${id}:${String(revision)}`, publicationStatus: 'syntheticdemo',
  };
}
function assertSafeDocuments(documents: readonly SyntheticDocument[]): void {
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) fail('Generated document IDs are not unique.');
    ids.add(document.id);
    const serialized = JSON.stringify(document);
    if (/https?:\/\/(?![a-z0-9.-]+\.invalid\b)/iu.test(serialized)
      || /(?:[a-z0-9._%+-]+)@(?:[a-z0-9.-]+)\.[a-z]{2,}/iu.test(serialized)
      || /(?:hs-hannover\.de|service\.it\.hs-hannover)/iu.test(serialized)) {
      fail('Generated output contains a source URL, hostname or contact address.');
    }
    if (document.text.length >= 4000 || document.title.length >= 200) fail('Generated output exceeds a field bound.');
  }
}
const args = parseArgs(process.argv.slice(2));
const faqRoot = await readPrivateJson(requiredArg(args, '--faq-index'));
const serviceRoot = await readPrivateJson(requiredArg(args, '--service-catalog'));
const publicRoot = await readPrivateJson(requiredArg(args, '--public-inventory'));
const linkRoot = await readPrivateJson(requiredArg(args, '--links'));
const formRoot = await readPrivateJson(requiredArg(args, '--forms'));
const faqEntries = uniqueEntries(entriesFrom(faqRoot, ['articles'], 'FAQ'), 'FAQ');
const serviceEntries = uniqueEntries(entriesFrom(serviceRoot, ['services', 'articles', 'serviceOverviews'], 'Service'), 'Service');
const linkEntriesRaw = uniqueEntries(entriesFrom(linkRoot, ['links'], 'Link'), 'Link');
const linkEntries = linkEntriesRaw.map(entry => ({ ...entry, title: deDuplicateRepeatedTitle(entry.title) }));
const formRows = requireEntries(formRoot, 'forms');
const forms = formRows.map(row => {
  const entry = sourceEntry(row, 'Form');
  const fields = Array.isArray(row.fields) ? row.fields.map(object).filter((x): x is Record<string, unknown> => x !== undefined) : [];
  return { entry, fields: fields.map(field => ({ name: text(field.name) ?? '', type: text(field.type) ?? '' })) };
});
const pages = publicPages(publicRoot);
const newsEntries = uniqueEntries(pages.filter(page => page.kind === 'news_article').map(page => {
  const title = page.title; const url = page.canonicalURL;
  if (!title || !url) fail('Public news metadata must include title and canonical URL.');
  return { title, url, group: topicGroup({ title, url }, 'news'), roles: [] };
}), 'Public news');
const publicFaqRows = pages.filter(page => page.kind === 'faq_article' && page.httpStatus === 200);
const authenticatedFaqUrls = new Set(faqEntries.map(entry => normalizeUrlKey(entry.url)));
const publicFaqArticleRows = publicFaqRows.map(page => ({
  page,
  topic: page.topicHeadings?.find(heading => heading.role === 'topic_title')?.text,
})).filter((row): row is { page: PublicPage; topic: string } => typeof row.topic === 'string' && row.topic.trim().length > 0);
const publicFaqLandingRows = publicFaqRows.filter(page => !page.topicHeadings?.some(heading => heading.role === 'topic_title')
  && page.topicHeadings?.some(heading => heading.role === 'faq_question_link'));
const publicFaqSupplementEntries = uniqueEntries(publicFaqArticleRows.map(({ page, topic }) => {
  const url = page.canonicalURL;
  if (!url || !page.title) fail('Public FAQ metadata must include page title and canonical URL.');
  return { title: topic, url, group: /rss.feed/iu.test(`${page.title} ${url}`) ? 'E-Mail-Postfach' : topicGroup({ title: page.title, url }, 'faq'), roles: [] };
}).filter(entry => !authenticatedFaqUrls.has(normalizeUrlKey(entry.url))), 'Public FAQ supplement');
const faqSupplementMetadata = publicFaqSupplementEntries.map(entry => {
  const page = publicFaqArticleRows.find(row => row.page.canonicalURL === entry.url)?.page;
  return { ...entry, pageTitle: page?.title ?? '', topicHeadings: page?.topicHeadings ?? [] };
});
const faqLandingMetadata = publicFaqLandingRows.map(page => ({ title: page.title ?? '', url: page.canonicalURL ?? '', topicHeadings: page.topicHeadings ?? [] }));
const publicServiceEntries = uniqueEntries(pages.filter(page => page.kind === 'service_article').map(page => {
  const title = page.title; const url = page.canonicalURL;
  if (!title || !url) fail('Public service metadata must include title and canonical URL.');
  return { title, url, group: title, roles: [] };
}), 'Public service');
const allServiceByUrl = new Map<string, SourceEntry>();
for (const entry of publicServiceEntries) allServiceByUrl.set(normalizeUrlKey(entry.url), entry);
for (const entry of serviceEntries) {
  const key = normalizeUrlKey(entry.url);
  const previous = allServiceByUrl.get(key);
  allServiceByUrl.set(key, previous ? {
    ...entry,
    group: entry.group ?? previous.group ?? 'Service',
    roles: entry.roles?.length ? entry.roles : previous.roles ?? [],
  } : entry);
}
const allServices = [...allServiceByUrl.values()];
if (faqEntries.length !== FAQ_COUNT) fail(`Expected ${String(FAQ_COUNT)} valid FAQ metadata records, received ${String(faqEntries.length)}.`);
if (publicFaqRows.length !== 38) fail(`Expected 38 public FAQ content routes, received ${String(publicFaqRows.length)}.`);
if (publicFaqSupplementEntries.length !== PUBLIC_FAQ_SUPPLEMENT_COUNT) fail(`Expected ${String(PUBLIC_FAQ_SUPPLEMENT_COUNT)} public FAQ article supplement, received ${String(publicFaqSupplementEntries.length)}.`);
if (publicFaqLandingRows.length !== PUBLIC_FAQ_LANDING_COUNT) fail(`Expected ${String(PUBLIC_FAQ_LANDING_COUNT)} public FAQ category landing, received ${String(publicFaqLandingRows.length)}.`);
if (serviceEntries.length !== SERVICE_COUNT) fail(`Expected ${String(SERVICE_COUNT)} authenticated service records, received ${String(serviceEntries.length)}.`);
if (allServices.length !== SERVICE_COUNT) fail(`Expected ${String(SERVICE_COUNT)} unique service overviews after public-route reconciliation, received ${String(allServices.length)}.`);
if (newsEntries.length !== NEWS_COUNT) fail(`Expected ${String(NEWS_COUNT)} public news records, received ${String(newsEntries.length)}.`);
if (linkEntries.length !== LINK_COUNT) fail(`Expected ${String(LINK_COUNT)} external link guides, received ${String(linkEntries.length)}.`);
if (forms.length !== FORM_COUNT) fail(`Expected ${String(FORM_COUNT)} read-only form guides, received ${String(forms.length)}.`);
if (formRows.some(row => row.readOnly !== true)) fail('Every source form must be marked read-only.');
const brokenReferences = Array.isArray(object(faqRoot)?.brokenReferences) ? object(faqRoot)?.brokenReferences as unknown[] : [];
const faqSorted = [...faqEntries, ...publicFaqSupplementEntries].sort((a, b) => normalizeUrlKey(a.url).localeCompare(normalizeUrlKey(b.url), 'en'));
const serviceSorted = [...allServices].sort((a, b) => normalizeUrlKey(a.url).localeCompare(normalizeUrlKey(b.url), 'en'));
const newsSorted = [...newsEntries].sort((a, b) => normalizeUrlKey(a.url).localeCompare(normalizeUrlKey(b.url), 'en'));
const linksSorted = [...linkEntries].sort((a, b) => normalizeUrlKey(a.url).localeCompare(normalizeUrlKey(b.url), 'en'));
const formsSorted = [...forms].sort((a, b) => normalizeUrlKey(a.entry.url).localeCompare(normalizeUrlKey(b.entry.url), 'en'));
const documents: SyntheticDocument[] = [
  ...faqSorted.map(entry => makeDocument(entry, 'faq')),
  ...serviceSorted.map(entry => makeDocument(entry, 'service')),
  ...newsSorted.map(entry => makeDocument(entry, 'news')),
  ...linksSorted.map(entry => makeDocument(entry, 'link')),
  ...formsSorted.map(form => makeDocument(form.entry, 'form')),
];
if (documents.length !== EXPECTED_TOTAL) fail(`Expected ${String(EXPECTED_TOTAL)} documents, generated ${String(documents.length)}.`);
assertSafeDocuments(documents);
const formCoverageRows = formsSorted.map(form => {
  const source = formRows.find(row => {
    const sourceUrl = text(row.url);
    return sourceUrl !== undefined && normalizeUrlKey(sourceUrl) === normalizeUrlKey(form.entry.url);
  });
  return { url: form.entry.url, actualUrl: text(source?.actualUrl) ?? '', title: form.entry.title,
    fieldLabels: stringArray(source?.fieldLabels), fields: form.fields };
});
const output = {
  schemaVersion: 1,
  datasetId: 'hasi-service-it-synthetic-v1',
  synthetic: true,
  createdAt: '2026-10-21',
  publicationStatus: 'syntheticdemo',
  rolePolicyNote: 'Demo audiences are fictional retrieval-test labels only and do not represent institutional permissions or real user rights.',
  coverage: {
    documentCount: documents.length,
    sources: {
      authenticatedFaq: { represented: faqEntries.length, metadataSha256: metadataDigest(faqEntries) },
      authenticatedServices: { represented: allServices.length, metadataSha256: metadataDigest(allServices) },
      publicFaqSupplement: { represented: publicFaqSupplementEntries.length, metadataSha256: digestRows(faqSupplementMetadata) },
      publicFaqCategoryLandingExcluded: { represented: publicFaqLandingRows.length, metadataSha256: digestRows(faqLandingMetadata) },
      publicNews: { represented: newsEntries.length, metadataSha256: metadataDigest(newsEntries) },
      authenticatedLinks: { represented: linkEntries.length, metadataSha256: metadataDigest(linkEntriesRaw) },
      readOnlyForms: { represented: forms.length, metadataSha256: digestRows(formCoverageRows) },
    },
    brokenFaqReferencesExcluded: brokenReferences.length,
  },
  documents,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = resolve(args.get('--out') ?? DEFAULT_OUTPUT);
if (outputPath !== DEFAULT_OUTPUT) fail('Output path is fixed to fixtures/service-it-synthetic-v1.json.');
await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o644 });
console.log(`Generated ${String(documents.length)} synthetic ServiceIT documents at fixtures/service-it-synthetic-v1.json.`);
console.log(`Coverage: ${String(faqEntries.length)} authenticated FAQ + ${String(publicFaqSupplementEntries.length)} public FAQ, ${String(allServices.length)} services, ${String(newsEntries.length)} news, ${String(linkEntries.length)} links, ${String(forms.length)} forms; ${String(brokenReferences.length)} broken FAQ references excluded.`);
