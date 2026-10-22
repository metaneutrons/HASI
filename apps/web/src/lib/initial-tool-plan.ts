import { classifyIntent } from "./chat-demo";
import { annyWorkflow } from "./chat-tool-loop";
import type { WireMessage } from "./chat-contract";

const ENGLISH_GREETING = /^(?:(?:hello|hi|hey|good\s+morning|good\s+afternoon|good\s+evening|howdy)[!,.:;\s]*)+(?:hasi[!,.:;\s]*)?[.!?…]*$/iu;
const CURRENT_CLOCK_QUESTION = /^(?:wie\s+spät\s+ist\s+es(?:\s+(?:jetzt|gerade))?|wie\s+ist\s+die\s+(?:aktuelle\s+)?uhrzeit(?:\s+(?:jetzt|gerade))?|welches\s+datum\s+(?:haben\s+wir|ist)\s+heute|was\s+ist\s+das\s+heutige\s+datum|what\s+time\s+is\s+it(?:\s+(?:today|now|right\s+now))?|what(?:'s|\s+is)\s+the\s+time(?:\s+(?:now|right\s+now))?|what\s+date\s+is\s+it\s+today|what(?:'s|\s+is)\s+the\s+date\s+today|what\s+day\s+is\s+it\s+today)[.!?…]*$/iu;
const PRESENTATION_ONLY_FOLLOW_UP = /^(?:bitte\s+kürzer|fasse\s+(?:das|es)\s+kurz\s+zusammen|bitte\s+als\s+stichpunkte|translate\s+(?:that|this)\s+into\s+english)[.!?…]*$/iu;
const CURRENT_ACTION_STATUS_QUESTION = /^(?:hat\s+das\s+(?:geklappt|funktioniert)|was\s+ist\s+der\s+(?:aktuelle\s+)?status|ist\s+(?:das|die\s+buchung|meine\s+buchung|die\s+stornierung)\s+(?:bestätigt|storniert|abgeschlossen)|did\s+that\s+(?:work|go\s+through)|what\s+is\s+the\s+(?:current\s+)?status|is\s+(?:that|the\s+booking|my\s+booking|the\s+cancellation)\s+(?:confirmed|cancelled|completed))[.!?…]*$/iu;

const STANDALONE_CONVERSATION = [
  /^(?:danke(?:\s+(?:dir|ihnen|schön|schoen))?|vielen\s+dank(?:\s+(?:dir|ihnen))?|merci)[.!?…]*$/iu,
  /^(?:thank\s+you(?:\s+(?:very\s+much|so\s+much))?|thanks?(?:\s+(?:a\s+lot|so\s+much))?|thx)[.!?…]*$/iu,
  /^(?:okay|ok|alles\s+klar|verstanden|stimmt|gut|passt|ja|nein|gern|gerne|kein\s+problem|yes|no|sure|got\s+it|understood|alright|all\s+right|sounds\s+good|you(?:'re|\s+are)\s+welcome)[.!?…]*$/iu,
  /^(?:tschüss|tschuess|auf\s+wiedersehen|bis\s+später|bis\s+spaeter|ciao|bye|goodbye|see\s+you|take\s+care)[.!?…]*$/iu,
  /^(?:what\s+can\s+you\s+do(?:\s+for\s+me)?|what\s+are\s+you\s+able\s+to\s+do|was\s+kannst\s+du(?:\s+für\s+mich\s+tun)?|welche\s+aufgaben\s+kannst\s+du\s+(?:übernehmen|uebernehmen))[.!?…]*$/iu,
  /^(?:(?:kannst|könntest|koenntest)\s+du\s+mir\s+helfen|können\s+sie\s+mir\s+helfen|koennen\s+sie\s+mir\s+helfen|ich\s+brauche\s+hilfe|i\s+need\s+help|can\s+you\s+help\s+me|could\s+you\s+help\s+me|i\s+could\s+use\s+some\s+help)[.!?…]*$/iu,
];

function isPlainConversation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Keep the existing German greeting vocabulary and boundaries authoritative.
  return classifyIntent(trimmed, false) === "greeting"
    || ENGLISH_GREETING.test(trimmed)
    || STANDALONE_CONVERSATION.some(pattern => pattern.test(trimmed));
}

function hasEarlierAssistantAnswer(messages: readonly WireMessage[], latestUserIndex: number): boolean {
  return messages.slice(0, latestUserIndex).some(message =>
    message.role === "assistant" && !message.toolCalls?.length && message.content.trim().length > 0,
  );
}

/**
 * Whether a first substantive assistant answer should be preceded by a tool plan.
 * This is UX routing only; it does not establish authority or defend against injection.
 */
export function needsInitialToolPlan(messages: readonly WireMessage[], context: {
  /** Host-fetched status, including an explicitly unavailable result; never client text. */
  hasCurrentActionStatus?: boolean;
} = {}): boolean {
  const latestUserIndex = messages.findLastIndex(message => message.role === "user");
  if (latestUserIndex < 0) return false;
  if (messages.slice(latestUserIndex + 1).some(message => message.role === "tool")) return false;
  if (annyWorkflow(messages) !== null) return false;

  const latestUser = messages[latestUserIndex];
  if (latestUser?.role !== "user") return false;

  const text = latestUser.content.trim();
  if (isPlainConversation(text) || CURRENT_CLOCK_QUESTION.test(text)) return false;
  if (context.hasCurrentActionStatus && CURRENT_ACTION_STATUS_QUESTION.test(text)) return false;
  if (PRESENTATION_ONLY_FOLLOW_UP.test(text) && hasEarlierAssistantAnswer(messages, latestUserIndex)) return false;
  return true;
}
