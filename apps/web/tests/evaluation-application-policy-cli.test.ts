import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owned: string[] = [];
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });

async function operator(args: string[], environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hasi-application-policy-cli-"));
  owned.push(directory);
  const preload = join(directory, "deny-fetch.mjs");
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("UNEXPECTED_PLAN_FETCH"); };\n');
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", preload, "--import", "tsx",
    "apps/web/scripts/evaluate-application-policy.ts", ...args], { cwd: root, encoding: "utf8", timeout: 15_000,
    maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? "", TMPDIR: directory,
      NODE_ENV: "test", ...environment } });
}

describe("actual application-policy operator entrypoint", () => {
  it("plans selected registered roles without provider credentials, budget access or fetch", async () => {
    const result = await operator(["--profiles", "groq-oss-120b", "--cases", "access-02", "--max-calls", "2"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(plan).toMatchObject({ mode: "plan_only", providerCalls: 0, budgetAccess: false, credentialsChecked: false,
      plannedRuns: 1, actualHttpAttemptCap: 2, cases: [{ id: "access-02", scenario: "lumen", role: "outsider" }] });
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it.each(["inject-02", "access-03", "attacker-installed-case"])("rejects unsupported manifest case %s", async id => {
    const result = await operator(["--profiles", "groq-oss-120b", "--cases", id]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it("does not create a report or spend when live opt-in/shared storage are missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-application-policy-report-"));
    owned.push(directory);
    const output = join(directory, "new.ndjson");
    const result = await operator(["--profiles", "groq-oss-120b", "--cases", "access-02", "--run", "--output", output]);
    expect(result.status).toBe(1);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it("refuses to replace an existing report before attempting shared-storage admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-application-policy-report-"));
    owned.push(directory);
    const output = join(directory, "existing.ndjson");
    await writeFile(output, "IMMUTABLE_PREVIOUS_REPORT\n");
    const result = await operator(["--profiles", "groq-oss-120b", "--cases", "access-02", "--run", "--output", output], {
      HASI_MODEL_EVALUATION: "1", HASI_EVALUATION_BUILD_REVISION: "a".repeat(40),
      DATABASE_URL: "postgresql://test@127.0.0.1:1/never_connect_for_existing_report",
    });
    expect(result.status).toBe(1);
    expect(await readFile(output, "utf8")).toBe("IMMUTABLE_PREVIOUS_REPORT\n");
    expect(result.stderr).not.toContain("never_connect_for_existing_report");
  });
});
