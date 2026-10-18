import assert from "node:assert/strict";
import { z } from "zod";
import { createAnnyChatTools } from "../src/lib/anny-chat-tools";
import { runModelStep } from "../src/lib/server/model-router";

const USER_REQUEST = "Ich suche einen Arbeitsplatz in Gebäude 1J.";
const RECEIVED_AT = "2026-10-18T10:00:00.000Z";
const FIXED_NOW = new Date(RECEIVED_AT);
const LOCAL_TEST_KEY = "synthetic-only-placeholder-no-network";

const resources = Array.from({ length: 7 }, (_, index) => ({
  id: `synthetic-workplace-${String(index + 1)}`,
  name: `Arbeitsplatz ${String(index + 1)}`,
  description: "Synthetischer Katalogeintrag für Messungen.",
  capacity: null,
  location: "Gebäude 1J",
  features: ["Monitor", "Höhenverstellbarer Schreibtisch"],
  serviceId: `synthetic-service-${String(index + 1)}`,
  kind: "workplace" as const,
  parentId: `synthetic-office-${String(index + 1)}`,
  parentName: `Büro 1J.${String(index + 1).padStart(2, "0")}`,
  officeWorkplaceCount: 3,
}));

const annyRequest = <T>(path: string): Promise<T> => {
  if (path !== "/api/resources") throw new Error(`Unexpected synthetic request: ${path}`);
  return Promise.resolve({ resources } as T);
};

const capturedBodies: Record<string, unknown>[] = [];
let providerCall = 0;
const fakeFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assert.equal(url, "https://api.groq.com/openai/v1/chat/completions", "The measurement must remain offline and use the Groq adapter shape.");
  const requestBody = init?.body;
  if (typeof requestBody !== "string") throw new Error("The fake provider should receive a serialized JSON body.");
  const parsedBody: unknown = JSON.parse(requestBody);
  const body = z.record(z.string(), z.unknown()).parse(parsedBody);
  capturedBodies.push(body);

  providerCall += 1;
  const toolCalls = providerCall === 1
    ? [{
        id: "synthetic-search-seven-workplaces",
        type: "function",
        function: {
          name: "anny_search_resources",
          arguments: JSON.stringify({ kind: "workplace", location: "Gebäude 1J", officeType: "any" }),
        },
      }]
    : undefined;

  return Promise.resolve(new Response(JSON.stringify({
    id: `synthetic-completion-${String(providerCall)}`,
    object: "chat.completion",
    created: 1,
    model: "openai/gpt-oss-120b",
    choices: [{
      index: 0,
      finish_reason: toolCalls ? "tool_calls" : "stop",
      message: { role: "assistant", content: toolCalls ? null : "Ich habe passende Arbeitsplätze gefunden.", ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { headers: { "content-type": "application/json" } }));
};

function metrics(body: Record<string, unknown>, inputMessages: { content: string }[]) {
  const modelMessages = z.array(z.object({ role: z.string(), content: z.unknown().optional() })).parse(body.messages);
  const system = modelMessages.find(message => message.role === "system")?.content;
  const systemText = z.string().parse(system);
  const history = modelMessages.filter(message => message.role !== "system");
  return {
    appMessageCount: inputMessages.length,
    conversationContentChars: inputMessages.reduce((total, message) => total + message.content.length, 0),
    systemChars: systemText.length,
    systemUtf8Bytes: Buffer.byteLength(systemText),
    toolsUtf8Bytes: Buffer.byteLength(JSON.stringify(body.tools)),
    serializedHistoryUtf8Bytes: Buffer.byteLength(JSON.stringify(history)),
    fullProviderRequestUtf8Bytes: Buffer.byteLength(JSON.stringify(body)),
    providerParameters: {
      max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort,
      parallel_tool_calls: body.parallel_tool_calls,
    },
  };
}

async function main() {
  const firstMessages = [{ role: "user" as const, content: USER_REQUEST }];
  const first = await runModelStep({ profileId: "groq-oss-120b", messages: firstMessages }, {
    env: { GROQ_API_KEY: LOCAL_TEST_KEY },
    fetch: fakeFetch,
    now: FIXED_NOW,
    messageTimes: [RECEIVED_AT],
  });

  assert.equal(first.message.toolCalls?.length, 1, "The fake first response should request one synthetic room search.");
  const search = await createAnnyChatTools(annyRequest, { now: () => FIXED_NOW }).run(
    "anny_search_resources",
    { kind: "workplace", location: "Gebäude 1J", officeType: "any" },
  );
  assert.equal(search.output.returned, 7, "Expected exactly seven synthetic workplace matches.");

  const toolCall = first.message.toolCalls[0];
  if (!toolCall) throw new Error("Synthetic provider did not return the expected tool call.");
  const toolOutput = JSON.stringify(search.output);
  const followupMessages = [
    ...firstMessages,
    first.message,
    { role: "tool" as const, toolCallId: toolCall.id, name: toolCall.name, content: toolOutput },
  ];
  await runModelStep({ profileId: "groq-oss-120b", messages: followupMessages }, {
    env: { GROQ_API_KEY: LOCAL_TEST_KEY },
    fetch: fakeFetch,
    now: FIXED_NOW,
    messageTimes: [RECEIVED_AT, null, null],
  });

  assert.equal(capturedBodies.length, 2, "Only the fake provider transport should be called twice.");
  console.log(JSON.stringify({
    mode: "synthetic fake-fetch only; no live provider or anny endpoint",
    syntheticSearchResult: {
      matches: search.output.returned,
      serializedChars: toolOutput.length,
      serializedUtf8Bytes: Buffer.byteLength(toolOutput),
    },
    firstCall: metrics(requiredBody(0), firstMessages),
    afterSevenWorkplaceMatches: metrics(requiredBody(1), followupMessages),
  }, null, 2));
}

function requiredBody(index: number): Record<string, unknown> {
  const body = capturedBodies[index];
  if (!body) throw new Error("Synthetic provider request capture is incomplete.");
  return body;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Synthetic measurement failed.");
  process.exitCode = 1;
});
