export function PublicDemoNotice() {
  if (process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO !== "1") return null;

  return (
    <aside className="public-demo-notice" role="note">
      <strong>Öffentlicher Prototyp.</strong>{" "}
      Chat über GroqCloud. Anmeldung und Wissensdokumente sind fiktiv. Raumkatalog: HsH-Snapshot; Verfügbarkeit und Buchungen: Simulation. Dein Testbereich wird serverseitig gespeichert. Keine Live-Verbindung zu HsH.
      {" "}<a href="https://github.com/metaneutrons/HASI" target="_blank" rel="noreferrer">Quellcode · GPLv3</a>
    </aside>
  );
}
