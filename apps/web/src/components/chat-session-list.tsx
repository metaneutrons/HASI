"use client";

import { MoreHorizontal, Pencil, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { MAX_CHAT_SESSIONS } from "@/lib/chat-sessions";
import { canStartNewChat, type ChatWorkspaceStore } from "@/lib/chat-workspace-store";

type View = ReturnType<ChatWorkspaceStore["getSnapshot"]>;
interface Editor { id: string; mode: "rename" | "delete" }

export function ChatSessionList({ view, store, close, onOpenChat, variant = "drawer" }: { view: View; store: ChatWorkspaceStore; close?: () => void; onOpenChat?: () => void; variant?: "drawer" | "embedded" }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [title, setTitle] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 208 });
  const list = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusLast = useRef(false);
  const idPrefix = useId().replaceAll(":", "");
  const sessions = [...view.workspace.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const menuSession = sessions.find(session => session.id === menuFor);
  const editedSession = sessions.find(session => session.id === editor?.id);
  const embedded = variant === "embedded";
  const canStart = canStartNewChat(view);

  function restoreFocus() {
    if (trigger.current?.isConnected) trigger.current.focus();
    else list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
  }

  function hideMenu(focus = false) {
    menu.current?.hidePopover();
    if (focus) restoreFocus();
  }

  function showMenu(button: HTMLButtonElement, sessionId: string, last = false) {
    if (menuOpen && menuFor === sessionId) { hideMenu(true); return; }
    trigger.current = button;
    focusLast.current = last;
    const bounds = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = Math.min(208, (viewport?.width ?? window.innerWidth) - 24);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    setPosition({ width, left: Math.max(left + 12, Math.min(bounds.right - width, left + (viewport?.width ?? window.innerWidth) - width - 12)), top: Math.max(top + 12, bounds.bottom + 112 < bottom - 12 ? bounds.bottom + 6 : bounds.top - 112) });
    setMenuFor(sessionId);
    menu.current?.showPopover();
  }

  useEffect(() => {
    if (!menuOpen) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    const dismiss = () => menu.current?.hidePopover();
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", dismiss, true); };
  }, [menuOpen, menuFor]);

  useEffect(() => {
    if (!editor) return;
    dialog.current?.showModal();
    if (editor.mode === "rename") { titleInput.current?.focus(); titleInput.current?.select(); }
    else cancelDelete.current?.focus();
  }, [editor]);

  function edit(mode: Editor["mode"]) {
    if (!menuSession || (mode === "delete" && view.busy[menuSession.id])) return;
    hideMenu();
    setTitle(menuSession.title);
    setEditor({ id: menuSession.id, mode });
  }

  function rename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !title.trim()) return;
    store.rename(editor.id, title);
    dialog.current?.close();
  }

  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideMenu(true); return; }
    if (event.key === "Tab") { hideMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[index]?.focus();
  }

  return <div ref={list} className={`chat-session-list${embedded ? " chat-session-list--embedded" : " chat-session-list--drawer"}`}>
    {embedded ? <h2 className="sr-only" id={`${idPrefix}-heading`}>Chats</h2> : <div className="chat-list-heading">
      <h2 id={`${idPrefix}-heading`}>Chats {sessions.length > 1 && <small className="chat-count-badge" aria-label={`${String(sessions.length)} Chats`}>{sessions.length}</small>}</h2>
      {close && <button className="icon-button" type="button" aria-label="Unterhaltungen schließen" onClick={close}><X size={20} aria-hidden="true" /></button>}
    </div>}
    <button className="chat-list-create" type="button" aria-label={!canStart && sessions.length >= MAX_CHAT_SESSIONS ? `Neuer Chat. Maximal ${String(MAX_CHAT_SESSIONS)} Chats.` : "Neuer Chat"} disabled={!canStart} title={canStart ? undefined : "Dieser Chat ist noch leer oder das Chatlimit ist erreicht."} onClick={() => { store.create(); close?.(); onOpenChat?.(); }}><SquarePen size={17} strokeWidth={1.8} aria-hidden="true" /><span>Neuer Chat</span></button>
    <div className="chat-session-items" role="list" aria-labelledby={`${idPrefix}-heading`}>
      {sessions.map(session => {
        const active = session.id === view.workspace.activeId;
        const busy = Boolean(view.busy[session.id]);
        const lastMessage = session.snapshot.messages.at(-1)?.text;
        const inputPreview = session.snapshot.input.trim();
        const preview = lastMessage !== undefined && lastMessage !== "" ? lastMessage : inputPreview !== "" ? inputPreview : "Stelle deine erste Frage";
        return <div className={`chat-session-row${active ? " is-active" : ""}`} key={session.id} role="listitem">
          <button type="button" className="chat-session-select" aria-current={active ? "true" : undefined} aria-label={`${session.title} öffnen`} onClick={() => { store.select(session.id); close?.(); onOpenChat?.(); }}>
            <span className="chat-session-copy"><strong>{session.title}</strong><span>{busy ? "HASI antwortet …" : preview}</span></span>
          </button>
          <button type="button" className="icon-button chat-session-menu" aria-label={`Aktionen für ${session.title}`} aria-haspopup="menu" aria-expanded={menuOpen && menuFor === session.id} aria-controls={`${idPrefix}-actions`} onClick={event => { showMenu(event.currentTarget, session.id); }} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); showMenu(event.currentTarget, session.id, event.key === "ArrowUp"); } }}><MoreHorizontal size={17} aria-hidden="true" /></button>
        </div>;
      })}
    </div>
    <div ref={menu} popover="auto" className="chat-actions-popover" id={`${idPrefix}-actions`} role="menu" aria-label={`Aktionen für ${menuSession?.title ?? "Chat"}`} style={position} onToggle={event => { setMenuOpen(event.newState === "open"); }} onKeyDown={menuKey}>
      <button type="button" role="menuitem" tabIndex={-1} disabled={!menuSession} onClick={() => { edit("rename"); }}><Pencil size={16} aria-hidden="true" /><span>Umbenennen</span></button>
      <div role="separator" />
      <button type="button" role="menuitem" tabIndex={-1} className="is-destructive" disabled={!menuSession || Boolean(view.busy[menuSession.id])} onClick={() => { edit("delete"); }}><Trash2 size={16} aria-hidden="true" /><span>Löschen …</span></button>
    </div>
    <dialog ref={dialog} className="chat-session-dialog" aria-labelledby={`${idPrefix}-editor-title`} aria-describedby={`${idPrefix}-editor-description`} onClose={() => { setEditor(null); restoreFocus(); }} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close(); }}>
      <div className={`chat-dialog-symbol${editor?.mode === "delete" ? " is-destructive" : ""}`} aria-hidden="true">{editor?.mode === "delete" ? <Trash2 size={22} /> : <Pencil size={22} />}</div>
      <h2 id={`${idPrefix}-editor-title`}>{editor?.mode === "delete" ? "Chat löschen?" : "Chat umbenennen"}</h2>
      <p id={`${idPrefix}-editor-description`}>{editor?.mode === "delete" ? <>„{editedSession?.title}“ und der Verlauf werden aus diesem Browser entfernt. Buchungen bleiben erhalten.</> : "Wähle einen kurzen, passenden Namen für diese Unterhaltung."}</p>
      {editor?.mode === "rename" ? <form onSubmit={rename}>
        <label className="sr-only" htmlFor={`${idPrefix}-rename`}>Chatname</label><input ref={titleInput} id={`${idPrefix}-rename`} aria-label="Chatname" maxLength={64} value={title} onChange={event => { setTitle(event.target.value); }} />
        <div className="chat-dialog-buttons"><button type="button" onClick={() => dialog.current?.close()}>Abbrechen</button><button type="submit" className="is-primary" disabled={!title.trim()}>Speichern</button></div>
      </form> : <div className="chat-dialog-buttons"><button ref={cancelDelete} type="button" onClick={() => dialog.current?.close()}>Abbrechen</button><button type="button" className="is-destructive" disabled={!editedSession || Boolean(view.busy[editedSession.id])} onClick={() => { if (!editor || view.busy[editor.id]) return; store.remove(editor.id); dialog.current?.close(); }}>Chat löschen</button></div>}
    </dialog>
    <p className="chat-list-footnote">Verläufe bleiben in diesem Browser und sind nach Testkonto getrennt.{sessions.length >= MAX_CHAT_SESSIONS && <span> Maximal {MAX_CHAT_SESSIONS} Chats. Lösche einen Verlauf für einen neuen Chat.</span>}</p>
  </div>;
}
