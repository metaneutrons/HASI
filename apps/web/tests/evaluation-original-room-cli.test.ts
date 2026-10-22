import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const corpusPath = join(root, "docs/evaluation/example-cases.json");
const corpusSha256 = "ff3efb055983aff35968495bffc409c9f8e1d13240eddcec390ad3ee03f1a078";
const registeredCases = ["anny-01", "anny-02", "anny-04", "anny-05", "inject-02"];
const safeFailure = "Original-room evaluation stopped.";
const unexpectedFetch = "UNEXPECTED_PLAN_FETCH";
const owned: string[] = [];

afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});

function bounded(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Buffer.isBuffer(value)) return value.toString("utf8", 0, 2_000);
  return "<non-text-output>";
}

function statusDiagnostics(result: ReturnType<typeof spawnSync>): string {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error ? {
      name: result.error.name,
      code: (result.error as NodeJS.ErrnoException).code,
      message: result.error.message.slice(0, 500),
    } : null,
    stdout: bounded(result.stdout),
    stderr: bounded(result.stderr),
  }, null, 2);
}

function expectStatus(result: ReturnType<typeof spawnSync>, status: number) {
  const diagnostics = statusDiagnostics(result);
  expect(result.error, diagnostics).toBeUndefined();
  expect(result.signal, diagnostics).toBeNull();
  expect(result.status, diagnostics).toBe(status);
}

async function operator(args: string[], environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hasi-original-room-cli-"));
  owned.push(directory);
  const preload = join(directory, "deny-fetch.mjs");
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("UNEXPECTED_PLAN_FETCH"); };\n');
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", preload, "--import", "tsx",
    "apps/web/scripts/evaluate-original-rooms.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: directory,
      TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
      NODE_ENV: "test",
      ...environment,
    },
  });
}

describe("original-room operator entrypoint", () => {
  it("shows help without configuration, credentials, fixture setup, or fetch", async () => {
    const result = await operator(["--help"]);
    expectStatus(result, 0);
    expect(result.stdout).toContain("Usage: pnpm evaluate:original-rooms");
    expect(result.stderr).not.toContain(unexpectedFetch);
  });

  it("plans the exact default five-case corpus with no credentials, fixture, budget, or fetch", async () => {
    const result = await operator(["--profiles", "groq-oss-120b"]);
    expectStatus(result, 0);
    const plan = JSON.parse(result.stdout) as {
      mode: string;
      executionTrack: string;
      corpusDigestSha256: string;
      plannedRuns: number;
      actualHttpAttemptCap: number;
      perCaseProviderRequestCap: number;
      cases: { id: string }[];
      limits: string[];
      fixtureCreated: boolean;
      fetchCalls: number;
      providerCalls: number;
      budgetAccess: boolean;
      credentialsChecked: boolean;
    };
    expect(plan).toMatchObject({
      mode: "plan_only",
      executionTrack: "controlled_full_original_evidence_and_native_pending_effects",
      corpusDigestSha256: corpusSha256,
      plannedRuns: 5,
      actualHttpAttemptCap: 24,
      perCaseProviderRequestCap: 6,
      fixtureCreated: false,
      fetchCalls: 0,
      providerCalls: 0,
      budgetAccess: false,
      credentialsChecked: false,
    });
    expect(plan.cases.map(item => item.id)).toEqual(registeredCases);
    expect(plan.limits.join(" ")).toContain("Full original benchmark evidence is passed through the direct production router");
    expect(plan.limits.join(" ")).toContain("exact pending proposal");
    expect(plan.limits.join(" ")).toContain("protected HTTP or browser route");
    expect(plan.limits.join(" ")).toContain("semantic");
    expect(result.stderr).not.toContain(unexpectedFetch);
  });

  it("prints the corpus digest only while the reviewed source corpus remains pinned", async () => {
    const bytes = await readFile(corpusPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(corpusSha256);
  });

  it.each([
    ["unregistered case", ["--profiles", "groq-oss-120b", "--cases", "attacker-installed-case"]],
    ["case list with an unregistered addition", ["--profiles", "groq-oss-120b", "--cases", "anny-01,attacker-installed-case"]],
    ["duplicate case selection", ["--profiles", "groq-oss-120b", "--cases", "anny-01,anny-01"]],
    ["mutated case identifier", ["--profiles", "groq-oss-120b", "--cases", "anny-01-mutated"]],
    ["zero provider-call cap", ["--profiles", "groq-oss-120b", "--max-calls", "0"]],
    ["provider-call cap above 64", ["--profiles", "groq-oss-120b", "--max-calls", "65"]],
    ["repetitions above 3", ["--profiles", "groq-oss-120b", "--repetitions", "4"]],
  ])("rejects %s without making a request", async (_label, args) => {
    const result = await operator(args);
    expectStatus(result, 1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(safeFailure);
    expect(result.stderr).not.toContain(unexpectedFetch);
  });

  it("does not create an output file or access shared budget without explicit run admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-original-room-report-"));
    owned.push(directory);
    const output = join(directory, "new.ndjson");
    const result = await operator(["--profiles", "groq-oss-120b", "--run", "--output", output]);
    expectStatus(result, 1);
    expect(result.stderr).toContain(safeFailure);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stderr).not.toContain(unexpectedFetch);
  });

  it("refuses an existing report before opening durable admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hasi-original-room-report-"));
    owned.push(directory);
    const output = join(directory, "existing.ndjson");
    await writeFile(output, "IMMUTABLE_PREVIOUS_REPORT\n");
    let databaseConnections = 0;
    const databaseSentinel = createServer(socket => { databaseConnections += 1; socket.destroy(); });
    await new Promise<void>((resolve, reject) => {
      databaseSentinel.once("error", reject);
      databaseSentinel.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = databaseSentinel.address() as AddressInfo;
      const result = await operator(["--profiles", "groq-oss-120b", "--run", "--output", output], {
        HASI_MODEL_EVALUATION: "1",
        HASI_EVALUATION_BUILD_REVISION: "a".repeat(40),
        DATABASE_URL: ["postgresql://test@127.0.0.1:", address.port, "/never_connect_for_existing_report"].join(""),
      });
      expectStatus(result, 1);
      expect(result.stderr).toContain(safeFailure);
      expect(await readFile(output, "utf8")).toBe("IMMUTABLE_PREVIOUS_REPORT\n");
      expect(databaseConnections).toBe(0);
      expect(result.stderr).not.toContain("never_connect_for_existing_report");
      expect(result.stderr).not.toContain(unexpectedFetch);
    } finally {
      await new Promise<void>((resolve, reject) => {
        databaseSentinel.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
