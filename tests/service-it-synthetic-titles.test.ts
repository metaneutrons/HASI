import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serviceItArticleTitle } from '../scripts/service-it-article-text.js';
import { formatSyntheticFaqTitle, syntheticFaqTitleCorrections } from '../scripts/synthetic-faq-titles.js';

interface Document {
  id: string; title: string; revision: number; citationId: string; tags: string[];
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/service-it-synthetic-v1.json', import.meta.url), 'utf8')) as { documents: Document[] };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('reviewed synthetic FAQ labels', () => {
  it('keeps known troubleshooting and setup questions distinct', () => {
    const title = (id: string) => fixture.documents.find(row => row.id === id)?.title;
    expect(title('svc-catalog-6c79c1e68f04')).toBe('FAQ: Warum funktioniert mein VPN nicht?');
    expect(title('svc-catalog-b2bfd3b4d323')).toBe('FAQ: Warum kann ich mich nach der Aktualisierung von GlobalProtect nicht mehr anmelden?');
    expect(title('svc-catalog-94f501ccd7be')).toBe('FAQ: Wie richte ich einen VPN-Client unter Android ein?');
    expect(title('svc-catalog-4d9b0bb1f7e7')).toBe('FAQ: Wie richte ich einen VPN-Client unter Windows S ein?');
    expect(title('svc-catalog-45e0e1ce9803')).toBe('FAQ: Wie richte ich einen VPN-Client unter Windows ein?');
    expect(title('svc-catalog-783e75088185')).toBe('FAQ: Wie und wo kann ich meine CampusCard aufladen?');
  });

  it('uses each reviewed exact migration once and is idempotent', () => {
    expect(syntheticFaqTitleCorrections).toHaveLength(85);
    expect(new Set(syntheticFaqTitleCorrections.map(row => row.id)).size).toBe(85);
    for (const correction of syntheticFaqTitleCorrections) {
      const revised = formatSyntheticFaqTitle(correction.id, correction.before, correction.previousRevision);
      expect(revised).toEqual({ title: correction.after, revision: correction.previousRevision + 1 });
      expect(formatSyntheticFaqTitle(correction.id, revised.title, revised.revision)).toEqual(revised);
      const document = fixture.documents.find(row => row.id === correction.id);
      expect(document?.tags).toContain('kind:faq');
      expect(document).toMatchObject({ title: serviceItArticleTitle(revised.title), revision: revised.revision + 1, citationId: `knowledge:service_it:${correction.id}:${String(revised.revision + 1)}` });
    }
  });

  it('does not guess new labels or reuse a reviewed revision for changed input', () => {
    const correction = syntheticFaqTitleCorrections[0]!;
    expect(() => formatSyntheticFaqTitle(correction.id, 'Changed source title', correction.previousRevision)).toThrow('requires review');
    expect(() => formatSyntheticFaqTitle(correction.id, correction.before, correction.previousRevision + 1)).toThrow('requires review');
    expect(() => formatSyntheticFaqTitle(correction.id, correction.after, correction.previousRevision)).toThrow('requires review');
    expect(formatSyntheticFaqTitle('new-demo-document', 'Demo-FAQ: Unreviewed example', 4)).toEqual({ title: 'Demo-FAQ: Unreviewed example', revision: 4 });
  });

  it('preserves source identity, classification and access across editorial changes', () => {
    expect(fixture.documents).toHaveLength(241);
    const identity = fixture.documents.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['title', 'text', 'revision', 'citationId'].includes(key))));
    expect(hash(identity)).toBe('604808694682fab11e257b5ce6fe0113f4fa8f3bf5c5511b6a317bb50dabc002');
  });
});
