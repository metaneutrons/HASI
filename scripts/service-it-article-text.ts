import { syntheticVpnGuidance } from './synthetic-vpn-guidance.js';

export type ServiceItArticleKind = 'faq' | 'service' | 'news' | 'link' | 'form';

/** Presentation prose is separate from the corpus's host-owned classification. */
export function serviceItArticleTitle(title: string, id?: string): string {
  const newsTitles: Readonly<Record<string, string>> = {
    'svc-catalog-55953427c0b0': 'Aktualisierung im Campusmanagement',
    'svc-catalog-cdf80b6fe76d': 'Wartungsfenster des Accountmanagers',
    'svc-catalog-2f647e9c9c35': 'SMS-Authentifizierung prüfen',
    'svc-catalog-bd4e2865f730': 'Hinweis zum Campusmanagement-Portal',
    'svc-catalog-ff9be118ad96': 'Validierungsautomat am Standort Nord',
    'svc-catalog-50c8209b02e2': 'Zertifikate prüfen',
    'svc-catalog-e8dfc6608f60': 'Wartungsfenster im Intranet',
    'svc-catalog-7425448efaa3': 'SSO-Anmeldung prüfen',
    'svc-catalog-1948578f1f04': 'Druckerverwaltungsgeräte prüfen',
    'svc-catalog-8c8430ac1412': 'Wartungsfenster des Ticketsystems',
    'svc-catalog-f597c7a72cd1': 'Wartungsfenster der Lernplattform',
  };
  const newsTitle = id ? newsTitles[id] : undefined;
  return newsTitle ? `Meldung: ${newsTitle}` : title.replace(/^Demo-/u, '').replace(/^Demo:\s*/u, '').replaceAll('Demo-Institution', 'Hochschule');
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('de-DE').replace(/[-_]/gu, ' ');
}

