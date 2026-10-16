"use client";

import { ArrowRight, ArrowUp, BookOpen, CalendarDays, Check, Clock3, MapPin, MessageCircle, PanelLeft, Plus, Search, Sparkles, Users, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { apiRequest, formatDateTime, formatTime } from "@/lib/api";
import { classifyIntent, matchingResources, mergeRoomRequest, missingRoomDetails, requestStartDate, roomRequestSummary, type RoomRequest } from "@/lib/chat-demo";
import type { Booking, Resource, TimeInterval, User } from "@/lib/types";
import { useSession } from "@/components/session-provider";
import { availabilityInputForSlot, createAnnyChatTools, type AnnyChatToolResult } from "@/lib/anny-chat-tools";
import { MODEL_PROFILE_IDS, modelReplySchema, type WireMessage } from "@/lib/chat-contract";
import { appendChatText } from "@/lib/chat-history";
import type { ChatMessage as Message, ChatProposal as Proposal, ChatSnapshot } from "@/lib/chat-sessions";
import { browserChatStorage, createChatWorkspaceStore } from "@/lib/chat-workspace-store";
import { ChatSessionList } from "@/components/chat-session-list";

type ModelProfile = { id: string; label: string; modelId: string; provider: "groq" };
type ModelConfiguration = { profiles: ModelProfile[]; ready: boolean; loading: boolean; error: string | null };

const suggestions = [
  { icon: Search, title: "Einen Raum finden", text: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.", caption: "Gemeinsam planen und buchen" },
  { icon: BookOpen, title: "Eine IT-Frage stellen", text: "Wie richte ich eduroam ein?", caption: "Wissenssuche ist in Vorbereitung" },
  { icon: CalendarDays, title: "Meine Buchungen", text: "Zeige mir meine Buchungen.", caption: "Deine Reservierungen im Überblick" },
];

function id() { return crypto.randomUUID(); }

export function AssistantPage() {
  const { user } = useSession();
  return user ? <ChatWorkspace key={user.id} user={user} /> : null;
}

function ChatWorkspace({ user }: { user: User }) {
  // SessionProvider establishes the account on the client before this mounts.
  const [store] = useState(() => createChatWorkspaceStore(user.id, browserChatStorage()));
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const drawer = useRef<HTMLDialogElement>(null);
  const [configuration, setConfiguration] = useState<ModelConfiguration>({ profiles: [], ready: false, loading: true, error: null });

  useEffect(() => {
    let active = true;
    fetch("/api/chat", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("configuration");
      return await response.json() as { configured: boolean; profiles: ModelProfile[] };
    }).then((result) => {
      if (active) setConfiguration({ profiles: result.profiles, ready: result.configured, loading: false, error: result.configured ? null : "GroqCloud ist noch nicht konfiguriert. Du kannst ausdrücklich die Dialog-Demo wählen." });
    }).catch(() => { if (active) setConfiguration({ profiles: [], ready: false, loading: false, error: "GroqCloud ist gerade nicht erreichbar. Die Dialog-Demo kann separat ausgewählt werden." }); });
    const flush = () => store.flush();
    window.addEventListener("pagehide", flush);
    return () => { active = false; window.removeEventListener("pagehide", flush); store.flush(); };
  }, [store]);

  function newChat() { store.create(); drawer.current?.close(); }

  return <section className="chat-workspace" aria-label="Deine Chatverläufe">
    <aside className="chat-session-panel" aria-label="Chatliste"><ChatSessionList view={view} store={store} /></aside>
    <dialog className="chat-history-dialog" ref={drawer} aria-label="Chatliste" onClick={(event) => { if (event.target === event.currentTarget) drawer.current?.close(); }}><div className="chat-history-dialog-body"><ChatSessionList view={view} store={store} close={() => drawer.current?.close()} /></div></dialog>
    <div className="chat-conversations">
      {view.notice && <div className="chat-storage-notice" role="status"><span>{view.notice}</span><button className="icon-button" type="button" aria-label="Hinweis schließen" onClick={store.dismissNotice}><X size={16} /></button></div>}
      {view.workspace.sessions.map((session) => <Conversation key={session.id} sessionId={session.id} ownerId={user.id} initial={session.snapshot} name={user.displayName.split(/\s|·/)[0] ?? ""} active={session.id === view.workspace.activeId} configuration={configuration} onSnapshot={store.update} onNewChat={newChat} onShowHistory={() => drawer.current?.showModal()} />)}
    </div>
  </section>;
}

type ConversationProps = { sessionId: string; ownerId: string; name: string; initial: ChatSnapshot; active: boolean; configuration: ModelConfiguration; onSnapshot: (id: string, snapshot: ChatSnapshot, busy: boolean) => void; onNewChat: () => void; onShowHistory: () => void };

function Conversation({ sessionId, ownerId, name, initial, active, configuration, onSnapshot, onNewChat, onShowHistory }: ConversationProps) {
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [input, setInput] = useState(initial.input);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [request, setRequest] = useState<RoomRequest>(initial.request);
  const [roomContext, setRoomContext] = useState(initial.roomContext);
  const [chosenRoom, setChosenRoom] = useState<Resource | null>(initial.chosenRoom);
  const [activeResult, setActiveResult] = useState<string | null>(initial.activeResult);
  const [activeProposal, setActiveProposal] = useState<string | null>(initial.activeProposal);
  const [profileId, setProfileId] = useState(initial.profileId);
  const [messagesTruncated, setMessagesTruncated] = useState(initial.messagesTruncated);
  const [interrupted, setInterrupted] = useState(initial.interrupted);
  const { profiles, ready: modelReady, loading: modelLoading, error: modelError } = configuration;
  const lock = useRef(false);
  const alive = useRef(true);
  const history = useRef<WireMessage[]>(structuredClone(initial.history));
  const toolBridge = useRef<ReturnType<typeof createAnnyChatTools> | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const latestMessage = messages.at(-1)?.id;
  const offline = profileId === "offline";
  const canSend = offline || (!modelLoading && modelReady);

  function tools() {
    toolBridge.current ??= createAnnyChatTools(requestForChat);
    return toolBridge.current;
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pendingRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    onSnapshot(sessionId, { messages, input, history: history.current, profileId, request, roomContext, chosenRoom, activeResult, activeProposal, interrupted: interrupted || busy, messagesTruncated }, busy);
  }, [messages, input, profileId, request, roomContext, chosenRoom, activeResult, activeProposal, interrupted, busy, messagesTruncated, sessionId, onSnapshot]);

  useEffect(() => {
    const element = scroller.current;
    if (active && element) element.scrollTo({ top: latestMessage || busy ? element.scrollHeight : 0, behavior: "instant" });
  }, [latestMessage, busy, active]);

  async function requestForChat<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal = pendingRequest.current?.signal;
    if (!alive.current || signal?.aborted) throw new DOMException("Chat closed", "AbortError");
    const session = await apiRequest<{ user: User | null }>("/api/session", { signal });
    if (!alive.current || signal?.aborted || session.user?.id !== ownerId) throw new Error("Das Testkonto wurde gewechselt. Bitte öffne den Chat erneut.");
    const result = await apiRequest<T>(path, { ...init, signal });
    if (!alive.current || signal?.aborted) throw new DOMException("Chat closed", "AbortError");
    return result;
  }

  function postForChat<T>(path: string, body: unknown) { return requestForChat<T>(path, { method: "POST", body: JSON.stringify(body) }); }

  function add(message: Omit<Message, "id">) {
    if (offline) appendChatText(history.current, message.role, message.text);
    const messageId = id();
    if (messages.length >= 200) setMessagesTruncated(true);
    setMessages((previous) => [...previous.slice(-199), { ...message, id: messageId }]);
    return messageId;
  }

  function addActionResult(message: Omit<Message, "id" | "role">) {
    if (!offline) appendChatText(history.current, "assistant", message.text);
    return add({ ...message, role: "assistant" });
  }

  function start(label: string) {
    if (lock.current) return false;
    lock.current = true;
    pendingRequest.current = new AbortController();
    setInterrupted(false);
    setBusy(true);
    setActivity(label);
    return true;
  }

  function finish() {
    lock.current = false;
    pendingRequest.current = null;
    setBusy(false);
  }

  function recordTool(name: import("@/lib/chat-contract").ChatToolName, arguments_: Record<string, unknown>, output: Record<string, unknown>) {
    const callId = id();
    history.current.push({ role: "assistant", content: "", toolCalls: [{ id: callId, name, arguments: arguments_ }] });
    history.current.push({ role: "tool", content: JSON.stringify(output), toolCallId: callId, name });
  }

  function showToolResult(result: AnnyChatToolResult, interactionId: string, model: string) {
    const labels = {
      anny_search_resources: "anny · Raumsuche",
      anny_get_availability: "anny · Verfügbarkeit",
      anny_list_my_bookings: "anny · Eigene Buchungen",
      anny_propose_booking: "anny · Buchungsvorschlag",
    };
    const text = result.proposal ? "Bitte prüfe den Buchungsvorschlag. Erst die Bestätigung auf dieser Karte löst die Testbuchung aus."
      : result.rooms ? (result.rooms.length ? "Ergebnisse aus den anny-Testdaten." : "Keine Räume entsprechen diesen Anforderungen.")
      : result.bookings ? (result.bookings.length ? "Deine Buchungen aus der Testumgebung." : "Du hast noch keine Testbuchungen.") : "Tool-Abfrage abgeschlossen.";
    add({ role: "assistant", text, tool: labels[result.name], rooms: result.rooms, bookings: result.bookings, proposal: result.proposal, model, interactionId });
    if (result.rooms) setActiveResult(interactionId);
    if (result.proposal) setActiveProposal(result.proposal.id);
  }

  async function runGroq(text: string) {
    // Drop complete oldest turns only; never separate a tool call from its result.
    while (history.current.length > 36 || JSON.stringify(history.current).length > 22_000) {
      const nextTurn = history.current.findIndex((message, index) => index > 0 && message.role === "user");
      if (nextTurn < 0) { history.current = []; break; }
      history.current.splice(0, nextTurn);
    }
    history.current.push({ role: "user", content: text });
    const interactionId = id();
    const controller = pendingRequest.current!;
    try {
      for (let step = 0; step < 4; step += 1) {
        setActivity("GroqCloud antwortet …");
        const response = await fetch("/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId, messages: history.current }), signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({ error: "Der Chat-Dienst ist gerade nicht erreichbar. Bitte versuche es später erneut." }));
        if (!response.ok) {
          const error = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "GroqCloud ist gerade nicht verfügbar.";
          throw new Error(error);
        }
        const validated = modelReplySchema.safeParse(payload);
        if (!validated.success) throw new Error("Die Modellantwort entspricht nicht dem erwarteten Format. Bitte versuche es erneut.");
        const reply = validated.data;
        history.current.push(reply.message);
        if (reply.message.content.trim()) add({ role: "assistant", text: reply.message.content, model: reply.profile.label });
        if (!reply.message.toolCalls?.length) return;
        let actionableResult = false;
        for (const call of reply.message.toolCalls) {
          setActivity(`anny · ${call.name === "anny_propose_booking" ? "Buchung vorbereiten" : "Testdaten abfragen"}`);
          let output: Record<string, unknown>;
          try {
            const result = await tools().run(call.name, call.arguments);
            output = result.output;
            showToolResult(result, interactionId, reply.profile.label);
            actionableResult ||= Boolean(result.proposal || result.bookings || result.rooms?.some((room) => room.checked && room.intervals.length > 0));
          } catch (cause) {
            output = { error: cause instanceof Error ? cause.message : "Das Tool konnte die Anfrage nicht abschließen." };
            add({ role: "assistant", text: String(output.error), tool: "anny · Anfrage fehlgeschlagen" });
          }
          history.current.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(output) });
        }
        // Host-rendered cards already provide the answer and next action.
        // Avoid a redundant generation after availability, proposals or bookings.
        if (actionableResult) return;
      }
      add({ role: "assistant", text: "Die maximale Zahl an Modellschritten für diese Nachricht ist erreicht. Du kannst die angezeigten Karten nutzen oder eine weitere Nachricht schreiben." });
    } catch (cause) {
      appendChatText(history.current, "assistant", "Die Verarbeitung der letzten Nachricht wurde durch einen technischen Fehler unterbrochen. Offene Schritte wurden nicht automatisch fortgesetzt; berücksichtige die bereits vorliegenden Tool-Ergebnisse.");
      throw cause;
    }
  }

  async function searchRooms(next: RoomRequest, selected: Resource | null) {
    const missing = missingRoomDetails(next);
    const invalid = Object.values(next).some((value) => value === "__invalid__" || (typeof value === "number" && value <= 0) || (Array.isArray(value) && value.includes("__invalid__")));
    if (invalid) {
      add({ role: "assistant", text: `Diese Angaben sind für die Dialog-Demo nicht eindeutig. Bitte präzisiere: ${missing.join(", ") || "Ausstattung oder Suchbegriff"}. Du kannst mit „neue Raumsuche“ auch von vorn beginnen.` });
      return;
    }
    setActivity("anny · Räume suchen");
    const result = await requestForChat<{ resources: Resource[] }>("/api/resources");
    const resources = matchingResources(result.resources, next).filter((resource) => !selected || resource.id === selected.id);
    if (!resources.length) {
      add({ role: "assistant", tool: "anny · Raumsuche", text: "Für diese Anforderungen finde ich in den zugänglichen Testdaten keinen Raum. Du kannst eine neue Raumsuche beginnen und die Anforderungen ändern." });
      return;
    }
    const startDate = requestStartDate(next);
    if (missing.length || !startDate || !next.durationMinutes) {
      const resultId = add({ role: "assistant", tool: "anny · Raumsuche", text: `${selected ? `Wir planen mit ${selected.name}.` : `${resources.length} ${resources.length === 1 ? "Raum passt" : "Räume passen"} zu deiner Suche.`} Für die Verfügbarkeitsprüfung brauche ich noch: ${missing.join(", ") || "ein gültiges Datum und eine gültige Startzeit"}. Antworte einfach hier im Chat, zum Beispiel „morgen um 14 Uhr für eine Stunde“.`, rooms: resources.map((resource) => ({ resource, intervals: [], checked: false })) });
      setActiveResult(resultId);
      return;
    }
    setActivity("anny · Verfügbarkeit prüfen");
    const options = await Promise.all(resources.map(async (resource) => {
      const availability = await postForChat<{ intervals: TimeInterval[] }>("/api/availability", { resourceId: resource.id, serviceId: resource.serviceId, startDate, durationMinutes: next.durationMinutes });
      return { resource, intervals: availability.intervals.filter((interval) => interval.available).slice(0, 3), checked: true };
    }));
    const count = options.filter((option) => option.intervals.length).length;
    const resultId = add({ role: "assistant", tool: "anny · Raumsuche und Verfügbarkeit", text: `${roomRequestSummary(next)}\n${count ? "Hier sind die verfügbaren Zeiten. Prüfe das Zeitfenster auf der Karte; es kann vom gewünschten Beginn abweichen. Wähle eine Zeit, dann bereite ich den Buchungsvorschlag vor." : "Zu diesen Anforderungen sind keine Zeiten frei. Nenne mir einen anderen Zeitraum."}`, rooms: options });
    setActiveResult(resultId);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 2000 || !canSend || !start("Anfrage wird verarbeitet")) return;
    setInput("");
    add({ role: "user", text: trimmed });
    setActiveResult(null);
    const pendingProposal = activeProposal;
    setActiveProposal(null);
    try {
      if (/^(ja|ok(?:ay)?|bestätigen|buche(?:n)?|mach das)[.!\s]*$/i.test(trimmed) && pendingProposal) {
        setActiveProposal(pendingProposal);
        const text = "Bitte prüfe Raum und Zeitraum im Buchungsvorschlag und nutze dort „Buchung bestätigen“. Erst dieser Schritt löst die Buchung aus.";
        if (!offline) {
          appendChatText(history.current, "user", trimmed);
          appendChatText(history.current, "assistant", text);
        }
        add({ role: "assistant", text });
        return;
      }
      if (!offline) {
        await runGroq(trimmed);
        return;
      }
      const intent = classifyIntent(trimmed, roomContext);
      if (intent === "bookings") {
        setActivity("anny · Eigene Buchungen laden");
        const result = await requestForChat<{ bookings: Booking[] }>("/api/bookings");
        add({ role: "assistant", tool: "anny · Eigene Buchungen", text: result.bookings.length ? "Hier sind deine Buchungen aus der Testumgebung." : "Du hast in der Testumgebung noch keine Buchungen. Soll ich einen Raum für dich suchen?", bookings: result.bookings });
        setRoomContext(false);
      } else if (intent === "knowledge") {
        setRoomContext(false);
        add({ role: "assistant", text: "Die Wissenssuche in Service IT und im Intranet gehört zu HASI. Diese Quellen sind in diesem Prototyp noch nicht angebunden. Deshalb kann ich deine Frage hier noch nicht mit geprüften Quellen und den passenden Zugriffsrechten beantworten. Du kannst bereits Raumsuche und Buchung im Chat ausprobieren." });
      } else if (intent === "rooms") {
        const reset = !roomContext || /(?:neue|andere)\s+(?:raum)?suche|(?:anderen|neuen)\s+raum|von vorne/i.test(trimmed);
        const next = mergeRoomRequest(trimmed, reset ? {} : request);
        const selected = reset || next.query !== request.query ? null : chosenRoom;
        if (!selected) setChosenRoom(null);
        setRequest(next);
        setRoomContext(true);
        await searchRooms(next, selected);
      } else {
        setRoomContext(false);
        add({ role: "assistant", text: intent === "greeting" ? `Hallo ${name}. Was möchtest du erledigen? Ich kann in dieser Demo Räume suchen, Buchungen vorbereiten und deine Reservierungen anzeigen.` : "Ich kann in dieser Dialog-Demo Räume suchen und buchen sowie deine Buchungen anzeigen. Schreib zum Beispiel: „Morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.“ Die IT- und Intranet-Wissenssuche wird später ebenfalls über diesen Chat erreichbar." });
      }
    } catch (cause) {
      add({ role: "assistant", text: cause instanceof Error ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut." });
    } finally {
      finish();
    }
  }

  async function chooseRoom(resource: Resource) {
    if (!offline) { await send(`Ich möchte ${resource.name} buchen. Verwende diesen Raum und frage nach noch fehlenden Angaben.`); return; }
    if (!start("Raum auswählen")) return;
    setChosenRoom(resource);
    setRoomContext(true);
    setActiveResult(null);
    setActiveProposal(null);
    add({ role: "user", text: `Ich möchte ${resource.name} buchen.` });
    try { await searchRooms(request, resource); }
    catch (cause) { add({ role: "assistant", text: cause instanceof Error ? cause.message : "Der Raum konnte nicht geprüft werden." }); }
    finally { finish(); if (active) composer.current?.focus(); }
  }

  async function prepare(resource: Resource, interval: TimeInterval) {
    if (!start("anny · Buchung vorbereiten")) return;
    setActiveResult(null);
    setActiveProposal(null);
    const selection = `${resource.name}, ${formatDateTime(interval.startDate)} bis ${formatTime(interval.endDate)} Uhr. Bitte vorbereiten.`;
    if (!offline) appendChatText(history.current, "user", selection);
    add({ role: "user", text: selection });
    try {
      const args = { resourceId: resource.id, startDate: interval.startDate, endDate: interval.endDate };
      if (!offline) {
        const check = availabilityInputForSlot(resource.id, interval);
        const checked = await tools().run("anny_get_availability", check);
        recordTool("anny_get_availability", check, checked.output);
      }
      const result = offline
        ? await postForChat<{ proposal: Proposal }>("/api/proposals", { ...args, serviceId: resource.serviceId })
        : await tools().run("anny_propose_booking", args);
      if (!result.proposal) throw new Error("Es wurde kein Buchungsvorschlag zurückgegeben.");
      if (!offline && "output" in result) recordTool("anny_propose_booking", args, result.output);
      const { id, resourceName, startDate, endDate, status, expiresAt } = result.proposal;
      addActionResult({ text: "Der Buchungsvorschlag ist vorbereitet. Bitte prüfe die Angaben und bestätige die Buchung ausdrücklich.", tool: "anny · Buchungsvorschlag", proposal: { id, resourceName, startDate, endDate, status, expiresAt } });
      setActiveProposal(result.proposal.id);
    } catch (cause) { addActionResult({ text: cause instanceof Error ? cause.message : "Der Buchungsvorschlag konnte nicht erstellt werden." }); }
    finally { finish(); }
  }

  async function confirm(proposal: Proposal) {
    if (activeProposal !== proposal.id || !start("anny · Bestätigte Buchung ausführen")) return;
    const action = `Ich bestätige den angezeigten Buchungsvorschlag für ${proposal.resourceName}, ${formatDateTime(proposal.startDate)} bis ${formatTime(proposal.endDate)} Uhr über die Schaltfläche.`;
    if (!offline) appendChatText(history.current, "user", action);
    add({ role: "user", text: action });
    try {
      const result = await postForChat<{ proposal: Proposal; bookingId?: string }>(`/api/proposals/${encodeURIComponent(proposal.id)}/confirm`, {});
      if (result.proposal.status === "confirmed") {
        setActiveProposal(null);
        setRoomContext(false);
        setRequest({});
        setChosenRoom(null);
        addActionResult({ text: `Die Testbuchung für ${result.proposal.resourceName} ist bestätigt. ${formatDateTime(result.proposal.startDate)} bis ${formatTime(result.proposal.endDate)} Uhr.`, tool: "anny · Buchung ausgeführt", confirmed: true });
      } else {
        setActiveProposal(null);
        addActionResult({ text: result.proposal.status === "outcome_unknown" ? "Der Buchungsdienst hat nicht eindeutig geantwortet. Prüfe deine Buchungen, bevor du erneut buchst." : "Die Buchung konnte nicht bestätigt werden. Bitte suche erneut nach freien Zeiten." });
      }
    } catch (cause) { addActionResult({ text: cause instanceof Error ? cause.message : "Die Bestätigung konnte nicht abgeschlossen werden. Prüfe vor einem erneuten Versuch deine Buchungen." }); }
    finally { finish(); }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void send(input); }

  return (
    <section className="chat-page" aria-label="HASI Chat" hidden={!active}>
      <div className="chat-toolbar"><button className="chat-history-toggle icon-button" type="button" onClick={onShowHistory} aria-label="Chatliste öffnen"><PanelLeft size={19} /></button><label className="chat-model-picker"><MessageCircle size={15} aria-hidden="true" /><span className="sr-only">Sprachmodell</span><select aria-label="Sprachmodell" value={profileId} disabled={busy || modelLoading} onChange={(event) => { const value = event.currentTarget.value; if (value === "offline" || MODEL_PROFILE_IDS.some((id) => id === value)) setProfileId(value as typeof profileId); }}>{profiles.length ? profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>) : <option value="groq-oss-120b">{modelLoading ? "Modell wird geladen …" : "GroqCloud nicht verfügbar"}</option>}<option value="offline">Dialog-Demo · ohne Modell</option></select></label><button type="button" onClick={onNewChat} className="chat-new" aria-label="Neuer Chat"><Plus size={16} aria-hidden="true" /><span>Neuer Chat</span></button></div>
      {modelError && !offline && <p className="chat-model-error" role="status">{modelError}</p>}
      {interrupted && <p className="chat-recovery-note" role="status">Eine frühere Anfrage wurde unterbrochen. Bei Buchungen prüfe bitte zuerst den aktuellen Status.</p>}
      {messagesTruncated && <p className="chat-recovery-note">Die letzten 200 Nachrichten dieses Chats werden gespeichert und angezeigt.</p>}
      <div className="chat-scroller" ref={scroller}>
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <span className="chat-orb" aria-hidden="true"><Sparkles size={30} strokeWidth={1.3} /></span>
            <p className="chat-greeting">Hallo {name}.</p>
            <h1>Was kann ich <br /><span>für dich tun?</span></h1>
            <p className="chat-intro">Eine Frage, ein Vorhaben, dein nächster Schritt.<br className="chat-desktop-break" /> Dein Hochschulalltag beginnt mit einem Gespräch.</p>
            <div className="chat-suggestions">{suggestions.map(({ icon: Icon, title, text, caption }) => <button type="button" key={title} disabled={busy || !canSend} onClick={() => void send(text)}><Icon size={19} strokeWidth={1.6} aria-hidden="true" /><strong>{title}</strong><span>{caption}</span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>
          </div>
        ) : (
          <div className="chat-transcript" role="log" aria-label="Gesprächsverlauf" aria-live="polite" aria-relevant="additions">
            {messages.map((message) => (
              <article key={message.id} className={`chat-message chat-message--${message.role}`} aria-label={message.role === "user" ? "Du" : "HASI"}>
                <span className="chat-speaker">{message.role === "user" ? "Du" : <><Sparkles size={14} aria-hidden="true" /> HASI {message.model && <small>{message.model}</small>}</>}</span>
                <div className="chat-message-body">
                  {message.tool && <span className="chat-tool-label"><Check size={13} aria-hidden="true" /> {message.tool}</span>}
                  <p>{message.text}</p>
                  {message.rooms && <div className="chat-room-list">{message.rooms.map(({ resource, intervals, checked }) => <article className="chat-tool-card" key={resource.id}>
                    <div className="chat-room-heading"><span className="chat-room-icon"><CalendarDays size={20} strokeWidth={1.5} aria-hidden="true" /></span><div><h2>{resource.name}</h2><span><MapPin size={12} aria-hidden="true" /> {resource.location}</span></div></div>
                    <p className="chat-room-details"><Users size={14} aria-hidden="true" /> Bis {resource.capacity} Personen <span>·</span> {resource.features.join(" · ")}</p>
                    {checked ? intervals.length ? <div className="chat-slots">{intervals.map((interval) => <button type="button" disabled={busy || activeResult !== message.id && activeResult !== message.interactionId} onClick={() => void prepare(resource, interval)} key={interval.startDate} aria-label={`${resource.name} am ${formatDateTime(interval.startDate)} bis ${formatTime(interval.endDate)} vorbereiten`}><Clock3 size={14} aria-hidden="true" /><span>{formatDateTime(interval.startDate)}–{formatTime(interval.endDate)}</span><ArrowRight size={14} aria-hidden="true" /></button>)}</div> : <p className="chat-no-slots">Keine freien Zeiten zu diesen Anforderungen.</p> : <button className="chat-card-action" type="button" disabled={busy || activeResult !== message.id && activeResult !== message.interactionId} onClick={() => void chooseRoom(resource)}>Diesen Raum planen <ArrowRight size={15} aria-hidden="true" /></button>}
                  </article>)}</div>}
                  {message.proposal && <div className="chat-tool-card chat-proposal"><span className="chat-proposal-label">BITTE PRÜFEN UND BESTÄTIGEN</span><h2>{message.proposal.resourceName}</h2><p>{formatDateTime(message.proposal.startDate)} bis {formatTime(message.proposal.endDate)} Uhr</p><small>Gültig bis {formatTime(message.proposal.expiresAt)} Uhr · Testumgebung</small><button className="button button--primary button--wide" type="button" disabled={busy || activeProposal !== message.proposal.id} onClick={() => void confirm(message.proposal!)}>{activeProposal === message.proposal.id ? "Buchung bestätigen" : "Vorschlag abgeschlossen oder ersetzt"}<Check size={16} aria-hidden="true" /></button></div>}
                  {message.bookings && message.bookings.length > 0 && <div className="chat-booking-list">{message.bookings.map((booking) => <div className="chat-tool-card" key={booking.id}><h2>{booking.resourceName}</h2><p>{formatDateTime(booking.startDate)} bis {formatTime(booking.endDate)} Uhr</p><span className="chat-booking-status">{booking.status === "confirmed" || booking.status === "accepted" ? "Bestätigt" : booking.status}</span></div>)}</div>}
                  {message.confirmed && <Link className="chat-card-action" href="/bookings">Meine Buchungen öffnen <ArrowRight size={15} aria-hidden="true" /></Link>}
                </div>
              </article>
            ))}
          </div>
        )}
        {busy && <div className="chat-activity" role="status"><span className="spinner" />{activity}</div>}
      </div>
      <div className="chat-composer-dock">
        <form className="chat-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor={inputId}>Nachricht an HASI</label>
          <textarea id={inputId} ref={composer} rows={2} maxLength={2000} value={input} onChange={(event) => setInput(event.currentTarget.value)} placeholder="Frag HASI oder beschreibe, was du vorhast …" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} />
          <div className="chat-composer-bottom"><span><span className="status-dot" /> {offline ? "Dialog-Demo · ohne Sprachmodell" : modelLoading ? "GroqCloud wird verbunden …" : modelReady ? "GroqCloud · anny-Testdaten" : "GroqCloud nicht verfügbar"}</span><button type="submit" aria-label="Nachricht senden" disabled={busy || !canSend || !input.trim()}><ArrowUp size={20} aria-hidden="true" /></button></div>
        </form>
        <p className="chat-footnote">{offline ? "Dialog-Demo mit Testdaten · IT- und Intranet-Wissen folgt" : "Nachrichten und Toolergebnisse gehen an GroqCloud. Bitte nur Testdaten eingeben."}</p>
      </div>
    </section>
  );
}
