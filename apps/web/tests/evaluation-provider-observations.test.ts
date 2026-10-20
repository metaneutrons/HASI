import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryJsonStore } from "@hasi/state";
import {
  createProviderObservationMeter,
  providerMeasurementsSchema,
  type ProviderMeasurements,
} from "../src/lib/server/evaluation/provider-observations";
import { createModelBudget, createModelBudgetAdmission, loadModelPrices } from "../src/lib/server/model-budgets";
import type { ModelBudgetAdmission } from "../src/lib/server/model-router";
import { loadModelConfiguration } from "../src/lib/server/model-config";

const configuration = loadModelConfiguration({});
const prices = loadModelPrices({});

function meter(admission: ModelBudgetAdmission = successfulAdmission()) {
  return createProviderObservationMeter({ admission, configuration, prices });
}

function successfulAdmission(options: {
  reserveError?: Error;
  settleError?: Error;
  onSettle?: (usage?: { inputTokens: number; outputTokens: number }) => void;
} = {}): ModelBudgetAdmission {
  return {
    reserve() {
      if (options.reserveError) return Promise.reject(options.reserveError);
      return Promise.resolve({
        settle(usage) {
          options.onSettle?.(usage);
          return options.settleError ? Promise.reject(options.settleError) : Promise.resolve();
        },
      });
    },
  };
}

function reserve(meterValue: ReturnType<typeof meter>, profileId = "groq-oss-120b", inputBound = 1_000, outputBound = 500) {
  return meterValue.admission.reserve({ profileId, inputTokens: inputBound, outputTokens: outputBound });
}

