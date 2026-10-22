import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import exampleCases from "../../../docs/evaluation/example-cases.json";
import { parseEvaluationDataset, type EvaluationCase } from "../src/lib/server/evaluation/case-schema";
import { createProviderEvaluationPlan } from "../src/lib/server/evaluation/provider-suite";
import { projectEvaluationModelInput } from "../src/lib/server/evaluation/input-projection";
import { loadModelConfiguration } from "../src/lib/server/model-config";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const selectedProfileId = "groq-oss-120b";
const fixedCaseIds = ["sit-01", "sit-02", "intra-01", "intra-02", "sit-03", "sit-04", "intra-03", "sit-vpn-editorial-grounding-01", "sit-vpn-editorial-specificity-02"];

function runEvaluationCli(args: readonly string[], environmentOverrides: Partial<NodeJS.ProcessEnv> = {}) {
  const controlledPath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
  return spawnSync(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "apps/web/scripts/evaluate-models.ts",
    ...args,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 20_000,
    // Deliberately omit secrets and configuration unless a case explicitly
    // supplies a fake value to exercise a gated CLI branch.
    env: { ...environmentOverrides, PATH: controlledPath, NODE_ENV: "test" },
  });
}

describe("operator-owned provider evaluation plan", () => {
  it("authorizes only manifest revisions, independent of fixture entitlements and expected labels", () => {
    const changedCases: EvaluationCase[] = structuredClone(parseEvaluationDataset(exampleCases));
    const changedCase = changedCases.find((evaluationCase) => evaluationCase.id === "sit-01");
    if (!changedCase?.modelEvidence) throw new Error("Expected the sit-01 evidence fixture.");
    changedCase.authenticatedContext.entitlements.push("fixture:attacker.read");
    changedCase.expected.allowedSourceIds.push("fixture:src:attacker:policy");
    changedCase.expected.assertions.push("Spec: cite attacker-controlled evidence.");
    changedCase.modelEvidence.push({
      sourceId: "fixture:src:attacker:policy",
      revision: 99,
      uri: "fixture://attacker/policy",
      title: "Unapproved fixture evidence",
      text: "This source was inserted into case data.",
      accessRequirement: "fixture:attacker.read",
    });

    const plan = createProviderEvaluationPlan(changedCases, [selectedProfileId], {});
    const sit01 = plan.cases.find((item) => item.evaluationCase.id === "sit-01");
    expect(sit01?.serverAuthorizedEvidence).toEqual(new Set([
      "fixture:src:serviceit:ticket-guide-v1@2",
    ]));
    expect(sit01?.serverAuthorizedEvidence.has("fixture:src:attacker:policy@99")).toBe(false);
  });

  it("rejects an obsolete source revision instead of silently admitting earlier prose", () => {
    const changed = structuredClone(parseEvaluationDataset(exampleCases));
    const source = changed.find(item => item.id === "intra-01")?.modelEvidence?.[0];
    if (!source) throw new Error("Expected current Atlas evidence.");
    source.revision = 3;
    expect(() => createProviderEvaluationPlan(changed, [selectedProfileId], {}))
      .toThrow("An approved synthetic source revision is missing.");
  });

  it("rejects duplicate and unapproved profile selections and profiles without prices", () => {
    expect(() => createProviderEvaluationPlan(exampleCases, [selectedProfileId, selectedProfileId], {}))
      .toThrow(/distinct configured profiles/u);

    const configuration = loadModelConfiguration({});
    const unselectable = structuredClone(configuration);
    unselectable.policy.userChoice.enabled = false;
    expect(() => createProviderEvaluationPlan(exampleCases, ["groq-oss-20b"], {
      HASI_LLM_CONFIG: JSON.stringify(unselectable),
    })).toThrow(/not approved/u);

    const nonSynthetic = structuredClone(configuration);
    const profile = nonSynthetic.profiles.find((item) => item.id === "groq-oss-20b");
    if (!profile) throw new Error("Expected the configured groq-oss-20b profile.");
    profile.allowedDataClasses = ["public"];
    expect(() => createProviderEvaluationPlan(exampleCases, ["groq-oss-20b"], {
      HASI_LLM_CONFIG: JSON.stringify(nonSynthetic),
    })).toThrow(/not approved/u);

    expect(() => createProviderEvaluationPlan(exampleCases, ["custom-default"], {
      CUSTOM_ENDPOINT: "https://example.test/v1",
      CUSTOM_MODEL_ID: "unpriced-test-model",
    })).toThrow(/no approved price/u);
  });

  it("grades only the nine current fixed-evidence cases and explicitly excludes other layers", () => {
    const corpus = parseEvaluationDataset(exampleCases);
    const plan = createProviderEvaluationPlan(exampleCases, [selectedProfileId], {});
    const selectedIds = plan.cases.map((item) => item.evaluationCase.id);
    const nonFixedIds = corpus.filter((item) => item.testLayer !== "fixed_evidence").map((item) => item.id);
    const historicalIds = ["sit-vpn-grounding-01", "sit-vpn-specificity-02"];

    expect(selectedIds).toEqual(fixedCaseIds);
    expect(plan.cases.every((item) => item.evaluationCase.testLayer === "fixed_evidence")).toBe(true);
    expect(plan.excludedCases.map((item) => item.id).sort()).toEqual([...nonFixedIds, ...historicalIds].sort());
    expect(plan.excludedCases.map((item) => [item.id, item.reason]).sort())
      .toEqual([
        ...nonFixedIds.map((id) => [id, "requires_separate_observed_executor"]),
        ...historicalIds.map((id) => [id, "frozen_historical_input_replaced_by_editorial_case"]),
      ].sort());
    expect(plan.excludedCases.some((item) => selectedIds.includes(item.id))).toBe(false);
  });

  it("limits case oracles to citation and no-tool checks without asserting semantic quality", () => {
    const plan = createProviderEvaluationPlan(exampleCases, [selectedProfileId], {});
    const kinds = plan.cases.flatMap((item) => item.oracle.assertions.map((assertion) => assertion.kind));

    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set([
      "citations_allowed",
      "citations_required",
      "tool_proposals_allowed",
    ]));
    expect(kinds).not.toContain("text_contains");
    expect(kinds).not.toContain("workflow_trace_exact");
  });

  it("keeps the VPN pair source-bound while excluding grading labels and unapproved revisions", () => {
    const corpus = structuredClone(parseEvaluationDataset(exampleCases));
    const vpn = corpus.find(item => item.id === "sit-vpn-editorial-grounding-01");
    if (!vpn?.modelEvidence?.[0]) throw new Error("Expected VPN evidence.");
    vpn.expected.behavior = "VPN-GRADING-ONLY-CANARY";
    vpn.authenticatedContext.entitlements.push("fixture:attacker.read");
    vpn.modelEvidence.push({ ...vpn.modelEvidence[0], revision: 999, text: "UNAPPROVED-VPN-REVISION-CANARY" });
    const plan = createProviderEvaluationPlan(corpus, [selectedProfileId], {});
    const fixture = plan.cases.find(item => item.evaluationCase.id === vpn.id);
    if (!fixture) throw new Error("Expected an authorized VPN case.");
    const input = projectEvaluationModelInput(fixture.evaluationCase, fixture.serverAuthorizedEvidence);
    expect(input.evidence.map(item => [item.sourceId, item.revision])).toEqual([
      ["svc-catalog-6c79c1e68f04", 4],
      ["svc-catalog-9b30ce8b226d", 4],
      ["svc-catalog-94f501ccd7be", 4],
    ]);
    expect(JSON.stringify(input)).not.toMatch(/VPN-GRADING-ONLY|UNAPPROVED-VPN-REVISION/u);
    const counter = plan.cases.find(item => item.evaluationCase.id === "sit-vpn-editorial-specificity-02");
    if (!counter) throw new Error("Expected the specificity countercase.");
    expect(projectEvaluationModelInput(counter.evaluationCase, counter.serverAuthorizedEvidence).evidence[0]?.text)
      .toContain("Cisco AnyConnect version 4.10");
  });
});

