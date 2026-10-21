import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";

const { listeners } = vi.hoisted(() => ({ listeners: [] as Server[] }));
vi.mock("server-only", () => ({}));
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    listeners.push(server);
    return server;
  } };
});
vi.mock("@hasi/demo-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@hasi/demo-runtime")>();
  return { ...actual, createDemoRuntime: (...args: Parameters<typeof actual.createDemoRuntime>) => {
    const runtime = actual.createDemoRuntime(...args);
    return { ...runtime, async close() {
      await runtime.close();
      throw new Error("Injected runtime shutdown failure after owned runtime close.");
    } };
  } };
});

import { createEvaluationAnnyFixture } from "../../../scripts/evaluation/anny-fixture.js";

describe("evaluation fixture shutdown failure", () => {
  it("closes its actual loopback listener even when runtime shutdown rejects", async () => {
    const fixture = await createEvaluationAnnyFixture("book");
    const active = listeners.filter(server => server.listening);
    expect(active).toHaveLength(1);
    try {
      await expect(fixture.close()).rejects.toThrow(/Injected runtime shutdown failure/u);
      expect(active[0]?.listening).toBe(false);
      await fixture.close();
    } finally {
      for (const server of listeners) {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
      }
    }
  });
});
