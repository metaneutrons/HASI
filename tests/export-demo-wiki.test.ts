import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDemoWikiPageTitle,
  generateDemoWikiXml,
  loadDemoWikiSeed,
  writeDemoWikiXml,
  type DemoWikiSeed,
} from '../scripts/export-demo-wiki.js';

interface ParsedPage {
  title: string;
  text: string;
  timestamp: string;
}

const temporaryDirectories: string[] = [];

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_entity, name: string) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
  });
}

function parseExport(xml: string): ParsedPage[] {
  const pageBlocks = [...xml.matchAll(/<page>([\s\S]*?)<\/page>/gu)].map(match => match[1]!);
  return pageBlocks.map(block => {
    const title = /<title>([\s\S]*?)<\/title>/u.exec(block)?.[1];
    const timestamp = /<timestamp>([\s\S]*?)<\/timestamp>/u.exec(block)?.[1];
    const text = /<text\b[^>]*>([\s\S]*?)<\/text>/u.exec(block)?.[1];
    if (title === undefined || timestamp === undefined || text === undefined) {
      throw new Error('Generated MediaWiki XML page is missing a required element.');
    }
    return { title: decodeXml(title), timestamp: decodeXml(timestamp), text: decodeXml(text) };
  });
}

async function seedFixture(): Promise<DemoWikiSeed> {
  return loadDemoWikiSeed();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('synthetic demo MediaWiki XML export', () => {
  it('exports all fixture documents deterministically with stable identities and navigable inventories', async () => {
    const seed = await seedFixture();
    const first = generateDemoWikiXml(seed);
    expect(generateDemoWikiXml(seed)).toBe(first);

    const pages = parseExport(first);
    expect(pages).toHaveLength(seed.documents.length + 3);
    expect(first).toContain('version="0.11"');
    expect(first).toContain('<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/"');
    expect(first).not.toContain('FICTIONAL DEMO CONTENT / FIKTIVE DEMO-INHALTE — SYNTHETIC ONLY');

    const pagesByTitle = new Map(pages.map(page => [page.title, page]));
    expect(pagesByTitle.has('Main Page')).toBe(false);
    expect(pagesByTitle.get('HASI Demo')?.text).toContain('[[Demo:Service-IT/Inventory|Service-IT inventory]]');
    expect(pagesByTitle.get('HASI Demo')?.text).toContain('[[Demo:Intranet/Inventory|Intranet inventory]]');
    expect(pagesByTitle.get('Demo:Service-IT/Inventory')?.text).toContain('30 Dokumente.');
    expect(pagesByTitle.get('Demo:Intranet/Inventory')?.text).toContain('30 Dokumente.');
    expect(pagesByTitle.get('Demo:Service-IT/Inventory')?.text).toContain('Navigation: [[HASI Demo|HASI Wissen]]');
    expect(pagesByTitle.get('Demo:Intranet/Inventory')?.text).toContain('Navigation: [[HASI Demo|HASI Wissen]]');

    const expectedTimestamp = `${seed.createdAt}T00:00:00Z`;
    for (const page of pages) expect(page.timestamp).toBe(expectedTimestamp);
    for (const document of seed.documents) {
      const title = createDemoWikiPageTitle(document);
      const page = pagesByTitle.get(title);
      expect(page).toBeDefined();
      expect(page?.text).toContain(`<nowiki>${document.title}</nowiki>`);
      expect(page?.text).toContain(`Zielgruppe: <nowiki>${document.demoAudience.join(', ')}</nowiki>`);
      expect(page?.text).not.toMatch(/demo|fictional|synthetic/iu);
      const inventoryTitle = document.sourceSystem === 'service_it' ? 'Demo:Service-IT/Inventory' : 'Demo:Intranet/Inventory';
      const safeLabel = document.title.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
      expect(pagesByTitle.get(inventoryTitle)?.text).toContain(`* [[${title}|<nowiki>${safeLabel}</nowiki> — ${document.id}]]`);
    }

    const documentPages = pages.filter(page => page.title.startsWith('Demo:') && !page.title.endsWith('/Inventory'));
    expect(documentPages).toHaveLength(60);
    expect(documentPages.every(page => !page.text.includes('This is not a source modification date.'))).toBe(true);
    expect(pages.every(page => !page.text.includes('[[Main Page'))).toBe(true);
  });

  it('keeps XML closing tags and nowiki breakout probes inert inside generated wikitext', async () => {
    const seed = structuredClone(await seedFixture());
    seed.documents[0]!.text = 'SYNTHETIC TEST </text><evil>payload</evil> </nowiki><ref>Injected</ref>{{Unsafe}}';
    const xml = generateDemoWikiXml(seed);
    const pages = parseExport(xml);
    expect(pages).toHaveLength(63);
    expect(xml).not.toContain('</text><evil>');

    const documentPage = pagesByTitle(pages).get(createDemoWikiPageTitle(seed.documents[0]!));
    expect(documentPage?.text).toContain('&lt;/text&gt;&lt;evil&gt;payload&lt;/evil&gt;');
    expect(documentPage?.text).toContain('&lt;/nowiki&gt;&lt;ref&gt;Injected&lt;/ref&gt;{{Unsafe}}');
    const exampleText = documentPage?.text.split(' ==\n')[1]?.split('\n\nZielgruppe:')[0];
    expect(exampleText).toBe('<nowiki>SYNTHETIC TEST &lt;/text&gt;&lt;evil&gt;payload&lt;/evil&gt; &lt;/nowiki&gt;&lt;ref&gt;Injected&lt;/ref&gt;{{Unsafe}}</nowiki>');
  });

  it('sanitizes untrusted title text and rejects unsafe document identifiers', async () => {
    const seed = structuredClone(await seedFixture());
    seed.documents[0]!.title = '../</nowiki>{{unsafe}}|New page';
    const xml = generateDemoWikiXml(seed);
    const page = pagesByTitle(parseExport(xml)).get(createDemoWikiPageTitle(seed.documents[0]!));
    expect(page?.title).toMatch(/^Demo:Service-IT\/[a-z0-9]+(?:-[a-z0-9]+)*--svc-001$/u);
    expect(page?.text).toContain('== <nowiki>../&lt;/nowiki&gt;{{unsafe}}|New page</nowiki> ==');

    const unsafeIdSeed = structuredClone(seed);
    unsafeIdSeed.documents[0]!.id = '../Main_Page';
    expect(() => generateDemoWikiXml(unsafeIdSeed)).toThrow(/invalid|unsafe|identifier/iu);
  });

  it('refuses to overwrite an existing output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hasi-demo-wiki-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'existing.xml');
    await writeFile(outputPath, 'keep this file', 'utf8');

    await expect(writeDemoWikiXml(outputPath, await seedFixture())).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('keep this file');
  });
});

function pagesByTitle(pages: ParsedPage[]): Map<string, ParsedPage> {
  return new Map(pages.map(page => [page.title, page]));
}
