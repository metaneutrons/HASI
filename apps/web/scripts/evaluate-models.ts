import { createHash, randomUUID } from "node:crypto";
import { readFile, open, type FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { createProviderEvaluationPlan } from "../src/lib/server/evaluation/provider-suite";
import { runProviderEvaluationCase } from "../src/lib/server/evaluation/provider-runner";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";
import { getProviderWorkflowDefinitions, createProviderWorkflowFixture } from "../../../scripts/evaluation/provider-workflow-fixture";

// Only this code-reviewed bundled synthetic development corpus may be sent.
// Updating the corpus requires updating this explicit pin in the same review.
const CORPUS_SHA256 = "ff3efb055983aff35968495bffc409c9f8e1d13240eddcec390ad3ee03f1a078";
const USAGE = "Usage: pnpm evaluate:models --profiles <id,id> [--workflows] [--cases id,id] [--max-calls 1..64] [--repetitions 1..3] [--run --output <new.ndjson>]";

function options(argv: readonly string[]) {
  const values = new Map<string, string>();
  let run = false;
  let workflows = false;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--run" && !run) { run = true; continue; }
    if (name === "--workflows" && !workflows) { workflows = true; continue; }
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
  return { run, workflows, profileIds, caseIds, maxCalls, repetitions, output };
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
  const corpus = parseEvaluationDataset(JSON.parse(bytes.toString("utf8")) as unknown);
  const plan = createProviderEvaluationPlan(corpus, selected.profileIds, process.env);
  const candidates = selected.workflows ? getProviderWorkflowDefinitions().map(definition => {
    const template = corpus.find(item => item.id === definition.baseCaseId);
    if (template?.testLayer !== "workflow" || template.datasetSplit !== "development"
      || template.clock.timezone !== "Europe/Berlin") throw new TypeError("The reviewed workflow template changed.");
    return { kind: "workflow" as const, id: definition.id, template };
  }) : plan.cases.map(fixture => ({ kind: "fixed" as const, id: fixture.evaluationCase.id, fixture }));
  // Selection narrows one reviewed server manifest; it cannot register a fixture,
  // grant evidence, select a source destination or change the action under test.
  if (selected.caseIds?.some(id => !candidates.some(item => item.id === id))) {
    throw new TypeError("Selected cases must belong to the explicitly selected reviewed manifest.");
  }
  const selectedCases = selected.caseIds
    ? candidates.filter(item => selected.caseIds?.includes(item.id)) : candidates;
  const plannedRuns = selectedCases.length * plan.profiles.length * selected.repetitions;
  const metadata = {
    schemaVersion: 1, kind: selected.workflows ? "provider_observed_workflow_development_plan" : "provider_fixed_evidence_development_plan", corpusDigestSha256,
    configurationDigestSha256: plan.configurationDigestSha256,
    profiles: plan.profiles, caseIds: selectedCases.map(item => item.id),
    excludedCases: selected.workflows ? corpus.map(item => ({ id: item.id, layer: item.testLayer,
      reason: getProviderWorkflowDefinitions().some(definition => definition.baseCaseId === item.id)
        ? "template_only_runtime_variant" : "outside_registered_workflow_manifest",
    })) : plan.excludedCases,
    repetitions: selected.repetitions, plannedRuns, actualHttpAttemptCap: selected.maxCalls,
    schedule: "case-major-rotating-profile-order", fallback: "disabled",
    limits: selected.workflows
      ? ["draft runtime variants; not original static case acceptance", "isolated loopback synthetic actions; no model tool executor or production writes",
        "independent observed trace; response semantics require human review", "fixture preparation excluded from provider latency",
        "not calendar, tool-planning, gold, blind comparison or M6 acceptance", "cache and resolved alias versions unknown"]
      : ["draft development corpus", "answer-only fixed evidence; no tool execution", "literal citation presence only; semantic quality requires human review", "not gold, blind comparison or M6 acceptance", "cache and resolved alias versions unknown"],
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
  let ungradedWorkflows = 0;
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
        const planned = selectedCases[caseIndex];
        if (!planned) throw new Error("Evaluation schedule is incomplete.");
        for (let offset = 0; offset < plan.profiles.length; offset++) {
          const profile = plan.profiles[(offset + caseIndex + repetition) % plan.profiles.length];
          if (!profile) throw new Error("Evaluation profile schedule is incomplete.");
          if (calls >= selected.maxCalls) { stopReason = "http_attempt_cap"; break outer; }
          if (stoppedConnections.has(profile.connectionId)) {
            skipped++;
            await writeRecord(file, { kind: "run_skipped", caseId: planned.id, profileId: profile.id, repetition, reason: "connection_stopped_after_error" });
            continue;
          }
          const waitMs = Math.max(0, (nextCallAt.get(profile.connectionId) ?? 0) - Date.now());
          if (waitMs) await setTimeout(waitMs);
          let workflowFixture: Awaited<ReturnType<typeof createProviderWorkflowFixture>> | undefined;
          let result: Awaited<ReturnType<typeof runProviderEvaluationCase>>;
          let cleanupFailed = false;
          try {
            // A new owned fixture is prepared per profile/repetition. The provider
            // receives only its sanitized status, never confirmation authority.
            const fixture = planned.kind === "workflow"
              ? (workflowFixture = await createProviderWorkflowFixture(planned.id, planned.template)) : planned.fixture;
            result = await runProviderEvaluationCase(fixture.evaluationCase, {
              profileId: profile.id, budgetAdmission,
              serverAuthorizedEvidence: fixture.serverAuthorizedEvidence, oracle: fixture.oracle,
              ...(workflowFixture ? { observeWorkflow: workflowFixture.observeWorkflow.bind(workflowFixture) } : {}),
              maxProviderRequests: Math.min(16, selected.maxCalls - calls),
            });
          } finally {
            try { await workflowFixture?.close(); } catch { cleanupFailed = true; }
          }
          calls += result.measurements.providerRequestCount;
          if (result.transport.status === "completed") completed++; else errorRuns++;
          await writeRecord(file, { kind: "case_result", runId, repetition, recordedAt: new Date().toISOString(), result,
            ...(workflowFixture ? { fixtureCleanup: cleanupFailed ? "failed" : "completed" } : {}),
          });
          console.info(JSON.stringify({ caseId: result.caseId, profileId: profile.id, repetition, transport: result.transport.status,
            assessment: result.assessment.status, usage: result.measurements.usageStatus, providerCalls: calls }));
          if (cleanupFailed) { stopReason = "workflow_fixture_cleanup_failed"; break outer; }
          if (result.runKind === "provider_observed_workflow" && result.assessment.status === "not_run") {
            ungradedWorkflows++;
            stopReason = "workflow_observation_unavailable";
            break outer;
          }
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
      plannedRuns, completed, errorRuns, ungradedWorkflows, skipped, notExecuted: plannedRuns - completed - errorRuns - skipped,
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