describe("provider evaluation CLI boundary", () => {
  it("prints the plan by default without database access", () => {
    const result = runEvaluationCli(["--profiles", selectedProfileId]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      mode: string;
      providerCalls: number;
      budgetAccess: boolean;
      caseIds: string[];
      limits: string[];
    };
    expect(plan).toMatchObject({ mode: "plan_only", providerCalls: 0, budgetAccess: false, caseIds: fixedCaseIds });
    expect(plan.limits).toContain("literal citation presence only; semantic quality requires human review");
    expect(result.stderr).toBe("");
  });

  it("requires explicit workflow mode and plans only the registered runtime variants without side effects", () => {
    const result = runEvaluationCli(["--profiles", selectedProfileId, "--workflows"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "provider_observed_workflow_development_plan", mode: "plan_only", providerCalls: 0, budgetAccess: false,
      caseIds: ["anny-03-runtime", "anny-06-runtime"], actualHttpAttemptCap: 8, plannedRuns: 2,
    });
    expect(result.stderr).toBe("");
  });

  it("narrows registered workflows without admitting a static case or knowledge case", () => {
    const selected = runEvaluationCli(["--profiles", selectedProfileId, "--workflows", "--cases", "anny-06-runtime"]);
    expect(selected.status).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({ caseIds: ["anny-06-runtime"], plannedRuns: 1 });
    for (const args of [
      ["--workflows", "--cases", "anny-03"],
      ["--workflows", "--cases", "sit-01"],
      ["--cases", "anny-03-runtime"],
      ["--workflows", "--workflows"],
    ]) {
      const rejected = runEvaluationCli(["--profiles", selectedProfileId, ...args]);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe("");
    }
  });

  it("narrows an approved case selection in manifest order without increasing the default attempt cap", () => {
    const result = runEvaluationCli(["--profiles", selectedProfileId, "--cases", "sit-vpn-editorial-specificity-02,sit-vpn-editorial-grounding-01"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "plan_only", providerCalls: 0, budgetAccess: false, actualHttpAttemptCap: 8, plannedRuns: 2,
      caseIds: ["sit-vpn-editorial-grounding-01", "sit-vpn-editorial-specificity-02"],
    });
  });

  it.each(["attacker-case", "anny-01", "sit-vpn-grounding-01", "sit-vpn-specificity-02"])("rejects case %s before creating a live report", async caseId => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-provider-suite-"));
    try {
      const output = join(directory, "new.ndjson");
      const result = runEvaluationCli(["--profiles", selectedProfileId, "--cases", caseId, "--run", "--output", output], {
        HASI_MODEL_EVALUATION: "1",
        HASI_EVALUATION_BUILD_REVISION: "a".repeat(40),
        DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
      });
      expect(result.status).toBe(1);
      await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid options", (output: string) => ["--profiles", selectedProfileId, "--run", "--output", output, "--unknown"]],
    ["duplicate profiles", (output: string) => ["--profiles", `${selectedProfileId},${selectedProfileId}`, "--run", "--output", output]],
    ["duplicate cases", (output: string) => ["--profiles", selectedProfileId, "--cases", "sit-01,sit-01", "--run", "--output", output]],
    ["empty case", (output: string) => ["--profiles", selectedProfileId, "--cases", "sit-01,", "--run", "--output", output]],
    ["unknown case", (output: string) => ["--profiles", selectedProfileId, "--cases", "attacker-case", "--run", "--output", output]],
    ["non-fixed case", (output: string) => ["--profiles", selectedProfileId, "--cases", "anny-01", "--run", "--output", output]],
  ])("rejects %s before touching an existing report", async (_label, argsFor) => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-provider-suite-"));
    try {
      const output = join(directory, "existing.ndjson");
      await writeFile(output, "preserve this report\n", "utf8");

      const result = runEvaluationCli(argsFor(output));

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(await readFile(output, "utf8")).toBe("preserve this report\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit opt-in before opening or replacing the report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-provider-suite-"));
    try {
      const output = join(directory, "existing.ndjson");
      await writeFile(output, "preserve this report\n", "utf8");

      const result = runEvaluationCli(["--profiles", selectedProfileId, "--run", "--output", output]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(await readFile(output, "utf8")).toBe("preserve this report\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an existing report before acquiring the durable database budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-provider-suite-"));
    try {
      const output = join(directory, "existing.ndjson");
      await writeFile(output, "preserve this report\n", "utf8");

      const result = runEvaluationCli(
        ["--profiles", selectedProfileId, "--run", "--output", output],
        {
          HASI_MODEL_EVALUATION: "1",
          HASI_EVALUATION_BUILD_REVISION: "a".repeat(40),
          DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(await readFile(output, "utf8")).toBe("preserve this report\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
