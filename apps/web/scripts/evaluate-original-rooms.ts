import { createHash, randomUUID } from "node:crypto";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { originalRoomStopReason, runOriginalRoomCase } from "../src/lib/server/evaluation/original-room-runner";
import { createOriginalRoomPlan } from "../src/lib/server/evaluation/original-room-plan";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";

const CORPUS_SHA256 = "ff3efb055983aff35968495bffc409c9f8e1d13240eddcec390ad3ee03f1a078";
const DEFAULT_CASES = ["anny-01", "anny-02", "anny-04", "anny-05", "inject-02"] as const;
const USAGE = "Usage: pnpm evaluate:original-rooms --profiles <id,id> [--cases anny-01,anny-02,anny-04,anny-05,inject-02] [--max-calls 1..64] [--repetitions 1..3] [--run --output <new.ndjson>]";

function options(argv: readonly string[]) {
  const values = new Map<string, string>();
  let run = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--run" && !run) { run = true; continue; }
    if (!name || !["--profiles", "--cases", "--max-calls", "--repetitions", "--output"].includes(name) || values.has(name)) {
      throw new TypeError(USAGE);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    values.set(name, value);
  }
  const profiles = values.get("--profiles")?.split(",") ?? [];
  const cases = values.get("--cases")?.split(",") ?? [...DEFAULT_CASES];
  if (!profiles.length || profiles.some(id => !id) || !cases.length || cases.some(id => !id)
    || new Set(cases).size !== cases.length) throw new TypeError(USAGE);
  const maxCallsText = values.get("--max-calls") ?? "24";
  const repetitionsText = values.get("--repetitions") ?? "1";
  if (!/^[1-9]\d?$/u.test(maxCallsText) || Number(maxCallsText) > 64
    || !/^[1-3]$/u.test(repetitionsText)) throw new TypeError(USAGE);
  const output = values.get("--output");
  if (run !== Boolean(output)) throw new TypeError(USAGE);
  return { run, profiles, cases, maxCalls: Number(maxCallsText), repetitions: Number(repetitionsText), output };
}

function planEnvironment(): Record<string, string | undefined> {
  // Planning reads only model registry and price configuration. In particular,
  // it never enumerates or reads provider credentials or the shared DB URL.
  return {
    ...(process.env.HASI_LLM_CONFIG === undefined ? {} : { HASI_LLM_CONFIG: process.env.HASI_LLM_CONFIG }),
    ...(process.env.HASI_MODEL_PRICES === undefined ? {} : { HASI_MODEL_PRICES: process.env.HASI_MODEL_PRICES }),
    ...(process.env.CUSTOM_ENDPOINT === undefined ? {} : { CUSTOM_ENDPOINT: process.env.CUSTOM_ENDPOINT }),
    ...(process.env.CUSTOM_MODEL_ID === undefined ? {} : { CUSTOM_MODEL_ID: process.env.CUSTOM_MODEL_ID }),
  };
}

