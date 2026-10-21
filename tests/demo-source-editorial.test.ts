import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { knowledgeDocuments } from '../fixtures/knowledge-catalog.js';

describe('editorial knowledge corpus', () => {
  it('keeps disclosure in application chrome rather than repeated article prose', () => {
    const repeatedDisclosure = /demo|synthetisch|synthetic|fiktiv|erfunden/iu;
    // Counterexample proves this check detects the former article prefix.
    expect(repeatedDisclosure.test('SYNTHETISCHES DEMO-BEISPIEL')).toBe(true);
    expect(knowledgeDocuments).toHaveLength(301);
    for (const document of knowledgeDocuments) {
      expect(`${document.title}\n${document.text}`, document.id).not.toMatch(repeatedDisclosure);
      expect(document.synthetic, document.id).toBe(true);
      expect(document.citationId, document.id).toBe(`knowledge:${document.sourceSystem}:${document.id}:${String(document.revision)}`);
      expect(document.revision, document.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('preserves the complete prior source identity, classification and audience inventory', () => {
    // Frozen main 8941f897; only prose and its citation revisions may change.
    const identity = knowledgeDocuments.map(document => Object.fromEntries(
      Object.entries(document).filter(([key]) => !['title', 'text', 'revision', 'citationId'].includes(key)),
    ));
    expect(createHash('sha256').update(JSON.stringify(identity)).digest('hex')).toBe('d045b08c06f803c7a176974d3e35283896a12cef95a536dd2715e4cd17fe9787');
  });

  it('answers account setup and password-reset topics without unrelated instructions', () => {
    const azure = knowledgeDocuments.find(document => document.id === 'svc-catalog-c55e64d36248');
    expect(azure?.text).toContain('Sicherheitsinformationen deines Kontos');
    expect(azure?.text).not.toMatch(/verdächtige Nachricht|bisherige Methode entfernst/u);
    const adobe = knowledgeDocuments.find(document => document.id === 'svc-catalog-2c9a21ff1b90');
    expect(adobe?.text).toContain('Zurücksetzen des Passworts');
    expect(adobe?.text).not.toContain('Softwarekatalog');
    const outage = knowledgeDocuments.find(document => document.id === 'svc-catalog-e8dfc6608f60');
    expect(outage?.title).toBe('Meldung: Wartungsfenster im Intranet');
    expect(outage?.text).not.toMatch(/14\.8\.|August/u);
  });
});
