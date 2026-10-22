import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { createRoomPlanningPlan, ROOM_PLANNING_CASE_ID } from "../src/lib/server/evaluation/room-planning-plan";
import { roomPlanningStopReason, runRoomPlanningCase } from "../src/lib/server/evaluation/room-planning-runner";
import { roomFixedEvidenceStopReason, runRoomFixedEvidenceCase } from "../src/lib/server/evaluation/room-fixed-evidence-runner";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";

const USAGE = "Usage: pnpm evaluate:room-planning --profiles <id,id> [--cases room-initial-preference-1j,room-fixed-evidence-clean-1j,room-fixed-evidence-poisoned-1j] [--max-calls 1..16] [--repetitions 1..3] [--run --output <new.ndjson>]";

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
  const cases = values.get("--cases")?.split(",") ?? [ROOM_PLANNING_CASE_ID];
  if (!profiles.length || profiles.some(id => !id) || !cases.length || cases.some(id => !id)
    || new Set(cases).size !== cases.length) throw new TypeError(USAGE);
  const maxCallsText = values.get("--max-calls") ?? "8";
  const repetitionsText = values.get("--repetitions") ?? "1";
  if (!/^[1-9]\d?$/u.test(maxCallsText) || Number(maxCallsText) > 16
    || !/^[1-3]$/u.test(repetitionsText)) throw new TypeError(USAGE);
  const output = values.get("--output");
  if (run !== Boolean(output)) throw new TypeError(USAGE);
  return { run, profiles, cases, maxCalls: Number(maxCallsText), repetitions: Number(repetitionsText), output };
}

async function write(file: FileHandle, record: unknown) {
  await file.writeFile(JSON.stringify(record) + "\n", "utf8");
  await file.sync();
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") { console.info(USAGE); return; }
  const selected = options(process.argv.slice(2));
  const plan = createRoomPlanningPlan(selected.profiles, process.env, selected.cases);
  const plannedRuns = plan.cases.length * plan.profiles.length * selected.repetitions;
  const metadata = {
    schemaVersion: 1,
    kind: "provider_room_planning_development_plan",
    configurationDigestSha256: plan.configurationDigestSha256,
    profiles: plan.profiles,
    cases: plan.cases,
    repetitions: selected.repetitions,
    plannedRuns,
    actualHttpAttemptCap: selected.maxCalls,
    schedule: "case-major-rotating-profile-order",
    fallback: "disabled",
    limits: plan.limits,
  };
  if (!selected.run) {
    console.info(JSON.stringify({ ...metadata, mode: "plan_only", fixtureCreated: false, fetchCalls: 0,
      providerCalls: 0, budgetAccess: false, credentialsChecked: false }, null, 2));
    return;
  }
  const buildRevision = process.env.HASI_EVALUATION_BUILD_REVISION;
  if (process.env.HASI_MODEL_EVALUATION !== "1" || !buildRevision || !/^[a-f0-9]{40}$/u.test(buildRevision)
    || !process.env.DATABASE_URL?.trim() || !selected.output) {
    throw new TypeError("Explicit pinned opt-in and existing shared storage are required.");
  }
  const file = await open(selected.output, "wx", 0o600);
  const runId = randomUUID();
  let providerCalls = 0;
  let completed = 0;
  let observed = 0;
  let stopReason = "plan_completed";
  const nextCallAt = new Map<string, number>();
  try {
    await write(file, { ...metadata, kind: "run_started", runId, buildRevision, startedAt: new Date().toISOString() });
    // Capture the existing shared durable admission while the deployment URL is
    // still in force. The runner receives this exact handle before fixture setup.
    const budgetAdmission: ModelBudgetAdmission = await getDurableModelBudgetAdmission();
    outer: for (let repetition = 0; repetition < selected.repetitions; repetition += 1) {
      for (let index = 0; index < plan.cases.length; index += 1) {
        const planned = plan.cases[index];
        if (!planned) throw new Error("Incomplete room-planning case schedule.");
        for (let offset = 0; offset < plan.profiles.length; offset += 1) {
          const profile = plan.profiles[(offset + index + repetition) % plan.profiles.length];
          if (!profile) throw new Error("Incomplete room-planning profile schedule.");
          if (providerCalls >= selected.maxCalls) { stopReason = "http_attempt_cap"; break outer; }
          const wait = Math.max(0, (nextCallAt.get(profile.connectionId) ?? 0) - Date.now());
          if (wait) await setTimeout(wait);
          const result = "executionTrack" in planned
            ? await runRoomFixedEvidenceCase({ caseId: planned.id, profileId: profile.id, budgetAdmission,
              maxProviderRequests: Math.min(planned.providerHttpAttemptLimit, selected.maxCalls - providerCalls) })
            : await runRoomPlanningCase({ caseId: planned.id, profileId: profile.id, budgetAdmission,
              maxProviderRequests: Math.min(8, selected.maxCalls - providerCalls) });
          observed += 1;
          providerCalls += result.measurements.providerRequestCount;
          if (result.outcome === "completed_observation") completed += 1;
          await write(file, { kind: "case_result", runId, repetition, result });
          console.info(JSON.stringify({ caseId: result.caseId, profileId: result.profileId, outcome: result.outcome,
            usage: result.measurements.usageStatus, providerHttpAttempts: providerCalls }));
          const stop = "executionTrack" in result
            ? roomFixedEvidenceStopReason(result)
            : roomPlanningStopReason(result);
          if (stop) { stopReason = stop; break outer; }
          nextCallAt.set(profile.connectionId, Date.now() + (profile.provider === "gwdg" ? 60_000 : 30_000));
        }
      }
    }
    await write(file, { kind: "run_finished", runId, finishedAt: new Date().toISOString(), stopReason,
      plannedRuns, observed, completedObservations: completed, notExecuted: plannedRuns - observed,
      providerHttpAttempts: providerCalls, modelAssessment: "requires_human_review",
      interpretation: "technical route and read observations only; no semantic pass, ranking, gold, or M6 acceptance" });
    if (stopReason !== "plan_completed" || completed !== plannedRuns) process.exitCode = 2;
  } catch {
    try { await write(file, { kind: "run_aborted", runId, completedRunProviderHttpAttempts: providerCalls, incompleteRunUsage: "unknown" }); }
    catch { /* The existing partial report remains private and unchanged beyond completed writes. */ }
    throw new Error("Room-planning evaluation stopped. Check reviewed options, opt-in, build identity, approved profiles and existing shared budget; no private cause is printed.");
  } finally { await file.close(); }
}

void main().catch(() => {
  console.error("Room-planning evaluation stopped. Check reviewed options, opt-in, build identity, approved profiles and existing shared budget; no private cause is printed.");
  process.exitCode = 1;
});
