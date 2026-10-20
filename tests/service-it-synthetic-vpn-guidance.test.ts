import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
  { id: 'svc-catalog-9b30ce8b226d', title: 'Demo-FAQ: Einrichtung: einen zweiten Faktor für die Nutzung von VPN ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-6c79c1e68f04', title: 'Demo-FAQ: Fehlersuche: funktioniert mein VPN nicht', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-b2bfd3b4d323', title: 'Demo-FAQ: Fehlerbild: mich nach der Aktualisierung von GlobalProtect nicht mehr anmelden', audience: ['employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-94f501ccd7be', title: 'Demo-FAQ: Einrichtung: einen VPN Client unter Android ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-8269e07ac91e', title: 'Demo-FAQ: Einrichtung: GlobalProtect auf meinem Chromebook ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-4d9b0bb1f7e7', title: 'Demo-FAQ: Einrichtung: einen VPN Client unter Windows S ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'microsoft', 'vpn'] },
  { id: 'svc-catalog-4760a271d1e7', title: 'Demo-FAQ: Einrichtung: einen VPN Client unter macOS ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'vpn'] },
  { id: 'svc-catalog-45e0e1ce9803', title: 'Demo-FAQ: Einrichtung: einen VPN Client unter Windows ein', audience: ['student', 'employee', 'admin'], tags: ['topic:vpn-virtual-private-network', 'kind:faq', 'microsoft', 'vpn'] },
  { id: 'svc-catalog-1b51d9da7793', title: 'Demo-Service: VPN (Virtual Private Network)', audience: ['student', 'employee', 'admin'], tags: ['topic:netzwerk', 'kind:service', 'vpn'] },
] as const;

describe('synthetic ServiceIT VPN guidance', () => {
  it('generates generic diagnostics only for FAQ and service VPN scenarios that reach this branch', () => {
    const guidance = syntheticVpnGuidance('VPN', 'VPN-Verbindung funktioniert nicht', 'faq');
    expect(guidance?.revision).toBe(2);
    expect(guidance?.text).toContain('SYNTHETISCHES DEMO-BEISPIEL');
    expect(guidance?.text).toContain('gewöhnliche Internetseiten');
    expect(guidance?.text).toContain('genauen Wortlaut der Fehlermeldung samt Fehlercode');
    expect(guidance?.text).toContain('Betriebssystem sowie Name und Version des VPN-Clients');
    expect(guidance?.text).toContain('VPN-Verbindungsaufbau selbst fehlschlägt');
    expect(guidance?.text).toContain('Anmeldung beziehungsweise Verbindung gelingt');
    expect(guidance?.text).toContain('keine institutionelle Anleitung');
    expect(guidance?.text).toContain('keine Passwörter oder MFA-Codes');
    expect(syntheticVpnGuidance('WLAN', 'WLAN-Verbindung funktioniert nicht', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'VPN-Störungshinweis', 'news')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'VPN Linkguide', 'link')).toBeUndefined();
    expect(syntheticVpnGuidance('VPN', 'MFA VPN mit Passkey', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('Academic Cloud VPN', 'VPN Zugang', 'faq')).toBeUndefined();
    expect(syntheticVpnGuidance('ServiceIT mit Wagtail', 'VPN FAQ', 'faq')).toBeUndefined();
  });

  it('distinguishes troubleshooting, setup, second factor, coverage and service information', () => {
    expect(syntheticVpnGuidance('VPN', 'Einrichtung: einen VPN Client unter Android ein', 'faq')?.text).toContain('keinen verifizierten Download');
    expect(syntheticVpnGuidance('VPN', 'Einrichtung: einen zweiten Faktor für VPN ein', 'faq')?.text).toContain('zugelassene Methode');
    expect(syntheticVpnGuidance('Microsoft', 'In welchen Gebieten benötige ich keine aktive VPN Verbindung', 'faq')?.text).toContain('keine freigegebenen Netze oder Ausnahmen');
    expect(syntheticVpnGuidance('Netzwerk', 'VPN (Virtual Private Network)', 'service')?.text).toContain('erfolgreiche Anmeldung beweist noch nicht');
  });

  it('revises exactly the ten corrected fixture documents and keeps their labels and citations aligned', () => {
    const expectedIds = expectedDocuments.map(({ id }) => id).sort();
    const revised = fixture.documents.filter((document) => document.revision === 2);
    expect(fixture.documents).toHaveLength(241);
    expect(revised.map(({ id }) => id).sort()).toEqual(expectedIds);
    expect(fixture.documents.filter((document) => document.revision === 1)).toHaveLength(231);

    for (const expected of expectedDocuments) {
      const document = fixture.documents.find((candidate) => candidate.id === expected.id);
      expect(document).toBeDefined();
      expect(document).toMatchObject({
        title: expected.title,
        revision: 2,
        demoAudience: expected.audience,
        tags: expected.tags,
        citationId: `knowledge:service_it:${expected.id}:2`,
      });
      const kind = expected.tags.some(tag => tag === 'kind:service') ? 'service' : 'faq';
      const generated = syntheticVpnGuidance('VPN', expected.title, kind);
      expect(document?.text).toBe(generated?.text);
      expect(document?.text).not.toContain(expected.id.slice(-6).toUpperCase());
      expect(document?.text).not.toMatch(/https?:\/\/|\.invalid\b|\b[A-F0-9]{6}\b/u);
    }

    expect(fixture.documents.every((document) => document.citationId.endsWith(`:${String(document.revision)}`))).toBe(true);
    expect(fixture.documents.every((document) => !document.text.includes('vpn-demo.invalid'))).toBe(true);
  });
});
