export function PublicDemoNotice() {
  if (process.env.NEXT_PUBLIC_HASI_PUBLIC_DEMO !== "1") return null;

  return (
    <aside className="public-demo-notice" role="note">
      <strong>Öffentlicher Prototyp.</strong>{" "}
      Chat über GroqCloud. anny nutzt Testdaten; Buchungen und Einstellungen bleiben in diesem Browser. Keine Verbindung zu HsH oder zum echten anny-System.
      {" "}<a href="https://github.com/metaneutrons/HASI" target="_blank" rel="noreferrer">Quellcode · GPLv3</a>
    </aside>
  );
}
