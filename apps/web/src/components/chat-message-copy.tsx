"use client";

import { Check, Code2, Copy, Eye } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "@/lib/chat-sessions";
import type { KnowledgeCitation } from "@/lib/knowledge-citations";
import { chatMessageCopyText, chatMessageMarkdownSource } from "@/lib/chat-message-copy";
import styles from "./chat-message-copy.module.css";

type CopyStatus = "idle" | "copying" | "copied" | "failed";

export function ChatMessageCopy({ message, citations }: { message: ChatMessage; citations?: readonly KnowledgeCitation[] }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [feedback, setFeedback] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 240, maxHeight: 320 });
  const id = useId().replaceAll(":", "");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceTextarea = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  const source = chatMessageMarkdownSource(message);

  const positionMenu = useCallback(() => {
    if (!trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const width = Math.min(240, viewportWidth - 24);
    const bottom = top + viewportHeight;
    const menuHeight = 158;
    const menuTop = Math.max(top + 12, bounds.bottom + menuHeight < bottom - 12 ? bounds.bottom + 6 : bounds.top - menuHeight - 6);
    setPosition({
      width,
      left: Math.max(left + 12, Math.min(bounds.right - width, left + viewportWidth - width - 12)),
      top: menuTop,
      maxHeight: Math.max(44, bottom - menuTop - 12),
    });
  }, []);

  useEffect(() => {
    if (status !== "copied" && status !== "failed") return;
    const timeout = window.setTimeout(() => { setStatus("idle"); setFeedback(""); }, status === "failed" ? 4000 : 2200);
    return () => { window.clearTimeout(timeout); };
  }, [status]);

  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener("resize", positionMenu);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", positionMenu);
    return () => { window.removeEventListener("resize", positionMenu); viewport?.removeEventListener("resize", positionMenu); };
  }, [menuOpen, positionMenu]);

  useEffect(() => {
    if (!sourceOpen) return;
    const dialog = sourceDialog.current;
    if (dialog && !dialog.open) dialog.showModal();
    sourceTextarea.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, [sourceOpen]);

  async function copy(text: string, confirmation: string) {
    setStatus("copying");
    setFeedback("");
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(confirmation);
      setStatus("copied");
    } catch {
      setFeedback("Kopieren fehlgeschlagen. Bitte erneut versuchen.");
      setStatus("failed");
    }
  }

  function hideMenu(restore = false) {
    restoreFocus.current = restore;
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    else {
      setMenuOpen(false);
      if (restore) trigger.current?.focus();
      restoreFocus.current = false;
    }
  }

  function showMenu() {
    if (!trigger.current || !menu.current) return;
    if (menu.current.matches(":popover-open")) { hideMenu(true); return; }

    positionMenu();
    menu.current.showPopover();
  }

  function closeSource() {
    sourceDialog.current?.close();
  }

  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[index]?.focus();
  }

  const copied = status === "copied";
  const inlineFeedback = feedback && !sourceOpen ? feedback : "";

  return <div className={`chat-message-copy-wrap ${styles.wrap ?? ""}`}>
    <button ref={trigger} className="chat-message-copy" type="button" aria-label="Kopieroptionen anzeigen" title={inlineFeedback || "Kopieroptionen anzeigen"} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`${id}-menu`} disabled={status === "copying"} onClick={showMenu} data-copied={copied || undefined}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
    <span className={inlineFeedback ? "chat-copy-feedback" : "sr-only"} role="status">{inlineFeedback}</span>

    <div ref={menu} id={`${id}-menu`} popover="auto" className={styles.menu} role="menu" aria-label="Kopieroptionen" style={position} onToggle={event => {
      const open = event.newState === "open";
      setMenuOpen(open);
      if (!open && restoreFocus.current) { trigger.current?.focus(); restoreFocus.current = false; }
    }} onKeyDown={menuKey} onBlur={event => {
      const next = event.relatedTarget as Node | null;
      if (next && !event.currentTarget.contains(next)) hideMenu();
    }}>
      <button type="button" role="menuitem" tabIndex={-1} disabled={status === "copying"} onClick={() => { hideMenu(true); void copy(chatMessageCopyText(message, window.location.origin, citations), "Nachricht kopiert"); }}><Copy size={16} aria-hidden="true" /><span>Nachricht und Ergebnisse kopieren</span></button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={status === "copying"} onClick={() => { hideMenu(true); void copy(source, "Markdown kopiert"); }}><Code2 size={16} aria-hidden="true" /><span>Markdown kopieren</span></button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { hideMenu(); setSourceOpen(true); }}><Eye size={16} aria-hidden="true" /><span>Quelltext anzeigen</span></button>
    </div>

    <dialog ref={sourceDialog} className={styles.sourceDialog} aria-labelledby={`${id}-source-title`} aria-describedby={`${id}-source-description`} onClose={() => {
      setSourceOpen(false);
      trigger.current?.focus();
    }} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeSource();
    }}>
      <h2 id={`${id}-source-title`}>Markdown-Quelltext</h2>
      <p id={`${id}-source-description`}>Der unveränderte Markdown-Text dieser Nachricht.</p>
      <label className="sr-only" htmlFor={`${id}-source`}>Markdown-Quelltext</label>
      <textarea ref={sourceTextarea} id={`${id}-source`} className={styles.sourceText} value={source} readOnly spellCheck={false} rows={14} />
      <p className={styles.dialogFeedback} role="status">{feedback}</p>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.primaryButton} disabled={status === "copying"} onClick={() => { void copy(source, "Markdown kopiert"); }}>Markdown kopieren</button>
        <button type="button" onClick={closeSource}>Schließen</button>
      </div>
    </dialog>
  </div>;
}
