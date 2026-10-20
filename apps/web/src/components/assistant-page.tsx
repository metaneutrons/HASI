"use client";

import { asksForActionControls, currentActionControls } from "@/lib/chat-action-guidance";

import { ArrowRight, ArrowUp, BookOpen, CalendarDays, Check, MessageCircle, PanelLeft, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { HasiIcon } from "@/components/hasi-icon";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject, type SyntheticEvent } from "react";
import { apiRequest, formatDateTime, formatTime } from "@/lib/api";
import { classifyIntent, mergeRoomRequest, requestStartDate, roomRequestSummary, type RoomRequest } from "@/lib/chat-demo";
import { hostDialogueMessageSchema, staticHostDialogue, type HostDialogueMessage, type StaticHostDialogueCode } from "@/lib/host-dialogue";
import { planRoomDialogue } from "@/lib/room-dialogue";
import { parseRoomDialogueResponse } from "@/lib/host-dialogue-client";
import type { Booking, Resource, TimeInterval, User } from "@/lib/types";
import { useChatWorkspaceStore } from "@/components/chat-sidebar-context";
import { useSession } from "@/components/session-provider";
import { availabilityInputForSlot, createAnnyChatTools, type AnnyChatToolResult } from "@/lib/anny-chat-tools";
import { knowledgeModelDocuments, knowledgeSourceMessage, knowledgeSourceSummary, searchKnowledge } from "@/lib/knowledge";
import { chatKnowledgeCitations } from "@/lib/chat-knowledge-citations";
import { knowledgeCitationHref } from "@/lib/knowledge-citations";
import { knowledgeChatReturnHref, knowledgeOrigin, knowledgeReturnLocation } from "@/lib/knowledge-navigation";
import { chatProfileIdSchema, chatToolSchemas, isChatToolName, modelProfilesResponseSchema, modelReplySchema, type ChatToolCallName, type ChatToolName, type MessageTimestamp, type ModelProfile, type ModelProfileId, type WireMessage } from "@/lib/chat-contract";
import { createChatMessageClock } from "@/lib/chat-message-clock";
import { appendChatText, trimChatHistory } from "@/lib/chat-history";
import type { AnnyChatProposal, ChatMessage as Message, ChatProposal as Proposal, ChatSnapshot } from "@/lib/chat-sessions";
import { assertRequestedRoomTime, requestedRoomInterval, RoomTimeMismatchError, RoomTimeUnresolvedError } from "@/lib/chat-room-time";
import { canStartNewChat } from "@/lib/chat-workspace-store";
import { ChatSessionList } from "@/components/chat-session-list";
import { MAX_MODEL_STEPS, annyWorkflow, toolNeedsModelFollowUp, toolBatchNeedsModelFollowUp, isAvailabilityFollowUp, isMixedKnowledgeRequest, officePreferenceSearch, isOwnBookingsRequest } from "@/lib/chat-tool-loop";
import { ActionPreviewDetails, ActionStatusControl } from "@/components/action-status";
import { classifyProposalFailure } from "@/lib/proposal-failure";
import { proposalPresentation, readProposalSnapshot, sameProposalDetails } from "@/lib/proposal-presentation";
import { PersonalConnectionNotice } from "@/components/personal-connection-notice";
import { ChatServiceConnection } from "@/components/chat-service-connection";
import { parsePluginAccountList } from "@/lib/plugin-accounts";
import { ChatMessageCopy } from "@/components/chat-message-copy";
import { ChatMarkdown } from "@/components/chat-markdown";
import { bookingStatusLabel } from "@/lib/chat-message-copy";
import { ChatRoomResults } from "@/components/chat-room-results";
import { PluginResultApp } from "@/components/plugin-result-app";
import { pluginResultReadResponseSchema, boundedPluginToolResult, compactPluginToolResult, parsePluginProposal, parsePluginProposalSnapshot, parsePluginTools, pluginToolProposalPresentation, samePluginProposalSnapshot, type PluginToolDescriptor, type PluginToolProposal } from "@/lib/plugin-tools";

interface ModelConfiguration { profiles: ModelProfile[]; userChoiceEnabled: boolean; defaultProfileId: ModelProfileId; loading: boolean; error: string | null }
interface ComposerSelection { start: number; end: number; direction: HTMLTextAreaElement["selectionDirection"] }

const suggestions = [
  { icon: Search, title: "Einen Raum finden", text: "Ich brauche morgen um 14 Uhr einen Raum für vier Personen für eine Stunde.", caption: "Gemeinsam planen und buchen" },
  { icon: BookOpen, title: "Eine IT-Frage stellen", text: "Wie prüfe ich in der Service-IT-Demo den WLAN-Zugang Morgenstern-Lab?", caption: "Service IT und Intranet mit Quellen" },
  { icon: CalendarDays, title: "Meine Buchungen", text: "Zeige mir meine Buchungen.", caption: "Deine Reservierungen im Überblick" },
];

