"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/chat-sessions";
import { chatMessageCopyText } from "@/lib/chat-message-copy";

export function ChatMessageCopy({ message }: { message: ChatMessage }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status !== "copied") return;
    const timeout = window.setTimeout(() => { setStatus("idle"); }, 2000);
    return () => { window.clearTimeout(timeout); };
  }, [status]);

  async function copy() {
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(chatMessageCopyText(message, window.location.origin));
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  const feedback = status === "copied" ? "Kopiert" : status === "failed" ? "Kopieren fehlgeschlagen. Bitte erneut versuchen." : "";
  return <span className="chat-message-copy-wrap">
    <button className="chat-message-copy" type="button" aria-label="Nachricht kopieren" title={feedback || "Nachricht kopieren"} disabled={status === "copying"} onClick={() => void copy()} data-copied={status === "copied" || undefined}>
      {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
    <span className={feedback ? "chat-copy-feedback" : "sr-only"} role="status">{feedback}</span>
  </span>;
}
