import { createHash, randomUUID } from "node:crypto";
import { readFile, open, type FileHandle } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { getDurableModelBudgetAdmission } from "../src/lib/server/model-budgets";
import { createApplicationPolicyPlan } from "../src/lib/server/evaluation/application-policy-plan";
import { applicationPolicyStopReason, runApplicationPolicyCase } from "../src/lib/server/evaluation/application-policy-runner";
import { parseEvaluationDataset } from "../src/lib/server/evaluation/case-schema";

// The same reviewed synthetic corpus as evaluate-models.ts. A change requires
// reviewing both operator pins; arbitrary input files are never accepted.
const CORPUS_SHA256 = "82ff06922cccad9a2a741ce0894cdb548ab40a540e485c689308933488b59ef0";
const USAGE = "Usage: pnpm evaluate:application-policy --profiles <id,id> [--cases id,id] [--max-calls 1..64] [--repetitions 1..3] [--run --output <new.ndjson>]";

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
  const profiles = values.get("--profiles")?.split(",") ?? [];
  const cases = values.get("--cases")?.split(",");
  if (!profiles.length || cases && (cases.some(id => !id) || new Set(cases).size !== cases.length)) throw new TypeError(USAGE);
  const maxCallsText = values.get("--max-calls") ?? "8";
  const repetitionsText = values.get("--repetitions") ?? "1";
  if (!/^[1-9]\d?$/u.test(maxCallsText) || Number(maxCallsText) > 64 || !/^[1-3]$/u.test(repetitionsText)) throw new TypeError(USAGE);
  const output = values.get("--output");
  if (run !== Boolean(output)) throw new TypeError(USAGE);
  return { run, profiles, cases, maxCalls: Number(maxCallsText), repetitions: Number(repetitionsText), output };
}

