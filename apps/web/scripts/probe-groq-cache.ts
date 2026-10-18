import { randomUUID } from "node:crypto";
import { createGroqCacheProbeTransport, GROQ_CACHE_PROBE_ENDPOINT as ENDPOINT } from "./groq-cache-probe-transport";
import { runModelStep, ModelRouterError } from "../src/lib/server/model-router";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { loadModelConfiguration, resolveModelConnection } from "../src/lib/server/model-config";

// Explicit operator command only. No application endpoint or build hook calls it.
const MAX_CALLS = 2;
const now = new Date();
const request = { profileId: "groq-oss-120b", messages: [{ role: "user" as const, content: "Ich brauche am kommenden Montag ein Büro im Gebäude 1J von 8-16 Uhr." }] };
let transport: ReturnType<typeof createGroqCacheProbeTransport>;
const observedFetch: typeof fetch = (input, init) => transport.fetch(input, init);
const mode = process.argv[2] ?? "hasi";

async function plainControl() {
  // Independent synthetic control: no HASI instructions, tools or changing clocks.
  // The nonce is created once, then both complete request bodies are identical.
  const content = `Synthetic cache qualification ${randomUUID()}. Read the following fictitious catalog and reply only OK.\n` +
    Array.from({ length: 160 }, (_, index) => `Record ${String(index)}: Campus Example has a blue desk, a green chair and a quiet study area.`).join("\n");
  const body = JSON.stringify({ model: mode === "plain-20b" ? "openai/gpt-oss-20b" : "openai/gpt-oss-120b", messages: [{ role: "system", content }, { role: "user", content: "Reply OK." }], max_completion_tokens: 64, reasoning_effort: "low", stream: false });
  for (let index = 0; index < MAX_CALLS; index += 1) {
    const response = await observedFetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${String(process.env.GROQ_API_KEY)}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
    // Consume the original branch without printing model output or provider errors.
    await response.body?.cancel();
    if (!response.ok) throw new Error("Control provider failure.");
  }
}


async function main() {
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error("Probe credential unavailable.");
  if (mode !== "hasi" && mode !== "plain" && mode !== "plain-20b") throw new Error("Unknown probe mode.");
  const configuration = loadModelConfiguration(process.env);
  const selectedProfileId = mode === 'plain-20b' ? 'groq-oss-20b' : 'groq-oss-120b';
  const profile = configuration.profiles.find(item => item.id === selectedProfileId);
  const connection = configuration.connections.find(item => item.id === profile?.connectionId);
  const expectedModelId = mode === 'plain-20b' ? 'openai/gpt-oss-20b' : 'openai/gpt-oss-120b';
  if (profile?.modelId !== expectedModelId || connection?.provider !== 'groq'
    || resolveModelConnection(connection).baseURL !== 'https://api.groq.com/openai/v1') {
    throw new Error('The probe model must match the operator-approved budget profile.');
  }
  const budgetAdmission = await getDurableModelBudgetAdmission();
  // The HASI router reserves every generate/repair attempt; this transport only
  // observes those calls. Plain controls have no router, so the transport admits
  // each direct HTTP request itself.
  transport = createGroqCacheProbeTransport(fetch, event => { console.log(JSON.stringify(event)); }, mode === "hasi" ? undefined : budgetAdmission);
  if (mode !== "hasi") await plainControl();
  else for (let index = 0; index < MAX_CALLS; index += 1) {
    const reply = await runModelStep(request, {
      // Only the approved bundled Groq profile and synthetic context are enabled.
      env: { GROQ_API_KEY: process.env.GROQ_API_KEY }, now, messageTimes: [now.toISOString()], fetch: observedFetch,
      context: { dataClasses: ['synthetic_demo'], toolsRequired: true },
      budgetAdmission,
      telemetry: metrics => { console.log(JSON.stringify({ event: "sdk_usage_observation", ...metrics })); },
    });
    console.log(JSON.stringify({ event: "probe_result", probe: index + 1, profileId: reply.profile.id, ...reply.usage }));
    // A repair changes the prompt; stop instead of pretending it was an identical repeat.
    if (transport.calls() !== index + 1) break;
  }
  console.log(JSON.stringify({ ...transport.comparison(), mode }));
}

main().catch((cause: unknown) => {
  // Never print SDK errors, provider text, headers, responses or environment values.
  console.error(JSON.stringify({ event: "probe_failed", ...(cause instanceof ModelRouterError ? { code: cause.code, providerStatus: cause.providerStatus, retryAfterSeconds: cause.rateLimits?.retryAfterSeconds } : { code: "probe_unavailable" }) }));
  process.exitCode = 1;
});
