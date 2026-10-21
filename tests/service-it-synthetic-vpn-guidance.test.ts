import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syntheticFaqTitleCorrections } from '../scripts/synthetic-faq-titles.js';
import { serviceItArticleTitle } from '../scripts/service-it-article-text.js';
import { syntheticVpnGuidance } from '../scripts/synthetic-vpn-guidance.js';

interface FixtureDocument {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly demoAudience: readonly string[];
  readonly tags: readonly string[];
  readonly text: string;
  readonly citationId: string;
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/service-it-synthetic-v1.json', import.meta.url), 'utf8')) as {
  readonly documents: readonly FixtureDocument[];
};

const expectedDocuments = [
  { id: 'svc-catalog-9e71428c190f', title: 'Demo-FAQ: In welchen Gebieten benötige ich keine aktive VPN Verbindung für die Anmeldung an M365 Diensten', audience: ['student', 'employee', 'admin'], tags: ['topic:microsoft', 'kind:faq', 'account', 'microsoft', 'vpn'] },
  { id: 'svc-catalog-9b30ce8b226d', title: 'Demo-FAQ: Wie richte ich einen zweiten Faktor für die VPN-Nutzung ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-6c79c1e68f04', title: 'Demo-FAQ: Warum funktioniert mein VPN nicht?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-b2bfd3b4d323', title: 'Demo-FAQ: Warum kann ich mich nach der Aktualisierung von GlobalProtect nicht mehr anmelden?', audience: ['employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-94f501ccd7be', title: 'Demo-FAQ: Wie richte ich einen VPN-Client unter Android ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-8269e07ac91e', title: 'Demo-FAQ: Wie richte ich GlobalProtect auf meinem Chromebook ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-4d9b0bb1f7e7', title: 'Demo-FAQ: Wie richte ich einen VPN-Client unter Windows S ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'microsoft', 'vpn'] },
  { id: 'svc-catalog-4760a271d1e7', title: 'Demo-FAQ: Wie richte ich einen VPN-Client unter macOS ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-45e0e1ce9803', title: 'Demo-FAQ: Wie richte ich einen VPN-Client unter Windows ein?', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'microsoft', 'vpn'] },
  { id: 'svc-catalog-1b51d9da7793', title: 'Demo-Service: VPN (Virtual Private Network)', audience: ['student', 'employee', 'admin'], tags: ['topic:netzwerk', 'kind:service', 'vpn'] },
] as const;

describe('synthetic ServiceIT VPN guidance', () => {
  it('generates generic diagnostics only for FAQ and service VPN scenarios that reach this branch', () => {
    const guidance = syntheticVpnGuidance('VPN', 'VPN-Verbindung funktioniert nicht', 'faq');
    expect(guidance?.revision).toBe(2);
    expect(guidance?.text).not.toMatch(/demo|synthetisch|fiktiv/iu);
    expect(guidance?.text).toContain('gewöhnliche Internetseiten');
    expect(guidance?.text).toContain('genauen Wortlaut der Fehlermeldung samt Fehlercode');
    expect(guidance?.text).toContain('Betriebssystem sowie Name und Version des VPN-Clients');
    expect(guidance?.text).toContain('VPN-Verbindungsaufbau selbst fehlschlägt');
    expect(guidance?.text).toContain('Anmeldung beziehungsweise Verbindung gelingt');
    expect(guidance?.text).toContain('keine Passwörter oder MFA-Codes');
    expect(syntheticVpnGuidance('WLAN', 'WLAN-Verbindung funktioniert nicht', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'VPN-Störungshinweis', 'news')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'VPN Linkguide', 'link')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'MFA VPN mit Passkey', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('Academic Cloud VPN', 'VPN Zugang', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('ServiceIT mit Wagtail', 'VPN FAQ', 'faq')).toBeUndefined();
  });

  it('distinguishes troubleshooting, setup, second factor, coverage and service information', () => {
    expect(syntheticVpnGuidance('VPN', 'Einrichtung: einen VPN Client unter Android ein', 'faq')?.text).toContain('Download, Serveradresse und Geräteprofil');
    expect(syntheticVpnGuidance('VPN', 'Einrichtung: einen zweiten Faktor für VPN ein', 'faq')?.text).toContain('zugelassene Methode');
    expect(syntheticVpnGuidance('Microsoft', 'In welchen Gebieten benötige ich keine aktive VPN Verbindung', 'faq')?.text).toContain('Freigegebene Netze und Ausnahmen');
    expect(syntheticVpnGuidance('Netzwerk', 'VPN (Virtual Private Network)', 'service')?.text).toContain('erfolgreiche Anmeldung beweist noch nicht');
  });

  it('preserves the ten corrected VPN bodies across later title revisions', () => {
    const expectedIds: string[] = expectedDocuments.map(({ id }) => id).sort();
    const revised = fixture.documents.filter((document) => document.tags.includes('vpn') && expectedIds.includes(document.id));
    expect(fixture.documents).toHaveLength(241);
    expect(revised.map(({ id }) => id).sort()).toEqual(expectedIds);
    expect(revised).toHaveLength(10);

    for (const expected of expectedDocuments) {
      const document = fixture.documents.find((candidate) => candidate.id === expected.id);
      expect(document).toBeDefined();
      const revision = expected.id === 'svc-catalog-9e71428c190f' || expected.id === 'svc-catalog-1b51d9da7793' ? 3 : 4;
      expect(document).toMatchObject({
        title: serviceItArticleTitle(expected.title),
        revision,
        demoAudience: expected.audience,
        tags: expected.tags,
        citationId: `knowledge:service_it:${expected.id}:${String(revision)}`,
      });
      const kind = expected.tags.some(tag => tag === 'kind:service') ? 'service' : 'faq';
      // Body synthesis uses the source cue, not the subsequently curated UI label.
      const cue = syntheticFaqTitleCorrections.find(row => row.id === expected.id)?.before ?? expected.title;
      const generated = syntheticVpnGuidance('VPN', cue, kind);
      expect(document?.text).toBe(generated?.text);
      expect(document?.text).not.toContain(expected.id.slice(-6).toUpperCase());
      expect(document?.text).not.toMatch(/https?:\/\/|\.invalid\b|\b[A-F0-9]{6}\b/u);
    }

    expect(fixture.documents.every((document) => document.citationId.endsWith(`:${String(document.revision)}`))).toBe(true);
    expect(fixture.documents.every((document) => !document.text.includes('vpn-demo.invalid'))).toBe(true);
  });
});
