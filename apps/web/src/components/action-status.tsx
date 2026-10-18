"use client";

import { useState } from "react";
import { postJson } from "@/lib/api";
import type { ActionPreview } from "@/lib/action-preview";

export function ActionPreviewDetails({ preview }: { preview?: ActionPreview | undefined }) {
  if (!preview) return null;
  return <div className="action-preview-details">
    <p><strong>{preview.instance}</strong> · {preview.account}</p>
    <p>{preview.effect}</p>
    <ul>{preview.consequences.map((text, index) => <li key={index}>{text}</li>)}</ul>
    <small>{preview.costs}</small>
  </div>;
}

/** Explicit read/reconciliation. Rendering an old transcript never executes a tool. */
export function ActionStatusControl({ proposalId, disabled }: { proposalId: string; disabled: boolean }) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  async function check() {
    if (checking || disabled) return;
    setChecking(true);
    try {
      const response = await postJson<{ proposal?: { id?: unknown; status?: unknown } }>(`/api/proposals/${encodeURIComponent(proposalId)}/reconcile`, {});
      const status = response.proposal?.id === proposalId ? response.proposal.status : undefined;
      setMessage(status === "confirmed" ? "Der Dienst bestätigt: Die Aktion wurde ausgeführt." : status === "failed" ? "Der Dienst bestätigt: Die Aktion wurde nicht ausgeführt." : "Der Ausgang bleibt unklar. Die Aktion wurde nicht erneut ausgeführt. Bitte den zuständigen Dienst prüfen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Der Status konnte nicht geprüft werden.");
    } finally { setChecking(false); }
  }
  return <div className="action-status-control">
    <button className="chat-card-action" type="button" disabled={disabled || checking} onClick={() => { void check(); }}>{checking ? "Status wird geprüft …" : "Aktionsstatus prüfen"}</button>
    {message && <p role="status">{message}</p>}
  </div>;
}