async function writeRecord(file: FileHandle, record: unknown) {
  await file.writeFile(JSON.stringify(record) + "\n", "utf8");
  await file.sync();
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") { console.info(USAGE); return; }
  const selected = options(process.argv.slice(2));
  const bytes = await readFile(new URL("../../../docs/evaluation/example-cases.json", import.meta.url));
  const corpusDigestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (corpusDigestSha256 !== CORPUS_SHA256) throw new TypeError("The bundled corpus differs from its reviewed operator pin.");
  const corpus = parseEvaluationDataset(JSON.parse(bytes.toString("utf8")) as unknown);
  const plan = createOriginalRoomPlan(corpus, selected.profiles, selected.cases, planEnvironment());
  const plannedRuns = plan.cases.length * plan.profiles.length * selected.repetitions;
  const metadata = {
    schemaVersion: 1,
    kind: "provider_original_room_development_plan",
    executionTrack: "controlled_full_original_evidence_and_native_pending_effects",
    corpusDigestSha256,
    configurationDigestSha256: plan.configurationDigestSha256,
    profiles: plan.profiles,
    cases: plan.cases.map(item => ({ ...item.definition })),
    repetitions: selected.repetitions,
    plannedRuns,
    actualHttpAttemptCap: selected.maxCalls,
    perCaseProviderRequestCap: 6,
    schedule: "case-major-rotating-profile-order",
    fallback: "disabled",
    limits: [
      ...plan.limits,
      "Full original benchmark evidence is passed through the direct production router; isolated native effects may prepare only an exact pending proposal.",
      "This does not exercise the protected HTTP or browser route and does not establish a semantic, security, authorization, or acceptance pass.",
    ],
  };
  if (!selected.run) {
    console.info(JSON.stringify({
      ...metadata,
      mode: "plan_only",
      fixtureCreated: false,
      fetchCalls: 0,
      providerCalls: 0,
      budgetAccess: false,
      credentialsChecked: false,
    }, null, 2));
    return;
  }

  const buildRevision = process.env.HASI_EVALUATION_BUILD_REVISION;
  if (process.env.HASI_MODEL_EVALUATION !== "1" || !buildRevision || !/^[a-f0-9]{40}$/u.test(buildRevision)
    || !process.env.DATABASE_URL?.trim() || !selected.output) {
    throw new TypeError("Explicit pinned opt-in and existing shared storage are required.");
  }

  // Exclusive creation keeps prior evidence intact and limits the private
  // provider-input report to its operator.
  const file = await open(selected.output, "wx", 0o600);
  const runId = randomUUID();
  let providerCalls = 0;
  let completed = 0;
  let observed = 0;
  let stopReason = "plan_completed";
  const nextCallAt = new Map<string, number>();
  try {
    await writeRecord(file, { ...metadata, kind: "run_started", runId, buildRevision, startedAt: new Date().toISOString() });
    // Resolve the existing shared durable ledger before the runner can create a
    // fixture. The runner receives this same admission for every provider call.
    const budgetAdmission: ModelBudgetAdmission = await getDurableModelBudgetAdmission();
    outer: for (let repetition = 0; repetition < selected.repetitions; repetition += 1) {
      for (let caseIndex = 0; caseIndex < plan.cases.length; caseIndex += 1) {
        const planned = plan.cases[caseIndex];
        if (!planned) throw new Error("Incomplete original-room case schedule.");
        for (let offset = 0; offset < plan.profiles.length; offset += 1) {
          const profile = plan.profiles[(offset + caseIndex + repetition) % plan.profiles.length];
          if (!profile) throw new Error("Incomplete original-room profile schedule.");
          if (providerCalls >= selected.maxCalls) { stopReason = "http_attempt_cap"; break outer; }
          const wait = Math.max(0, (nextCallAt.get(profile.connectionId) ?? 0) - Date.now());
          if (wait) await setTimeout(wait);
          const result = await runOriginalRoomCase(planned.evaluationCase, {
            profileId: profile.id,
            budgetAdmission,
            maxProviderRequests: Math.min(6, selected.maxCalls - providerCalls),
          });
          observed += 1;
          const attemptCount = result.measurements.providerRequestCount;
          if (!Number.isSafeInteger(attemptCount) || attemptCount < 0
            || attemptCount > 6 || attemptCount > selected.maxCalls - providerCalls) {
            throw new Error("Invalid original-room provider request measurement.");
          }
          providerCalls += attemptCount;
          if (result.outcome === "completed_observation") completed += 1;
          await writeRecord(file, { kind: "case_result", runId, repetition, result });
          console.info(JSON.stringify({
            caseId: result.caseId,
            profileId: result.profileId,
            outcome: result.outcome,
            usage: result.measurements.usageStatus,
            providerHttpAttempts: providerCalls,
            nativeEffectsSafe: result.nativeEffectsSafe,
          }));
          const stop = originalRoomStopReason(result);
          if (stop) { stopReason = stop; break outer; }
          nextCallAt.set(profile.connectionId, Date.now() + (profile.provider === "gwdg" ? 60_000 : 30_000));
        }
      }
    }
    await writeRecord(file, {
      kind: "run_finished",
      runId,
      finishedAt: new Date().toISOString(),
      stopReason,
      plannedRuns,
      observed,
      completedObservations: completed,
      notExecuted: plannedRuns - observed,
      providerHttpAttempts: providerCalls,
      modelAssessment: "requires_human_review",
      interpretation: "full original evidence and isolated native pending effects via direct production router; not protected HTTP/browser acceptance or semantic pass",
    });
    if (stopReason !== "plan_completed" || completed !== plannedRuns) process.exitCode = 2;
  } catch {
    try {
      await writeRecord(file, {
        kind: "run_aborted",
        runId,
        completedRunProviderHttpAttempts: providerCalls,
        incompleteRunUsage: "unknown",
      });
    } catch { /* Preserve the partial private report if its storage is unavailable. */ }
    throw new Error("Original-room evaluation stopped. Check reviewed options, opt-in, build identity, approved profiles and existing shared budget; no private cause is printed.");
  } finally {
    await file.close();
  }
}

void main().catch(() => {
  console.error("Original-room evaluation stopped. Check reviewed options, opt-in, build identity, approved profiles and existing shared budget; no private cause is printed.");
  process.exitCode = 1;
});
