"use client";

import { ArrowRight, ArrowUp, BookOpen, CalendarDays, Check, Clock3, MapPin, MessageCircle, Plus, Search, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest, formatDateTime, formatTime, postJson } from "@/lib/api";
import { classifyIntent, matchingResources, mergeRoomRequest, missingRoomDetails, requestStartDate, roomRequestSummary, type RoomRequest } from "@/lib/chat-demo";
import type { Booking, Resource, TimeInterval } from "@/lib/types";
import { useSession } from "@/components/session-provider";
import { createAnnyChatTools, type AnnyChatToolResult } from "@/lib/anny-chat-tools";
import { modelReplySchema, type WireMessage } from "@/lib/chat-contract";
import { appendChatText } from "@/lib/chat-history";

type Proposal = {
  id: string;
  resourceName: string;
  startDate: string;
  endDate: string;
  status: "pending" | "confirmed" | "outcome_unknown" | "failed";
  expiresAt: string;
};
type RoomOption = { resource: Resource; intervals: TimeInterval[]; checked: boolean };
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tool?: string;
  rooms?: RoomOption[];
  proposal?: Proposal;
  bookings?: Booking[];
  confirmed?: boolean;
  model?: string;
  interactionId?: string;
};

type ModelProfile = { id: string; label: string; modelId: string; provider: "groq" };