export function serviceItArticleText(group: string, title: string, kind: ServiceItArticleKind, id: string): string {
  const topic = fold(`${group} ${title}`);
  const ref = id.slice(-6).toUpperCase();
  const subject = serviceItArticleTitle(title, id).replace(/^(?:FAQ|Service|Meldung|Link|Formular):\s*/u, '');
  if (kind === 'news') {
    const day = (Number.parseInt(id.slice(-2), 16) % 28) + 1;
    const hour = 8 + (Number.parseInt(id.slice(-3, -1), 16) % 9);
    return `Hinweis ${ref}: ${subject}. Für den Standort Nord ist am ${String(day).padStart(2, '0')}. November 2026 ein Zeitfenster von ${String(hour).padStart(2, '0')}:00 bis ${String(hour).padStart(2, '0')}:20 Uhr vermerkt. Prüfe den veröffentlichten Status, die betroffene Funktion und den nächsten Prüfzeitpunkt. Gib bei einer Rückfrage die Referenz ${ref} an.`;
  }
  if (kind === 'form') {
    if (/postfach|verteiler|mail/u.test(topic)) return `Erfasse die gewünschte Postfach- oder Verteilerberechtigung, die vorgesehene Rolle, den Zweck und die Laufzeit. Prüfe vor dem Absenden die Vorschau und beschränke den Mitgliederkreis auf die benötigten Personen. Passwörter und Wiederherstellungscodes gehören nicht in das Formular. Ein gespeicherter Entwurf ist noch kein übermittelter Antrag.`;
    if (/microsoft|gruppe|365/u.test(topic)) return `Gib den Namen der Arbeitsgruppe, den Zweck und die benötigte Funktion an. Lege fest, wer Mitglied werden und wer die Gruppe verwalten soll. Prüfe den Mitgliederkreis und die Rolle jeder Person in der Vorschau. Ein gespeicherter Entwurf ist noch kein übermittelter Antrag.`;
    return `Erfasse den Projektnamen, den vorgesehenen Inhalt und die zuständige Person. Prüfe die Pflichtfelder und die Vorschau, bevor du den Antrag absendest. Zugangsdaten gehören nicht in Freitextfelder. Ein gespeicherter Entwurf ist noch kein übermittelter Antrag.`;
  }
  if (kind === 'link') {
    if (/cloud|collaboard|rocket|speicher/u.test(topic)) return `Der Einstieg für ${subject} ist unter https://cloud.campus.invalid erreichbar. Wähle den passenden Arbeitsbereich und prüfe vor einer Freigabe den Empfängerkreis sowie die Lese- und Bearbeitungsrechte. Freigaben für einen Ordner können auch Unterordner betreffen.`;
    if (/account|anmeldung|konto/u.test(topic)) return `Öffne https://konto.campus.invalid und prüfe die angezeigte Kennung sowie den Kontostatus. Nutze nur die für dein Konto freigegebene Anmeldemethode. Teile weder dein Passwort noch einen zweiten Faktor in Nachrichten oder Supportformularen.`;
    if (/mail|postfach|verteiler/u.test(topic)) return `Öffne https://mail.campus.invalid und wähle das benötigte Postfach. Prüfe vor Änderungen den Postfachnamen und deine Berechtigungen. Kontrolliere bei einer Zustellungsstörung Absender, Empfänger, Zeitpunkt und Fehlermeldung; gib keine Zugangsdaten weiter.`;
    return `Der Katalog unter https://katalog.campus.invalid führt die Einträge zu ${subject}. Vergleiche vor dem Öffnen den Namen des Dienstes und die vollständige Zieladresse. Prüfe im ausgewählten Eintrag die Voraussetzungen und den Zugangsweg.`;
  }
  const vpn = syntheticVpnGuidance(group, title, kind);
  if (vpn) return vpn.text;
  if (/academic.?cloud|academic cloud/u.test(topic)) {
    if (/softwarecenter|install/u.test(topic)) return `Öffne das Softwarecenter unter https://apps.campus.invalid und wähle die Cloud-Anwendung. Prüfe Betriebssystem, angebotene Version und Installationsumfang. Speichere offene Arbeiten, bevor du eine Installation beginnst. Die Anzeige eines Produkts allein bestätigt noch keine Lizenzberechtigung.`;
    if (/freigabe|teile|datei|ordner/u.test(topic)) return `Wähle den gewünschten Ordner in der Academic Cloud und öffne die Freigabeeinstellungen. Lege fest, ob Empfänger nur lesen oder auch bearbeiten dürfen. Prüfe den Umfang einschließlich Unterordnern und entferne nicht mehr benötigte Freigabelinks.`;
    if (/mobil|smartphone|handy/u.test(topic)) return `Öffne auf dem Mobilgerät die für die Academic Cloud freigegebene Anwendung und melde dich mit der vorgesehenen Kontomethode an. Prüfe, ob der richtige Arbeitsbereich angezeigt wird und welche Datei- und Chatfunktionen verfügbar sind. Übernimm kein Geräteprofil aus einer unbekannten Quelle.`;
    return `Die Academic Cloud bietet die Bereiche Dateien, Chat und Zusammenarbeit. Öffne https://cloud.campus.invalid, wähle deinen Arbeitsbereich und kontrolliere die angezeigte Rolle. Prüfe vor einer Freigabe die Empfänger und Berechtigungen; ein sichtbarer Arbeitsbereich begründet keine Berechtigung für alle darin verknüpften Inhalte.`;
  }
  if (topic.includes('wagtail')) return `Öffne die Redaktion unter https://cms.campus.invalid und lege einen Entwurf an. Prüfe Titel, Sprache, Seitenvorschau und Beschreibungen verwendeter Medien. Kontrolliere die vorgesehene Veröffentlichungsstelle und veröffentliche erst nach der erforderlichen Freigabe. Speichern und Veröffentlichen sind getrennte Schritte.`;
  if (/sicherheitsinformationen|sicherheitsinformation/u.test(topic) && /azure|microsoft|konto/u.test(topic)) return `Öffne die Sicherheitsinformationen deines Kontos und prüfe die hinterlegten Anmeldemethoden. Wähle eine für dein Konto freigegebene Methode und prüfe anschließend die Bestätigung der Einrichtung. Bewahre Wiederherstellungscodes getrennt vom Anmeldegerät auf. Teile keine Passwörter, MFA-Codes oder Wiederherstellungscodes.`;
  if (/passwort|password/u.test(topic) && /zuruck|andere|anderung|ersten zugriff/u.test(topic)) return `Öffne die Kontoverwaltung des betroffenen Dienstes und wähle die Funktion zum Ändern oder Zurücksetzen des Passworts. Prüfe die angezeigte Kontokennung und verwende den für dieses Konto freigegebenen Wiederherstellungsweg. Notiere bei einem Fehler den betroffenen Schritt und die Meldung. Gib weder dein Passwort noch MFA- oder Wiederherstellungscodes in Supportnachrichten an.`;
  if (/multi faktor|mfa|passkey|yubikey|authenticator|totp|keepass/u.test(topic)) return `Wähle in den Kontoeinstellungen die für dein Konto zugelassene Methode des zweiten Faktors. Folge der zugehörigen Einrichtungsanleitung und prüfe die Bestätigung, bevor du eine bisherige Methode entfernst. Bewahre Wiederherstellungscodes getrennt vom Anmeldegerät auf. Teile keine Passwörter, MFA-Codes oder Wiederherstellungscodes mit anderen Personen.`;
  if (/kurzurl|shorturl|domain/u.test(topic)) return `Prüfe im URL-Verzeichnis die vollständige Zieladresse und die bestehende Zuordnung. Öffne zunächst die Vorschau und kontrolliere, ob die gewünschte Seite erreicht wird. Die Einträge short.campus.invalid und ziel.campus.invalid dienen als Adressen im Katalog. Speichere eine geänderte Zuordnung erst nach Prüfung des Ziels.`;
  if (/gast|gaste|guest|einladen/u.test(topic)) return `Erfasse im Gästezugang den Anlass, die benötigte Laufzeit und die vorgesehene Rolle. Vergib nur die erforderlichen Rechte und kontrolliere die Vorschau vor einer Einladung. Widerrufe einen Zugang, wenn er nicht mehr benötigt wird. Eine Einladung bestätigt noch keinen Zugriff auf interne Anwendungen.`;
  if (topic.includes('campuscard')) {
    return /verlust|gesperrt|bezahlfunktion/u.test(topic)
      ? `Sperre eine verlorene CampusCard über die Kartenverwaltung und notiere den Zeitpunkt. Prüfe die Bestätigung der Sperre. Eine Ersatzkarte wird in einem separaten Vorgang beantragt; eine Sperre allein stellt keine neue Karte aus und überträgt kein Guthaben.`
      : `Öffne das Kartenprofil und wähle die benötigte Funktion. Kontrolliere den Kartenstatus vor Ausgabe, Aufladung oder Validierung. Bibliotheks- und Zutrittsfunktionen können eigene Voraussetzungen haben; eine aktive Karte bestätigt nicht automatisch jede einzelne Berechtigung.`;
  }
  if (/campusmanagement|prufung/u.test(topic)) return `Wähle im Campusmanagement das richtige Semester und das gewünschte Modul. Prüfe Kurskennung, Termin und Anmeldestatus in der Vorschau. Ein gespeicherter Entwurf ist noch keine bestätigte Anmeldung; maßgeblich ist die anschließend angezeigte Bestätigung.`;
  if (/wlan|netzwerk/u.test(topic)) return `Prüfe, ob der Flugmodus ausgeschaltet ist und die Gerätezeit stimmt. Vergleiche den Namen des gespeicherten WLAN-Profils mit dem gewünschten Netz. Entferne bei einem fehlerhaften Profil nur den betreffenden Eintrag und richte ihn nach der freigegebenen Anleitung erneut ein. Vergleiche bei einer Störung das Verhalten an einem zweiten Gerät und notiere Ort, Zeitpunkt und Fehlermeldung ohne Zugangsdaten.`;
  if (/netzlaufwerk|fileservice/u.test(topic)) return `Prüfe den vollständigen Laufwerkspfad und deine Berechtigung für den gewünschten Ordner. Bei einem Kontingent von 250 MB und einem angezeigten Verbrauch von 230 MB stehen noch 20 MB zur Verfügung. Prüfe große Dateien und den Papierkorb; sichere benötigte Inhalte vor Änderungen. Verschiebe oder lösche keine Unterlagen, deren Aufbewahrung noch ungeklärt ist.`;
  if (/sicherheit|security|phishing|kompromittiert/u.test(topic)) return `Öffne bei einer verdächtigen Nachricht keine unerwarteten Anhänge und folge keinem darin verlangten Anmeldeweg. Prüfe Absenderanzeige, Zieladresse und verlangte Handlung. Halte Zeitpunkt und beobachtete Merkmale fest und verwende den vorgesehenen Meldeweg. Passwörter, MFA-Codes und vertrauliche Dateien gehören nicht in eine freie Fehlerbeschreibung.`;
  if (topic.includes('rss')) return `Trage die Feed-Adresse https://feed.campus.invalid/rss.xml in den Feed-Reader ein. Prüfe Titel und Aktualisierungsstatus und kontrolliere, ob neue Beiträge angezeigt werden. Entferne ein nicht mehr benötigtes Abonnement im Reader.`;
  if (/mail|postfach|outlook|thunderbird/u.test(topic)) return `Prüfe den Namen des betroffenen Postfachs, die Verbindung und die genaue Fehlermeldung. Vergleiche bei Bedarf die Anzeige im Webmail unter https://mail.campus.invalid mit der Anzeige im verwendeten Mailprogramm. Ändere Einstellungen einzeln und kontrolliere das Ergebnis. Leite keine Nachrichten ungeprüft weiter und teile keine Zugangsdaten.`;
  if (/telefon|voice over ip|voip/u.test(topic)) return `Prüfe im Telefonie-Client das ausgewählte Mikrofon, den Lautsprecher und den Präsenzstatus. Vergleiche bei einer Störung die Geräteauswahl und die Anzeige der Verbindung. Notiere Zeitpunkt und Fehlermeldung; private Rufnummern gehören nicht in eine allgemeine Fehlerbeschreibung.`;
  if (/microsoft|teams|office|onedrive|azure/u.test(topic)) return `Prüfe zuerst die angezeigte Kontokennung und öffne den gewünschten Funktionsbereich. Kontrolliere bei Dateien, Gruppen oder Besprechungen die vorgesehene Rolle und den Empfängerkreis. Eine erfolgreiche Anmeldung allein bestätigt weder eine Produktlizenz noch die Berechtigung für jede Funktion.`;
  if (/druck|kopier|scann/u.test(topic)) return `Wähle die benötigte Druckwarteschlange und kontrolliere Format, Seitenzahl und Farbe in der Vorschau. Prüfe nach dem Senden den Auftragsstatus, bevor du denselben Auftrag erneut übermittelst. Entferne einen nicht mehr benötigten Auftrag aus der Warteschlange.`;
  if (/webhosting|webspace|datenbank/u.test(topic)) return `Öffne die Verwaltung unter https://webspace.campus.invalid und prüfe den gewählten Webspace. Das Speicherlimit beträgt 512 MB; Sicherungskopien werden 30 Tage aufbewahrt. Sichere den bisherigen Stand, bevor du eine Seite änderst, und kontrolliere das Ergebnis zuerst in der Vorschau. Zugangsdaten gehören nicht in veröffentlichte Dateien.`;
  if (/software|adobe|matlab|zoom|citavi|lizenz/u.test(topic)) return `Öffne den Softwarekatalog und prüfe Produktname, angebotene Version, Betriebssystem und Bezugsberechtigung. Verwende den im Katalog angegebenen Installationsweg. Eine Produktbeschreibung allein bestätigt weder eine Lizenz noch einen Rabatt; bei einer Fehlermeldung werden Betriebssystem, Programmversion und Fehlercode benötigt.`;
  if (/dienstausweis|badge/u.test(topic)) return `Prüfe im Ausweisprofil die benötigte Funktion und den aktuellen Status. Ausgabe, Zutritt und weitere Berechtigungen können getrennte Voraussetzungen haben. Notiere für eine Anfrage die gewünschte Funktion und die Fehlermeldung, ohne persönliche Ausweiskennungen in allgemeine Nachrichten aufzunehmen.`;
  return `Öffne den Eintrag zu „${subject}“ im Serviceportal unter https://portal.campus.invalid. Prüfe die Voraussetzungen, die angezeigte Kontokennung und die vorgesehene Rolle. Führe den beschriebenen Schritt aus und kontrolliere die Rückmeldung. Bei einer Störung werden der betroffene Schritt und der genaue Wortlaut der Fehlermeldung benötigt; teile keine Zugangsdaten.`;
}
