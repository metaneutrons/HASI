import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('../fixtures/knowledge-demo-v1.json', import.meta.url));
const expectedDatasetId = 'hasi-knowledge-demo-v1';
const expectedDocumentCount = 60;
const expectedDocumentsPerSource = 30;
const allowedSourceSystems = ['service_it', 'intranet'] as const;
const allowedAudiences = ['student', 'employee', 'admin'] as const;
const mediaWikiNamespace = 'http://www.mediawiki.org/xml/export-0.11/';

export type DemoWikiSourceSystem = typeof allowedSourceSystems[number];
export type DemoWikiAudience = typeof allowedAudiences[number];

export interface DemoWikiDocument {
  id: string;
  sourceSystem: DemoWikiSourceSystem;
  synthetic: true;
  language: 'de' | 'en';
  title: string;
  text: string;
  demoAudience: DemoWikiAudience[];
}

export interface DemoWikiSeed {
  schemaVersion: 1;
  datasetId: typeof expectedDatasetId;
  synthetic: true;
  createdAt: string;
  documents: DemoWikiDocument[];
}

interface ExportPage {
  title: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSourceSystem(value: unknown): value is DemoWikiSourceSystem {
  return typeof value === 'string' && allowedSourceSystems.includes(value as DemoWikiSourceSystem);
}

function isAudience(value: unknown): value is DemoWikiAudience {
  return typeof value === 'string' && allowedAudiences.includes(value as DemoWikiAudience);
}

function isSeedDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function assertXmlCharacters(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !(
      codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    )) throw new Error('Demo seed contains a character that XML 1.0 cannot represent.');
  }
}

function validateSeed(value: unknown): DemoWikiSeed {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.datasetId !== expectedDatasetId ||
    value.synthetic !== true || !isSeedDate(value.createdAt) || !Array.isArray(value.documents) ||
    value.documents.length !== expectedDocumentCount) {
    throw new Error('Expected the complete synthetic HASI knowledge demo seed.');
  }

  const ids = new Set<string>();
  const counts: Record<DemoWikiSourceSystem, number> = { service_it: 0, intranet: 0 };
  const documents: DemoWikiDocument[] = [];

  for (const candidate of value.documents) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' ||
      !/^(svc|int)-\d{3}$/u.test(candidate.id) || !isSourceSystem(candidate.sourceSystem) ||
      candidate.synthetic !== true || (candidate.language !== 'de' && candidate.language !== 'en') ||
      typeof candidate.title !== 'string' || candidate.title.length < 1 || candidate.title.length > 256 ||
      typeof candidate.text !== 'string' || candidate.text.length < 1 || candidate.text.length > 20_000 ||
      !Array.isArray(candidate.demoAudience) || candidate.demoAudience.length < 1 ||
      !candidate.demoAudience.every(isAudience)) {
      throw new Error('Demo seed contains an invalid or non-synthetic document.');
    }

    const expectedIdPrefix = candidate.sourceSystem === 'service_it' ? 'svc-' : 'int-';
    if (!candidate.id.startsWith(expectedIdPrefix) || ids.has(candidate.id)) {
      throw new Error('Demo seed contains an unsafe or duplicate document identifier.');
    }
    assertXmlCharacters(candidate.id);
    assertXmlCharacters(candidate.title);
    assertXmlCharacters(candidate.text);
    ids.add(candidate.id);
    counts[candidate.sourceSystem] += 1;
    documents.push({
      id: candidate.id,
      sourceSystem: candidate.sourceSystem,
      synthetic: true,
      language: candidate.language,
      title: candidate.title,
      text: candidate.text,
      demoAudience: [...new Set(candidate.demoAudience)],
    });
  }

  if (counts.service_it !== expectedDocumentsPerSource || counts.intranet !== expectedDocumentsPerSource) {
    throw new Error('Demo seed does not contain the expected synthetic source split.');
  }

  return {
    schemaVersion: 1,
    datasetId: expectedDatasetId,
    synthetic: true,
    createdAt: value.createdAt,
    documents,
  };
}

export async function loadDemoWikiSeed(): Promise<DemoWikiSeed> {
  const fixture = await readFile(fixturePath, 'utf8');
  return validateSeed(JSON.parse(fixture) as unknown);
}

function xmlEscape(value: string): string {
  assertXmlCharacters(value);
  return value.replace(/[&<>"'\r]/gu, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      case '\r': return '&#13;';
      default: return character;
    }
  });
}

function safeNowikiText(value: string): string {
  // Escape ampersands first so references supplied as input remain inert in wikitext.
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function nowiki(value: string): string {
  return `<nowiki>${safeNowikiText(value)}</nowiki>`;
}

function titleSlug(title: string): string {
  const sourceTitle = title.replace(/^Demo:\s*/u, '');
  const slug = sourceTitle.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80).replace(/-+$/u, '');
  return slug || 'document';
}

function assertSafeDocumentId(sourceSystem: DemoWikiSourceSystem, id: string): void {
  const sourcePrefix = sourceSystem === 'service_it' ? 'svc-' : 'int-';
  if (!new RegExp(`^${sourcePrefix}\\d{3}$`, 'u').test(id)) {
    throw new Error('Demo document identifier cannot be used in a wiki page title.');
  }
}

export function createDemoWikiPageTitle(document: Pick<DemoWikiDocument, 'id' | 'sourceSystem' | 'title'>): string {
  assertSafeDocumentId(document.sourceSystem, document.id);
  const section = document.sourceSystem === 'service_it' ? 'Service-IT' : 'Intranet';
  const pageTitle = `Wissen:${section}/${titleSlug(document.title)}--${document.id}`;
  if (!/^Wissen:(Service-IT|Intranet)\/[a-z0-9]+(?:-[a-z0-9]+)*--(?:svc|int)-\d{3}$/u.test(pageTitle)) {
    throw new Error('Generated wiki page title is unsafe.');
  }
  return pageTitle;
}

