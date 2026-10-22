"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import type { ActionPreview } from "@/lib/action-preview";
import type { ChatProposal } from "@/lib/chat-sessions";
import { forwardProposalStatus, proposalPresentation, readProposalSnapshot, sameProposalDetails } from "@/lib/proposal-presentation";

export function ActionPreviewDetails({ preview, status = "pending" }: { preview?: ActionPreview | undefined; status?: ChatProposal["status"] }) {
  if (!preview) return null;
  return <div className="action-preview-details">
    <p><strong>{preview.instance}</strong> · {preview.account}</p>
    {status === "pending" && <>
      <p>{preview.effect}</p>
      <ul>{preview.consequences.map((text, index) => <li key={index}>{text}</li>)}</ul>
    </>}
    <small>{preview.costs}</small>
  </div>;
}

/** Explicit read/reconciliation. Rendering an old transcript never executes a tool. */
export function ActionStatusControl({ proposal, disabled, onStatusChange }: {
  proposal: ChatProposal; disabled: boolean; onStatusChange: (status: ChatProposal["status"]) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  async function check() {
    if (checking || disabled) return;
    const controller = new AbortController();
    pending.current = controller;
    setChecking(true);
    try {
      const reconcile = proposal.status === "outcome_unknown" || proposal.status === "executing";
      const response = await apiRequest<unknown>(`/api/proposals/${encodeURIComponent(proposal.id)}${reconcile ? "/reconcile" : ""}`,
        { signal: controller.signal, ...(reconcile ? { method: "POST", body: "{}" } : {}) });
      if (controller.signal.aborted) return;
      const current = readProposalSnapshot(response, proposal);
      if (!current || !sameProposalDetails(proposal, current) || (!(proposal.status === "pending" && current.status === "invalidated") && !forwardProposalStatus(proposal.status, current.status))) {
        throw new Error("Der Beleg stimmt nicht mit der angezeigten Aktion überein. Bitte lade den aktuellen Stand neu.");
      }
      setMessage(proposalPresentation(current).summary);
      onStatusChange(current.status);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Der Status konnte nicht geprüft werden.");
    } finally { if (!controller.signal.aborted) setChecking(false); }
  }
  if (proposal.status === "invalidated") return null;
  return <div className="action-status-control">
    <button className="chat-card-action" type="button" disabled={disabled || checking} onClick={() => { void check(); }}>{checking ? "Status wird geprüft …" : "Aktionsstatus prüfen"}</button>
    {message && <p role="status">{message}</p>}
  </div>;
}
