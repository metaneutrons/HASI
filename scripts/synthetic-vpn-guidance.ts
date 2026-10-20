export const SYNTHETIC_DEMO_NOTICE = 'SYNTHETISCHES DEMO-BEISPIEL: Alle Namen, Werte, Wege und Abläufe in diesem Text sind erfunden. Der Eintrag beschreibt keine tatsächliche Hochschulregel.';

type ScenarioKind = 'faq' | 'service' | 'news' | 'link' | 'form';
export interface SyntheticVpnGuidance {
  readonly revision: 2;
  readonly text: string;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('de-DE');
}

export function syntheticVpnGuidance(group: string, title: string, kind: ScenarioKind): SyntheticVpnGuidance | undefined {
  if (kind !== 'faq' && kind !== 'service') return undefined;

  const topic = normalize(`${group} ${title}`);
  // These scenarios are handled earlier in the generator and retain revision 1.
  if (/academic.?cloud|serviceit mit wagtail|wagtail|multi.?faktor|mfa|passkey|yubikey|authenticator|totp|keepass/u.test(topic)) {
    return undefined;
  }
  if (!/vpn|virtual private|globalprotect/u.test(topic)) return undefined;

  const guidance = topic.includes('zweiten faktor')
    ? 'Für einen zweiten Faktor benötigst du die freigegebene Einrichtungsanleitung und die für dein Konto zugelassene Methode. Diese Demo enthält weder eine MFA-Registrierung noch gültige Einrichtungscodes. Notiere, ob die Einrichtung selbst scheitert oder eine bereits eingerichtete Methode bei der VPN-Anmeldung nicht funktioniert. Teile keine Passwörter, Wiederherstellungscodes oder MFA-Codes.'
    : topic.includes('in welchen gebieten')
      ? 'Ob ein M365-Dienst ohne VPN erreichbar ist, hängt vom verwendeten Netz und den geltenden Zugriffsregeln ab. Diese Demo legt keine freigegebenen Netze oder Ausnahmen fest. Notiere den betroffenen Dienst, das verwendete Netz und die genaue Anmeldefehlermeldung. Aus diesem Eintrag lässt sich weder eine allgemeine VPN-Pflicht noch eine Ausnahme für einen Hochschulstandort ableiten.'
      : topic.includes('einrichtung')
        ? 'Für die VPN-Einrichtung müssen Betriebssystem und Version, ein freigegebener VPN-Client sowie die dafür vorgesehenen Verbindungsparameter zusammenpassen. Diese Demo enthält keinen verifizierten Download, keine Serveradresse und kein Geräteprofil. Notiere Betriebssystem und Version sowie den Schritt, an dem du nicht weiterkommst, und verwende für konkrete Einstellungen die freigegebene Anleitung des zuständigen Dienstes. Teile keine Passwörter oder MFA-Codes.'
        : kind === 'service'
          ? 'Ein VPN kann den Zugriff auf Ressourcen in einem anderen Netz ermöglichen. Eine erfolgreiche Anmeldung beweist noch nicht, dass jede Ressource freigegeben oder erreichbar ist. Diese Demo nennt keine echten VPN-Adressen, Geräteprofile oder Zugriffsrechte. Unterscheide bei der Fehlersuche zwischen fehlender Internetverbindung, gescheitertem VPN-Aufbau und einer einzelnen nicht erreichbaren Ressource. Notiere dabei Betriebssystem, Client-Version und die genaue Fehlermeldung, ohne Passwörter oder MFA-Codes weiterzugeben.'
          : 'Prüfe zuerst, ob gewöhnliche Internetseiten ohne VPN erreichbar sind. Notiere den genauen Wortlaut der Fehlermeldung samt Fehlercode, das Betriebssystem sowie Name und Version des VPN-Clients. Halte fest, ob der VPN-Verbindungsaufbau selbst fehlschlägt oder ob die Anmeldung beziehungsweise Verbindung gelingt, aber eine benötigte Ressource nicht erreichbar ist. Teile keine Passwörter oder MFA-Codes.';
  return {
    revision: 2,
    text: `${SYNTHETIC_DEMO_NOTICE} ${guidance} Diese allgemeinen Hinweise sind keine institutionelle Anleitung.`,
  };
}
