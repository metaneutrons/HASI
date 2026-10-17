"use client";

import { ArrowRight, ArrowUp, BookOpen, CalendarDays, Check, MessageCircle, PanelLeft, Plus, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { apiRequest, formatDateTime, formatTime } from "@/lib/api";
import { classifyIntent, matchingResources, mergeRoomRequest, missingRoomDetails, requestStartDate, roomRequestSummary, workplaceGroupQuestion, workplaceOfficeTypeCounts, workplaceRefinementQuestion, type RoomRequest } from "@/lib/chat-demo";
import type { Booking, Resource, TimeInterval, User } from "@/lib/types";
import { useChatWorkspaceStore } from "@/components/chat-sidebar-context";
import { useSession } from "@/components/session-provider";
import { availabilityInputForSlot, createAnnyChatTools, type AnnyChatToolResult } from "@/lib/anny-chat-tools";
import { searchKnowledge, knowledgeDocumentHref, knowledgeSourceLabel } from "@/lib/knowledge";
import { chatProfileIdSchema, modelProfilesResponseSchema, modelReplySchema, type ModelProfile, type ModelProfileId, type WireMessage } from "@/lib/chat-contract";
import { createChatMessageClock } from "@/lib/chat-message-clock";
import { appendChatText } from "@/lib/chat-history";
import type { ChatMessage as Message, ChatProposal as Proposal, ChatSnapshot } from "@/lib/chat-sessions";
import { canStartNewChat } from "@/lib/chat-workspace-store";
import { ChatSessionList } from "@/components/chat-session-list";
import { ChatRoomResults } from "@/components/chat-room-results";

type ModelConfiguration = { profiles: ModelProfile[]; userChoiceEnabled: boolean; defaultProfileId: ModelProfileId; loading: boolean; error: string | null };

const suggestions = [
  { icon: Search, title: "Einen Raum finden", text: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.", caption: "Gemeinsam planen und buchen" },
  { icon: BookOpen, title: "Eine IT-Frage stellen", text: "Wie prüfe ich in der Service-IT-Demo den WLAN-Zugang Morgenstern-Lab?", caption: "Service IT und Intranet mit Quellen" },
  { icon: CalendarDays, title: "Meine Buchungen", text: "Zeige mir meine Buchungen.", caption: "Deine Reservierungen im Überblick" },
];

function id() { return crypto.randomUUID(); }
function modelProviderName(provider: ModelProfile["provider"]) {
  return ({ groq: "GroqCloud", gwdg: "GWDG SAIA", openai: "OpenAI", anthropic: "Anthropic", custom: "Custom endpoint" })[provider];
}
function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function canRequestCancellation(booking: Booking, now = Date.now()) {
  const status = booking.status.toLowerCase();
  return ["requested", "accepted", "confirmed"].includes(status)
    && Number.isFinite(Date.parse(booking.startDate))
    && Date.parse(booking.startDate) > now;
}

function bookingStatusLabel(status: string) {
  switch (status.toLowerCase()) {
    case "requested":
    case "pending": return "Angefragt";
    case "accepted":
    case "confirmed": return "Bestätigt";
    case "cancelled":
    case "canceled": return "Storniert";
    default: return status;
  }
}

function sameProposalSnapshot(displayed: Proposal, authoritative: Proposal) {
  const sameInstant = (left: string, right: string) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    return Number.isFinite(leftTime) && leftTime === rightTime;
  };
  return displayed.id === authoritative.id
    && (displayed.action ?? "book") === (authoritative.action ?? "book")
    && displayed.resourceName === authoritative.resourceName
    && sameInstant(displayed.startDate, authoritative.startDate)
    && sameInstant(displayed.endDate, authoritative.endDate);
}

function roomIdentityKey(resource: Resource) {
  return `${resource.serviceId}:${resource.id}`;
}

export function AssistantPage() {
  const { user } = useSession();
  return user ? <ChatWorkspace key={user.id} user={user} /> : null;
}

function ChatWorkspace({ user }: { user: User }) {
  // SessionProvider establishes the account on the client before this mounts.
  const store = useChatWorkspaceStore();
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const drawer = useRef<HTMLDialogElement>(null);
  const [configuration, setConfiguration] = useState<ModelConfiguration>({ profiles: [], userChoiceEnabled: false, defaultProfileId: "groq-oss-120b", loading: true, error: null });

  useEffect(() => {
    let active = true;
    fetch("/api/chat", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("configuration");
      const result = modelProfilesResponseSchema.safeParse(await response.json());
      if (!result.success) throw new Error("configuration");
      return result.data;
    }).then((result) => {
      if (active) store.setDefaultProfile(result.defaultProfileId);
      if (active) setConfiguration({ profiles: result.profiles, userChoiceEnabled: result.userChoiceEnabled, defaultProfileId: result.defaultProfileId, loading: false, error: null });
    }).catch(() => { if (active) setConfiguration({ profiles: [], userChoiceEnabled: false, defaultProfileId: "groq-oss-120b", loading: false, error: "Der Modellstatus konnte nicht geladen werden." }); });
    return () => {
      active = false;
      const latest = store.getSnapshot();
      for (const session of latest.workspace.sessions) {
        if (latest.busy[session.id]) store.update(session.id, { ...session.snapshot, interrupted: true }, false);
      }
    };
  }, [store]);

  function newChat() { store.create(configuration.defaultProfileId); drawer.current?.close(); }

  return <section className="chat-workspace" aria-label="Deine Chatverläufe">
    <dialog className="chat-history-dialog" ref={drawer} id="chat-conversations-dialog" aria-label="Unterhaltungen" onClick={(event) => { if (event.target === event.currentTarget) drawer.current?.close(); }}><div className="chat-history-dialog-body"><ChatSessionList view={view} store={store} close={() => drawer.current?.close()} /></div></dialog>
    <div className="chat-conversations">
      {view.notice && <div className="chat-storage-notice" role="status"><span>{view.notice}</span><button className="icon-button" type="button" aria-label="Hinweis schließen" onClick={store.dismissNotice}><X size={16} /></button></div>}
      {!configuration.loading && view.workspace.sessions.map((session) => <Conversation key={session.id} sessionId={session.id} ownerId={user.id} initial={session.snapshot} name={user.displayName.split(/\s|·/)[0] ?? ""} active={session.id === view.workspace.activeId} configuration={configuration} onSnapshot={store.update} onNewChat={newChat} newChatDisabled={!canStartNewChat(view)} onShowHistory={() => drawer.current?.showModal()} />)}
    </div>
  </section>;
}

