"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api";

export function PluginAccountConsent({ installationId, state }: { installationId: string; state: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function approve() {
    setBusy(true);
    try {
      const result = await postJson<{ returnTo?: unknown }>(`/api/plugin-accounts/${encodeURIComponent(installationId)}/consent`, { state, approved: true });
      const destination = result.returnTo;
      if (destination !== "/" && destination !== "/admin" && destination !== "/bookings" && destination !== "/account/connections") throw new Error("Ungültige Rückkehradresse.");
      // Match the real provider callback: discard the pre-consent in-memory
      // authority before mounting any actionable chat cards again.
      window.location.assign(destination);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Die Testverbindung konnte nicht hergestellt werden."); setBusy(false); }
  }
  return <section className="page-content"><p className="eyebrow">Testumgebung</p><h1>Dienst verbinden</h1><p>Du verbindest dein ausgewähltes Testkonto mit dem simulierten Dienst. HASI darf damit freigegebene Daten lesen und Aktionen nach deiner gesonderten Bestätigung ausführen.</p><p>Es werden keine Hochschul-Zugangsdaten abgefragt. Du kannst die Verbindung unter „Verbundene Dienste“ erneuern oder trennen.</p><div className="action-consent-controls"><button className="button button--primary" type="button" disabled={busy} onClick={() => { void approve(); }}>{busy ? "Wird verbunden …" : "Testkonto verbinden"}</button><button className="button" type="button" disabled={busy} onClick={() => { router.push("/account/connections"); }}>Abbrechen</button></div>{error && <p role="alert">{error}</p>}</section>;
}
