import type { WireMessage } from "./chat-contract";

/** Record host UI actions without creating adjacent assistant messages. */
export function appendChatText(history: WireMessage[], role: "user" | "assistant", content: string) {
  const text = content.trim().slice(0, 4000);
  if (!text) return;
  const previous = history.at(-1);
  if (role === "assistant" && previous?.role === "assistant" && !previous.toolCalls?.length) {
    previous.content = `${previous.content}\n${text}`.slice(-4000);
    return;
  }
  history.push({ role, content: text });
}