describe("server-owned provider observation meter", () => {
  it("reports an empty, undispatched observation with zero totals", () => {
    const observation = meter().snapshot({ latencyMs: 0, providerRequestCount: 0 });
    expect(observation).toEqual({
      kind: "provider_reported",
      latencyMs: 0,
      providerRequestCount: 0,
      currency: "USD",
      costKind: "token_usage_at_configured_rates",
      usageStatus: "not_dispatched",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      cacheStatus: "unknown",
      reservations: [],
    });
  });

  it("rejects a provider request without an admitted reservation", () => {
    expect(() => meter().snapshot({ latencyMs: 10, providerRequestCount: 1 })).toThrow(/budget reservation/u);
    expect(() => meter().snapshot({ latencyMs: 120_001, providerRequestCount: 0 })).toThrow();
    expect(() => meter().snapshot({ latencyMs: 1, providerRequestCount: 1.5 })).toThrow();
  });

  it("requires valid approved pricing and safe bounds before calling the delegate", async () => {
    const reserveCalls: unknown[] = [];
    const delegate: ModelBudgetAdmission = {
      reserve(input) {
        reserveCalls.push(input);
        return Promise.resolve({ settle: () => Promise.resolve() });
      },
    };
    const invalidPrice = [{ ...prices[0], inputMicroUsdPerMillion: 0 }] as typeof prices;
    const badPriceMeter = createProviderObservationMeter({ admission: delegate, configuration, prices: invalidPrice });
    await expect(reserve(badPriceMeter)).rejects.toMatchObject({ code: "budget_unpriced" });
    await expect(badPriceMeter.admission.reserve({ profileId: "missing-profile", inputTokens: 1, outputTokens: 1 }))
      .rejects.toMatchObject({ code: "budget_unpriced" });
    await expect(badPriceMeter.admission.reserve({ profileId: "groq-oss-120b", inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 }))
      .rejects.toMatchObject({ code: "budget_usage_invalid" });
    expect(reserveCalls).toEqual([]);
  });

  it("does not admit a request when the delegated budget reservation fails", async () => {
    const failure = new Error("budget storage is unavailable");
    const observed = meter(successfulAdmission({ reserveError: failure }));
    await expect(reserve(observed)).rejects.toBe(failure);
    expect(() => observed.snapshot({ latencyMs: 50, providerRequestCount: 1 })).toThrow(/budget reservation/u);
    expect(observed.snapshot({ latencyMs: 50, providerRequestCount: 0 }).reservations).toEqual([]);
  });

  it("does not report not-dispatched while a delegated reservation is pending", async () => {
    let releaseReserve: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseReserve = resolve; });
    const delegate: ModelBudgetAdmission = {
      async reserve() {
        await gate;
        return { settle: () => Promise.resolve() };
      },
    };
    const observed = meter(delegate);
    const pendingReservation = reserve(observed);
    expect(() => observed.snapshot({ latencyMs: 5, providerRequestCount: 0 })).toThrow(/still in progress/u);
    if (!releaseReserve) throw new Error("Expected the deferred budget reservation callback.");
    releaseReserve();
    await pendingReservation;
  });

  it("keeps an unknown settlement at its reservation bounds and reports null aggregates", async () => {
    let delegatedUsage: { inputTokens: number; outputTokens: number } | undefined = { inputTokens: 1, outputTokens: 1 };
    const observed = meter(successfulAdmission({ onSettle: usage => { delegatedUsage = usage; } }));
    const reservation = await reserve(observed);
    await reservation.settle(undefined);
    expect(delegatedUsage).toBeUndefined();
    expect(observed.snapshot({ latencyMs: 200, providerRequestCount: 1 })).toMatchObject({
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      reservations: [{ inputBound: 1_000, outputBound: 500, inputTokens: null, outputTokens: null, settlement: "unknown" }],
    });
  });

  it("propagates the original settlement failure and marks caller usage unconfirmed", async () => {
    const failure = new Error("private storage detail");
    const observed = meter(successfulAdmission({ settleError: failure }));
    const reservation = await reserve(observed);
    await expect(reservation.settle({ inputTokens: 40, outputTokens: 10 })).rejects.toBe(failure);
    const snapshot = observed.snapshot({ latencyMs: 300, providerRequestCount: 1 });
    expect(snapshot).toMatchObject({ usageStatus: "unknown", inputTokens: null, outputTokens: null, estimatedCostUsd: null });
    expect(snapshot.reservations[0]?.settlement).toBe("unconfirmed");
    expect(JSON.stringify(snapshot)).not.toContain("private storage detail");
  });

  it("reconciles invalid raw counts as unknown without forwarding them to the budget delegate", async () => {
    const settlements: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
    const observed = meter(successfulAdmission({ onSettle: usage => settlements.push(usage) }));
    const reservation = await reserve(observed);
    await expect(reservation.settle({ inputTokens: 1_001, outputTokens: 2 })).rejects.toMatchObject({ code: "budget_usage_invalid" });
    expect(settlements).toEqual([undefined]);
    expect(observed.snapshot({ latencyMs: 400, providerRequestCount: 1 })).toMatchObject({
      usageStatus: "unknown",
      reservations: [{ settlement: "unknown", inputTokens: null, outputTokens: null, estimatedCostUsd: null }],
    });
  });

  it("calculates profile-specific costs for published and operator-estimated prices", async () => {
    const observed = meter();
    const groq = await reserve(observed, "groq-oss-120b");
    const gwdg = await reserve(observed, "gwdg-qwen3-30b");
    await groq.settle({ inputTokens: 100, outputTokens: 50 });
    await gwdg.settle({ inputTokens: 10, outputTokens: 5 });

    expect(observed.snapshot({ latencyMs: 1_234.5, providerRequestCount: 2 })).toEqual({
      kind: "provider_reported",
      latencyMs: 1_234.5,
      providerRequestCount: 2,
      currency: "USD",
      costKind: "token_usage_at_configured_rates",
      usageStatus: "complete",
      inputTokens: 110,
      outputTokens: 55,
      estimatedCostUsd: 0.000073,
      cacheStatus: "unknown",
      reservations: [
        {
          profileId: "groq-oss-120b", inputBound: 1_000, outputBound: 500,
          inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.000045,
          pricingBasis: "published", settlement: "reported",
        },
        {
          profileId: "gwdg-qwen3-30b", inputBound: 1_000, outputBound: 500,
          inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.000028,
          pricingBasis: "operator_estimate", settlement: "reported",
        },
      ],
    });
  });

  it("reconciles unknown usage through the real budget handle and preserves later known usage", async () => {
    const ledger = createModelBudget(new MemoryJsonStore("provider-observation-meter"), prices, false);
    await ledger.initialize();
    const observed = meter(createModelBudgetAdmission(ledger, configuration, prices));
    const reservation = await reserve(observed, "groq-oss-120b", 100, 50);
    await reservation.settle(undefined);

    const unknownBudget = await ledger.snapshot();
    expect(unknownBudget.unresolvedReservations).toBe(1);
    expect(unknownBudget.unknownUsageReservations).toBe(1);
    expect(unknownBudget.inputTokensUsed).toBe(100);
    expect(observed.snapshot({ latencyMs: 50, providerRequestCount: 1 }).usageStatus).toBe("unknown");

    const actualUsage = { inputTokens: 20, outputTokens: 5 };
    await reservation.settle(actualUsage);
    await reservation.settle(actualUsage);
    await reservation.settle(undefined);

    const reconciledBudget = await ledger.snapshot();
    expect(reconciledBudget.unresolvedReservations).toBe(0);
    expect(reconciledBudget.unknownUsageReservations).toBe(0);
    expect(reconciledBudget.inputTokensUsed).toBe(actualUsage.inputTokens);
    expect(reconciledBudget.outputTokensUsed).toBe(actualUsage.outputTokens);
    expect(observed.snapshot({ latencyMs: 80, providerRequestCount: 1 })).toMatchObject({
      usageStatus: "complete",
      inputTokens: actualUsage.inputTokens,
      outputTokens: actualUsage.outputTokens,
      reservations: [{ settlement: "reported", inputTokens: actualUsage.inputTokens, outputTokens: actualUsage.outputTokens }],
    });
  });

  it("delegates a conflicting second known settlement and marks its measurement unconfirmed", async () => {
    const ledger = createModelBudget(new MemoryJsonStore("provider-observation-conflict"), prices, false);
    await ledger.initialize();
    const observed = meter(createModelBudgetAdmission(ledger, configuration, prices));
    const reservation = await reserve(observed, "groq-oss-120b", 100, 50);
    await reservation.settle({ inputTokens: 20, outputTokens: 5 });

    await expect(reservation.settle({ inputTokens: 21, outputTokens: 5 })).rejects.toMatchObject({ code: "conflict" });
    expect(observed.snapshot({ latencyMs: 80, providerRequestCount: 1 })).toMatchObject({
      usageStatus: "unknown",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      reservations: [{ settlement: "unconfirmed", inputTokens: null, outputTokens: null, estimatedCostUsd: null }],
    });
  });

  it("returns independent plain objects from each snapshot and exposes a strict bounded schema", async () => {
    const observed = meter();
    const reservation = await reserve(observed);
    await reservation.settle({ inputTokens: 12, outputTokens: 4 });
    const first = observed.snapshot({ latencyMs: 10, providerRequestCount: 1 });
    const firstReservation = first.reservations[0];
    if (!firstReservation) throw new Error("Expected one reservation.");
    firstReservation.inputTokens = 999;
    first.reservations.pop();

    const second = observed.snapshot({ latencyMs: 20, providerRequestCount: 1 });
    expect(second.reservations[0]?.inputTokens).toBe(12);
    expect(second.reservations).toHaveLength(1);
    expect(providerMeasurementsSchema.safeParse({ ...second, extra: true }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({ ...second, latencyMs: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({ ...second, inputTokens: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("requires complete aggregates to equal the reported reservation totals", () => {
    const valid: ProviderMeasurements = {
      kind: "provider_reported",
      latencyMs: 10,
      providerRequestCount: 1,
      currency: "USD",
      costKind: "token_usage_at_configured_rates",
      usageStatus: "complete",
      inputTokens: 10,
      outputTokens: 1,
      estimatedCostUsd: 0.0000021,
      cacheStatus: "unknown",
      reservations: [{
        profileId: "groq-oss-120b",
        inputBound: 10,
        outputBound: 10,
        inputTokens: 10,
        outputTokens: 1,
        estimatedCostUsd: 0.0000021,
        pricingBasis: "published",
        settlement: "reported",
      }],
    };
    const reservation = valid.reservations[0];
    if (!reservation) throw new Error("Expected one reported reservation.");
    expect(providerMeasurementsSchema.safeParse(valid).success).toBe(true);
    expect(providerMeasurementsSchema.safeParse({ ...valid, providerRequestCount: 2 }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({ ...valid, inputTokens: 11 }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({ ...valid, outputTokens: 2 }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({ ...valid, estimatedCostUsd: 0.000003 }).success).toBe(false);
    expect(providerMeasurementsSchema.safeParse({
      ...valid,
      inputTokens: 11,
      reservations: [{ ...reservation, inputTokens: 11 }],
    }).success).toBe(false);
  });
});
