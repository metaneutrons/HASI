import { createHash } from "node:crypto";
import { runModelStep, ModelRouterError } from "../src/lib/server/model-router";

// Explicit operator command only. No application endpoint or build hook calls it.
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_CALLS = 2;
const MAX_RESPONSE_BYTES = 65_536;
const now = new Date();
const request = { profileId: "groq-oss-120b", messages: [{ role: "user" as const, content: "Ich brauche am kommenden Montag ein Büro im Gebäude 1J von 8-16 Uhr." }] };
const bodies: string[] = [];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function counter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { state: "reported", value } : { state: value === undefined ? "missing" : value === null ? "null" : "invalid" };
}

async function observe(response: Response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return { status: response.status, observation: "body_missing" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return { status: response.status, observation: "body_limit" };
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return { status: response.status, observation: "invalid_json" }; }
    const usage = record(record(payload).usage);
    return {
      status: response.status,
      promptTokens: counter(usage.prompt_tokens),
      completionTokens: counter(usage.completion_tokens),
      documentedCacheTokens: counter(record(usage.prompt_tokens_details).cached_tokens),
      alternateCacheTokens: counter(usage.cached_tokens),
    };
  } finally {
    // Cancelling one cloned response branch can wait for the unread SDK branch.
    // Initiate cancellation without delaying delivery of that original branch.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const observedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== ENDPOINT || bodies.length >= MAX_CALLS || typeof init?.body !== "string") throw new Error("Probe transport boundary.");
  bodies.push(init.body);
  const response = await fetch(input, { ...init, redirect: "error" });
  console.log(JSON.stringify({ event: "raw_usage_observation", call: bodies.length, ...await observe(response) }));
  return response;
};

async function main() {
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error("Probe credential unavailable.");
  for (let index = 0; index < MAX_CALLS; index += 1) {
    const reply = await runModelStep(request, {
      // Only the approved bundled Groq profile and synthetic context are enabled.
      env: { GROQ_API_KEY: process.env.GROQ_API_KEY }, now, messageTimes: [now.toISOString()], fetch: observedFetch,
      telemetry: metrics => console.log(JSON.stringify({ event: "sdk_usage_observation", ...metrics })),
    });
    console.log(JSON.stringify({ event: "probe_result", probe: index + 1, profileId: reply.profile.id, ...reply.usage }));
    // A repair changes the prompt; stop instead of pretending it was an identical repeat.
    if (bodies.length !== index + 1) break;
  }
  console.log(JSON.stringify({ event: "request_comparison", calls: bodies.length, identical: bodies.length === 2 && bodies[0] === bodies[1], requestBytes: bodies.map(body => Buffer.byteLength(body)), syntheticRequestHashes: bodies.map(body => createHash("sha256").update(body).digest("hex")) }));
}

main().catch(cause => {
  // Never print SDK errors, provider text, headers, responses or environment values.
  console.error(JSON.stringify({ event: "probe_failed", ...(cause instanceof ModelRouterError ? { code: cause.code, providerStatus: cause.providerStatus, retryAfterSeconds: cause.rateLimits?.retryAfterSeconds } : { code: "probe_unavailable" }) }));
  process.exitCode = 1;
});