type ConversationProps = { sessionId: string; ownerId: string; name: string; initial: ChatSnapshot; active: boolean; configuration: ModelConfiguration; onSnapshot: (id: string, snapshot: ChatSnapshot, busy: boolean) => void; onNewChat: () => void; newChatDisabled: boolean; onShowHistory: () => void };

function Conversation({ sessionId, ownerId, name, initial, active, configuration, onSnapshot, onNewChat, newChatDisabled, onShowHistory }: ConversationProps) {
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
  const { profiles, loading: modelLoading } = configuration;
  const lock = useRef(false);
  const alive = useRef(true);
  const history = useRef<WireMessage[]>(structuredClone(initial.history));
  const routingToken = useRef<string | undefined>(undefined);
  const resolvedProfile = useRef<ModelProfile["provider"] | null>(null);
  const [fallbackLabel, setFallbackLabel] = useState<string | null>(null);
  const toolBridge = useRef<ReturnType<typeof createAnnyChatTools> | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const messageClock = useRef<ReturnType<typeof createChatMessageClock> | null>(null);
  messageClock.current ??= createChatMessageClock(events => postForChat("/api/chat/timestamps", { messages: events }));
  const latestMessage = messages.at(-1)?.id;
  const offline = profileId === "offline";
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const defaultProfile = profiles.find((profile) => profile.id === configuration.defaultProfileId);
  const isDefaultProfile = profileId === configuration.defaultProfileId;
  const providerLabel = selectedProfile?.provider === "gwdg" ? "GWDG SAIA"
    : selectedProfile?.provider === "groq" ? "GroqCloud"
      : selectedProfile?.provider === "custom" ? "Custom endpoint"
        : selectedProfile?.provider === "openai" ? "OpenAI"
          : selectedProfile?.provider === "anthropic" ? "Anthropic" : null;
  const modelError = modelLoading ? null
    : offline
      ? configuration.userChoiceEnabled ? null : "Die Dialog-Demo ist für diesen Chat nicht freigegeben. Beginne einen neuen Chat mit dem konfigurierten Standardmodell."
      : !configuration.userChoiceEnabled && !isDefaultProfile
        ? `Das gespeicherte Modell „${profileId}“ ist in dieser Konfiguration nicht freigegeben. Beginne einen neuen Chat mit dem Standardmodell.`
        : !selectedProfile
          ? configuration.error ?? `Das gespeicherte Modell „${profileId}“ ist nicht verfügbar. Wähle ein freigegebenes Modell.`
          : !selectedProfile.configured
            ? `${providerLabel ?? "Der ausgewählte Modellanbieter"} ist für dieses Modell nicht konfiguriert. Bitte wähle ausdrücklich ein verfügbares Modell${configuration.userChoiceEnabled ? " oder die Dialog-Demo" : ""}.`
            : configuration.error;
  const canSend = !modelLoading && (offline
    ? configuration.userChoiceEnabled
    : !configuration.error && (configuration.userChoiceEnabled || isDefaultProfile) && selectedProfile?.configured === true);
  const staticProfileLabel = offline ? "Dialog-Demo" : selectedProfile?.label ?? (isDefaultProfile ? defaultProfile?.label ?? configuration.defaultProfileId : "Gespeichertes Modell nicht verfügbar");

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

  function remember<T extends WireMessage>(message: T): T {
    return messageClock.current!.track(message);
  }

  function appendHistory(role: "user" | "assistant", text: string, eventId = id()) {
    const previous = history.current.at(-1);
    // A combined history status is a separate event from the visible new text.
    const historyId = role === "assistant" && previous?.role === "assistant" && !previous.toolCalls?.length ? id() : eventId;
    const message = appendChatText(history.current, role, text, historyId);
    if (message) remember(message);
  }

  async function stampMessages() {
    const timestamps = await messageClock.current!.flush();
    if (timestamps.size) history.current = history.current.map(message => message.id && timestamps.has(message.id) ? { ...message, timestamp: timestamps.get(message.id)! } : message);
    if (timestamps.size) setMessages(previous => previous.map(message => timestamps.has(message.id) ? { ...message, timestamp: timestamps.get(message.id)! } : message));
  }

  function add(message: Omit<Message, "id">, messageId = id()) {
    if (offline) appendHistory(message.role, message.text, messageId);
    remember({ id: messageId, role: message.role, content: message.text, ...(message.timestamp ? { timestamp: message.timestamp } : {}) });
    if (messages.length >= 200) setMessagesTruncated(true);
    setMessages((previous) => [...previous.slice(-199), { ...message, id: messageId }]);
    return messageId;
  }

  function addActionResult(message: Omit<Message, "id" | "role">) {
    if (!offline) appendHistory("assistant", message.text);
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

  async function finish() {
    try { await stampMessages(); }
    catch { /* Preserve the conversation with unknown times if the clock is unavailable. */ }

    lock.current = false;
    pendingRequest.current = null;
    setBusy(false);
  }

  function recordTool(name: import("@/lib/chat-contract").ChatToolName, arguments_: Record<string, unknown>, output: Record<string, unknown>) {
    const callId = id();
    history.current.push(remember({ role: "assistant", content: "", toolCalls: [{ id: callId, name, arguments: arguments_ }] }));
    history.current.push(remember({ role: "tool", content: JSON.stringify(output), toolCallId: callId, name }));
  }

  function showToolResult(result: AnnyChatToolResult, interactionId: string, model: string) {
    const labels = {
      anny_search_resources: "anny · Raumsuche",
      anny_get_availability: "anny · Verfügbarkeit",
      anny_list_my_bookings: "anny · Eigene Buchungen",
      anny_propose_booking: "anny · Buchungsvorschlag",
      anny_propose_cancellation: "anny · Stornierungsvorschlag",
    };
    const refinementQuestion = typeof result.output.refinementQuestion === "string" ? result.output.refinementQuestion : undefined;
    const clarificationQuestion = typeof result.output.clarificationRequired === "string" ? result.output.clarificationRequired : undefined;
    const notice = typeof result.output.notice === "string" ? result.output.notice : undefined;
    const question = result.output.refinementRequired === true
      ? refinementQuestion ?? clarificationQuestion ?? "Bitte präzisiere, ob du ein Einzelbüro oder ein gemeinsames Büro suchst."
      : clarificationQuestion;
    const questionText = question && notice && !question.includes(notice) ? `${question}\n${notice}` : question ?? notice;
    const returned = typeof result.output.returned === "number" && Number.isInteger(result.output.returned) && result.output.returned >= 0 ? result.output.returned : 0;
    const truncated = typeof result.output.truncated === "number" && Number.isInteger(result.output.truncated) && result.output.truncated > 0 ? result.output.truncated : 0;
    const truncatedSearchText = result.name === "anny_search_resources" && truncated > 0
      ? `${returned + truncated} passende Katalogtreffer. Die Karten enthalten die ersten ${returned}; die Verfügbarkeit wurde noch nicht geprüft. Mit einem Büronamen oder Standort kannst du die Suche eingrenzen.`
      : undefined;
    const text = result.proposal?.action === "cancel_booking" ? "Der Stornierungsvorschlag ist vorbereitet. Prüfe die Buchung; erst die separate Bestätigung auf dieser Karte führt die Stornierung aus."
      : result.proposal ? "Bitte prüfe den Buchungsvorschlag. Erst die Bestätigung auf dieser Karte löst die Testbuchung aus."
      : question ? questionText ?? question
      : truncatedSearchText ?? questionText
      ?? (result.rooms ? (result.rooms.length ? "Ergebnisse aus den anny-Testdaten." : "Keine Treffer für diese Suchfilter. Die Verfügbarkeit wurde noch nicht geprüft.")
      : result.bookings ? (result.bookings.length ? "Deine Buchungen aus der Testumgebung." : "Du hast noch keine Testbuchungen.") : "Tool-Abfrage abgeschlossen.");
    add({ role: "assistant", text, tool: labels[result.name], rooms: result.rooms, bookings: result.bookings, proposal: result.proposal, model, interactionId });
    if (result.rooms) setActiveResult(interactionId);
    if (result.proposal) setActiveProposal(result.proposal.id);
  }

  async function runModel() {
    // Drop complete oldest turns only; never separate a tool call from its result.
    while (history.current.length > 36 || JSON.stringify(history.current).length > 22_000) {
      const nextTurn = history.current.findIndex((message, index) => index > 0 && message.role === "user");
      if (nextTurn < 0) { history.current = []; break; }
      history.current.splice(0, nextTurn);
    }
    const interactionId = id();
    const controller = pendingRequest.current!;
    const latestUserText = [...history.current].reverse().find((message) => message.role === "user")?.content ?? "";
    const cancellationRequested = /\b(?:storn\w*|kündig\w*|cancel\w*|annull\w*)\b/iu.test(latestUserText);
    try {
      for (let step = 0; step < 4; step += 1) {
        setActivity(`${resolvedProfile.current ? modelProviderName(resolvedProfile.current) : providerLabel ?? "Das Modell"} antwortet …`);
        await stampMessages();
        const response = await fetch("/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId, ...(routingToken.current ? { routingToken: routingToken.current } : {}), messages: history.current }), signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({ error: "Der Chat-Dienst ist gerade nicht erreichbar. Bitte versuche es später erneut." }));
        if (!response.ok) {
          const error = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Der ausgewählte Modellanbieter ist gerade nicht verfügbar.";
          throw new Error(error);
        }
        const validated = modelReplySchema.safeParse(payload);
        if (!validated.success) throw new Error("Die Modellantwort entspricht nicht dem erwarteten Format. Bitte versuche es erneut.");
        const reply = validated.data;
        resolvedProfile.current = reply.profile.provider;
        const actualLabel = `${modelProviderName(reply.profile.provider)} · ${reply.profile.label}`;
        setFallbackLabel(reply.profile.id !== profileId ? actualLabel : null);
        if (reply.routingToken) routingToken.current = reply.routingToken;
        history.current.push(reply.message);
        if (reply.message.content.trim()) add({ role: "assistant", text: reply.message.content, model: actualLabel, timestamp: reply.message.timestamp }, reply.message.id);
        if (!reply.message.toolCalls?.length) return;
        let actionableResult = false;
        for (const call of reply.message.toolCalls) {
          setActivity(`anny · ${call.name === "anny_propose_booking" ? "Buchung vorbereiten" : call.name === "anny_propose_cancellation" ? "Stornierung vorbereiten" : "Testdaten abfragen"}`);
          let output: Record<string, unknown>;
          try {
            if (call.name === "knowledge_search") {
              setActivity("Wissensdienst · Demoquellen suchen");
              const result = await searchKnowledge(requestForChat, call.arguments as { query: string; sourceSystem?: "service_it" | "intranet" });
              output = { ...result };
              add({ role: "assistant", text: result.documents.length ? "Gefundene Demoquellen. Die folgende Antwort wertet diese Beispiele aus." : "Keine passenden, für dein Testkonto freigegebenen Demoquellen gefunden.", tool: "Wissensdienst · MCP", sources: result.documents, model: actualLabel });
            } else {
            const result = await tools().run(call.name, call.arguments);
            output = result.output;
            showToolResult(result, interactionId, actualLabel);
            actionableResult ||= Boolean(result.proposal || result.bookings && !cancellationRequested
              || result.output.refinementRequired === true || typeof result.output.clarificationRequired === "string"
              || result.rooms?.some((room) => room.checked && room.intervals.length > 0));
            }
          } catch (cause) {
            output = { error: cause instanceof Error ? cause.message : "Das Tool konnte die Anfrage nicht abschließen." };
            add({ role: "assistant", text: String(output.error), tool: call.name === "knowledge_search" ? "Wissensdienst · Anfrage fehlgeschlagen" : "anny · Anfrage fehlgeschlagen" });
          }
          history.current.push(remember({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(output) }));
        }
        // Host-rendered cards already provide the answer and next action.
        // Avoid a redundant generation after availability, proposals or bookings.
        if (actionableResult) return;
      }
      add({ role: "assistant", text: "Die maximale Zahl an Modellschritten für diese Nachricht ist erreicht. Du kannst die angezeigten Karten nutzen oder eine weitere Nachricht schreiben." });
    } catch (cause) {
      appendHistory("assistant", "Die Verarbeitung der letzten Nachricht wurde durch einen technischen Fehler unterbrochen. Offene Schritte wurden nicht automatisch fortgesetzt; berücksichtige die bereits vorliegenden Tool-Ergebnisse.");
      throw cause;
    }
  }

  async function searchRooms(next: RoomRequest, selected: Resource | null) {
    const clarification = workplaceGroupQuestion(next);
    if (clarification) { add({ role: 'assistant', text: clarification }); return; }
    const missing = missingRoomDetails(next);
    const invalid = Object.values(next).some((value) => value === "__invalid__" || (typeof value === "number" && value <= 0) || (Array.isArray(value) && value.includes("__invalid__")));
    if (invalid) {
      add({ role: "assistant", text: `Diese Angaben sind für die Dialog-Demo nicht eindeutig. Bitte präzisiere: ${missing.join(", ") || "Ausstattung oder Suchbegriff"}. Du kannst mit „neue Raumsuche“ auch von vorn beginnen.` });
      return;
    }
    setActivity("anny · Räume suchen");
    const result = await requestForChat<{ resources: Resource[] }>("/api/resources");
    const matches = matchingResources(result.resources, next).filter((resource) => !selected || resource.id === selected.id);
    const refinement = selected ? null : workplaceRefinementQuestion(matches, next);
    if (refinement) {
      add({ role: "assistant", tool: "anny · Raumsuche", text: refinement.question });
      return;
    }
    if (next.kind === "workplace" && next.officeType && next.officeType !== "any" && matches.length === 0) {
      const unfiltered = matchingResources(result.resources, { ...next, officeType: undefined });
      const unknown = workplaceOfficeTypeCounts(unfiltered).unknown;
      if (unknown > 0) {
        const requestedName = next.officeType === "single" ? "Einzelbüro/1er-Büro" : "geteiltes/2er-/3er-Büro";
        add({
          role: "assistant",
          tool: "anny · Raumsuche",
          text: `Kein Arbeitsplatz-Treffer ist ausdrücklich als ${requestedName} dokumentiert. Bei ${unknown} weiteren Treffern ist der Bürotyp nicht dokumentiert; daraus folgt nicht, dass es dort keine passenden Büros gibt. Verfügbarkeit wurde nicht geprüft.`,
        });
        return;
      }
    }
    const resources = matches.slice(0, 8);
    if (!resources.length) {
      add({ role: "assistant", tool: "anny · Raumsuche", text: "Für diese Anforderungen finde ich in den zugänglichen Testdaten keinen Raum. Du kannst eine neue Raumsuche beginnen und die Anforderungen ändern." });
      return;
    }
    const startDate = requestStartDate(next);
    if (missing.length || !startDate || !next.durationMinutes) {
      const resultId = add({ role: "assistant", tool: "anny · Ressourcen suchen", text: `${selected ? `Wir planen mit ${selected.name}.` : `${matches.length} passende ${next.kind === 'workplace' ? 'Arbeitsplätze' : 'Ressourcen'} gefunden.${matches.length > resources.length ? ' Ich zeige die ersten acht; mit einem Büronamen oder Standort kannst du eingrenzen.' : ''}`} Für die Verfügbarkeitsprüfung brauche ich noch: ${missing.join(", ") || "ein gültiges Datum und eine gültige Startzeit"}. Antworte einfach hier im Chat, zum Beispiel „morgen um 14 Uhr für eine Stunde“.`, rooms: resources.map((resource) => ({ resource, intervals: [], checked: false })) });
      setActiveResult(resultId);
      return;
    }
    setActivity("anny · Verfügbarkeit prüfen");
    const options = await Promise.all(resources.map(async (resource) => {
      const availability = await postForChat<{ intervals: TimeInterval[] }>("/api/availability", { resourceId: resource.id, serviceId: resource.serviceId, startDate, durationMinutes: next.durationMinutes });
      const freeIntervals = availability.intervals.filter((interval) => interval.available);
      const exactInterval = freeIntervals.find((interval) => Date.parse(interval.startDate) === Date.parse(startDate));
      return { resource, requestedStartDate: startDate, intervals: exactInterval ? [exactInterval] : freeIntervals.slice(0, 3), checked: true };
    }));
    const count = options.filter((option) => option.intervals.length).length;
    const resultId = add({ role: "assistant", tool: "anny · Raumsuche und Verfügbarkeit", text: `${roomRequestSummary(next)}\n${count ? "Verfügbarkeit geprüft. Die Karten kennzeichnen Treffer im gewünschten Zeitraum und alternative freie Zeiten. Wähle eine Zeit, dann bereite ich den Buchungsvorschlag vor." : "Zu diesen Anforderungen sind keine Zeiten frei. Nenne mir einen anderen Zeitraum."}`, rooms: options });
    setActiveResult(resultId);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 2000 || !canSend || !start("Anfrage wird verarbeitet")) return;
    routingToken.current = undefined;
    resolvedProfile.current = null;
    setFallbackLabel(null);
    setInput("");
    const eventId = add({ role: "user", text: trimmed });
    if (!offline) appendHistory("user", trimmed, eventId);
    setActiveResult(null);
    const pendingProposal = activeProposal;
    setActiveProposal(null);
    try {
      await stampMessages();
      if (/^(ja|ok(?:ay)?|bestätigen|buche(?:n)?|mach das)[.!\s]*$/i.test(trimmed) && pendingProposal) {
        setActiveProposal(pendingProposal);
        const proposal = messages.find((message) => message.proposal?.id === pendingProposal)?.proposal;
        const text = proposal?.action === "cancel_booking"
          ? "Bitte prüfe die Buchung im Stornierungsvorschlag und nutze dort „Stornierung bestätigen“. Erst dieser Schritt löst die Stornierung aus."
          : "Bitte prüfe Raum und Zeitraum im Buchungsvorschlag und nutze dort „Buchung bestätigen“. Erst dieser Schritt löst die Buchung aus.";
        if (!offline) {
          appendHistory("assistant", text);
        }
        add({ role: "assistant", text });
        return;
      }
      if (!offline) {
        await runModel();
        return;
      }
      const cancellationIntent = /\b(?:storn\w*|kündig\w*|cancel\w*|annull\w*)\b/iu.test(trimmed);
      const refinedRequest = roomContext && request.kind === "workplace" ? mergeRoomRequest(trimmed, request) : null;
      const officeRefinementReply = refinedRequest !== null
        && refinedRequest.officeType !== request.officeType
        && refinedRequest.officeType !== undefined;
      const intent = cancellationIntent ? "bookings" : officeRefinementReply ? "rooms" : classifyIntent(trimmed, roomContext);
      if (intent === "bookings") {
        setActivity("anny · Eigene Buchungen laden");
        const result = await requestForChat<{ bookings: Booking[] }>("/api/bookings");
        const text = cancellationIntent
          ? result.bookings.length ? "Hier sind deine eigenen Buchungen. Bei einer aktiven zukünftigen Buchung kannst du eine Stornierung vorbereiten; ausgeführt wird sie erst nach Prüfung und Bestätigung auf der Vorschlagskarte." : "Du hast in der Testumgebung keine eigenen Buchungen, die du stornieren kannst."
          : result.bookings.length ? "Hier sind deine Buchungen aus der Testumgebung." : "Du hast in der Testumgebung noch keine Testbuchungen. Soll ich einen Raum für dich suchen?";
        add({ role: "assistant", tool: "anny · Eigene Buchungen", text, bookings: result.bookings });
        setRoomContext(false);
      } else if (intent === "knowledge") {
        setRoomContext(false);
        setActivity("Wissensdienst · Demoquellen suchen");
        const result = await searchKnowledge(requestForChat, { query: trimmed });
        add({ role: "assistant", text: result.documents.length ? "Diese synthetischen Dokumente passen zu deiner Frage. In der Dialog-Demo kannst du die Quellen lesen; für eine formulierte Antwort wähle ein Sprachmodell." : "Keine passenden, für dein Testkonto freigegebenen Demoquellen gefunden.", tool: "Wissensdienst · MCP", sources: result.documents });
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
        add({ role: "assistant", text: intent === "greeting" ? `Hallo ${name}. Was möchtest du erledigen? Ich kann in dieser Demo Räume suchen, Buchungen vorbereiten und deine Reservierungen anzeigen.` : "Ich kann in dieser Dialog-Demo Räume suchen und buchen sowie deine Buchungen anzeigen. Schreib zum Beispiel: „Morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.“ Zu IT- und Intranet-Fragen kann ich außerdem synthetische Demoquellen suchen." });
      }
    } catch (cause) {
      add({ role: "assistant", text: cause instanceof Error ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut." });
    } finally {
      await finish();
    }
  }

  async function chooseRoom(resource: Resource) {
    const label = `${resource.kind === 'workplace' ? 'einen einzelnen Arbeitsplatz: ' : ''}${resource.name}${resource.parentName ? ` im Büro ${resource.parentName}` : ''}`;
    if (!offline) { await send(`Ich möchte ${label} buchen (resourceId: ${resource.id}). Verwende genau diese Ressource und frage nach noch fehlenden Angaben.`); return; }
    if (!start("Raum auswählen")) return;
    setChosenRoom(resource);
    const next = { ...request, kind: resource.kind ?? 'room' as const };
    setRequest(next);
    setRoomContext(true);
    setActiveResult(null);
    setActiveProposal(null);
    add({ role: "user", text: `Ich möchte ${label} buchen.` });
    try { await stampMessages(); await searchRooms(next, resource); }
    catch (cause) { add({ role: "assistant", text: cause instanceof Error ? cause.message : "Der Raum konnte nicht geprüft werden." }); }
    finally { await finish(); if (active) composer.current?.focus(); }
  }

  async function prepare(resource: Resource, interval: TimeInterval) {
    if (!start("anny · Buchung vorbereiten")) return;
    setActiveResult(null);
    setActiveProposal(null);
    const selection = `${resource.kind === 'workplace' ? 'Einzelner Arbeitsplatz: ' : ''}${resource.name}${resource.parentName ? ` · ${resource.parentName}` : ''}, ${formatDateTime(interval.startDate)} bis ${formatTime(interval.endDate)} Uhr. Bitte vorbereiten.`;
    const eventId = add({ role: "user", text: selection });
    if (!offline) appendHistory("user", selection, eventId);
    try {
      await stampMessages();
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
    finally { await finish(); }
  }

  async function prepareCancellation(booking: Booking) {
    if (!canRequestCancellation(booking) || !start("anny · Stornierung vorbereiten")) return;
    setActiveResult(null);
    setActiveProposal(null);
    const selection = `Stornierung vorbereiten: ${booking.resourceName}, ${formatDateTime(booking.startDate)} bis ${formatTime(booking.endDate)} Uhr.`;
    const eventId = add({ role: "user", text: selection });
    if (!offline) appendHistory("user", selection, eventId);
    try {
      await stampMessages();
      const args = { bookingId: booking.id };
      const result = await tools().run("anny_propose_cancellation", args);
      if (!result.proposal || result.proposal.action !== "cancel_booking") throw new Error("Es wurde kein Stornierungsvorschlag zurückgegeben.");
      if (!offline) recordTool("anny_propose_cancellation", args, result.output);
      addActionResult({
        text: "Der Stornierungsvorschlag ist vorbereitet. Prüfe die angezeigte Buchung und bestätige die Stornierung ausdrücklich.",
        tool: "anny · Stornierungsvorschlag",
        proposal: result.proposal,
      });
      setActiveProposal(result.proposal.id);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Der Stornierungsvorschlag konnte nicht erstellt werden.";
      addActionResult({ text: `Der Stornierungsvorschlag konnte nicht erstellt werden. ${detail}` });
    } finally {
      await finish();
    }
  }

  async function confirm(proposal: Proposal) {
    const cancellation = proposal.action === "cancel_booking";
    if (activeProposal !== proposal.id || !start(cancellation ? "anny · Stornierung ausführen" : "anny · Bestätigte Buchung ausführen")) return;
    let executionAttempted = false;
    const action = cancellation
      ? `Ich bestätige die Stornierung der angezeigten Buchung für ${proposal.resourceName}, ${formatDateTime(proposal.startDate)} bis ${formatTime(proposal.endDate)} Uhr über die Schaltfläche.`
      : `Ich bestätige den angezeigten Buchungsvorschlag für ${proposal.resourceName}, ${formatDateTime(proposal.startDate)} bis ${formatTime(proposal.endDate)} Uhr über die Schaltfläche.`;
    const eventId = add({ role: "user", text: action });
    if (!offline) appendHistory("user", action, eventId);
    try {
      await stampMessages();
      const proposalUrl = `/api/proposals/${encodeURIComponent(proposal.id)}`;
      const current = await requestForChat<{ proposal?: Proposal & { arguments?: { bookingId?: string } } }>(proposalUrl);
      const authoritative = current.proposal;
      const currentAction = authoritative?.action ?? "book";
      const canonicalBookingId = authoritative?.arguments?.bookingId;
      if (!authoritative || authoritative.status !== "pending" || !sameProposalSnapshot(proposal, authoritative)
        || (cancellation && (currentAction !== "cancel_booking" || typeof canonicalBookingId !== "string" || !canonicalBookingId.trim()))) {
        setActiveProposal(null);
        const text = authoritative?.status === "outcome_unknown"
          ? cancellation ? "Der Status der Stornierung ist bereits unklar. Prüfe deine Buchungen, bevor du einen weiteren Vorschlag erstellst." : "Der Status der Buchung ist unklar. Prüfe deine Buchungen, bevor du einen weiteren Vorschlag erstellst."
          : authoritative?.status === "confirmed"
            ? cancellation ? "Dieser Stornierungsvorschlag wurde bereits abgeschlossen. Prüfe deine Buchungen." : "Dieser Buchungsvorschlag wurde bereits abgeschlossen. Prüfe deine Buchungen."
            : cancellation ? "Der Stornierungsvorschlag stimmt nicht mehr mit der gespeicherten Buchung überein oder ist nicht mehr offen. Lade deine Buchungen erneut und bereite einen neuen Vorschlag vor." : "Der Buchungsvorschlag stimmt nicht mehr mit dem gespeicherten Vorschlag überein oder ist nicht mehr offen. Suche erneut nach freien Zeiten.";
        addActionResult({ text });
        return;
      }
      executionAttempted = true;
      const result = await postForChat<{ proposal: Proposal; bookingId?: string; status?: "cancelled" }>(`${proposalUrl}/confirm`, {});
      const responseMatches = sameProposalSnapshot(proposal, result.proposal);
      const bookingIdMatches = cancellation && typeof result.bookingId === "string"
        && result.bookingId.trim().length > 0 && result.bookingId === canonicalBookingId;
      const confirmed = responseMatches && result.proposal.status === "confirmed"
        && (!cancellation || result.status === "cancelled" && bookingIdMatches);
      if (confirmed) {
        setActiveProposal(null);
        if (cancellation) {
          if (result.status === "cancelled" && result.bookingId && bookingIdMatches) {
            setMessages((previous) => previous.map((message) => message.bookings
              ? { ...message, bookings: message.bookings.map((booking) => booking.id === result.bookingId ? { ...booking, status: "cancelled" } : booking) }
              : message));
          }
          addActionResult({ text: `Die Stornierung der Testbuchung für ${result.proposal.resourceName} wurde bestätigt. ${formatDateTime(result.proposal.startDate)} bis ${formatTime(result.proposal.endDate)} Uhr.`, tool: "anny · Stornierung ausgeführt" });
        } else {
          setRoomContext(false);
          setRequest({});
          setChosenRoom(null);
          addActionResult({ text: `Die Testbuchung für ${result.proposal.resourceName} ist bestätigt. ${formatDateTime(result.proposal.startDate)} bis ${formatTime(result.proposal.endDate)} Uhr.`, tool: "anny · Buchung ausgeführt", confirmed: true });
        }
      } else {
        setActiveProposal(null);
        const text = cancellation
          ? !responseMatches || result.proposal.status === "outcome_unknown" || result.proposal.status === "confirmed" ? "Die Antwort passt nicht eindeutig zum angezeigten Stornierungsvorschlag. Prüfe deine Buchungen, bevor du einen neuen Vorschlag erstellst." : "Die Stornierung konnte nicht bestätigt werden. Prüfe den Buchungsstatus, bevor du erneut vorgehst."
          : result.proposal.status === "outcome_unknown" ? "Der Buchungsdienst hat nicht eindeutig geantwortet. Prüfe deine Buchungen, bevor du erneut buchst." : "Die Buchung konnte nicht bestätigt werden. Bitte suche erneut nach freien Zeiten.";
        addActionResult({ text });
      }
    } catch (cause) {
      setActiveProposal(null);
      const detail = cause instanceof Error ? cause.message : "Der Dienst hat nicht geantwortet.";
      const text = cancellation
        ? executionAttempted
          ? `Die Antwort auf die Stornierung war nicht eindeutig. ${detail} Prüfe zuerst den Status deiner Buchung und erstelle keinen neuen Vorschlag, bevor du das Ergebnis geklärt hast.`
          : `Der Stornierungsvorschlag konnte nicht vorab geprüft werden; eine Ausführung wurde nicht angefordert. ${detail} Lade deine Buchungen erneut und prüfe den Status.`
        : executionAttempted
          ? `Die Antwort auf die Buchung war nicht eindeutig. ${detail} Prüfe zuerst deine Buchungen, bevor du erneut buchst.`
          : `Der Buchungsvorschlag konnte nicht vorab geprüft werden und wurde nicht ausgeführt. ${detail} Suche erneut nach freien Zeiten.`;
      addActionResult({ text });
    }
    finally { await finish(); }
  }

  const checkedResourcesByInteraction = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!message.interactionId || !message.rooms) continue;
    const checkedRooms = message.rooms.filter((room) => room.checked);
    if (!checkedRooms.length) continue;
    const identities = checkedResourcesByInteraction.get(message.interactionId) ?? new Set<string>();
    for (const room of checkedRooms) identities.add(roomIdentityKey(room.resource));
    checkedResourcesByInteraction.set(message.interactionId, identities);
  }
  const renderedMessages = messages.flatMap((message) => {
    if (!message.interactionId || !message.rooms) return [message];
    const checkedIdentities = checkedResourcesByInteraction.get(message.interactionId);
    if (!checkedIdentities) return [message];
    if (message.rooms.length === 0) return [message];
    const rooms = message.rooms.filter((room) => room.checked || !checkedIdentities.has(roomIdentityKey(room.resource)));
    if (!rooms.length) return [];
    return rooms.length === message.rooms.length ? [message] : [{ ...message, rooms }];
  });

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void send(input); }

  return (
    <section className="chat-page" aria-label="HASI Chat" hidden={!active}>
      <div className="chat-toolbar"><button className="chat-history-toggle icon-button" type="button" onClick={onShowHistory} aria-label="Unterhaltungen anzeigen" title="Unterhaltungen anzeigen" aria-haspopup="dialog" aria-controls="chat-conversations-dialog"><PanelLeft size={19} aria-hidden="true" /><span>Chats</span></button>{configuration.userChoiceEnabled ? <label className="chat-model-picker"><MessageCircle size={15} aria-hidden="true" /><span className="sr-only">Sprachmodell</span><select aria-label="Sprachmodell" value={profileId} disabled={busy || modelLoading} onChange={(event) => { const parsed = chatProfileIdSchema.safeParse(event.currentTarget.value); if (!parsed.success) return; if (parsed.data === "offline" ? configuration.userChoiceEnabled : profiles.some((profile) => profile.id === parsed.data && profile.configured)) setProfileId(parsed.data); }}>{!offline && !selectedProfile && <option value={profileId} disabled>Gespeichertes Modell nicht verfügbar</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!profile.configured}>{profile.label}{profile.configured ? "" : " · nicht konfiguriert"}</option>)}<option value="offline">Dialog-Demo</option></select></label> : <span className="chat-model-picker" aria-label="Sprachmodell"><MessageCircle size={15} aria-hidden="true" />{modelLoading ? "Modellstatus wird geladen …" : staticProfileLabel}</span>}<button type="button" onClick={onNewChat} disabled={newChatDisabled} title={newChatDisabled ? "Dieser Chat ist noch leer oder das Chatlimit ist erreicht." : undefined} className="chat-new" aria-label="Neuer Chat"><Plus size={16} aria-hidden="true" /><span>Neuer Chat</span></button></div>
      {fallbackLabel && <p className="chat-recovery-note" role="status">Ausweichmodell für diesen Dialog: {fallbackLabel}</p>}
      {modelError && <p className="chat-model-error" role="status">{modelError}</p>}
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
            {renderedMessages.map((message) => (
              <article key={message.id} className={`chat-message chat-message--${message.role}`} aria-label={message.role === "user" ? "Du" : "HASI"}>
                <span className="chat-speaker">{message.role === "user" ? "Du" : <><Sparkles size={14} aria-hidden="true" /> HASI {message.model && <small>{message.model}</small>}</>}</span>
                {message.timestamp ? <time className="chat-message-time" dateTime={message.timestamp.createdAt} title="Servereingang · Europe/Berlin">{formatMessageTime(message.timestamp.createdAt)}</time> : <span className="chat-message-time">Zeitpunkt unbekannt</span>}
                <div className="chat-message-body">
                  {message.tool && <span className="chat-tool-label"><Check size={13} aria-hidden="true" /> {message.tool}</span>}
                  <p>{message.text}</p>
                  {message.rooms && <ChatRoomResults
                    rooms={message.rooms}
                    disabled={busy || (activeResult !== message.id && activeResult !== message.interactionId)}
                    onChooseRoom={(resource) => void chooseRoom(resource)}
                    onChooseSlot={(resource, interval) => void prepare(resource, interval)}
                  />}
                  {message.sources && message.sources.length > 0 && <div className="chat-source-list" aria-label="Gefundene Demoquellen">{message.sources.map((source) => <Link className="chat-source-card" href={knowledgeDocumentHref(source.id)} target="_blank" rel="noreferrer" key={source.id}><BookOpen size={18} aria-hidden="true" /><span><small>{knowledgeSourceLabel(source.sourceSystem)} · Fassung {source.revision}</small><strong>{source.title}</strong><code>{source.citationId}</code></span><ArrowRight size={16} aria-hidden="true" /></Link>)}</div>}
                  {message.proposal && <div className="chat-tool-card chat-proposal">
                    <span className="chat-proposal-label">{message.proposal.action === "cancel_booking" ? "STORNIERUNG PRÜFEN" : "BITTE PRÜFEN UND BESTÄTIGEN"}</span>
                    <h2>{message.proposal.resourceName}</h2>
                    <p>{formatDateTime(message.proposal.startDate)} bis {formatTime(message.proposal.endDate)} Uhr</p>
                    {message.proposal.action === "cancel_booking" && <p>Diese bestehende Buchung wird erst nach deiner Bestätigung storniert.</p>}
                    <small>Gültig bis {formatTime(message.proposal.expiresAt)} Uhr · Testumgebung</small>
                    <button className="button button--primary button--wide" type="button" disabled={busy || activeProposal !== message.proposal.id} onClick={() => void confirm(message.proposal!)}>
                      {activeProposal === message.proposal.id ? message.proposal.action === "cancel_booking" ? "Stornierung bestätigen" : "Buchung bestätigen" : message.proposal.action === "cancel_booking" ? "Stornierungsvorschlag abgeschlossen oder ersetzt" : "Vorschlag abgeschlossen oder ersetzt"}
                      <Check size={16} aria-hidden="true" />
                    </button>
                  </div>}
                  {message.bookings && message.bookings.length > 0 && <div className="chat-booking-list">{message.bookings.map((booking) => <div className="chat-tool-card" key={booking.id}><h2>{booking.resourceName}</h2><p>{formatDateTime(booking.startDate)} bis {formatTime(booking.endDate)} Uhr</p><span className="chat-booking-status">{bookingStatusLabel(booking.status)}</span>{canRequestCancellation(booking) && <button className="chat-card-action" type="button" disabled={busy} onClick={() => void prepareCancellation(booking)}>Stornierung vorbereiten <ArrowRight size={15} aria-hidden="true" /></button>}</div>)}</div>}
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
          <div className="chat-composer-bottom"><span><span className="status-dot" /> {offline ? "Dialog-Demo · ohne Sprachmodell" : modelLoading ? "Modellstatus wird geladen …" : selectedProfile?.configured ? `${providerLabel} · anny-Testdaten` : `${providerLabel ?? "Modellanbieter"} nicht konfiguriert`}</span><button type="submit" aria-label="Nachricht senden" disabled={busy || !canSend || !input.trim()}><ArrowUp size={20} aria-hidden="true" /></button></div>
        </form>
        <p className="chat-footnote">{offline ? "Dialog-Demo mit Testdaten · synthetisches IT- und Intranet-Wissen" : `Nachrichten und ausgewählte Toolergebnisse gehen an ${providerLabel ?? "den ausgewählten Modellanbieter"}. Bitte nur Testdaten eingeben.${selectedProfile?.fallbackLabels?.length ? ` Konfigurierte Ausweichmodelle: ${selectedProfile.fallbackLabels.join(", ")}.` : ""}`}</p>
      </div>
    </section>
  );
}
