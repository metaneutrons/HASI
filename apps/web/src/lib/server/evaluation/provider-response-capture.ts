import "server-only";

import { createHash } from "node:crypto";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const providerMessageMemberNameHashDomain = "hasi.provider-message-member-name.v1\0";
const maxUnexpectedMessageMemberNameHashes = 8;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerMessageMemberNameHash(name: string): string {
  return hash(`${providerMessageMemberNameHashDomain}${name}`);
}

export type ProviderCaptureIssue = "unexpected_message_member" | "unexpected_message_role" | "assistant_name_metadata_invalid" | "legacy_function_call_present" | "audio_payload_present"
  | "text_value_unavailable" | "tool_calls_container_invalid" | "tool_call_shape_invalid" | "tool_name_unavailable" | "tool_name_limit_exceeded"
  | "tool_arguments_unavailable" | "tool_arguments_limit_exceeded" | "tool_proposal_limit_exceeded"
  | "content_part_shape_invalid" | "content_part_type_unsupported" | "output_part_shape_invalid" | "output_message_content_invalid"
  | "output_content_part_type_unsupported" | "output_part_type_unsupported" | "text_limit_exceeded";

/** Excludes reasoning and response headers; these observations never authorize tools. */
export function captureProviderAnswer(value: unknown) {
  const text: string[] = [];
  const proposals: { tool: string; argumentsText: string }[] = [];
  const captureIssues = new Set<ProviderCaptureIssue>();
  let unexpectedMessageMembers: { count: number; nameSha256: string[]; truncated: boolean } | undefined;
  let recognized = false;
  const markPartial = (issue: ProviderCaptureIssue) => { captureIssues.add(issue); };
  const addText = (value: unknown) => { if (typeof value === "string") text.push(value); else markPartial("text_value_unavailable"); };
  const addCall = (name: unknown, arguments_: unknown, encoding: "string" | "object" = "string") => {
    if (typeof name !== "string") { markPartial("tool_name_unavailable"); return; }
    if (name.length > 128) { markPartial("tool_name_limit_exceeded"); return; }
    if (encoding === "string" ? typeof arguments_ !== "string" : !object(arguments_)) { markPartial("tool_arguments_unavailable"); return; }
    const argumentsText = typeof arguments_ === "string" ? arguments_ : JSON.stringify(arguments_ ?? null);
    if (argumentsText.length > 16_384) { markPartial("tool_arguments_limit_exceeded"); return; }
    if (proposals.length >= 32) { markPartial("tool_proposal_limit_exceeded"); return; }
    proposals.push({ tool: name, argumentsText });
  };
  if (object(value)) {
    const choice = Array.isArray(value.choices) ? value.choices[0] as unknown : undefined;
    if (object(choice) && object(choice.message)) {
      recognized = "content" in choice.message || Array.isArray(choice.message.tool_calls) || typeof choice.message.refusal === "string";
      const messageKeys = new Set(["role", "name", "content", "tool_calls", "reasoning", "reasoning_content", "refusal", "annotations", "audio", "function_call"]);
      const unknownMessageMemberNames = Object.keys(choice.message).filter(key => !messageKeys.has(key));
      if (unknownMessageMemberNames.length) {
        markPartial("unexpected_message_member");
        const sortedNameSha256 = unknownMessageMemberNames.map(providerMessageMemberNameHash).sort();
        unexpectedMessageMembers = {
          count: unknownMessageMemberNames.length,
          nameSha256: sortedNameSha256.slice(0, maxUnexpectedMessageMemberNameHashes),
          truncated: sortedNameSha256.length > maxUnexpectedMessageMemberNameHashes,
        };
      }
      if (choice.message.role !== "assistant") markPartial("unexpected_message_role");
      // Optional OpenAI-compatible metadata never establishes identity or tool authority.
      if (choice.message.name !== undefined && choice.message.name !== null && typeof choice.message.name !== "string") {
        markPartial("assistant_name_metadata_invalid");
      }
      if (choice.message.function_call !== undefined && choice.message.function_call !== null) markPartial("legacy_function_call_present");
      if (choice.message.audio !== undefined && choice.message.audio !== null) markPartial("audio_payload_present");
      if (choice.message.refusal !== undefined && choice.message.refusal !== null) addText(choice.message.refusal);
      if (choice.message.content !== null && choice.message.content !== undefined) addText(choice.message.content);
      if (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null && !Array.isArray(choice.message.tool_calls)) markPartial("tool_calls_container_invalid");
      for (const call of Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []) {
        if (object(call) && object(call.function)) addCall(call.function.name, call.function.arguments);
        else markPartial("tool_call_shape_invalid");
      }
    }
    if (Array.isArray(value.content) || Array.isArray(value.output)) recognized = true;
    for (const part of Array.isArray(value.content) ? value.content : []) {
      if (!object(part)) { markPartial("content_part_shape_invalid"); continue; }
      if (part.type === "text") addText(part.text);
      else if (part.type === "tool_use") addCall(part.name, part.input, "object");
      else if (part.type !== "thinking" && part.type !== "redacted_thinking") markPartial("content_part_type_unsupported");
    }
    for (const part of Array.isArray(value.output) ? value.output : []) {
      if (!object(part)) { markPartial("output_part_shape_invalid"); continue; }
      if (part.type === "function_call") addCall(part.name, part.arguments);
      else if (part.type === "message") {
        if (!Array.isArray(part.content)) markPartial("output_message_content_invalid");
        for (const content of Array.isArray(part.content) ? part.content : []) {
          if (object(content) && content.type === "output_text") addText(content.text);
          else if (object(content) && content.type === "refusal") addText(content.refusal);
          else markPartial("output_content_part_type_unsupported");
        }
      } else if (part.type !== "reasoning") markPartial("output_part_type_unsupported");
    }
  }
  if (!recognized) return { captureStatus: "unrecognized_shape" as const };
  const joined = text.join("\n");
  if (joined.length > 30_000) markPartial("text_limit_exceeded");
  if (captureIssues.size) return { captureStatus: "partial" as const, captureIssues: [...captureIssues],
    ...(unexpectedMessageMembers ? { unexpectedMessageMembers } : {}),
    ...(text.length ? { text: joined.slice(0, 30_000) } : {}) };
  return { captureStatus: "captured" as const, ...(text.length ? { text: joined } : {}), proposals };
}

export async function readProviderObservationBytes(response: Response): Promise<Uint8Array> {
  if (response.redirected || response.status >= 300 && response.status < 400) throw new Error("Unapproved provider redirect.");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) throw new Error("The provider response exceeded the observation bound.");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(parts);
}