function id() { return crypto.randomUUID(); }
function modelProviderName(provider: ModelProfile["provider"]) {
  return ({ groq: "GroqCloud", gwdg: "GWDG SAIA", deepinfra: "DeepInfra", openai: "OpenAI", anthropic: "Anthropic", custom: "Custom endpoint" })[provider];
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


function roomIdentityKey(resource: Resource) {
  return `${resource.serviceId}:${resource.id}`;
}

/** Keep the explicit confirmation inside the chat viewport, including tall previews. */
function revealProposalCard(container: HTMLDivElement, card: HTMLDivElement) {
  const frame = container.getBoundingClientRect();
  const preview = card.getBoundingClientRect();
  const button = card.querySelector<HTMLButtonElement>("button[data-proposal-confirm]:not(:disabled)");
  const offset = button && preview.height > container.clientHeight - 32
    ? button.getBoundingClientRect().bottom - frame.bottom + 16
    : preview.top - frame.top - 16;
  container.scrollTo({ top: container.scrollTop + offset, behavior: "instant" });
}

const pluginAppsEnabled = process.env.NEXT_PUBLIC_HASI_PLUGIN_APPS === "1";

function requestWasAborted(active: boolean, signal: AbortSignal | undefined) {
  return !active || signal?.aborted === true;
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
  const composerFocus = useRef(new Map<string, ComposerSelection>());
  const [configuration, setConfiguration] = useState<ModelConfiguration>({ profiles: [], userChoiceEnabled: false, defaultProfileId: "groq-oss-120b", loading: true, error: null });

  useLayoutEffect(() => {
    const origin = knowledgeReturnLocation(window.location);
    if (!origin) return;
    const session = store.getSnapshot().workspace.sessions.find(item => item.id === origin.sessionId);
    if (session?.snapshot.messages.some(message => message.id === origin.messageId)) store.select(session.id);
    else window.history.replaceState(window.history.state, "", "/");
  }, [store]);

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
  const saveConversation = useCallback((id: string, snapshot: ChatSnapshot, busy: boolean) => {
    store.updateConversation(id, snapshot, busy);
  }, [store]);

  if (store.hasAuthorityChange()) return <section className="chat-workspace" aria-label="Deine Chatverläufe"><p role="status">Kontorechte werden aktualisiert …</p></section>;

  return <section className="chat-workspace" aria-label="Deine Chatverläufe">
    <dialog className="chat-history-dialog" ref={drawer} id="chat-conversations-dialog" aria-label="Unterhaltungen" onClick={(event) => { if (event.target === event.currentTarget) drawer.current?.close(); }}><div className="chat-history-dialog-body"><ChatSessionList view={view} store={store} close={() => drawer.current?.close()} /></div></dialog>
    <div className="chat-conversations">
      {view.notice && <div className="chat-storage-notice" role="status"><span>{view.notice}</span><button className="icon-button" type="button" aria-label="Hinweis schließen" onClick={() => { store.dismissNotice(); }}><X size={16} /></button></div>}
      {!configuration.loading && view.workspace.sessions.map((session) => <Conversation key={`${session.id}:${String(view.sessionEpochs[session.id] ?? 0)}`} composerFocus={composerFocus} sessionId={session.id} ownerId={user.id} initial={session.snapshot} name={user.displayName.split(/\s|·/)[0] ?? ""} active={session.id === view.workspace.activeId} configuration={configuration} onSnapshot={saveConversation} onDraft={(id, input) => { store.updateDraft(id, input); }} onNewChat={newChat} newChatDisabled={!canStartNewChat(view)} onShowHistory={() => drawer.current?.showModal()} />)}
    </div>
  </section>;
}

interface ConversationProps { composerFocus: RefObject<Map<string, ComposerSelection>>; sessionId: string; ownerId: string; name: string; initial: ChatSnapshot; active: boolean; configuration: ModelConfiguration; onSnapshot: (id: string, snapshot: ChatSnapshot, busy: boolean) => void; onDraft: (id: string, input: string) => void; onNewChat: () => void; newChatDisabled: boolean; onShowHistory: () => void }

function Conversation({ composerFocus, sessionId, ownerId, name, initial, active, configuration, onSnapshot, onDraft, onNewChat, newChatDisabled, onShowHistory }: ConversationProps) {
  const { mode } = useSession();
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [input, setInput] = useState(initial.input);
  const [inputNotice, setInputNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [request, setRequest] = useState<RoomRequest>(initial.request);
  const roomIntent = useRef<RoomRequest>(initial.request);
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
  useLayoutEffect(() => {
    const element = composer.current;
    const selections = composerFocus.current;
    const selection = active ? selections.get(sessionId) : undefined;
    if (active) selections.delete(sessionId);
    if (active && element && selection && element.ownerDocument.activeElement === element.ownerDocument.body) {
      element.focus({ preventScroll: true });
      element.setSelectionRange(selection.start, selection.end, selection.direction);
    }
    return () => {
      // Reauthorization may remount this conversation. Retain only selection,
      // never content, and never steal focus from another control or account.
      if (!active || !element) return;
      if (element.ownerDocument.activeElement === element) {
        selections.set(sessionId, { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection });
      }
    };
  }, [active, composerFocus, sessionId]);
  const proposalCards = useRef(new Map<string, HTMLDivElement>());
  const actionHelpLocation = useRef<string | null>(null);
  const pendingProposalFocus = useRef<{ id: string; confirmation: boolean; requested?: boolean } | null>(null);
  const inputId = useId();
  const messageClock = useRef<ReturnType<typeof createChatMessageClock> | null>(null);
  messageClock.current ??= createChatMessageClock(events => postForChat("/api/chat/timestamps", { messages: events }));
  const latestMessage = messages.at(-1)?.id;
  const offline = profileId === "offline";
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const defaultProfile = profiles.find((profile) => profile.id === configuration.defaultProfileId);
  const isDefaultProfile = profileId === configuration.defaultProfileId;
  const providerLabel = selectedProfile ? modelProviderName(selectedProfile.provider) : null;
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

  function updateRequest(next: RoomRequest) { roomIntent.current = next; setRequest(next); }

  function updateInput(next: string) {
    setInputNotice("");
    onDraft(sessionId, next);
    setInput(next);
  }

  function getMessageClock() {
    const clock = messageClock.current;
    if (!clock) throw new Error("Chat message clock unavailable.");
    return clock;
  }

  function withWireTimestamp(message: WireMessage, timestamps: Map<string, MessageTimestamp>): WireMessage {
    const timestamp = message.id ? timestamps.get(message.id) : undefined;
    return timestamp ? { ...message, timestamp } : message;
  }

  function withChatTimestamp(message: Message, timestamps: Map<string, MessageTimestamp>): Message {
    const timestamp = message.id ? timestamps.get(message.id) : undefined;
    return timestamp ? { ...message, timestamp } : message;
  }

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
    if (!active || !element) return;
    const helpCard = actionHelpLocation.current ? proposalCards.current.get(actionHelpLocation.current) : undefined;
    if (!busy && helpCard?.isConnected) {
      revealProposalCard(element, helpCard);
      return;
    }
    const origin = knowledgeReturnLocation(window.location);
    if (origin?.sessionId === sessionId) {
      const message = element.ownerDocument.getElementById(`chat-${sessionId}-message-${origin.messageId}`);
      if (message && element.contains(message)) {
        element.scrollTo({ top: element.scrollTop + message.getBoundingClientRect().top - element.getBoundingClientRect().top - 16, behavior: "instant" });
        // A slow route load must not take focus from a newer user interaction.
        if (element.ownerDocument.activeElement === element.ownerDocument.body) message.focus({ preventScroll: true });
        window.history.replaceState(window.history.state, "", "/");
        return;
      }
    }
    element.scrollTo({ top: latestMessage || busy ? element.scrollHeight : 0, behavior: "instant" });
  }, [latestMessage, busy, active, sessionId]);

  // Explicit action help takes scroll priority over following the newest message.
  useEffect(() => {
    if (busy || !pendingProposalFocus.current) return;
    const requested = pendingProposalFocus.current;
    pendingProposalFocus.current = null;
    const card = proposalCards.current.get(requested.id);
    // Disabled/removed confirmation buttons lose focus. Restore it after the
    // final render without interrupting a task switch or a user's newer focus.
    if (!active || !card?.isConnected || !card.getClientRects().length || !requested.requested && card.ownerDocument.activeElement !== card.ownerDocument.body) return;
    const buttons = card.querySelectorAll<HTMLButtonElement>('button[data-proposal-confirm]');
    const confirmation = buttons.length === 1 ? buttons.item(0) : null;
    const target = requested.confirmation && confirmation && !confirmation.disabled ? confirmation : card;
    const container = scroller.current;
    if (requested.requested && container) revealProposalCard(container, card);
    target.focus({ preventScroll: true });
  }, [active, busy, messages]);


  async function requestForChat<T>(path: string, init: RequestInit = {}, onRequestStart?: () => void): Promise<T> {
    const signal = pendingRequest.current?.signal;
    if (requestWasAborted(alive.current, signal)) throw new DOMException("Chat closed", "AbortError");
    const session = await apiRequest<{ user: User | null }>("/api/session", signal === undefined ? {} : { signal });
    if (requestWasAborted(alive.current, signal) || session.user?.id !== ownerId) throw new Error("Das Testkonto wurde gewechselt. Bitte öffne den Chat erneut.");
    onRequestStart?.();
    const result = await apiRequest<T>(path, { ...init, ...(signal === undefined ? {} : { signal }) });
    if (requestWasAborted(alive.current, signal)) throw new DOMException("Chat closed", "AbortError");
    return result;
  }

  function postForChat<T>(path: string, body: unknown, onRequestStart?: () => void) { return requestForChat<T>(path, { method: "POST", body: JSON.stringify(body) }, onRequestStart); }

  async function loadModelTools(): Promise<PluginToolDescriptor[]> {
    const parsed = parsePluginTools(await requestForChat<unknown>("/api/tools"));
    if (!parsed) throw new Error("Die freigegebenen Werkzeuge konnten nicht sicher geladen werden.");
    return parsed;
  }

  async function checkAnnyAccess(workflow: "rooms" | "bookings" | null, available: readonly PluginToolDescriptor[]): Promise<boolean> {
    if (!workflow) return true;
    const required = workflow === "rooms" ? "anny.search_resources" : "anny.list_my_bookings";
    if (available.some(tool => tool.pluginId === "de.hsh.hasi.anny" && tool.name === required)) return true;
    const accounts = parsePluginAccountList(await requestForChat<unknown>("/api/plugin-accounts"));
    const account = accounts.find(item => item.installationId === "de.hsh.hasi.anny");
    const requestId = history.current.findLast(message => message.role === "user")?.id;
    const needsConnection = account && account.status !== "linked" && requestId;
    add({
      role: "assistant",
      tool: "anny · Dienstverbindung",
      text: needsConnection
        ? "Dein anny-Konto ist noch nicht verbunden oder der Zugriff muss erneuert werden. Verbinde es hier, dann kann ich mit deiner Anfrage fortfahren. Du brauchst keine Raum- oder Arbeitsplatz-ID; Gebäude und Zeitraum bleiben erhalten."
        : "Die anny-Funktion ist für dein Konto derzeit nicht freigegeben. Bitte prüfe die Dienstverbindung oder wende dich an die Administration. Eine interne Ressourcen-ID würde diese Freigabe nicht ersetzen.",
      ...(needsConnection ? { serviceConnection: { installationId: account.installationId, label: account.label, requestId } } : {}),
    });
    // This host-owned prerequisite is local UI state, not a fabricated model reply.
    return false;
  }

  async function resumeConnectedRequest(requestId: string) {
    if (history.current.findLast(message => message.role === "user")?.id !== requestId || history.current.at(-1)?.role === "assistant" || !start("Dienstverbindung wird geprüft …")) return;
    try { await runModel(); }
    catch (cause) { add({ role: "assistant", text: cause instanceof Error ? cause.message : "Die Anfrage konnte nicht fortgesetzt werden." }); }
    finally { await finish(); }
  }

  function remember<T extends WireMessage>(message: T): T {
    return getMessageClock().track(message);
  }

  function appendHistory(role: "user" | "assistant", text: string, eventId = id()) {
    const previous = history.current.at(-1);
    // A combined history status is a separate event from the visible new text.
    const historyId = role === "assistant" && previous?.role === "assistant" && !previous.toolCalls?.length ? id() : eventId;
    const message = appendChatText(history.current, role, text, historyId);
    if (message) remember(message);
  }

  async function stampMessages() {
    const timestamps = await getMessageClock().flush();
    if (timestamps.size) history.current = history.current.map(message => withWireTimestamp(message, timestamps));
    if (timestamps.size) setMessages(previous => previous.map(message => withChatTimestamp(message, timestamps)));
    return timestamps;
  }

  function add(message: Omit<Message, "id">, messageId = id(), modelInput = true) {
    if (modelInput && offline && message.role === "user") appendHistory(message.role, message.text, messageId);
    remember({ id: messageId, role: message.role, content: message.text, ...(message.timestamp ? { timestamp: message.timestamp } : {}) });
    if (messages.length >= 200) setMessagesTruncated(true);
    setMessages((previous) => [...previous.slice(-199), { ...message, id: messageId }]);
    return messageId;
  }

  function addActionResult(message: Omit<Message, "id" | "role">) {
    // Host action UI is separate from model/source evidence.
    return add({ ...message, role: "assistant" });
  }

  function addHostMessage(message: HostDialogueMessage, resources: Resource[] = []) {
    const { id, ...content } = message;
    return add({ ...content, tool: "HASI · Dialoghinweis",
      ...(resources.length ? { rooms: resources.map(resource => ({ resource, intervals: [], checked: false })) } : {}) }, id);
  }

  async function hostNotice(code: StaticHostDialogueCode) {
    if (mode !== "oidc") return add({ role: "assistant", text: staticHostDialogue[code], tool: "HASI · Dialoghinweis" });
    try {
      const result = await postForChat<{ message: unknown }>("/api/chat/dialogue", { kind: "static", conversationId: sessionId, code });
      const message = hostDialogueMessageSchema.parse(result.message);
      if (message.hostDialogue.code !== code) throw new Error("Dialoghinweis passt nicht zur Anfrage.");
      return addHostMessage(message);
    } catch {
      if (alive.current) setInputNotice("Der Dialoghinweis konnte nicht gespeichert werden. Bitte prüfe deine Verbindung und versuche die Anfrage erneut. Bei einer begonnenen Aktion prüfe zuerst den Aktionsstatus.");
      return undefined;
    }
  }

  function updateProposalStatus(proposalId: string, status: Proposal["status"]) {
    if (status !== "pending") pendingProposalFocus.current = { id: proposalId, confirmation: false };
    setMessages((previous) => previous.map((message) => {
      const proposal = message.proposal;
      return proposal?.id === proposalId ? { ...message, text: proposalPresentation({ ...proposal, status }).summary, proposal: { ...proposal, status } } : message;
    }));
  }

  function start(label: string) {
    if (lock.current) return false;
    lock.current = true;
    actionHelpLocation.current = null;
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

  function recordTool(name: ChatToolCallName, arguments_: Record<string, unknown>, output: Record<string, unknown>) {
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
    const questionText = result.output.refinementRequired === true ? question
      : question && notice && !question.includes(notice) ? `${question}\n${notice}` : question ?? notice;
    const returned = typeof result.output.returned === "number" && Number.isInteger(result.output.returned) && result.output.returned >= 0 ? result.output.returned : 0;
    const truncated = typeof result.output.truncated === "number" && Number.isInteger(result.output.truncated) && result.output.truncated > 0 ? result.output.truncated : 0;
    const truncatedSearchText = result.name === "anny_search_resources" && truncated > 0
      ? `${String(returned + truncated)} passende Katalogtreffer. Die Karten enthalten die ersten ${String(returned)}; die Verfügbarkeit wurde noch nicht geprüft. Mit einem Büronamen oder Standort kannst du die Suche eingrenzen.`
      : undefined;
    const text = result.proposal?.action === "cancel_booking" ? "Der Stornierungsvorschlag ist vorbereitet. Prüfe die Buchung; erst die separate Bestätigung auf dieser Karte führt die Stornierung aus."
      : result.proposal ? "Bitte prüfe den Buchungsvorschlag. Erst die Bestätigung auf dieser Karte löst die Testbuchung aus."
      : question ? questionText ?? question
      : truncatedSearchText ?? questionText
      ?? (result.rooms ? (result.rooms.length ? "Ergebnisse aus den anny-Testdaten." : "Keine Treffer für diese Suchfilter. Die Verfügbarkeit wurde noch nicht geprüft.")
      : result.bookings ? (result.bookings.length ? "Deine Buchungen aus der Testumgebung." : "Du hast noch keine Testbuchungen.") : "Tool-Abfrage abgeschlossen.");
    add({
      role: "assistant",
      text,
      tool: labels[result.name],
      ...(result.rooms === undefined ? {} : { rooms: result.rooms }),
      ...(result.bookings === undefined ? {} : { bookings: result.bookings }),
      ...(result.proposal === undefined ? {} : { proposal: result.proposal }),
      model,
      interactionId,
    });
    if (result.rooms) setActiveResult(interactionId);
    if (result.proposal) setActiveProposal(result.proposal.id);
  }

  async function runModel() {
    // Keep complete exchanges, including direct tool actions with no inference.
    if (!trimChatHistory(history.current)) throw new Error("Dieser einzelne Gesprächsschritt ist für den Modellkontext zu umfangreich. Beginne bitte einen neuen Chat mit einer kürzeren Anfrage; deine vorhandenen Karten bleiben erhalten.");
    const interactionId = id();
    const controller = pendingRequest.current;
    if (!controller) throw new Error("Chat request was not started.");
    const latestUserText = history.current.findLast(message => message.role === "user")?.content ?? "";
    const mixedRequest = isMixedKnowledgeRequest(latestUserText, roomContext);
    const stepLimit = mixedRequest ? 3 : MAX_MODEL_STEPS;
    try {
      const authorizedTools = await loadModelTools();
      if (!await checkAnnyAccess(annyWorkflow(history.current), authorizedTools)) return;
      const pluginToolsByModelName = new Map(authorizedTools.map(descriptor => [descriptor.modelName, descriptor]));
      for (let step = 0; step < stepLimit; step += 1) {
        setActivity(`${resolvedProfile.current ? modelProviderName(resolvedProfile.current) : providerLabel ?? "Das Modell"} antwortet …`);
        await stampMessages();
        const response = await fetch("/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId, conversationId: sessionId, ...(routingToken.current ? { routingToken: routingToken.current } : {}), proposalIds: [...new Set(messages.flatMap(message => message.proposal ? [message.proposal.id] : []))].slice(-8), messages: history.current }), signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({ error: "Der Chat-Dienst ist gerade nicht erreichbar. Bitte versuche es später erneut." }));
        if (!response.ok) {
          if (response.status === 409 && payload && typeof payload === "object" && "code" in payload && payload.code === "required_tools_unavailable") {
            if (!await checkAnnyAccess(annyWorkflow(history.current), await loadModelTools())) return;
          }
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
        if (reply.contextNotice) setInputNotice(reply.contextNotice);
        history.current.push(reply.message);
        if (reply.message.content.trim()) add({
          role: "assistant",
          text: reply.message.content,
          model: actualLabel,
          ...(reply.message.evidence ? { evidence: reply.message.evidence } : {}),
          ...(reply.message.timestamp === undefined ? {} : { timestamp: reply.message.timestamp }),
        }, reply.message.id);
        if (!reply.message.toolCalls?.length) return;
        let actionableResult = false;
        const successfulTools: ChatToolName[] = [];
        for (const call of reply.message.toolCalls) {
          const pluginDescriptor = isChatToolName(call.name) ? undefined : pluginToolsByModelName.get(call.name);
          setActivity(pluginDescriptor ? `Plugin · ${pluginDescriptor.title}` : `anny · ${call.name === "anny_propose_booking" ? "Buchung vorbereiten" : call.name === "anny_propose_cancellation" ? "Stornierung beginnen" : "Testdaten abfragen"}`);
          let output: Record<string, unknown>;
          let toolContextId: string | undefined;
          try {
            if (!isChatToolName(call.name)) {
              if (!pluginDescriptor) throw new Error("Das freigegebene Werkzeug ist in dieser Sitzung nicht verfügbar.");
              const protectedRead = mode === "oidc" && pluginDescriptor.effect === "read";
              const response = protectedRead
                ? await postForChat<{ result: Record<string, unknown>; contextId: string }>("/api/chat/plugin-read", {
                  conversationId: sessionId, assistantMessage: reply.message, toolCallId: call.id,
                })
                : await postForChat<unknown>("/api/tools/call", {
                  pluginId: pluginDescriptor.pluginId, name: pluginDescriptor.name, arguments: call.arguments,
                });
              const read = protectedRead ? pluginResultReadResponseSchema.parse(response) : undefined;
              const raw = read?.result ?? response;
              toolContextId = read?.contextId;
              output = boundedPluginToolResult(raw);
              if (pluginDescriptor.effect === "prepare") {
                const proposal = parsePluginProposal(raw, pluginDescriptor);
                if (!proposal) throw new Error("Der Vorschlag konnte nicht sicher geprüft werden.");
                add({
                  role: "assistant",
                  text: `Der Vorschlag „${proposal.title}“ ist vorbereitet. Prüfe die angegebenen Daten; erst die gesonderte Bestätigung auf dieser Karte führt die Aktion aus.`,
                  tool: `Plugin · ${proposal.title}`,
                  proposal,
                });
                setActiveProposal(proposal.id);
                actionableResult = true;
              } else {
                add({ role: "assistant", text: compactPluginToolResult(output), tool: `Plugin · ${pluginDescriptor.title}`,
                  ...(toolContextId ? { pluginResultContextId: toolContextId } : { model: actualLabel }) });
              }
            } else if (call.name === "knowledge_search") {
              setActivity("Wissensdienst · Quellen suchen");
              const args = chatToolSchemas.knowledge_search.parse(call.arguments);
              const result = await searchKnowledge(requestForChat, {
                query: args.query,
                ...(args.sourceSystem === undefined ? {} : { sourceSystem: args.sourceSystem }),
              });
              output = { ...result, documents: knowledgeModelDocuments(result.documents) };
              successfulTools.push("knowledge_search");
              add({ role: "assistant", text: knowledgeSourceSummary(result.documents), tool: "Wissensdienst · MCP", ...knowledgeSourceMessage(result), model: actualLabel });
            } else {
              assertRequestedRoomTime(call.name, call.arguments, roomIntent.current);
              const result = await tools().run(call.name, call.arguments);
              output = result.output;
              successfulTools.push(result.name);
              showToolResult(result, interactionId, actualLabel);
              actionableResult ||= !toolNeedsModelFollowUp(result.name);
            }
          } catch (cause) {
            if (cause instanceof RoomTimeUnresolvedError) actionableResult = true;
            output = { error: cause instanceof Error ? cause.message : "Das Tool konnte die Anfrage nicht abschließen.", ...(cause instanceof RoomTimeMismatchError ? { requestedInterval: cause.expectedInterval } : {}) };
            const failedLabel = pluginDescriptor ? `Plugin · ${pluginDescriptor.title} · Anfrage fehlgeschlagen` : call.name === "knowledge_search" ? "Wissensdienst · Anfrage fehlgeschlagen" : "anny · Anfrage fehlgeschlagen";
            add({ role: "assistant", text: String(output.error), tool: failedLabel });
          }
          history.current.push(remember({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(output), ...(toolContextId ? { toolContextId } : {}) }));
        }
        // Host-rendered cards already provide the answer and next action.
        // Stop after every successful Anny result, including empty/unchecked searches.
        if (actionableResult && !mixedRequest && !toolBatchNeedsModelFollowUp(successfulTools)) return;
      }
      add({ role: "assistant", text: "Die maximale Zahl an Modellschritten für diese Nachricht ist erreicht. Du kannst die angezeigten Karten nutzen oder eine weitere Nachricht schreiben." });
    } catch (cause) {
      appendHistory("assistant", "Die Verarbeitung der letzten Nachricht wurde durch einen technischen Fehler unterbrochen. Offene Schritte wurden nicht automatisch fortgesetzt; berücksichtige die bereits vorliegenden Tool-Ergebnisse.");
      throw cause;
    }
  }

  async function searchRooms(next: RoomRequest, selected: Resource | null) {
    setActivity("anny · Räume suchen");
    let response: ReturnType<typeof parseRoomDialogueResponse>;
    if (mode === "oidc") {
      response = parseRoomDialogueResponse(await postForChat<unknown>("/api/chat/dialogue", {
        kind: "rooms", conversationId: sessionId, request: next,
        ...(selected ? { selectedResourceId: selected.id } : {}),
      }));
    } else {
      const preliminary = planRoomDialogue(next, [], selected?.id);
      const catalog = preliminary.catalogDependent ? (await requestForChat<{ resources: Resource[] }>("/api/resources")).resources : [];
      response = { plan: planRoomDialogue(next, catalog, selected?.id) };
    }
    const { plan, message } = response;
    const resources = plan.resources;
    if (!plan.needsAvailability) {
      const resultId = message ? addHostMessage(message, resources) : add({ role: "assistant", text: plan.text,
        tool: "HASI · Dialoghinweis", ...(resources.length ? { rooms: resources.map(resource => ({ resource, intervals: [], checked: false })) } : {}) });
      setActiveResult(resources.length ? resultId : null);
      return;
    }
    const startDate = requestStartDate(next);
    if (!startDate || !next.durationMinutes) throw new Error("Bitte präzisiere Datum, Uhrzeit und Dauer.");
    setActivity("anny · Verfügbarkeit prüfen");
    const requestedEndDate = new Date(Date.parse(startDate) + next.durationMinutes * 60_000).toISOString();
    const options = await Promise.all(resources.map(async (resource) => {
      const availability = await postForChat<{ intervals: TimeInterval[] }>("/api/availability", { resourceId: resource.id, serviceId: resource.serviceId, startDate, durationMinutes: next.durationMinutes });
      const freeIntervals = availability.intervals.filter((interval) => interval.available);
      const exactInterval = freeIntervals.find((interval) => Date.parse(interval.startDate) === Date.parse(startDate));
      return { resource, requestedStartDate: startDate, requestedEndDate, intervals: exactInterval ? [exactInterval] : freeIntervals.slice(0, 3), checked: true };
    }));
    const count = options.filter((option) => option.intervals.length).length;
    const resultId = add({ role: "assistant", tool: "anny · Raumsuche und Verfügbarkeit", text: `${roomRequestSummary(next)}\n${count ? "Verfügbarkeit geprüft. Die Karten kennzeichnen Treffer im gewünschten Zeitraum und alternative freie Zeiten. Wähle eine Zeit, dann bereite ich den Buchungsvorschlag vor." : "Zu diesen Anforderungen sind keine Zeiten frei. Nenne mir einen anderen Zeitraum."}`, rooms: options });
    setActiveResult(resultId);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || text.length > 4000 || !canSend || !start("Anfrage wird verarbeitet")) return;
    routingToken.current = undefined;
    resolvedProfile.current = null;
    setFallbackLabel(null);
    updateInput("");
    const eventId = add({ role: "user", text });
    if (!offline) appendHistory("user", text, eventId);
    setActiveResult(null);
    const pendingProposal = activeProposal;
    setActiveProposal(null);
    try {
      await stampMessages();
      const priorProposal = messages.findLast(message => message.proposal)?.proposal;
      if (priorProposal && asksForActionControls(trimmed)) {
        try {
          const response = await requestForChat<unknown>(`/api/proposals/${encodeURIComponent(priorProposal.id)}`);
          const controls = currentActionControls(priorProposal, response);
          if (!controls) {
            setInputNotice("Der Vorschlag hat sich geändert. Die frühere Karte kann nicht bestätigt werden; bereite einen neuen Vorschlag vor.");
          } else {
            const { proposal: current, confirmable } = controls;
            updateProposalStatus(current.id, current.status);
            setActiveProposal(confirmable ? current.id : null);
            actionHelpLocation.current = current.id;
            pendingProposalFocus.current = { id: current.id, confirmation: confirmable, requested: true };
          }
        } catch {
          setInputNotice("Der aktuelle Aktionsstatus konnte nicht geprüft werden. Das beweist weder Erfolg noch Misserfolg. Prüfe den Status, bevor du die Aktion erneut vorbereitest.");
        }
        await hostNotice("action_controls_guidance");
        return;
      }
      if (/^(ja|ok(?:ay)?|bestätigen|buche(?:n)?|mach das)[.!\s]*$/i.test(trimmed) && pendingProposal) {
        setActiveProposal(pendingProposal);
        await hostNotice("confirmation_guidance");
        return;
      }
      if (!offline) {
        if (classifyIntent(trimmed, roomContext) === "rooms" || roomContext && isAvailabilityFollowUp(trimmed)) {
          const timestamp = history.current.find(message => message.id === eventId)?.timestamp;
          if (timestamp) {
            const reset = !roomContext || /(?:neue|andere)\s+(?:raum)?suche|(?:anderen|neuen)\s+raum|von vorne/i.test(trimmed);
            const previous = roomIntent.current;
            const now = new Date(timestamp.createdAt);
            const preference = !reset ? officePreferenceSearch(trimmed, previous, now) : null;
            const next = preference ?? mergeRoomRequest(trimmed, reset ? {} : previous, now);
            updateRequest(next);
            setRoomContext(true);
            if (preference) {
              if (!await checkAnnyAccess("rooms", await loadModelTools())) return;
              setChosenRoom(null);
              const args = Object.fromEntries(["kind", "officeType", "capacity", "features", "location", "query"].flatMap(key => {
                const value = next[key as keyof RoomRequest];
                return value === undefined ? [] : [[key, value]];
              }));
              const result = await tools().run("anny_search_resources", args);
              recordTool("anny_search_resources", args, result.output);
              showToolResult(result, id(), "");
              return;
            }
          }
        }
        if (isOwnBookingsRequest(trimmed)) {
          if (!await checkAnnyAccess("bookings", await loadModelTools())) return;
          const result = await tools().run("anny_list_my_bookings", {});
          recordTool("anny_list_my_bookings", {}, result.output);
          showToolResult(result, id(), "");
          setRoomContext(false);
          return;
        }
        await runModel();
        return;
      }
      const received = history.current.find(message => message.id === eventId)?.timestamp;
      if (!received) throw new Error("Der Anfragezeitpunkt konnte nicht bestätigt werden. Bitte versuche es erneut.");
      const requestTime = new Date(received.createdAt);
      const cancellationIntent = /\b(?:storn\w*|kündig\w*|cancel\w*|annull\w*)\b/iu.test(trimmed);
      const refinedRequest = roomContext && request.kind === "workplace" ? mergeRoomRequest(trimmed, request, requestTime) : null;
      const officeRefinementReply = refinedRequest !== null
        && refinedRequest.officeType !== request.officeType
        && refinedRequest.officeType !== undefined;
      const intent = cancellationIntent ? "bookings" : officeRefinementReply ? "rooms" : classifyIntent(trimmed, roomContext);
      if (intent === "bookings") {
        setActivity("anny · Eigene Buchungen laden");
        const result = await requestForChat<{ bookings: Booking[] }>("/api/bookings");
        const text = cancellationIntent
          ? result.bookings.length ? "Hier sind deine eigenen Buchungen. Bei einer aktiven zukünftigen Buchung kannst du eine Stornierung beginnen; ausgeführt wird sie erst nach Prüfung und Bestätigung auf der Vorschlagskarte." : "Du hast in der Testumgebung keine eigenen Buchungen, die du stornieren kannst."
          : result.bookings.length ? "Hier sind deine Buchungen aus der Testumgebung." : "Du hast in der Testumgebung noch keine Testbuchungen. Soll ich einen Raum für dich suchen?";
        if (result.bookings.length === 0 && mode === "oidc") {
          const empty = await postForChat<{ message: unknown }>("/api/chat/dialogue", { kind: "bookings_empty", conversationId: sessionId });
          const message = hostDialogueMessageSchema.parse(empty.message);
          if (message.hostDialogue.code !== "bookings_empty") throw new Error("Unerwarteter Buchungshinweis.");
          addHostMessage(message);
        } else add({ role: "assistant", tool: "anny · Eigene Buchungen", text, bookings: result.bookings });
        setRoomContext(false);
      } else if (intent === "knowledge") {
        setRoomContext(false);
        setActivity("Wissensdienst · Quellen suchen");
        const result = await searchKnowledge(requestForChat, { query: trimmed });
        add({ role: "assistant", text: knowledgeSourceSummary(result.documents), tool: "Wissensdienst · MCP", ...knowledgeSourceMessage(result) });
      } else if (intent === "rooms") {
        const reset = !roomContext || /(?:neue|andere)\s+(?:raum)?suche|(?:anderen|neuen)\s+raum|von vorne/i.test(trimmed);
        const next = mergeRoomRequest(trimmed, reset ? {} : request, requestTime);
        const selected = reset || next.query !== request.query ? null : chosenRoom;
        if (!selected) setChosenRoom(null);
        updateRequest(next);
        setRoomContext(true);
        await searchRooms(next, selected);
      } else {
        setRoomContext(false);
        await hostNotice(intent === "greeting" ? "greeting" : "capabilities");
      }
    } catch (cause) {
      setInputNotice(cause instanceof Error ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.");
      await hostNotice("request_retry");
    } finally {
      await finish();
    }
  }

  async function chooseRoom(resource: Resource) {
    const label = `${resource.kind === 'workplace' ? 'einen einzelnen Arbeitsplatz: ' : ''}${resource.name}${resource.parentName ? ` im Büro ${resource.parentName}` : ''}`;
    if (!offline) {
      let interval: ReturnType<typeof requestedRoomInterval>;
      try { interval = requestedRoomInterval(roomIntent.current); }
      catch (cause) {
        addActionResult({ text: cause instanceof Error ? cause.message : "Bitte präzisiere den gewünschten Zeitraum." });
        try { await stampMessages(); } catch { /* Preserve unknown time when the clock is unavailable. */ }
        return;
      }
      if (!interval) { await send(`Ich möchte ${label} buchen (resourceId: ${resource.id}). Verwende genau diese Ressource und frage nach noch fehlenden Angaben.`); return; }
      if (!start("anny · Gewünschten Zeitraum prüfen")) return;
      setChosenRoom(resource);
      setActiveResult(null);
      setActiveProposal(null);
      const selection = `Bitte prüfe ${label} am ${formatDateTime(interval.startDate)} bis ${formatTime(interval.endDate)} Uhr.`;
      const eventId = add({ role: "user", text: selection });
      appendHistory("user", selection, eventId);
      try {
        await stampMessages();
        const args = availabilityInputForSlot(resource.id, { ...interval, available: false });
        const result = await tools().run("anny_get_availability", args);
        recordTool("anny_get_availability", args, result.output);
        showToolResult(result, id(), "");
      } catch (cause) { addActionResult({ text: cause instanceof Error ? cause.message : "Der Zeitraum konnte nicht geprüft werden." }); }
      finally { await finish(); }
      return;
    }
    if (!start("Raum auswählen")) return;
    setChosenRoom(resource);
    const next = { ...request, kind: resource.kind ?? 'room' as const };
    updateRequest(next);
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
      const proposal = readProposalSnapshot(result, result.proposal);
      if (proposal?.action !== "book" || proposal.status !== "pending") throw new Error("Es wurde kein offener Buchungsvorschlag zurückgegeben.");
      addActionResult({ text: "Der Buchungsvorschlag ist vorbereitet. Bitte prüfe die Angaben und bestätige die Buchung ausdrücklich.", tool: "anny · Buchungsvorschlag", proposal });
      setActiveProposal(proposal.id);
    } catch (cause) { addActionResult({ text: cause instanceof Error ? cause.message : "Der Buchungsvorschlag konnte nicht erstellt werden." }); }
    finally { await finish(); }
  }

  async function prepareCancellation(booking: Booking) {
    if (!canRequestCancellation(booking) || !start("anny · Stornierung beginnen")) return;
    setActiveResult(null);
    setActiveProposal(null);
    const selection = `Stornierung beginnen: ${booking.resourceName}, ${formatDateTime(booking.startDate)} bis ${formatTime(booking.endDate)} Uhr.`;
    const eventId = add({ role: "user", text: selection });
    if (!offline) appendHistory("user", selection, eventId);
    try {
      await stampMessages();
      const args = { bookingId: booking.id };
      const result = await tools().run("anny_propose_cancellation", args);
      if (result.proposal?.action !== "cancel_booking") throw new Error("Es wurde kein Stornierungsvorschlag zurückgegeben.");
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

  async function confirmPluginProposal(proposal: PluginToolProposal) {
    const presentation = pluginToolProposalPresentation(proposal);
    const actionName = presentation.actionTitle;
    if (activeProposal !== proposal.id || !start(`Plugin · ${presentation.confirmLabel}`)) return;
    let executionAttempted = false;
    const action = `Ich bestätige die angezeigte Aktion „${actionName}“ über die Schaltfläche.`;
    // A UI attempt is visible, but is not a model statement of action success.
    add({ role: "user", text: action }, id(), false);
    try {
      await stampMessages();
      const proposalUrl = `/api/proposals/${encodeURIComponent(proposal.id)}`;
      const current = await requestForChat<unknown>(proposalUrl);
      const authoritative = parsePluginProposalSnapshot(current, proposal);
      if (authoritative && authoritative.status !== "pending" && samePluginProposalSnapshot(proposal, authoritative)) {
        setActiveProposal(null);
        updateProposalStatus(proposal.id, authoritative.status);
        return;
      }
      if (authoritative?.status !== "pending" || !samePluginProposalSnapshot(proposal, authoritative)) {
        setActiveProposal(null);
        const statusText = authoritative?.status === "outcome_unknown"
          ? "Der Status dieser Aktion ist unklar. Prüfe den aktuellen Stand im zuständigen Dienst, bevor du erneut vorgehst."
          : authoritative?.status === "confirmed"
            ? "Diese Aktion wurde bereits abgeschlossen."
            : "Der Vorschlag stimmt nicht mehr mit dem gespeicherten Stand überein oder ist nicht mehr offen. Bereite ihn erneut vor.";
        setInputNotice(statusText);
        return;
      }
      const rawResult = await postForChat<unknown>(`${proposalUrl}/confirm`, {}, () => { executionAttempted = true; });
      const confirmed = parsePluginProposalSnapshot(rawResult, proposal);
      if (confirmed?.status === "confirmed" && samePluginProposalSnapshot(proposal, confirmed)) {
        setActiveProposal(null);
        updateProposalStatus(proposal.id, "confirmed");
      } else {
        setActiveProposal(null);
        if (confirmed?.status === "outcome_unknown") updateProposalStatus(proposal.id, "outcome_unknown");
        const text = confirmed?.status === "outcome_unknown"
          ? "Der Dienst konnte den Ausgang der Aktion nicht eindeutig bestätigen. Prüfe den aktuellen Stand, bevor du einen weiteren Vorschlag erstellst."
          : "Die Antwort stimmt nicht eindeutig mit der angezeigten Aktion überein. Prüfe den aktuellen Stand, bevor du erneut vorgehst.";
        setInputNotice(text);
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Der Dienst hat nicht geantwortet.";
      const disposition = classifyProposalFailure(cause, executionAttempted);
      if (disposition === "invalidated") {
        pendingProposalFocus.current = { id: proposal.id, confirmation: false };
        setActiveProposal(null);
        updateProposalStatus(proposal.id, "invalidated");
      } else if (disposition === "retry_preflight") {
        pendingProposalFocus.current = { id: proposal.id, confirmation: true };
        setActiveProposal(proposal.id);
      } else {
        setActiveProposal(null);
        if (disposition === "outcome_unknown") updateProposalStatus(proposal.id, "outcome_unknown");
      }
      const text = disposition === "invalidated"
        ? "Vorschlag ungültig. Die Aktion wurde nicht ausgeführt. Bitte bereite sie neu vor."
        : disposition === "outcome_unknown"
          ? `Die Antwort auf „${actionName}“ war nicht eindeutig. ${detail} Prüfe zuerst den aktuellen Stand und löse die Aktion nicht erneut aus, bevor das Ergebnis geklärt ist.`
          : disposition === "retry_preflight"
            ? `Der Vorschlag konnte vorab nicht geprüft werden und bleibt offen. Du kannst es erneut versuchen. ${detail}`
            : `Der Vorschlag konnte nicht vorab geprüft werden; eine Ausführung wurde nicht angefordert. ${detail}`;
      setInputNotice(text);
    } finally {
      await finish();
    }
  }

  async function confirm(proposal: Proposal) {
    if (proposal.action === "execute_tool") {
      await confirmPluginProposal(proposal);
      return;
    }
    const cancellation = proposal.action === "cancel_booking";
    if (activeProposal !== proposal.id || !start(cancellation ? "anny · Stornierung ausführen" : "anny · Bestätigte Buchung ausführen")) return;
    let executionAttempted = false;
    const action = cancellation
      ? `Ich bestätige die Stornierung der angezeigten Buchung für ${proposal.resourceName}, ${formatDateTime(proposal.startDate)} bis ${formatTime(proposal.endDate)} Uhr über die Schaltfläche.`
      : `Ich bestätige den angezeigten Buchungsvorschlag für ${proposal.resourceName}, ${formatDateTime(proposal.startDate)} bis ${formatTime(proposal.endDate)} Uhr über die Schaltfläche.`;
    // A UI attempt is visible, but is not a model statement of action success.
    add({ role: "user", text: action }, id(), false);
    try {
      await stampMessages();
      const proposalUrl = `/api/proposals/${encodeURIComponent(proposal.id)}`;
      const current = await requestForChat<{ proposal?: AnnyChatProposal & { arguments?: { bookingId?: string } } }>(proposalUrl);
      const authoritative = readProposalSnapshot(current, proposal);
      const currentAction = authoritative?.action ?? "book";
      const canonicalBookingId = current.proposal?.arguments?.bookingId;
      if (authoritative && authoritative.status !== "pending" && sameProposalDetails(proposal, authoritative)) {
        setActiveProposal(null);
        updateProposalStatus(proposal.id, authoritative.status);
        return;
      }
      if (authoritative?.status !== "pending" || !sameProposalDetails(proposal, authoritative)
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
      const result = await postForChat<{ proposal: AnnyChatProposal; bookingId?: string; status?: "cancelled" }>(`${proposalUrl}/confirm`, {}, () => { executionAttempted = true; });
      const responseProposal = readProposalSnapshot(result, proposal);
      const responseMatches = responseProposal !== null && sameProposalDetails(proposal, responseProposal);
      const bookingIdMatches = cancellation && typeof result.bookingId === "string"
        && result.bookingId.trim().length > 0 && result.bookingId === canonicalBookingId;
      const confirmed = responseMatches && responseProposal.status === "confirmed"
        && (!cancellation || result.status === "cancelled" && bookingIdMatches);
      if (confirmed) {
        setActiveProposal(null);
        if (cancellation) {
          if (result.status === "cancelled" && result.bookingId && bookingIdMatches) {
            setMessages((previous) => previous.map((message) => message.bookings
              ? { ...message, bookings: message.bookings.map((booking) => booking.id === result.bookingId ? { ...booking, status: "cancelled" } : booking) }
              : message));
          }
          updateProposalStatus(proposal.id, "confirmed");
        } else {
          setRoomContext(false);
          updateRequest({});
          setChosenRoom(null);
          updateProposalStatus(proposal.id, "confirmed");
        }
      } else {
        setActiveProposal(null);
        if (responseProposal?.status === "outcome_unknown") updateProposalStatus(proposal.id, "outcome_unknown");
        const text = cancellation
          ? !responseMatches || responseProposal.status === "outcome_unknown" || responseProposal.status === "confirmed" ? "Die Antwort passt nicht eindeutig zum angezeigten Stornierungsvorschlag. Prüfe deine Buchungen, bevor du einen neuen Vorschlag erstellst." : "Die Stornierung konnte nicht bestätigt werden. Prüfe den Buchungsstatus, bevor du erneut vorgehst."
          : responseProposal?.status === "outcome_unknown" ? "Der Buchungsdienst hat nicht eindeutig geantwortet. Prüfe deine Buchungen, bevor du erneut buchst." : "Die Buchung konnte nicht bestätigt werden. Bitte suche erneut nach freien Zeiten.";
        addActionResult({ text });
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Der Dienst hat nicht geantwortet.";
      const disposition = classifyProposalFailure(cause, executionAttempted);
      if (disposition === "invalidated") {
        pendingProposalFocus.current = { id: proposal.id, confirmation: false };
        setActiveProposal(null);
        updateProposalStatus(proposal.id, "invalidated");
      } else if (disposition === "retry_preflight") {
        pendingProposalFocus.current = { id: proposal.id, confirmation: true };
        setActiveProposal(proposal.id);
      } else {
        setActiveProposal(null);
        if (disposition === "outcome_unknown") updateProposalStatus(proposal.id, "outcome_unknown");
      }
      const text = disposition === "invalidated"
        ? "Vorschlag ungültig. Die Aktion wurde nicht ausgeführt. Bitte bereite sie neu vor."
        : disposition === "outcome_unknown"
          ? cancellation
            ? `Die Antwort auf die Stornierung war nicht eindeutig. ${detail} Prüfe zuerst den Status deiner Buchung und erstelle keinen neuen Vorschlag, bevor du das Ergebnis geklärt hast.`
            : `Die Antwort auf die Buchung war nicht eindeutig. ${detail} Prüfe zuerst deine Buchungen, bevor du erneut buchst.`
          : disposition === "retry_preflight"
            ? `Der Vorschlag konnte vorab nicht geprüft werden und bleibt offen. Du kannst es erneut versuchen. ${detail}`
            : cancellation
              ? `Der Stornierungsvorschlag konnte nicht vorab geprüft werden; eine Ausführung wurde nicht angefordert. ${detail} Lade deine Buchungen erneut und prüfe den Status.`
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
  const knowledgeCitations = useMemo(() => chatKnowledgeCitations(messages, mode !== "oidc"), [messages, mode]);

  function rememberSourceOrigin(messageId: string) {
    const origin = knowledgeOrigin(sessionId, messageId);
    if (origin) window.history.replaceState(window.history.state, "", knowledgeChatReturnHref(origin));
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) { event.preventDefault(); void send(input); }

  return (
    <section className="chat-page" aria-label="HASI Chat" hidden={!active}>
      <div className="chat-toolbar"><button className="chat-history-toggle icon-button" type="button" onClick={onShowHistory} aria-label="Unterhaltungen anzeigen" title="Unterhaltungen anzeigen" aria-haspopup="dialog" aria-controls="chat-conversations-dialog"><PanelLeft size={19} aria-hidden="true" /><span>Chats</span></button>{configuration.userChoiceEnabled ? <label className="chat-model-picker"><MessageCircle size={15} aria-hidden="true" /><span className="sr-only">Sprachmodell</span><select aria-label="Sprachmodell" value={profileId} disabled={busy || modelLoading} onChange={(event) => { const parsed = chatProfileIdSchema.safeParse(event.currentTarget.value); if (!parsed.success) return; if (parsed.data === "offline" ? configuration.userChoiceEnabled : profiles.some((profile) => profile.id === parsed.data && profile.configured)) setProfileId(parsed.data); }}>{!offline && !selectedProfile && <option value={profileId} disabled>Gespeichertes Modell nicht verfügbar</option>}{profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!profile.configured}>{profile.label}{profile.configured ? "" : " · nicht konfiguriert"}</option>)}<option value="offline">Dialog-Demo</option></select></label> : <span className="chat-model-picker" aria-label="Sprachmodell"><MessageCircle size={15} aria-hidden="true" />{modelLoading ? "Modellstatus wird geladen …" : staticProfileLabel}</span>}<button type="button" onClick={onNewChat} disabled={newChatDisabled} title={newChatDisabled ? "Dieser Chat ist noch leer oder das Chatlimit ist erreicht." : undefined} className="chat-new" aria-label="Neuer Chat"><Plus size={16} aria-hidden="true" /><span>Neuer Chat</span></button></div>
      {fallbackLabel && <p className="chat-recovery-note" role="status">Ausweichmodell für diesen Dialog: {fallbackLabel}</p>}
      {modelError && <p className="chat-model-error" role="status">{modelError}</p>}
      {interrupted && <p className="chat-recovery-note" role="status">Eine frühere Anfrage wurde unterbrochen. Bei Buchungen prüfe bitte zuerst den aktuellen Status.</p>}
      {messagesTruncated && <p className="chat-recovery-note">Die letzten 200 Nachrichten dieses Chats werden gespeichert und angezeigt.</p>}
      <div className="chat-scroller" ref={scroller}>
        {!offline && <PersonalConnectionNotice />}
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <span className="chat-orb" aria-hidden="true"><HasiIcon size={36} /></span>
            <p className="chat-greeting">Hallo {name}.</p>
            <h1>Was kann ich <br /><span>für dich tun?</span></h1>
            <p className="chat-intro">Eine Frage, ein Vorhaben, dein nächster Schritt.<br className="chat-desktop-break" /> Dein Hochschulalltag beginnt mit einem Gespräch.</p>
            <div className="chat-suggestions">{suggestions.map(({ icon: Icon, title, text, caption }) => <button type="button" key={title} disabled={busy || !canSend} onClick={() => void send(text)}><Icon size={19} strokeWidth={1.6} aria-hidden="true" /><strong>{title}</strong><span>{caption}</span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>
          </div>
        ) : (
          <div className="chat-transcript" role="log" aria-label="Gesprächsverlauf" aria-live="polite" aria-relevant="additions">
            {renderedMessages.map((message) => {
              const pluginProposal = message.proposal?.action === "execute_tool" ? message.proposal : null;
              const pluginProposalView = pluginProposal ? pluginToolProposalPresentation(pluginProposal) : null;
              const serviceConnection = message.serviceConnection;
              return (
              <article key={message.id} id={`chat-${sessionId}-message-${message.id}`} tabIndex={-1} className={`chat-message chat-message--${message.role}`} aria-label={message.role === "user" ? "Du" : "HASI"}>
                <span className="chat-speaker">{message.role === "user" ? "Du" : <><HasiIcon size={18} /> HASI {message.model && <small>{message.model}</small>}</>}</span>
                <div className="chat-message-meta">{message.timestamp ? <time className="chat-message-time" dateTime={message.timestamp.createdAt} title="Servereingang · Europe/Berlin">{formatMessageTime(message.timestamp.createdAt)}</time> : <span className="chat-message-time">Zeitpunkt unbekannt</span>}<ChatMessageCopy message={message} citations={knowledgeCitations.answers.get(message.id) ?? knowledgeCitations.sourceCards.get(message.id) ?? []} /></div>
                <div className="chat-message-body">
                  {message.tool && <span className="chat-tool-label"><Check size={13} aria-hidden="true" /> {message.tool}</span>}
                  <ChatMarkdown source={message.proposal ? proposalPresentation(message.proposal).summary : message.text} citations={knowledgeCitations.answers.get(message.id) ?? []} origin={{ sessionId, messageId: message.id }} onCitationOpen={() => { rememberSourceOrigin(message.id); }} />
                  {serviceConnection && <ChatServiceConnection
                    key={`${serviceConnection.installationId}:${serviceConnection.requestId}`}
                    installationId={serviceConnection.installationId}
                    label={serviceConnection.label}
                    disabled={busy || messages.findLast(item => item.role === "user")?.id !== serviceConnection.requestId || messages.at(-1)?.id !== message.id}
                    onReady={() => resumeConnectedRequest(serviceConnection.requestId)}
                  />}
                  {message.rooms && <ChatRoomResults
                    rooms={message.rooms}
                    disabled={busy || (activeResult !== message.id && activeResult !== message.interactionId)}
                    onChooseRoom={(resource) => void chooseRoom(resource)}
                    onChooseSlot={(resource, interval) => void prepare(resource, interval)}
                  />}
                  {pluginAppsEnabled && message.rooms && <PluginResultApp
                    pluginId="de.hsh.hasi.anny"
                    presentationId="resources"
                    initialResult={{
                      resources: message.rooms.map(room => room.resource),
                      ...(message.rooms[0]?.requestedStartDate ? { requestedStartDate: message.rooms[0].requestedStartDate } : {}),
                      ...(message.rooms[0]?.requestedEndDate ? { requestedEndDate: message.rooms[0].requestedEndDate } : {}),
                      availabilityChecked: message.rooms.every(room => room.checked),
                    }}
                  />}
                  {(knowledgeCitations.sourceCards.get(message.id)?.length ?? 0) > 0 && <div className="chat-source-list" aria-label="Gefundene Quellen">{knowledgeCitations.sourceCards.get(message.id)?.map(source => <Link className="chat-source-card" href={knowledgeCitationHref(source, { sessionId, messageId: message.id }) ?? source.href} onClick={event => { if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.button === 0) rememberSourceOrigin(message.id); }} aria-label={`Quelle ${String(source.number)}: ${source.title} · ${source.sourceLabel} · Fassung ${String(source.revision)}`} key={source.citationId}><span className="chat-source-number" aria-hidden="true">{source.number}</span><span><small>{source.sourceLabel} · Fassung {source.revision}</small><strong>{source.title}</strong></span><ArrowRight size={16} aria-hidden="true" /></Link>)}</div>}
                  {pluginProposal && pluginProposalView && <div className="chat-tool-card chat-proposal" role="group" tabIndex={-1} aria-label={pluginProposal.status === "pending" ? "Pluginaktionsvorschlag" : proposalPresentation(pluginProposal).label} ref={node => { if (node) proposalCards.current.set(pluginProposal.id, node); else proposalCards.current.delete(pluginProposal.id); }}>
                    <span className="chat-proposal-label">{proposalPresentation(pluginProposal).label}</span>
                    <h2>{pluginProposalView.actionTitle}</h2>
                    {pluginProposalView.executionDescription && <p>{pluginProposalView.executionDescription}</p>}
                    <small>Plugin: {pluginProposalView.pluginId} · Werkzeug: <code>{pluginProposalView.executionTool}</code></small>
                    <ActionPreviewDetails preview={pluginProposal.preview} />
                    {pluginProposal.resourceName && <p>{pluginProposal.resourceName}</p>}
                    <p>{compactPluginToolResult(pluginProposal.arguments, 800)}</p>
                    {pluginProposal.status === "pending" && <small>Vorbereitet durch: {pluginProposalView.preparationTitle} · Gültig bis {formatTime(pluginProposal.expiresAt)} Uhr</small>}
                    {pluginProposal.status === "pending" && <button className="button button--primary button--wide" data-proposal-confirm type="button" disabled={busy || activeProposal !== pluginProposal.id} onClick={() => { void confirm(pluginProposal); }}>
                      {activeProposal === pluginProposal.id ? pluginProposalView.confirmLabel : "Vor Bestätigung erneut prüfen"}
                      <Check size={16} aria-hidden="true" />
                    </button>}
                  </div>}
                  {message.proposal && message.proposal.action !== "execute_tool" && <div className="chat-tool-card chat-proposal" role="group" tabIndex={-1} aria-label={message.proposal.status !== "pending" ? proposalPresentation(message.proposal).label : message.proposal.action === "cancel_booking" ? "Stornierungsvorschlag" : "Buchungsvorschlag"} ref={node => { const proposalId = message.proposal?.id; if (!proposalId) return; if (node) proposalCards.current.set(proposalId, node); else proposalCards.current.delete(proposalId); }}>
                    <span className="chat-proposal-label">{proposalPresentation(message.proposal).label}</span>
                    <h2>{message.proposal.resourceName}</h2>
                    <ActionPreviewDetails preview={message.proposal.preview} />
                    <p>{formatDateTime(message.proposal.startDate)} bis {formatTime(message.proposal.endDate)} Uhr</p>
                    {message.proposal.action === "cancel_booking" && message.proposal.status === "pending" && <p>Diese bestehende Buchung wird erst nach deiner Bestätigung storniert.</p>}
                    {message.proposal.status === "pending" && <small>Gültig bis {formatTime(message.proposal.expiresAt)} Uhr · Testumgebung</small>}
                    {message.proposal.status === "pending" && <button className="button button--primary button--wide" data-proposal-confirm type="button" disabled={busy || activeProposal !== message.proposal.id} onClick={() => { if (message.proposal) void confirm(message.proposal); }}>
                      {activeProposal === message.proposal.id ? message.proposal.action === "cancel_booking" ? "Stornierung bestätigen" : "Buchung bestätigen" : "Vor Bestätigung erneut prüfen"}
                      <Check size={16} aria-hidden="true" />
                    </button>}
                  </div>}
                  {message.proposal && activeProposal !== message.proposal.id && <ActionStatusControl key={JSON.stringify(message.proposal)} proposal={message.proposal} disabled={busy} onStatusChange={status => { if (message.proposal) updateProposalStatus(message.proposal.id, status); }} />}
                  {message.bookings && message.bookings.length > 0 && <div className="chat-booking-list">{message.bookings.map((booking) => <div className="chat-tool-card" key={booking.id}><h2>{booking.resourceName}</h2><p>{formatDateTime(booking.startDate)} bis {formatTime(booking.endDate)} Uhr</p><div className="chat-booking-footer"><span className="chat-booking-status">{bookingStatusLabel(booking.status)}</span>{canRequestCancellation(booking) && <button className="chat-card-action" type="button" disabled={busy} onClick={() => void prepareCancellation(booking)}>Stornierung beginnen <ArrowRight size={15} aria-hidden="true" /></button>}</div></div>)}</div>}
                  {message.proposal && proposalPresentation(message.proposal).bookingsLink && <Link className="chat-card-action" href="/bookings">Meine Buchungen öffnen <ArrowRight size={15} aria-hidden="true" /></Link>}
                </div>
              </article>
              );
            })}
          </div>
        )}
        {busy && <div className="chat-activity" role="status"><span className="spinner" />{activity}</div>}
      </div>
      <div className="chat-composer-dock">
        <form className="chat-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor={inputId}>Nachricht an HASI</label>
          <span className="sr-only" id={`${inputId}-formatting`}>Markdown ist möglich. Umschalt und Eingabetaste fügt eine neue Zeile ein. Eingabetaste sendet die Nachricht.</span>
          <textarea id={inputId} ref={composer} rows={2} maxLength={4000} value={input} aria-describedby={`${inputId}-formatting${inputNotice ? ` ${inputId}-notice` : ""}`} onChange={(event) => { updateInput(event.currentTarget.value); }} placeholder="Frag HASI oder beschreibe, was du vorhast …" onPaste={(event) => {
            const field = event.currentTarget;
            const pasted = event.clipboardData.getData("text/plain");
            if (field.value.length - (field.selectionEnd - field.selectionStart) + pasted.length > 4000) {
              event.preventDefault();
              setInputNotice("Nicht eingefügt: maximal 4.000 Zeichen. Dein Entwurf bleibt erhalten.");
            }
          }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} />
          {inputNotice && <p className="chat-input-notice" id={`${inputId}-notice`} role="alert">{inputNotice}</p>}
          <div className="chat-composer-bottom"><span><span className="status-dot" /> {offline ? "Dialog-Demo · ohne Sprachmodell" : modelLoading ? "Modellstatus wird geladen …" : selectedProfile?.configured ? `${providerLabel ?? "Modellanbieter"} · anny-Testdaten` : `${providerLabel ?? "Modellanbieter"} nicht konfiguriert`}</span><button type="submit" aria-label="Nachricht senden" disabled={busy || !canSend || !input.trim()}><ArrowUp size={20} aria-hidden="true" /></button></div>
        </form>
        <p className="chat-footnote">{offline ? "Dialog-Demo mit Testdaten · synthetisches IT- und Intranet-Wissen" : `Nachrichten und ausgewählte Toolergebnisse gehen an ${providerLabel ?? "den ausgewählten Modellanbieter"}. Bitte nur Testdaten eingeben.${selectedProfile?.fallbackLabels?.length ? ` Konfigurierte Ausweichmodelle: ${selectedProfile.fallbackLabels.join(", ")}.` : ""}`}</p>
      </div>
    </section>
  );
}
