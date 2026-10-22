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
  const directory = await mkdtemp(join(tmpdir(), "hasi-room-planning-cli-"));
  owned.push(directory);
  const preload = join(directory, "deny-fetch.mjs");
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("UNEXPECTED_PLAN_FETCH"); };\n');
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", preload, "--import", "tsx",
    "apps/web/scripts/evaluate-room-planning.ts", ...args], { cwd: root, encoding: "utf8", timeout: 15_000,
    maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? "", TMPDIR: directory,
      TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
      NODE_ENV: "test", ...environment } });
}

describe("room-planning operator entrypoint", () => {
  it("plans the fixed case without credentials, fixture, budget access, or fetch", async () => {
    const result = await operator(["--profiles", "groq-oss-120b", "--cases", "room-initial-preference-1j", "--max-calls", "2"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(plan).toMatchObject({ mode: "plan_only", fixtureCreated: false, fetchCalls: 0, providerCalls: 0,
      budgetAccess: false, credentialsChecked: false,
      plannedRuns: 1, actualHttpAttemptCap: 2, cases: [{ id: "room-initial-preference-1j", location: "1J", timezone: "Europe/Berlin" }] });
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it("plans the ordered clean and poisoned fixed-evidence pair without setup or fetch", async () => {
    const result = await operator(["--profiles", "groq-oss-120b", "--cases",
      "room-fixed-evidence-clean-1j,room-fixed-evidence-poisoned-1j", "--max-calls", "2"]);
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(plan).toMatchObject({ mode: "plan_only", fixtureCreated: false, fetchCalls: 0, providerCalls: 0,
      budgetAccess: false, credentialsChecked: false, plannedRuns: 2, actualHttpAttemptCap: 2,
      cases: [
        { id: "room-fixed-evidence-clean-1j", executionTrack: "controlled_fixed_evidence", catalogVariant: "clean",
          nativeToolExecutionAttemptCap: 3, providerHttpAttemptLimit: 1, coreApiHttpAttemptLimit: 32 },
        { id: "room-fixed-evidence-poisoned-1j", executionTrack: "controlled_fixed_evidence", catalogVariant: "poisoned_room_name",
          nativeToolExecutionAttemptCap: 3, providerHttpAttemptLimit: 1, coreApiHttpAttemptLimit: 32 },
      ] });
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it.each(["attacker-installed-case", "access-01", "room-initial-preference-1j,attacker-installed-case"])(
    "rejects unregistered case selection %s without network", async id => {
      const result = await operator(["--profiles", "groq-oss-120b", "--cases", id]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
    });

  it("does not create an output file or access shared budget without explicit run admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-room-planning-report-"));
    owned.push(directory);
    const output = join(directory, "new.ndjson");
    const result = await operator(["--profiles", "groq-oss-120b", "--run", "--output", output]);
    expect(result.status).toBe(1);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });

  it("refuses an existing report before opening durable admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-room-planning-report-"));
    owned.push(directory);
    const output = join(directory, "existing.ndjson");
    await writeFile(output, "IMMUTABLE_PREVIOUS_REPORT\n");
    const result = await operator(["--profiles", "groq-oss-120b", "--run", "--output", output], {
      HASI_MODEL_EVALUATION: "1", HASI_EVALUATION_BUILD_REVISION: "a".repeat(40),
      DATABASE_URL: "postgresql://test@127.0.0.1:1/never_connect_for_existing_report",
    });
    expect(result.status).toBe(1);
    expect(await readFile(output, "utf8")).toBe("IMMUTABLE_PREVIOUS_REPORT\n");
    expect(result.stderr).not.toContain("never_connect_for_existing_report");
    expect(result.stderr).not.toContain("UNEXPECTED_PLAN_FETCH");
  });
});
