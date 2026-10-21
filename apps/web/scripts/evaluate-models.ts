import { createHash, randomUUID } from "node:crypto";
import { readFile, open, type FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { createProviderEvaluationPlan } from "../src/lib/server/evaluation/provider-suite";
import { runProviderEvaluationCase } from "../src/lib/server/evaluation/provider-runner";

// Only this code-reviewed bundled synthetic development corpus may be sent.
// Updating the corpus requires updating this explicit pin in the same review.
const CORPUS_SHA256 = "f4c543a711875b6e93cea32f26aaeffeec2cb90ea24207da161c590d6eaca8ef";
const USAGE = "Usage: pnpm evaluate:models --profiles <id,id> [--cases id,id] [--max-calls 1..64] [--repetitions 1..3] [--run --output <new.ndjson>]";

function options(argv: readonly string[]) {
  const values = new Map<string, string>();
  let run = false;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--run" && !run) { run = true; continue; }
    if (!name || !["--profiles", "--cases", "--max-calls", "--repetitions", "--output"].includes(name) || values.has(name)) throw new TypeError(USAGE);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TypeError(USAGE);
    values.set(name, value);
  }
  const profileIds = values.get("--profiles")?.split(",") ?? [];
  const caseIds = values.get("--cases")?.split(",");
  if (caseIds && (caseIds.some(id => !id) || new Set(caseIds).size !== caseIds.length)) throw new TypeError(USAGE);
  const maxCallsText = values.get("--max-calls") ?? "8";
  const repetitionsText = values.get("--repetitions") ?? "1";
  const maxCalls = Number(maxCallsText);
  const repetitions = Number(repetitionsText);
  if (!/^[1-9]\d?$/u.test(maxCallsText) || maxCalls > 64 || !/^[1-3]$/u.test(repetitionsText)) throw new TypeError(USAGE);
  const output = values.get("--output");
  if (profileIds.length === 0 || (run && !output) || (!run && output)) throw new TypeError(USAGE);
  return { run, profileIds, caseIds, maxCalls, repetitions, output };
}

