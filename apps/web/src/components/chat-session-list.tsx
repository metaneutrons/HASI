"use client";

import { MessageCircle, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { MAX_CHAT_SESSIONS } from "@/lib/chat-sessions";
import type { ChatWorkspaceStore } from "@/lib/chat-workspace-store";

type View = ReturnType<ChatWorkspaceStore["getSnapshot"]>;

export function ChatSessionList({ view, store, close }: { view: View; store: ChatWorkspaceStore; close?: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const sessions = [...view.workspace.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  function rename(event: FormEvent<HTMLFormElement>, sessionId: string) {
    event.preventDefault();
    if (!title.trim()) return;
    store.rename(sessionId, title); setEditing(null);
  }

  return <>
    <div className="chat-list-heading"><div><span className="chat-list-kicker">DEIN ARBEITSPLATZ</span><h2>Chats <small>{sessions.length}</small></h2></div>{close && <button className="icon-button" type="button" aria-label="Chatliste schließen" onClick={close}><X size={20} /></button>}</div>
    <button className="chat-list-create" type="button" disabled={sessions.length >= MAX_CHAT_SESSIONS} onClick={() => { store.create(); close?.(); }}><Plus size={18} /> Neuer Chat</button>
    <div className="chat-session-items" aria-label="Gespeicherte Chats">
      {sessions.map((session) => {
        const active = session.id === view.workspace.activeId;
        const busy = Boolean(view.busy[session.id]);
        const preview = session.snapshot.messages.at(-1)?.text || "Stelle deine erste Frage";
        return <div className={`chat-session-row${active ? " is-active" : ""}`} key={session.id}>
          {editing === session.id ? <form className="chat-rename-form" onSubmit={(event) => rename(event, session.id)}>
            <label className="sr-only" htmlFor={`rename-${session.id}`}>Chatname</label><input id={`rename-${session.id}`} aria-label="Chatname" autoFocus maxLength={64} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }} />
            <div><button type="button" onClick={() => setEditing(null)}>Abbrechen</button><button type="submit" disabled={!title.trim()}>Speichern</button></div>
          </form> : <>
            <button type="button" className="chat-session-select" aria-current={active ? "true" : undefined} aria-label={`${session.title} öffnen`} onClick={() => { store.select(session.id); close?.(); }}>
              <span className="chat-session-symbol">{busy ? <span className="spinner" aria-label="Antwort läuft" /> : <MessageCircle size={16} />}</span>
              <span className="chat-session-copy"><strong>{session.title}</strong><span>{busy ? "HASI antwortet …" : preview}</span></span>
            </button>
            <button type="button" className="icon-button chat-session-menu" aria-label={`Aktionen für ${session.title}`} aria-expanded={menuFor === session.id} aria-controls={`actions-${session.id}`} onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}><MoreHorizontal size={17} /></button>
            {menuFor === session.id && <div className="chat-session-actions" id={`actions-${session.id}`} role="group" aria-label={`Aktionen für ${session.title}`}>
              <button type="button" onClick={() => { setMenuFor(null); setRemoving(null); setTitle(session.title); setEditing(session.id); }}><Pencil size={14} /> Umbenennen</button>
              <button type="button" disabled={busy} onClick={() => { setMenuFor(null); setRemoving(session.id); }}><Trash2 size={14} /> Löschen</button>
            </div>}
          </>}
          {removing === session.id && <div className="chat-delete-check" role="group" aria-label="Chat löschen bestätigen"><p>Diesen Chat löschen? Buchungen bleiben erhalten.</p><div><button type="button" onClick={() => setRemoving(null)}>Abbrechen</button><button type="button" disabled={busy} onClick={() => { store.remove(session.id); setRemoving(null); }}>Chat löschen</button></div></div>}
        </div>;
      })}
    </div>
    <p className="chat-list-footnote">Verläufe bleiben in diesem Browser und sind nach Testkonto getrennt.{sessions.length >= MAX_CHAT_SESSIONS && <span> Maximal {MAX_CHAT_SESSIONS} Chats. Lösche einen Verlauf für einen neuen Chat.</span>}</p>
  </>;
}