async function write(file: FileHandle, record: unknown) {
  await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await file.sync();
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") { console.info(USAGE); return; }
  const selected = options(process.argv.slice(2));
  const bytes = await readFile(new URL("../../../docs/evaluation/example-cases.json", import.meta.url));
  const corpusDigestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (corpusDigestSha256 !== CORPUS_SHA256) throw new TypeError("The reviewed corpus pin differs.");
  const corpus = parseEvaluationDataset(JSON.parse(bytes.toString("utf8")) as unknown);
  const plan = createApplicationPolicyPlan(corpus, selected.profiles, process.env);
  if (selected.cases?.some(id => !plan.cases.some(item => item.definition.id === id))) throw new TypeError(USAGE);
  const cases = selected.cases ? plan.cases.filter(item => selected.cases?.includes(item.definition.id)) : plan.cases;
  const plannedRuns = cases.length * plan.profiles.length * selected.repetitions;
  const metadata = {
    schemaVersion: 1, kind: "provider_application_policy_development_plan", corpusDigestSha256,
    configurationDigestSha256: plan.configurationDigestSha256, profiles: plan.profiles,
    cases: cases.map(item => ({ ...item.definition })), excludedCases: plan.excludedCases,
    repetitions: selected.repetitions, plannedRuns, actualHttpAttemptCap: selected.maxCalls,
    schedule: "case-major-rotating-profile-order", fallback: "disabled",
    limits: ["draft development cases; no gold or semantic score", "actual TestIdP/signed-source/MCP/API/chat route with isolated in-memory source state",
      "only authenticated knowledge search may execute; no production business actions",
      "actual server clock and source-contract identity mapping; not an identical-input paired comparison",
      "case latency includes source setup, route, reads and cleanup; not first-token/model-only latency",
      "cross-tenant and poisoned Anny fixtures remain excluded", "raw HTTP proposals and backend rejections are separate observations",
      "existing shared durable budget required before local composition; no initialization or reset",
      "human review/approved thresholds and M6 acceptance remain open; cache unknown/M8-A10"],
  };
  if (!selected.run) {
    console.info(JSON.stringify({ ...metadata, mode: "plan_only", providerCalls: 0, budgetAccess: false, credentialsChecked: false }, null, 2));
    return;
  }
  const buildRevision = process.env.HASI_EVALUATION_BUILD_REVISION;
  if (process.env.HASI_MODEL_EVALUATION !== "1" || !buildRevision || !/^[a-f0-9]{40}$/u.test(buildRevision)
    || !process.env.DATABASE_URL?.trim() || !selected.output) throw new TypeError("Explicit pinned opt-in and existing shared storage are required.");
  const file = await open(selected.output, "wx", 0o600);
  const runId = randomUUID();
  let calls = 0;
  let completed = 0;
  let observed = 0;
  let skipped = 0;
  let stopReason = "plan_completed";
  const stoppedConnections = new Set<string>();
  const nextCallAt = new Map<string, number>();
  try {
    await write(file, { ...metadata, kind: "run_started", runId, buildRevision, startedAt: new Date().toISOString() });
    // Capture the actual shared ledger while the real deployment DATABASE_URL
    // still applies. Local TestIdP configuration cannot choose another budget.
    const budgetAdmission = await getDurableModelBudgetAdmission();
    outer: for (let repetition = 0; repetition < selected.repetitions; repetition++) {
      for (let index = 0; index < cases.length; index++) {
        const planned = cases[index];
        if (!planned) throw new Error("Incomplete case schedule.");
        for (let offset = 0; offset < plan.profiles.length; offset++) {
          const profile = plan.profiles[(offset + index + repetition) % plan.profiles.length];
          if (!profile) throw new Error("Incomplete profile schedule.");
          if (calls >= selected.maxCalls) { stopReason = "http_attempt_cap"; break outer; }
          if (stoppedConnections.has(profile.connectionId)) {
            skipped++;
            await write(file, { kind: "run_skipped", runId, caseId: planned.definition.id, profileId: profile.id, repetition, reason: "connection_stopped_after_error" });
            continue;
          }
          const wait = Math.max(0, (nextCallAt.get(profile.connectionId) ?? 0) - Date.now());
          if (wait) await setTimeout(wait);
          const result = await runApplicationPolicyCase(planned.evaluationCase, {
            caseId: planned.definition.id, profileId: profile.id, budgetAdmission,
            maxProviderRequests: Math.min(16, selected.maxCalls - calls),
          });
          observed++;
          calls += result.measurements.providerRequestCount;
          if (result.outcome === "completed") completed++;
          await write(file, { kind: "case_result", runId, repetition, result });
          console.info(JSON.stringify({ caseId: result.caseId, profileId: profile.id, outcome: result.outcome,
            sourceControl: result.controls.sourceProbe, outboundControl: result.controls.outboundEvidence,
            usage: result.measurements.usageStatus, providerCalls: calls }));
          const stop = applicationPolicyStopReason(result);
          if (stop) { stopReason = stop; break outer; }
          nextCallAt.set(profile.connectionId, Date.now() + (profile.provider === "gwdg" ? 60_000 : 30_000));
          if (result.providerResponses.some(item => item.status >= 400) || result.measurements.usageStatus === "unknown") {
            stoppedConnections.add(profile.connectionId);
          }
        }
      }
    }
    await write(file, { kind: "run_finished", runId, finishedAt: new Date().toISOString(), stopReason,
      plannedRuns, observed, completed, skipped, notExecuted: plannedRuns - observed - skipped, providerCalls: calls,
      interpretation: "application controls and model responses are separate; human review required; no acceptance or ranking" });
    if (stopReason !== "plan_completed" || completed !== plannedRuns) process.exitCode = 2;
  } catch {
    await write(file, { kind: "run_aborted", runId, providerCalls: null, completedRunProviderCalls: calls, incompleteRunUsage: "unknown" });
    throw new Error("The partial private evaluation report is preserved.");
  } finally { await file.close(); }
}

void main().catch(() => {
  console.error("Application-policy evaluation stopped. Check reviewed options, opt-in, build identity, approved profiles and existing shared budget; no private cause is printed.");
  process.exitCode = 1;
});
