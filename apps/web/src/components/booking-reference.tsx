"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Technical references are available for support without crowding the overview. */
export function BookingReference({ reference }: { reference: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  async function copy() {
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(reference);
      setStatus("copied");
    } catch { setStatus("failed"); }
  }
  return <details className="booking-reference">
    <summary>Details</summary>
    <div className="booking-reference-body">
      <span>Referenz für Rückfragen</span>
      <code>{reference}</code>
      <button className="chat-card-action" type="button" disabled={status === "copying"} onClick={() => { void copy(); }} aria-label="Buchungsreferenz kopieren">
        {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {status === "copying" ? "Wird kopiert …" : status === "copied" ? "Kopiert" : "Referenz kopieren"}
      </button>
      <span role="status">{status === "copied" ? "Buchungsreferenz kopiert." : status === "failed" ? "Kopieren fehlgeschlagen. Du kannst die Referenz oben markieren und kopieren." : ""}</span>
    </div>
  </details>;
}
