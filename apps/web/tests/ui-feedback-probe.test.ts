import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gateUiFeedback,
  installUiFeedbackProbe,
  type UiFeedbackArmOptions,
  type UiFeedbackName,
  type UiFeedbackProbe,
  type UiFeedbackSample,
} from "../scripts/ui-feedback-probe";

const names: UiFeedbackName[] = ["navigation", "actions-open", "results", "theme"];

function passingSamples(durationMs = 100): UiFeedbackSample[] {
  return names.flatMap(name => Array.from({ length: 20 }, () => ({
    name,
    status: "passed" as const,
    delayMs: 0 as const,
    elapsedMs: durationMs,
  })));
}

function replaceFirstSample(
  samples: UiFeedbackSample[],
  update: (sample: UiFeedbackSample) => UiFeedbackSample,
): void {
  const first = samples[0];
  if (!first) throw new Error("Expected a first sample");
  samples[0] = update(first);
}

function stubProbeEnvironment(origin = "http://127.0.0.1:3001"): void {
  vi.stubGlobal("window", { location: { origin } });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    getElementById: vi.fn(() => null),
    documentElement: {},
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("gateUiFeedback", () => {
  it("passes 20 samples per interaction at the 200 ms boundary", () => {
    const result = gateUiFeedback(passingSamples(200));
    expect(result.passed).toBe(true);
    expect(Object.values(result.interactions).every(interaction => interaction.count === 20)).toBe(true);
    expect(result.interactions.navigation.maxMs).toBe(200);
  });

  it("rejects one 250 ms outlier among otherwise fast observations", () => {
    const samples = passingSamples(80);
    replaceFirstSample(samples, sample => ({ ...sample, elapsedMs: 250 }));
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.maxMs).toBe(250);
    expect(result.interactions.navigation.failures).toContain("over-limit");
  });

  it("does not round a duration just above the threshold down to 200 ms", () => {
    const samples = passingSamples(80);
    replaceFirstSample(samples, sample => ({ ...sample, elapsedMs: 200.0001 }));
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.maxMs).toBe(200.0001);
    expect(result.interactions.navigation.failures).toContain("over-limit");
  });

  it("rejects the intentionally delayed countercase through the same limit", () => {
    const samples = passingSamples(80);
    replaceFirstSample(samples, sample => ({ ...sample, delayMs: 250, elapsedMs: 251 }));
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.failures).toContain("over-limit");
  });

  it("rejects a recorded timeout or other failed sample", () => {
    const samples = passingSamples();
    samples[0] = { name: "navigation", status: "failed", delayMs: 0, failure: "feedback-timeout" };
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.failures).toContain("feedback-timeout");
  });

  it("rejects fewer than the required observations for any interaction", () => {
    const result = gateUiFeedback(passingSamples().slice(1));
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.count).toBe(19);
    expect(result.interactions.navigation.failures).toContain("too-few-samples");
  });

  it("rejects malformed timing values", () => {
    const samples = passingSamples();
    replaceFirstSample(samples, sample => ({ ...sample, elapsedMs: Number.NaN }));
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.failures).toContain("invalid-timing");
  });

  it("rejects a sample recorded while the page is hidden", () => {
    const samples = passingSamples();
    samples[0] = { name: "navigation", status: "failed", delayMs: 0, failure: "hidden-page" };
    const result = gateUiFeedback(samples);
    expect(result.passed).toBe(false);
    expect(result.interactions.navigation.failures).toContain("hidden-page");
  });
});

describe("installUiFeedbackProbe admission", () => {
  it("rejects every origin except the exact local demo origin", () => {
    stubProbeEnvironment("http://localhost:3001");
    expect(() => installUiFeedbackProbe()).toThrow("only admits http://127.0.0.1:3001");
  });

  it("rejects a delay outside 0 or 250 ms before target selection", () => {
    stubProbeEnvironment();
    const probe = installUiFeedbackProbe();
    expect(() => { probe.arm("navigation", { delayMs: 125 } as unknown as UiFeedbackArmOptions); }).toThrow("invalid-options");
    expect(probe.read()).toMatchObject([
      { name: "navigation", status: "failed", delayMs: 0, failure: "invalid-options" },
    ]);
    probe.dispose();
  });

  it("rejects and records a missing visible target instead of dropping the sample", () => {
    stubProbeEnvironment();
    const probe: UiFeedbackProbe = installUiFeedbackProbe();
    expect(() => { probe.arm("navigation"); }).toThrow("missing-target");
    expect(probe.read()).toMatchObject([
      { name: "navigation", status: "failed", delayMs: 0, failure: "missing-target" },
    ]);
    probe.dispose();
  });
});
