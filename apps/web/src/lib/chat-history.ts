import type { WireMessage } from "./chat-contract";

/** Existing rolling budget, also applied to direct tool actions that spend no model call. */
export function trimChatHistory(history: WireMessage[]): boolean {
  while (history.length > 36 || JSON.stringify(history).length > 22_000) {
    const nextTurn = history.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextTurn < 0) return false;
    history.splice(0, nextTurn);
  }
  return true;
}

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
  if (role === "user") trimChatHistory(history);
  return message;
}
