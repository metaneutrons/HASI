import { createHash } from "node:crypto";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";

// Diagnostic-only: never imported by the application runtime.
export const GROQ_CACHE_PROBE_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const ENDPOINT = GROQ_CACHE_PROBE_ENDPOINT;
const MAX_CALLS = 2;
const MAX_RESPONSE_BYTES = 65_536;

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
    for (;;) {
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

export function createGroqCacheProbeTransport(upstream: typeof fetch, log: (event: unknown) => void, admission?: ModelBudgetAdmission) {
  const bodies: string[] = [];
  let pendingAdmissions = 0;
  const observedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== ENDPOINT || bodies.length + pendingAdmissions >= MAX_CALLS || typeof init?.body !== "string") throw new Error("Probe transport boundary.");
    const body = init.body;
    const limits = admission ? probeAdmissionLimits(body) : undefined;
    let reservation: Awaited<ReturnType<ModelBudgetAdmission['reserve']>> | undefined;
    pendingAdmissions += 1;
    try {
      reservation = limits ? await admission?.reserve(limits) : undefined;
      bodies.push(body);
    } finally { pendingAdmissions -= 1; }
    let settlementAttempted = false;
    try {
      const response = await upstream(url, { ...init, body, redirect: "error" });
      const observation = await observe(response);
      log({ event: "raw_usage_observation", call: bodies.length, ...observation });
      if (reservation && limits) {
        const prompt = 'promptTokens' in observation ? observation.promptTokens : undefined;
        const completion = 'completionTokens' in observation ? observation.completionTokens : undefined;
        const inputTokens = prompt?.state === 'reported' ? prompt.value : undefined;
        const outputTokens = completion?.state === 'reported' ? completion.value : undefined;
        const verified = typeof inputTokens === 'number' && inputTokens > 0 && inputTokens <= limits.inputTokens
          && typeof outputTokens === 'number' && outputTokens >= 0 && outputTokens <= limits.outputTokens;
        settlementAttempted = true;
        await reservation.settle(verified ? { inputTokens, outputTokens } : undefined);
        if (response.ok && !verified) throw new Error("Probe usage is unavailable or outside admission bounds.");
      }
      return response;
    } catch (error) {
      if (reservation && !settlementAttempted) await reservation.settle();
      throw error;
    }
  };

  return { fetch: observedFetch, calls: () => bodies.length, comparison: () => ({
    event: "request_comparison", calls: bodies.length,
    identical: bodies.length === 2 && bodies[0] === bodies[1],
    requestBytes: bodies.map(body => Buffer.byteLength(body)),
    syntheticRequestHashes: bodies.map(body => createHash("sha256").update(body).digest("hex")),
  }) };
}

function probeAdmissionLimits(body: string): { profileId: string; inputTokens: number; outputTokens: number } {
  if (Buffer.byteLength(body) > 60_000) throw new Error("Probe request exceeds admission bounds.");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("Invalid probe request."); }
  const payload = record(parsed);
  const profileId = payload.model === 'openai/gpt-oss-120b' ? 'groq-oss-120b'
    : payload.model === 'openai/gpt-oss-20b' ? 'groq-oss-20b' : undefined;
  const outputTokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (!profileId || typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 1536) throw new Error("Unapproved probe model or output limit.");
  return { profileId, inputTokens: Buffer.byteLength(body) + 4096, outputTokens };
}
