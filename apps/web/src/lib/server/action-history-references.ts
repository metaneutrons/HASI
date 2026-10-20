import "server-only";

import { z } from "zod";
import { MAX_CHAT_MESSAGES, MAX_CHAT_SESSIONS, type ChatMessage, type ChatWorkspace } from "../chat-sessions";

export const UNAVAILABLE_ANSWER = "Diese frühere Antwort ist nicht mehr verfügbar. Bitte stelle die Frage erneut.";

const actionReferenceSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  proposalId: z.uuid(),
  readOnly: z.boolean(),
});
export type ActionHistoryReference = z.infer<typeof actionReferenceSchema>;

export function actionReferenceKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}

export const actionReferencesSchema = z.array(actionReferenceSchema).max(MAX_CHAT_MESSAGES * MAX_CHAT_SESSIONS)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    for (const reference of references) {
      const key = actionReferenceKey(reference.sessionId, reference.messageId);
      if (seen.has(key)) context.addIssue({ code: "custom", message: "Duplicate action reference location." });
      seen.add(key);
    }
  });

function uniqueAssistantMessages(workspace: ChatWorkspace): Map<string, ChatMessage> {
  const messages = new Map<string, ChatMessage>();
  const seen = new Set<string>();
  for (const session of workspace.sessions) {
    for (const message of session.snapshot.messages) {
      const key = actionReferenceKey(session.id, message.id);
      if (seen.has(key)) messages.delete(key);
      else if (message.role === "assistant") messages.set(key, message);
      seen.add(key);
    }
  }
  return messages;
}

/** Only signed server-side locations survive. Deleted, moved or repurposed rows do not. */
export function retainedActionReferences(workspace: ChatWorkspace, references: readonly ActionHistoryReference[]): ActionHistoryReference[] {
  const messages = uniqueAssistantMessages(workspace);
  const cardFields = new Set(["id", "role", "text", "timestamp", "proposal", "tool", "model"]);
  const placeholderFields = new Set(["id", "role", "text", "timestamp"]);
  return references.flatMap(reference => {
    const message = messages.get(actionReferenceKey(reference.sessionId, reference.messageId));
    if (!message) return [];
    if (message.proposal?.id === reference.proposalId && Object.keys(message).every(key => cardFields.has(key))) return [reference];
    if (message.text === UNAVAILABLE_ANSWER && Object.keys(message).every(key => placeholderFields.has(key))) {
      return [{ ...reference, readOnly: true }];
    }
    return [];
  });
}

/** Call only on sanitized host receipts; browser input cannot mint a reference. */
export function updatedActionReferences(workspace: ChatWorkspace, retained: readonly ActionHistoryReference[]): ActionHistoryReference[] {
  const prior = new Map(retained.map(reference => [actionReferenceKey(reference.sessionId, reference.messageId), reference]));
  const references: ActionHistoryReference[] = [];
  for (const [key, message] of uniqueAssistantMessages(workspace)) {
    const reference = prior.get(key);
    if (message.proposal && z.uuid().safeParse(message.proposal.id).success) {
      const [sessionId, messageId] = JSON.parse(key) as [string, string];
      references.push({ sessionId, messageId, proposalId: message.proposal.id,
        readOnly: reference?.proposalId === message.proposal.id ? reference.readOnly : false });
    } else if (reference && message.text === UNAVAILABLE_ANSWER) references.push({ ...reference, readOnly: true });
  }
  return references;
}
