#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function fail(message) {
  throw new Error(message);
}

function transientNetworkError(error) {
  return error?.name === "TimeoutError" || transientCodes.has(error?.cause?.code);
}

export async function waitForHttpReady(url, {
  timeoutMs = 120_000,
  intervalMs = 2_000,
  request = globalThis.fetch,
  sleep = delay,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastNetworkCode = "connection refused";
  while (now() < deadline) {
    const remaining = deadline - now();
    try {
      const response = await request(url, { signal: AbortSignal.timeout(Math.min(5_000, remaining)) });
      if (response.status !== 200) {
        fail(`runtime endpoint returned HTTP ${response.status}; only connection failures count as startup delay.`);
      }
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("runtime endpoint returned HTTP ")) throw error;
      if (!transientNetworkError(error)) fail("runtime readiness request failed with a non-transient network error.");
      lastNetworkCode = error?.cause?.code ?? error?.name ?? "connection failure";
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  fail(`runtime did not become HTTP-ready within ${timeoutMs}ms (last result: ${lastNetworkCode}).`);
}

export function sanitizeRuntimeLogs(logs, secret = "") {
  let sanitized = String(logs);
  if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
  return sanitized.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgresql://[redacted]");
}

function main() {
  const url = process.argv[2];
  if (!url) fail("usage: runtime-readiness.mjs <http-health-url>");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    fail("runtime health URL must target the loopback HTTP interface.");
  }
  return waitForHttpReady(url);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().then(() => {
    process.stdout.write("Application container returned HTTP 200 from its readiness endpoint.\n");
  }).catch((error) => {
    const readinessError = error instanceof Error ? error.message : "runtime readiness failed.";
    const logs = spawnSync("docker", ["logs", "hasi-release-app"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    process.stderr.write(`Container startup failed: ${readinessError}\n`);
    if (!logs.error && logs.status === 0) {
      const safeLogs = sanitizeRuntimeLogs(`${logs.stdout}${logs.stderr}`, process.env.HASI_DEMO_SECRET);
      process.stderr.write(`Sanitized container log tail:\n${safeLogs.split("\n").slice(-40).join("\n")}\n`);
    } else {
      process.stderr.write("Container logs were unavailable.\n");
    }
    process.exitCode = 1;
  });
}