const suggestions = [
  { icon: Search, title: "Einen Raum finden", text: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.", caption: "Gemeinsam planen und buchen" },
  { icon: BookOpen, title: "Eine IT-Frage stellen", text: "Wie richte ich eduroam ein?", caption: "Wissenssuche ist in Vorbereitung" },
  { icon: CalendarDays, title: "Meine Buchungen", text: "Zeige mir meine Buchungen.", caption: "Deine Reservierungen im Überblick" },
];

function id() { return crypto.randomUUID(); }

export function AssistantPage() {
  const { user } = useSession();
  return <Conversation key={user?.id} name={user?.displayName.split(/\s|·/)[0] ?? ""} />;
}

function Conversation({ name }: { name: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [request, setRequest] = useState<RoomRequest>({});
  const [roomContext, setRoomContext] = useState(false);
  const [chosenRoom, setChosenRoom] = useState<Resource | null>(null);
  const [activeResult, setActiveResult] = useState<string | null>(null);
  const [activeProposal, setActiveProposal] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [profileId, setProfileId] = useState("groq-oss-120b");
  const [modelReady, setModelReady] = useState(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const lock = useRef(false);
  const history = useRef<WireMessage[]>([]);
  const toolBridge = useRef<ReturnType<typeof createAnnyChatTools> | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const latestMessage = messages.at(-1)?.id;
  const offline = profileId === "offline";
  const canSend = offline || (!modelLoading && modelReady);

  function tools() {
    toolBridge.current ??= createAnnyChatTools(apiRequest);
    return toolBridge.current;
  }

  useEffect(() => {
    let active = true;
    fetch("/api/chat", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Die Modellkonfiguration ist nicht erreichbar.");
        return await response.json() as { configured: boolean; profiles: ModelProfile[]; defaultProfileId: string };
      })
      .then((result) => {
        if (!active) return;
        setProfiles(result.profiles);
        setProfileId(result.defaultProfileId);
        setModelReady(result.configured);
        if (!result.configured) setModelError("GroqCloud ist noch nicht konfiguriert. Du kannst ausdrücklich die Dialog-Demo wählen.");
      })
      .catch(() => { if (active) setModelError("GroqCloud ist gerade nicht erreichbar. Die Dialog-Demo kann separat ausgewählt werden."); })
      .finally(() => { if (active) setModelLoading(false); });
    return () => { active = false; pendingRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: latestMessage || busy ? element.scrollHeight : 0, behavior: "instant" });
  }, [latestMessage, busy]);

  function add(message: Omit<Message, "id">) {
    if (offline) appendChatText(history.current, message.role, message.text);
    const messageId = id();
    setMessages((previous) => [...previous, { ...message, id: messageId }]);
    return messageId;
  }

  function addActionResult(message: Omit<Message, "id" | "role">) {
    if (!offline) appendChatText(history.current, "assistant", message.text);
    return add({ ...message, role: "assistant" });
  }

  function start(label: string) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setActivity(label);
    return true;
  }

  function finish() {
    lock.current = false;
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
    const controller = new AbortController();
    pendingRequest.current = controller;
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
        for (const call of reply.message.toolCalls) {
          setActivity(`anny · ${call.name === "anny_propose_booking" ? "Buchung vorbereiten" : "Testdaten abfragen"}`);
          let output: Record<string, unknown>;
          try {
            const result = await tools().run(call.name, call.arguments);
            output = result.output;
            showToolResult(result, interactionId, reply.profile.label);
          } catch (cause) {
            output = { error: cause instanceof Error ? cause.message : "Das Tool konnte die Anfrage nicht abschließen." };
            add({ role: "assistant", text: String(output.error), tool: "anny · Anfrage fehlgeschlagen" });
          }
          history.current.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(output) });
        }
      }
      add({ role: "assistant", text: "Die maximale Zahl an Modellschritten für diese Nachricht ist erreicht. Du kannst die angezeigten Karten nutzen oder eine weitere Nachricht schreiben." });
    } finally { pendingRequest.current = null; }
  }

  async function searchRooms(next: RoomRequest, selected: Resource | null) {
    const missing = missingRoomDetails(next);
    const invalid = Object.values(next).some((value) => value === "__invalid__" || (typeof value === "number" && value <= 0) || (Array.isArray(value) && value.includes("__invalid__")));
    if (invalid) {
      add({ role: "assistant", text: `Diese Angaben sind für die Dialog-Demo nicht eindeutig. Bitte präzisiere: ${missing.join(", ") || "Ausstattung oder Suchbegriff"}. Du kannst mit „neue Raumsuche“ auch von vorn beginnen.` });
      return;
    }
    setActivity("anny · Räume suchen");
    const result = await apiRequest<{ resources: Resource[] }>("/api/resources");
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
      const availability = await postJson<{ intervals: TimeInterval[] }>("/api/availability", { resourceId: resource.id, serviceId: resource.serviceId, startDate, durationMinutes: next.durationMinutes });
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
        const result = await apiRequest<{ bookings: Booking[] }>("/api/bookings");
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
    finally { finish(); composer.current?.focus(); }
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
      const result = offline
        ? await postJson<{ proposal: Proposal }>("/api/proposals", { ...args, serviceId: resource.serviceId })
        : await tools().run("anny_propose_booking", args);
      if (!result.proposal) throw new Error("Es wurde kein Buchungsvorschlag zurückgegeben.");
      if (!offline && "output" in result) recordTool("anny_propose_booking", args, result.output);
      addActionResult({ text: "Der Buchungsvorschlag ist vorbereitet. Bitte prüfe die Angaben und bestätige die Buchung ausdrücklich.", tool: "anny · Buchungsvorschlag", proposal: result.proposal });
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
      const result = await postJson<{ proposal: Proposal; bookingId?: string }>(`/api/proposals/${encodeURIComponent(proposal.id)}/confirm`, {});
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

  function reset() {
    if (lock.current) return;
    setMessages([]); setRequest({}); setRoomContext(false); setChosenRoom(null); setActiveResult(null); setActiveProposal(null); setInput("");
    history.current = []; tools().reset();
    composer.current?.focus();
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void send(input); }

  return (
    <section className="chat-page" aria-label="HASI Chat">
      <div className="chat-toolbar"><label className="chat-model-picker"><MessageCircle size={15} aria-hidden="true" /><span className="sr-only">Sprachmodell</span><select aria-label="Sprachmodell" value={profileId} disabled={busy || modelLoading} onChange={(event) => setProfileId(event.currentTarget.value)}>{profiles.length ? profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>) : <option value="groq-oss-120b">{modelLoading ? "Modell wird geladen …" : "GroqCloud nicht verfügbar"}</option>}<option value="offline">Dialog-Demo · ohne Modell</option></select></label><button type="button" onClick={reset} disabled={busy} className="chat-new"><Plus size={16} aria-hidden="true" /> Neuer Chat</button></div>
      {modelError && !offline && <p className="chat-model-error" role="status">{modelError}</p>}
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
          <label className="sr-only" htmlFor="chat-input">Nachricht an HASI</label>
          <textarea id="chat-input" ref={composer} rows={2} maxLength={2000} value={input} onChange={(event) => setInput(event.currentTarget.value)} placeholder="Frag HASI oder beschreibe, was du vorhast …" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} />
          <div className="chat-composer-bottom"><span><span className="status-dot" /> {offline ? "Dialog-Demo · ohne Sprachmodell" : modelLoading ? "GroqCloud wird verbunden …" : modelReady ? "GroqCloud · anny-Testdaten" : "GroqCloud nicht verfügbar"}</span><button type="submit" aria-label="Nachricht senden" disabled={busy || !canSend || !input.trim()}><ArrowUp size={20} aria-hidden="true" /></button></div>
        </form>
        <p className="chat-footnote">{offline ? "Dialog-Demo mit Testdaten · IT- und Intranet-Wissen folgt" : "Nachrichten und Toolergebnisse gehen an GroqCloud. Bitte nur Testdaten eingeben."}</p>
      </div>
    </section>
  );
}