function timestampFromSeed(seed: DemoWikiSeed): string {
  return `${seed.createdAt}T00:00:00Z`;
}

function renderDocumentPage(document: DemoWikiDocument): ExportPage {
  const audience = document.demoAudience.join(', ');
  const text = [
    `== ${nowiki(document.title)} ==`,
    `<nowiki>${safeNowikiText(document.text)}</nowiki>`,
    '',
    `Zielgruppe: ${nowiki(audience)}`,
  ].join('\n');
  return { title: createDemoWikiPageTitle(document), text };
}

function renderInventoryPage(seed: DemoWikiSeed, sourceSystem: DemoWikiSourceSystem): ExportPage {
  const section = sourceSystem === 'service_it' ? 'Service-IT' : 'Intranet';
  const inventoryTitle = `Wissen:${section}/Inventory`;
  const documents = seed.documents.filter(document => document.sourceSystem === sourceSystem)
    .sort((first, second) => first.id.localeCompare(second.id, 'en'));
  const links = documents.map(document => {
    const title = createDemoWikiPageTitle(document);
    return `* [[${title}|${nowiki(document.title)} — ${document.id}]]`;
  });
  return {
    title: inventoryTitle,
    text: [
      `== ${section} ==`,
      `${String(documents.length)} Dokumente.`,
      '',
      ...links,
      '',
      'Navigation: [[HASI Wissen]]',
    ].join('\n'),
  };
}

function renderMainPage(seed: DemoWikiSeed): ExportPage {
  return {
    title: 'HASI Wissen',
    text: [
      '== HASI Wissen ==',
      'Wissensartikel zu Service IT und Intranet.',
      `${String(seed.documents.length)} Dokumente · Stand: ${seed.createdAt}.`,
      '',
      '* [[Wissen:Service-IT/Inventory|Service-IT inventory]]',
      '* [[Wissen:Intranet/Inventory|Intranet inventory]]',
    ].join('\n'),
  };
}

function mediaWikiSha1(value: string): string {
  const digest = createHash('sha1').update(value, 'utf8').digest('hex');
  return BigInt(`0x${digest}`).toString(36).padStart(31, '0');
}

function createPages(seed: DemoWikiSeed): ExportPage[] {
  const pages = [
    renderMainPage(seed),
    renderInventoryPage(seed, 'service_it'),
    renderInventoryPage(seed, 'intranet'),
    ...seed.documents
      .slice()
      .sort((first, second) => first.sourceSystem.localeCompare(second.sourceSystem, 'en') || first.id.localeCompare(second.id, 'en'))
      .map(document => renderDocumentPage(document)),
  ];
  const titles = new Set<string>();
  for (const page of pages) {
    if (titles.has(page.title)) throw new Error('Demo wiki contains duplicate generated page titles.');
    titles.add(page.title);
  }
  return pages;
}

function renderPageXml(page: ExportPage, pageId: number, timestamp: string): string {
  const revisionId = pageId;
  return [
    '  <page>',
    `    <title>${xmlEscape(page.title)}</title>`,
    '    <ns>0</ns>',
    `    <id>${String(pageId)}</id>`,
    '    <revision>',
    `      <id>${String(revisionId)}</id>`,
    `      <timestamp>${timestamp}</timestamp>`,
    '      <contributor><ip>127.0.0.1</ip></contributor>',
    '      <comment>Generated seeded import; timestamp derived from fixture createdAt.</comment>',
    `      <origin>${String(revisionId)}</origin>`,
    '      <model>wikitext</model>',
    '      <format>text/x-wiki</format>',
    `      <text bytes="${String(Buffer.byteLength(page.text, 'utf8'))}" xml:space="preserve">${xmlEscape(page.text)}</text>`,
    `      <sha1>${mediaWikiSha1(page.text)}</sha1>`,
    '    </revision>',
    '  </page>',
  ].join('\n');
}

export function generateDemoWikiXml(input: unknown): string {
  const seed = validateSeed(input);
  const pages = createPages(seed);
  const timestamp = timestampFromSeed(seed);
  const pageXml = pages.map((page, index) => renderPageXml(page, index + 1, timestamp));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mediawiki xmlns="${mediaWikiNamespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${mediaWikiNamespace} https://www.mediawiki.org/xml/export-0.11.xsd" version="0.11" xml:lang="en">`,
    '  <siteinfo>',
    '    <sitename>HASI Wissen</sitename>',
    '    <dbname>hasi_knowledge</dbname>',
    '    <generator>HASI deterministic wiki exporter</generator>',
    '    <case>first-letter</case>',
    '    <namespaces>',
    '      <namespace key="0" case="first-letter" />',
    '    </namespaces>',
    '  </siteinfo>',
    ...pageXml,
    '</mediawiki>',
    '',
  ].join('\n');
}

export async function writeDemoWikiXml(outputPath: string, input: unknown): Promise<void> {
  const output = generateDemoWikiXml(input);
  await writeFile(resolve(outputPath), output, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}

async function main(): Promise<void> {
  const [outputArgument, ...extraArgs] = process.argv.slice(2);
  if (outputArgument === undefined || extraArgs.length !== 0) {
    console.error('Usage: tsx scripts/export-demo-wiki.ts <output-path>');
    process.exitCode = 2;
    return;
  }

  const seed = await loadDemoWikiSeed();
  const destination = resolve(outputArgument);
  await writeDemoWikiXml(destination, seed);
  console.log(`Wrote synthetic demo wiki XML with ${String(seed.documents.length)} documents to ${destination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Demo wiki export failed. The output path must be new and writable.');
    process.exitCode = 1;
  });
}
