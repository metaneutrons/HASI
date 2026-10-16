import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { sanitizeRuntimeLogs, waitForHttpReady } from "./runtime-readiness.mjs";

test("waits through a refused connection and accepts the first HTTP 200", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200).end("ready");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    assert.equal(await waitForHttpReady(`http://127.0.0.1:${port}/health`, { timeoutMs: 500 }), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("fails immediately when a responding health endpoint returns a failure status", async () => {
  await assert.rejects(waitForHttpReady("http://127.0.0.1:3000/health", {
    request: async () => new Response("unavailable", { status: 503 }),
  }), /HTTP 503/);
});

test("bounds connection retries and redacts secrets and database credentials from logs", async () => {
  let clock = 0;
  await assert.rejects(waitForHttpReady("http://127.0.0.1:3000/health", {
    timeoutMs: 10,
    intervalMs: 5,
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
    request: async () => {
      const error = new Error("fetch failed");
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    },
  }), /did not become HTTP-ready within 10ms/);
  assert.equal(
    sanitizeRuntimeLogs("secret=smoke-token postgresql://postgres:password@db:5432/hasi", "smoke-token"),
    "secret=[redacted] postgresql://[redacted]",
  );
});
