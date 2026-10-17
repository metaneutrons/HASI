import type { WireMessage } from "./chat-contract";

/** Record host UI actions without creating adjacent assistant messages. */
export function appendChatText(history: WireMessage[], role: "user" | "assistant", content: string, eventId?: string) {
  const text = content.trim().slice(0, 4000);
  if (!text) return;
  const previous = history.at(-1);
  if (role === "assistant" && previous?.role === "assistant" && !previous.toolCalls?.length) {
    previous.content = `${previous.content}\n${text}`.slice(-4000);
    // Coalescing changes the event; an old receipt must never certify new text.
    delete previous.timestamp;
    if (eventId) previous.id = eventId;
    else delete previous.id;
    return previous;
  }
  const message: WireMessage = { role, content: text, ...(eventId ? { id: eventId } : {}) };
  history.push(message);
  return message;
}
