import type { ChatMessage } from "./chat-sessions";
import { knowledgeCitationFromDocument, type KnowledgeCitation } from "./knowledge-citations";

/** Presentation only. Document reads still recheck source access and revision in Core. */
export function chatKnowledgeCitations(messages: readonly ChatMessage[], allowUnsignedSynthetic = false) {
  const sourceCards = new Map<string, KnowledgeCitation[]>();
  const answers = new Map<string, KnowledgeCitation[]>();
  const numbers = new Map<string, number>();
  const contexts = new Map<string, KnowledgeCitation[]>();
  let turnSources: KnowledgeCitation[] = [];
  for (const message of messages) {
    if (message.role === "user") { turnSources = []; continue; }
    if (message.sources) {
      const cards = message.sources.flatMap(document => {
        const number = numbers.get(document.citationId) ?? numbers.size + 1;
        const citation = knowledgeCitationFromDocument(document, number);
        if (!citation) return [];
        numbers.set(citation.citationId, number);
        return [citation];
      });
      sourceCards.set(message.id, cards);
      if (message.sourceContextId) contexts.set(message.sourceContextId, cards);
      if (allowUnsignedSynthetic) {
        const synthetic = new Set(message.sources.filter(document => document.synthetic).map(document => document.citationId));
        turnSources.push(...cards.filter(citation => synthetic.has(citation.citationId)));
      }
      continue;
    }
    if (message.tool || message.proposal || message.bookings || message.rooms) continue;
    const eligible = message.evidence
      ? message.evidence.contextIds.flatMap(contextId => contexts.get(contextId) ?? [])
      : allowUnsignedSynthetic ? turnSources : [];
    answers.set(message.id, [...new Map(eligible.map(citation => [citation.citationId, citation])).values()]);
  }
  return { sourceCards, answers };
}
