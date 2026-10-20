import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_DEMO_NOTICE as NOTICE, syntheticVpnGuidance } from './synthetic-vpn-guidance.js';

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
  readonly revision: 1 | 2;
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
function safeCaseId(id: string): string { return id.slice(-6).toUpperCase(); }
function syntheticDate(id: string): string {
  const seed = Number.parseInt(id.slice(-2), 16);
  const day = (seed % 28) + 1;
  return `2026-11-${String(day).padStart(2, '0')}`;
}
function scenario(group: string, title: string, type: 'faq' | 'service' | 'news' | 'link' | 'form', id: string): string {
  const g = fold(group);
  const t = fold(title);
  const cue = cueFor(title, type);
  const ref = safeCaseId(id);
  if (type === 'news') {
    const date = syntheticDate(id);
    const time = `${String(8 + (Number.parseInt(id.slice(-3, -1), 16) % 9)).padStart(2, '0')}:00–${String(8 + (Number.parseInt(id.slice(-3, -1), 16) % 9)).padStart(2, '0')}:20`;
    return `${NOTICE} Diese Meldung gehört zum vollständig erfundenen Übungsfall ${ref} über ${cue}. Das Demo-Statusboard nennt für den fiktiven Demo-Standort Nord das rein fiktive Zeitfenster ${date}, ${time}; dieses Datum, die Uhrzeit und der Ort sind nur Testwerte. Prüfe im Nachrichtenentwurf, ob Betreff, Status, betroffene Demo-Funktion und nächster Prüfzeitpunkt verständlich genannt sind. Nutze für Rückfragen ausschließlich die interne Simulationsnotiz ${ref}; es gibt hier keinen realen Störungsstatus und keine reale Kontaktstelle.`;
  }
  if (type === 'link') {
    if (/cloud|collaboard|rocket|speicher/u.test(`${g} ${t}`)) return `${NOTICE} Der Linkguide ${ref} beschreibt den simulierten Einstieg zu ${cue}. Öffne im Übungsportal ausschließlich den reservierten Platzhalter https://cloud-demo.invalid und lege dort den Testordner ${ref} an. Prüfe vor einer Freigabe, ob nur die vorgesehene Demo-Rolle Leserechte erhält; lade keine echten Dateien hoch und übernimm keine realen Zugangsdaten.`;
    if (/account|anmeldung|konto/u.test(`${g} ${t}`)) return `${NOTICE} Für ${cue} wird im Fall ${ref} ein fiktives Konto im Platzhalter https://konto-demo.invalid verwendet. Kontrolliere nur die angezeigte Demo-Kennung und den Status „bereit“. Gib kein echtes Passwort ein, bestätige keine echte Anmeldung und verwende den Guide nur, um Navigation und Rückmeldungen einer Testoberfläche zu üben.`;
    if (/mail|postfach|verteiler/u.test(`${g} ${t}`)) return `${NOTICE} Dieser Linkguide führt den Fall ${ref} für ${cue} durch ein erfundenes Mail-Labor unter https://mail-demo.invalid. Arbeite mit dem Testpostfach MAIL-${ref}, kontrolliere die simulierte Zustellung und beende den Durchlauf mit einer Vorschau. Es werden keine Nachrichten versandt, keine realen Adressen verwendet und keine Rechte geändert.`;
    return `${NOTICE} Im Linkguide ${ref} geht es um ${cue}. Öffne den Eintrag im fiktiven Linkkatalog https://katalog-demo.invalid, gleiche Thema und Demo-Ziel ab und starte anschließend nur die Vorschau des Testfalls. Prüfe vor dem nächsten Schritt, dass das Ziel auf einer reservierten .invalid-Adresse liegt; echte Konten, Dateien und externe Aktionen bleiben außen vor.`;
  }
  if (type === 'form') {
    if (/postfach|verteiler|mail/u.test(`${g} ${t}`)) return `${NOTICE} Das Formularbeispiel ${ref} übt ${cue} in einer lokalen Simulation. Fülle nur die fiktiven Angaben Demo-Antrag ${ref}, Testrolle und Zweck „Übungsfall“ ein; echte Namen, E-Mail-Adressen und Postfachkennungen sind ausgeschlossen. Vergleiche die Vorschau der gewünschten Berechtigungsart und Laufzeit, markiere die Prüfschritte als erledigt und brich vor einem tatsächlichen Versand ab. Das Formular wird nicht übermittelt.`;
    if (/microsoft|gruppe|365/u.test(`${g} ${t}`)) return `${NOTICE} Der Formularleitfaden ${ref} simuliert ${cue} für eine erfundene Arbeitsgruppe. Verwende die Bezeichnung GRUPPE-${ref}, wähle eine Testrolle und beschreibe den Zweck ohne Personen- oder Kontaktdaten. Prüfe in der Vorschau, dass Mitgliederkreis und gewünschte Funktion zusammenpassen; der Ablauf endet vor dem Absenden und ändert keine echte Gruppe.`;
    return `${NOTICE} Der Leitfaden ${ref} übt ${cue} anhand eines fiktiven Webspace-Antrags. Trage als Projektname WEB-${ref} und als Inhalt nur „Demo-Dateien“ ein, kontrolliere die Vorschau und notiere einen erfundenen Zuständigkeitsweg. Keine realen Namen, Domains, Kontaktdaten oder Zugangsdaten eintragen; das Formular wird nicht versandt.`;
  }
  if (/academic.?cloud/u.test(`${g} ${t}`)) {
    if (/softwarecenter|install/u.test(t)) return `${NOTICE} Der Installationsfall ${ref} für ${cue} nutzt einen erfundenen Softwarekatalog https://apps-demo.invalid. Prüfe zuerst, ob das Demogerät als PC markiert ist, öffne die Detailkarte der Cloud-App und kontrolliere Version sowie Testumfang in der Vorschau. Der Ablauf endet vor dem Installieren; es wird keine Hochschulsoftware bezogen oder Lizenz zugesagt.`;
    if (/desktop.anwend/u.test(t)) return `${NOTICE} Der Desktop-Fall ${ref} zu ${cue} nutzt ausschließlich das Testgerät PC-${ref}. Prüfe in der Vorschau, ob die Demo-App gestartet ist, öffne einen leeren Testordner und kontrolliere den simulierten Synchronisationsstatus. Lege keine realen Dateien ab und verknüpfe kein produktives Benutzerprofil.`;
    if (/handy|smartphone|mobil/u.test(t)) return `${NOTICE} Die Mobilübung ${ref} für ${cue} richtet ein ausschließlich fiktives Gerät MOBIL-${ref} ein. Öffne im Testhandbuch die App-Übersicht, prüfe die simulierte Anmeldung und vergleiche die Vorschau für Datei- und Chatfunktionen. Installiere keine echte App, trage keine persönlichen Kontodaten ein und übernimm kein reales Geräteprofil.`;
    if (/browser|web-browser|webbrowser/u.test(t)) return `${NOTICE} Der Browserfall ${ref} zu ${cue} startet an der reservierten Demo-Adresse https://cloud-demo.invalid. Prüfe in der Vorschau, ob die Weboberfläche den Testarbeitsraum CLOUD-${ref} öffnet, und kontrolliere anschließend nur die simulierten Datei- und Chatbereiche. Es findet keine echte Anmeldung statt und es werden keine Dateien hochgeladen.`;
    if (/rocket\.chat|chat/u.test(t)) return `${NOTICE} Der Chatfall ${ref} übt ${cue} im fiktiven Raum CHAT-${ref}. Prüfe zuerst die Vorschau der Raumrolle, verfasse eine Nachricht mit reinem Testtext und kontrolliere, dass sie im Entwurf bleibt. Es werden keine realen Nachrichten versandt, Mitglieder eingeladen oder Konten angelegt.`;
    if (/collaboard|board/u.test(t)) return `${NOTICE} Der Boardfall ${ref} simuliert ${cue} auf dem Testboard BOARD-${ref}. Lege eine leere Vorschau an, prüfe die Demo-Rolle für Betrachtung oder Bearbeitung und kontrolliere den Freigabeumfang vor dem Beenden. Es werden keine realen Boards oder Einladungen erstellt und keine Dateien geteilt.`;
    if (/umfrage|abstimm/u.test(t)) return `${NOTICE} Die Umfrageübung ${ref} zu ${cue} verwendet den erfundenen Entwurf UMFRAGE-${ref}. Formuliere eine neutrale Testfrage, prüfe Antwortoptionen und Sichtbarkeit in der Vorschau und beende den Ablauf vor einer Veröffentlichung. Es werden keine echten Antworten erhoben und keine Personen eingeladen.`;
    if (/teile|freigabe|datei|ordner/u.test(t)) return `${NOTICE} Der Freigabefall ${ref} zu ${cue} verwendet den Testordner CLOUD-${ref}. Wähle in der Vorschau eine fiktive Leseberechtigung für die Demo-Rolle, kontrolliere den Umfang für Datei und Unterordner und entferne den Testlink wieder. Es werden keine echten Dateien hochgeladen und keine externe Freigabe eingerichtet.`;
    if (/anmeld|melde|login|einlogg|zugang|gelange/u.test(t)) return `${NOTICE} Der Zugangsfall ${ref} für ${cue} nutzt das fiktive Profil CLOUD-${ref}. Prüfe im Demo-Ablauf die Statusfolge „Kennung erkannt“, „Testprüfung“ und „Arbeitsraum geöffnet“. Verwende weder ein echtes Passwort noch einen echten zweiten Faktor; der Test bestätigt keinen realen Zugang.`;
    return `${NOTICE} Der Cloud-Überblick ${ref} zu ${cue} vergleicht im fiktiven Arbeitsraum CLOUD-${ref} die Bereiche Dateien, Chat und Zusammenarbeit. Öffne nur die Vorschau, ordne die passende Testfunktion dem Bedarf zu und beende den Durchlauf ohne Freigabe. Es werden keine echten Konten, Dateien, Nachrichten oder Mitgliedschaften angelegt.`;
  }
  if (/serviceit mit wagtail|wagtail/u.test(`${g} ${t}`)) return `${NOTICE} Die fiktive Redaktion übt ${cue} im CMS-Labor https://cms-demo.invalid. Erstelle einen Entwurf mit der Referenz ${ref}, prüfe Titel, Vorschau und Sprache und kontrolliere bei Medien die erfundene Beschreibung. Änderungen bleiben im Testbereich und werden nicht veröffentlicht; es werden weder echte Seiten noch echte Formulare bearbeitet.`;
  if (/multi.?faktor|mfa|passkey|yubikey|authenticator|totp|keepass/u.test(`${g} ${t}`)) return `${NOTICE} Die Übung ${ref} simuliert ${cue} mit dem Testprofil MFA-${ref}. Wähle in der Oberfläche eine fiktive Methode, prüfe die Bestätigung mit einem ausdrücklich synthetischen Demo-Code und entferne anschließend das Testprofil. Keine echte Passkey-, Schlüssel-, Authenticator- oder KeePass-Registrierung ausführen und keine Codes aus einem persönlichen Gerät übernehmen.`;
  const vpnGuidance = syntheticVpnGuidance(g, t, type);
  if (vpnGuidance) return vpnGuidance.text;
  if (/kurzurl|shorturl/u.test(`${g} ${t}`)) return `${NOTICE} Der URL-Fall ${ref} zeigt ${cue} mit short-demo.invalid und ziel-demo.invalid. Vergleiche zuerst die vollständige Zieladresse, öffne eine sichere Vorschau und ändere anschließend nur den fiktiven Eintrag URL-${ref}. Beide Domains sind reservierte Testnamen; eine reale Weiterleitung oder DNS-Änderung findet nicht statt.`;
  if (/person einladen|gäste|gast|guest/u.test(`${g} ${t}`)) return `${NOTICE} Die Übung ${ref} simuliert ${cue} mit dem Profil GAST-${ref}. Wähle nur eine fiktive Laufzeit und minimale Demo-Rolle, kontrolliere in der Vorschau, dass keine echte Person oder E-Mail-Adresse eingetragen ist, und widerrufe das Testprofil am Ende. Es wird keine echte Einladung oder WLAN-Berechtigung beantragt.`;
  if (g.includes('campuscard')) {
    const lost = /verlust|gesperrt|bezahlfunktion/u.test(t);
    return lost
      ? `${NOTICE} Im Fall ${ref} wird die erfundene Karte CARD-${ref} als verloren simuliert. Markiere nur diesen Demo-Datensatz als gesperrt, notiere den erfundenen Zeitpunkt und prüfe, ob die Übungsanzeige keine echte Kartenkennung enthält. Für eine Ersatzkarte wird im Szenario ein separater Testvorgang angelegt; keine reale Karte sperren und kein Guthaben umbuchen.`
      : `${NOTICE} Der Übungsfall ${ref} behandelt ${cue} mit der fiktiven Karte CARD-${ref}. Öffne die Vorschau des Karten-Demoprofils, wähle die passende Testfunktion und prüfe eine Anzeige mit erfundenen Demo-Punkten. Ausgabe, Aufladung, Bibliotheksfreigabe und Validierung sind ausschließlich simuliert; es werden keine realen Kartendaten oder Beträge verändert.`;
  }
  if (g.includes('campusmanagement')) return `${NOTICE} Für ${cue} verwendet der Fall ${ref} den erfundenen Kurs PRUEFUNG-${ref} im Testsemester. Öffne die Vorschau, prüfe Kurskennung und Status „Entwurf“ und speichere eine simulierte Auswahl, ohne sie einzureichen. Datum, Prüfung, Person und Ergebnis sind Demo-Daten; daraus folgt keine tatsächliche Anmeldung oder Frist.`;
  if (/wlan|netzwerk/u.test(g)) return `${NOTICE} Diese Anleitung simuliert ${cue} mit dem fiktiven Profil WLAN-LAB-${ref}. Kontrolliere am Testgerät Flugmodus und gespeichertes Demo-Profil, entferne bei Bedarf nur den Laboreintrag und starte einen neuen Verbindungstest. Das Profil ist kein Hochschulnetz und benötigt weder echte Kennung noch Passwort; bei einem zweiten Testgerät wird nur der Fehlervergleich dokumentiert.`;
  if (/netzlaufwerke|fileservice/u.test(g)) return `${NOTICE} Im Laborfall ${ref} beschreibt ${cue} eine erfundene Dateiablage. Arbeite ausschließlich im Testordner ABLAGE-${ref}; das Beispielkontingent von 250 MB und der angezeigte Verbrauch von 230 MB sind ausdrücklich frei erfundene Werte. Prüfe Dateipfad und Papierkorb, sichere eine Testkopie und beende den Lauf mit einer Vorschau. Es werden keine realen Dateien verschoben oder wiederhergestellt.`;
  if (/informationssicherheit|security/u.test(g)) return `${NOTICE} Der Sicherheitsfall ${ref} behandelt ${cue} an einem vollständig erfundenen Beispiel. Nutze nur die Datei PHISHING-${ref}.eml und das reservierte Testziel https://warnung-demo.invalid, sichere eine Kopie der Demo-Anzeige und notiere beobachtete Merkmale ohne echte Zugangsdaten. Ein möglicher Vorfall wird hier weder gemeldet noch technisch untersucht; die Übung enthält keine reale Person oder Kontaktstelle.`;
  if (t.includes('rss')) return `${NOTICE} Der RSS-Fall ${ref} übt ${cue} mit dem fiktiven Feed https://feed-demo.invalid/rss.xml. Füge die Testadresse in eine lokale Vorschau ein, prüfe Titel und Aktualisierungsstatus und entferne den Eintrag danach wieder. Der Feed enthält keine echten Meldungen und wird nicht mit einem persönlichen Konto verknüpft.`;
  if (/e-mail|email|postfach/u.test(g)) return `${NOTICE} Der Postfachfall ${ref} übt ${cue} im erfundenen Mail-Labor https://mail-demo.invalid. Prüfe den Status des Testpostfachs MAIL-${ref}, vergleiche die Vorschau im zweiten Demo-Client und ändere nur eine simulierte Einstellung. Es werden keine echten Nachrichten weitergeleitet, versandt, gelöscht oder in ein persönliches Konto verschoben.`;
  if (/teams telefonie|voice over ip/u.test(g) || (t.includes('teams') && /telefon|anruf|voip/u.test(t))) return `${NOTICE} Der Telefonie-Fall ${ref} simuliert ${cue} im Testclient TEL-${ref}. Prüfe in der Vorschau Geräteauswahl, Präsenz und eine interne Testverbindung ohne Rufnummer. Starte keinen echten Anruf, hinterlege keine private Nummer und leite keine Gespräche um.`;
  if (/microsoft|teams/u.test(g) || /microsoft|office 365|microsoft 365|onedrive/u.test(t)) return `${NOTICE} Im Testtenant OFFICE-${ref} übt der Fall ${ref} ${cue}. Kontrolliere zuerst die Demo-Kontoeinstellung, öffne danach nur den vorgesehenen Funktionsbereich und vergleiche die Vorschau mit der gewünschten Testrolle. Dateien, Gruppen, Meetings und Lizenzen sind fiktiv; es wird kein reales Konto registriert, keine Lizenz zugesagt und nichts an echte Personen freigegeben.`;
  if (/drucken|kopieren|scannen/u.test(g)) return `${NOTICE} Die Druckübung ${ref} nutzt die fiktive Warteschlange PRINT-${ref}. Sende eine einseitige Testseite ohne persönliche Daten, prüfe Druckvorschau und Warteschlangenstatus und entferne den Demojob anschließend. Gerät, Standort, Toner und Ergebnis sind erfunden; weder ein realer Drucker noch ein echter Druckauftrag werden verändert.`;
  if (g.includes('webhosting')) return `${NOTICE} Im Fall ${ref} wird ${cue} auf dem erfundenen Webspace WEB-${ref} nachvollzogen. Verwende ausschließlich beispielhafte Dateien unter https://webspace-demo.invalid, prüfe zuerst eine Sicherungskopie und ändere dann eine einzelne Testseite. Die fiktive Grenze von 512 MB und die Beispielaufbewahrung von 30 Tagen sind keine realen Tarife oder Fristen.`;
  if (/drittanbieter|software|adobe|matlab|zoom/u.test(g)) return `${NOTICE} Der Softwarefall ${ref} behandelt ${cue} in einer isolierten Lizenz-Sandbox. Öffne das fiktive Profil SOFTWARE-${ref}, prüfe den angezeigten Produktnamen und wähle nur eine Vorschau oder Testinstallation. Die Demo bestätigt keine reale Bezugsberechtigung, Lizenz oder Rabattregel; keine Installation auf einem produktiven Gerät starten.`;
  if (/kurzurl|domain/u.test(g)) return `${NOTICE} Der URL-Fall ${ref} zeigt ${cue} mit short-demo.invalid und ziel-demo.invalid. Vergleiche zuerst die vollständige Zieladresse, öffne eine sichere Vorschau und ändere anschließend nur den fiktiven Eintrag URL-${ref}. Beide Domains sind reservierte Testnamen; eine reale Weiterleitung oder DNS-Änderung findet nicht statt.`;
  if (g.includes('dienstausweis')) return `${NOTICE} Der Dienstausweis-Fall ${ref} simuliert ${cue} mit BADGE-${ref}. Prüfe die fiktive Funktionsliste, notiere nur den gewünschten Demo-Anwendungsfall und vergleiche ihn mit der Vorschau. Ausgabe, Zutritt und Kontaktdaten sind nicht real; aus diesem Beispiel folgt keine tatsächliche Berechtigung.`;
  if (/zoom|konferenz/u.test(g)) return `${NOTICE} Der Konferenzfall ${ref} übt ${cue} mit dem fiktiven Meeting DEMO-${ref}. Prüfe die Vorschau von Rolle, Audio und alternativer Moderation, verwende ein Testgerät und beende den Raum nach dem Probelauf. Es gibt keine echte Einwahlnummer, Einladung oder Lizenzzusage.`;
  return `${NOTICE} Für ${cue} beschreibt der Guide ${ref} einen abgegrenzten Testablauf im fiktiven Portal https://portal-demo.invalid. Prüfe zuerst die Demo-Kennung, führe anschließend genau einen Vorschau-Schritt aus und kontrolliere die erwartete Rückmeldung. Angaben, Zuständigkeiten und Ergebnisse sind erfunden; der Guide ist keine reale Verfahrens- oder Zugangsregel.`;
}
function makeDocument(entry: SourceEntry, kind: 'faq' | 'service' | 'news' | 'link' | 'form'): SyntheticDocument {
  const id = idFor(entry.url);
  const group = topicGroup(entry, kind);
  const tags = [`topic:${slug(group)}`, `kind:${kind}`, ...queryTags(group, entry.title)].filter((tag, index, all) => all.indexOf(tag) === index).slice(0, 10);
  const title = cleanTitle(entry, kind);
  const vpnGuidance = syntheticVpnGuidance(group, entry.title, kind);
  const body = scenario(group, entry.title, kind, id);
  const revision: 1 | 2 = vpnGuidance?.text === body ? vpnGuidance.revision : 1;
  if (title.length >= 200 || body.length >= 4000) fail('A generated document exceeds a field limit.');
  return {
    id, sourceSystem: 'service_it', synthetic: true, language: 'de', title, revision,
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
  createdAt: '2026-10-18',
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
