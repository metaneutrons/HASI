/** Canonical retained result when no server-verifiable result context exists. */
export function omittedToolHistoryContent(): string {
  return JSON.stringify({
    historyDetailsOmitted: true,
    requiresFreshRead: true,
    notice: "Frühere Tool-Daten sind nicht verifiziert. Verwende aktuelle Werkzeugabfragen; die Oberfläche zeigt separate Ergebniskarten.",
  });
}