async function writeRecord(file: FileHandle, record: unknown) {
  await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await file.sync();
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") { console.info(USAGE); return; }
  const selected = options(process.argv.slice(2));
  const bytes = await readFile(new URL("../../../docs/evaluation/example-cases.json", import.meta.url));
  const corpusDigestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (corpusDigestSha256 !== CORPUS_SHA256) throw new TypeError("The bundled corpus differs from its reviewed operator pin.");
  const plan = createProviderEvaluationPlan(JSON.parse(bytes.toString("utf8")) as unknown, selected.profileIds, process.env);
  // Selection narrows the reviewed server manifest; it never grants new evidence.
  if (selected.caseIds?.some(id => !plan.cases.some(item => item.evaluationCase.id === id))) {
    throw new TypeError("Selected cases must belong to the approved fixed-evidence manifest.");
  }
  const selectedCases = selected.caseIds
    ? plan.cases.filter(item => selected.caseIds?.includes(item.evaluationCase.id))
    : plan.cases;
  const plannedRuns = selectedCases.length * plan.profiles.length * selected.repetitions;
  const metadata = {
    schemaVersion: 1, kind: "provider_fixed_evidence_development_plan", corpusDigestSha256,
    configurationDigestSha256: plan.configurationDigestSha256,
    profiles: plan.profiles, caseIds: selectedCases.map(item => item.evaluationCase.id), excludedCases: plan.excludedCases,
    repetitions: selected.repetitions, plannedRuns, actualHttpAttemptCap: selected.maxCalls,
    schedule: "case-major-rotating-profile-order", fallback: "disabled",
    limits: ["draft development corpus", "answer-only fixed evidence; no tool execution", "literal citation presence only; semantic quality requires human review", "not gold, blind comparison or M6 acceptance", "cache and resolved alias versions unknown"],
  };
  if (!selected.run) { console.info(JSON.stringify({ ...metadata, mode: "plan_only", providerCalls: 0, budgetAccess: false }, null, 2)); return; }
  const buildRevision = process.env.HASI_EVALUATION_BUILD_REVISION;
  if (process.env.HASI_MODEL_EVALUATION !== "1" || !buildRevision || !/^[a-f0-9]{40}$/u.test(buildRevision)) {
    throw new TypeError("Live evaluation requires explicit operator opt-in and a pinned evaluation build revision.");
  }
  if (!process.env.DATABASE_URL?.trim()) throw new TypeError("Live evaluation requires the existing shared PostgreSQL budget.");
  if (!selected.output) throw new TypeError(USAGE);
  // Exclusive creation prevents replacing a previous report or repository file.
  const file = await open(selected.output, "wx", 0o600);
  const runId = randomUUID();
  let calls = 0;
  let completed = 0;
  let errorRuns = 0;
  let skipped = 0;
  let stopReason = "plan_completed";
  const stoppedConnections = new Set<string>();
  const nextCallAt = new Map<string, number>();
  try {
    await writeRecord(file, { ...metadata, kind: "run_started", runId, buildRevision, startedAt: new Date().toISOString() });
    // This loads the existing ledger with requireExistingState. No initialization,
    // process-local fallback, per-evaluation budget or quota reset is permitted.
    const budgetAdmission = await getDurableModelBudgetAdmission();
    outer: for (let repetition = 0; repetition < selected.repetitions; repetition++) {
      for (let caseIndex = 0; caseIndex < selectedCases.length; caseIndex++) {
        const fixture = selectedCases[caseIndex];
        if (!fixture) throw new Error("Evaluation schedule is incomplete.");
        for (let offset = 0; offset < plan.profiles.length; offset++) {
          const profile = plan.profiles[(offset + caseIndex + repetition) % plan.profiles.length];
          if (!profile) throw new Error("Evaluation profile schedule is incomplete.");
          if (calls >= selected.maxCalls) { stopReason = "http_attempt_cap"; break outer; }
          if (stoppedConnections.has(profile.connectionId)) {
            skipped++;
            await writeRecord(file, { kind: "run_skipped", caseId: fixture.evaluationCase.id, profileId: profile.id, repetition, reason: "connection_stopped_after_error" });
            continue;
          }
          const waitMs = Math.max(0, (nextCallAt.get(profile.connectionId) ?? 0) - Date.now());
          if (waitMs) await setTimeout(waitMs);
          const result = await runProviderEvaluationCase(fixture.evaluationCase, {
            profileId: profile.id, budgetAdmission,
            serverAuthorizedEvidence: fixture.serverAuthorizedEvidence, oracle: fixture.oracle,
            maxProviderRequests: Math.min(16, selected.maxCalls - calls),
          });
          calls += result.measurements.providerRequestCount;
          if (result.transport.status === "completed") completed++; else errorRuns++;
          await writeRecord(file, { kind: "case_result", runId, repetition, recordedAt: new Date().toISOString(), result });
          console.info(JSON.stringify({ caseId: result.caseId, profileId: profile.id, repetition, transport: result.transport.status,
            assessment: result.assessment.status, usage: result.measurements.usageStatus, providerCalls: calls }));
          const spacing = profile.provider === "gwdg" ? 60_000 : 30_000;
          nextCallAt.set(profile.connectionId, Date.now() + spacing);
          if (result.transport.status === "error") {
            // No retries after rate limits, missing credentials, provider errors
            // or unknown usage. Other connections may still be sampled safely.
            stoppedConnections.add(profile.connectionId);
            if (result.transport.code.startsWith("budget_")) { stopReason = result.transport.code; break outer; }
          }
        }
      }
    }
    await writeRecord(file, { kind: "run_finished", runId, finishedAt: new Date().toISOString(), stopReason,
      plannedRuns, completed, errorRuns, skipped, notExecuted: plannedRuns - completed - errorRuns - skipped,
      providerCalls: calls, interpretation: "development observations; no model ranking or acceptance decision" });
    if (errorRuns > 0 || stopReason !== "plan_completed") process.exitCode = 2;
  } catch {
    await writeRecord(file, { kind: "run_aborted", runId, recordedAt: new Date().toISOString(), code: "operator_evaluation_failed", providerCalls: null, completedRunProviderCalls: calls, incompleteRunUsage: "unknown" });
    throw new Error("Operator evaluation failed; the partial report is preserved.");
  } finally { await file.close(); }
}

void main().catch(() => {
  // Provider/config/database causes can contain credentials or raw response text.
  console.error("Model evaluation stopped. Check options, approved profiles, corpus pin, explicit opt-in and shared budget availability. No private error cause is printed.");
  process.exitCode = 1;
});
