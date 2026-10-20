import "server-only";

import { z } from "zod";
import { modelPrice, type ModelPrice } from "../model-budgets";
import type { ModelBudgetAdmission } from "../model-router";
import type { ModelConfiguration } from "../model-config";
import { ModelRouterError } from "../model-router-error";

const MAX_PROVIDER_REQUESTS = 16;
const safeNonNegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a safe non-negative integer.",
);
const nullableTokenCountSchema = safeNonNegativeIntegerSchema.nullable();
const nullableCostSchema = z.number().min(0).nullable();

const reservationSchema = z.strictObject({
  profileId: z.string().min(1).max(128),
  inputBound: safeNonNegativeIntegerSchema,
  outputBound: safeNonNegativeIntegerSchema,
  inputTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  estimatedCostUsd: nullableCostSchema,
  pricingBasis: z.enum(["published", "operator_estimate"]),
  settlement: z.enum(["reserved", "reported", "unknown", "unconfirmed"]),
}).superRefine((reservation, context) => {
  if (reservation.settlement === "reported") {
    if (reservation.inputTokens === null || reservation.outputTokens === null || reservation.estimatedCostUsd === null) {
      context.addIssue({ code: "custom", message: "Reported reservations require token counts and a cost." });
      return;
    }
    if (reservation.inputTokens > reservation.inputBound || reservation.outputTokens > reservation.outputBound) {
      context.addIssue({ code: "custom", message: "Reported usage cannot exceed its admitted bounds." });
    }
  } else if (reservation.inputTokens !== null || reservation.outputTokens !== null || reservation.estimatedCostUsd !== null) {
    context.addIssue({ code: "custom", message: "Unsettled reservations cannot include reported usage." });
  }
});

/**
 * Bounded server-side measurements for a provider call. Costs use the approved
 * configured tariff and are estimates, not provider invoice accounting.
 */
export const providerMeasurementsSchema = z.strictObject({
  kind: z.literal("provider_reported"),
  latencyMs: z.number().min(0).max(120_000),
  providerRequestCount: z.number().int().min(0).max(MAX_PROVIDER_REQUESTS),
  currency: z.literal("USD"),
  costKind: z.literal("token_usage_at_configured_rates"),
  usageStatus: z.enum(["complete", "unknown", "not_dispatched"]),
  inputTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  estimatedCostUsd: nullableCostSchema,
  cacheStatus: z.literal("unknown"),
  reservations: z.array(reservationSchema).max(MAX_PROVIDER_REQUESTS),
}).superRefine((measurements, context) => {
  if (measurements.providerRequestCount > measurements.reservations.length) {
    context.addIssue({ code: "custom", path: ["reservations"], message: "Provider requests require budget reservations." });
  }

  if (measurements.usageStatus === "unknown") {
    if (measurements.inputTokens !== null || measurements.outputTokens !== null || measurements.estimatedCostUsd !== null) {
      context.addIssue({ code: "custom", message: "Unknown aggregate usage must be null." });
    }
    if (!measurements.reservations.some((reservation) => reservation.settlement !== "reported")) {
      context.addIssue({ code: "custom", message: "Unknown aggregate usage requires an unsettled reservation." });
    }
  } else if (measurements.usageStatus === "complete") {
    if (measurements.inputTokens === null || measurements.outputTokens === null || measurements.estimatedCostUsd === null) {
      context.addIssue({ code: "custom", message: "Complete aggregate usage requires token counts and a cost." });
    }
    const allReported = measurements.reservations.every((reservation) => reservation.settlement === "reported");
    if (!allReported) {
      context.addIssue({ code: "custom", message: "Complete aggregate usage requires all reservations to be reported." });
    }
    if (allReported && measurements.inputTokens !== null && measurements.outputTokens !== null
      && measurements.estimatedCostUsd !== null) {
      const inputTotal = measurements.reservations.reduce((total, reservation) => total + (reservation.inputTokens ?? 0), 0);
      const outputTotal = measurements.reservations.reduce((total, reservation) => total + (reservation.outputTokens ?? 0), 0);
      const costTotal = measurements.reservations.reduce((total, reservation) => total + (reservation.estimatedCostUsd ?? 0), 0);
      if (!Number.isSafeInteger(inputTotal) || measurements.inputTokens !== inputTotal) {
        context.addIssue({ code: "custom", path: ["inputTokens"], message: "Aggregate input usage must equal its reservations." });
      }
      if (!Number.isSafeInteger(outputTotal) || measurements.outputTokens !== outputTotal) {
        context.addIssue({ code: "custom", path: ["outputTokens"], message: "Aggregate output usage must equal its reservations." });
      }
      if (!Number.isFinite(costTotal) || measurements.estimatedCostUsd !== costTotal) {
        context.addIssue({ code: "custom", path: ["estimatedCostUsd"], message: "Aggregate cost must equal its reservations." });
      }
    }
  } else if (measurements.providerRequestCount !== 0 || measurements.reservations.length !== 0
    || measurements.inputTokens !== 0 || measurements.outputTokens !== 0 || measurements.estimatedCostUsd !== 0) {
    context.addIssue({ code: "custom", message: "Not-dispatched usage must have no reservations or requests and zero totals." });
  }

  if (measurements.providerRequestCount === 0 && measurements.reservations.length === 0
    && measurements.usageStatus !== "not_dispatched") {
    context.addIssue({ code: "custom", message: "An empty observation must be marked not dispatched." });
  }
});

export type ProviderMeasurements = z.infer<typeof providerMeasurementsSchema>;

const approvedPriceSchema = z.strictObject({
  provider: z.enum(["groq", "gwdg", "deepinfra", "openai", "anthropic", "custom"]),
  baseURL: z.url().max(2048),
  modelId: z.string().min(1).max(256),
  inputMicroUsdPerMillion: z.number().int().positive().max(1_000_000_000),
  outputMicroUsdPerMillion: z.number().int().positive().max(1_000_000_000),
  basis: z.enum(["published", "operator_estimate"]),
});

interface InternalReservation {
  readonly profileId: string;
  readonly inputBound: number;
  readonly outputBound: number;
  readonly inputRate: number;
  readonly outputRate: number;
  readonly pricingBasis: ModelPrice["basis"];
  settlement: "reserved" | "reported" | "unknown" | "unconfirmed";
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  settlementQueue?: Promise<void>;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidUsage(
  usage: unknown,
  bounds: { inputBound: number; outputBound: number },
): usage is { inputTokens: number; outputTokens: number } {
  if (typeof usage !== "object" || usage === null) return false;
  const candidate = usage as { inputTokens?: unknown; outputTokens?: unknown };
  return isSafeNonNegativeInteger(candidate.inputTokens)
    && isSafeNonNegativeInteger(candidate.outputTokens)
    && candidate.inputTokens <= bounds.inputBound
    && candidate.outputTokens <= bounds.outputBound;
}

function costUsd(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number {
  // Rates are micro-USD per million tokens: dividing the token-rate products
  // by 10^12 converts them directly to USD without an unsafe integer product.
  const amount = BigInt(inputTokens) * BigInt(inputRate)
    + BigInt(outputTokens) * BigInt(outputRate);
  const result = Number(amount) / 1_000_000_000_000;
  if (!Number.isFinite(result)) throw new TypeError("Provider cost could not be represented safely.");
  return result;
}

function parseApprovedPrice(
  profileId: string,
  configuration: ModelConfiguration,
  prices: readonly ModelPrice[],
): ModelPrice {
  let candidate: ModelPrice | undefined;
  try {
    candidate = modelPrice(profileId, configuration, prices);
  } catch {
    candidate = undefined;
  }
  const parsed = approvedPriceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ModelRouterError("budget_unpriced", "The selected model has no valid approved price.");
  }
  return parsed.data;
}

function assertBounds(input: { profileId: string; inputTokens: number; outputTokens: number }): void {
  if (typeof input.profileId !== "string" || input.profileId.length < 1 || input.profileId.length > 128
    || !isSafeNonNegativeInteger(input.inputTokens) || !isSafeNonNegativeInteger(input.outputTokens)
    || (input.inputTokens === 0 && input.outputTokens === 0)) {
    throw new ModelRouterError("budget_usage_invalid", "Model admission bounds are invalid.");
  }
}

function safeAggregateTotal(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new TypeError("Aggregate provider usage exceeds the safe integer range.");
  return total;
}

function requiredReportedValue(value: number | null): number {
  if (value === null) throw new TypeError("Reported provider usage is incomplete.");
  return value;
}

/**
 * Wraps the router's existing admission handle to observe bounded reservations
 * and settlements. This helper never initializes or changes budget storage.
 */
export function createProviderObservationMeter(input: {
  admission: ModelBudgetAdmission;
  configuration: ModelConfiguration;
  prices: readonly ModelPrice[];
}): {
  admission: ModelBudgetAdmission;
  snapshot(input: { latencyMs: number; providerRequestCount: number }): ProviderMeasurements;
} {
  const reservations: InternalReservation[] = [];
  let reservationsInFlight = 0;

  const admission: ModelBudgetAdmission = {
    async reserve(request) {
      assertBounds(request);
      if (reservations.length + reservationsInFlight >= MAX_PROVIDER_REQUESTS) {
        throw new ModelRouterError("budget_unavailable", "Provider observation reservation limit reached.");
      }
      const price = parseApprovedPrice(request.profileId, input.configuration, input.prices);

      reservationsInFlight += 1;
      let delegated: Awaited<ReturnType<ModelBudgetAdmission["reserve"]>>;
      try {
        // The real budget delegate must reserve successfully before this call is admitted.
        delegated = await input.admission.reserve(request);
      } finally {
        reservationsInFlight -= 1;
      }

      const observed: InternalReservation = {
        profileId: request.profileId,
        inputBound: request.inputTokens,
        outputBound: request.outputTokens,
        inputRate: price.inputMicroUsdPerMillion,
        outputRate: price.outputMicroUsdPerMillion,
        pricingBasis: price.basis,
        settlement: "reserved",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      };
      reservations.push(observed);

      return {
        settle(usage) {
          const executeSettlement = async () => {
            if (usage === undefined) {
              try {
                await delegated.settle(undefined);
                if (observed.settlement === "reserved") observed.settlement = "unknown";
              } catch (cause) {
                observed.settlement = "unconfirmed";
                observed.inputTokens = null;
                observed.outputTokens = null;
                observed.estimatedCostUsd = null;
                throw cause;
              }
              return;
            }

            const usageIsValid = isValidUsage(usage, observed);
            if (!usageIsValid) {
              try {
                await delegated.settle(undefined);
                if (observed.settlement === "reserved") observed.settlement = "unknown";
              } catch (cause) {
                observed.settlement = "unconfirmed";
                observed.inputTokens = null;
                observed.outputTokens = null;
                observed.estimatedCostUsd = null;
                throw cause;
              }
              throw new ModelRouterError("budget_usage_invalid", "Provider usage exceeds the admitted bounds.");
            }

            try {
              const estimatedCostUsd = costUsd(
                usage.inputTokens,
                usage.outputTokens,
                observed.inputRate,
                observed.outputRate,
              );
              await delegated.settle({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
              observed.inputTokens = usage.inputTokens;
              observed.outputTokens = usage.outputTokens;
              observed.estimatedCostUsd = estimatedCostUsd;
              observed.settlement = "reported";
            } catch (cause) {
              observed.settlement = "unconfirmed";
              observed.inputTokens = null;
              observed.outputTokens = null;
              observed.estimatedCostUsd = null;
              throw cause;
            }
          };
          const previous = observed.settlementQueue ?? Promise.resolve();
          const current = previous.catch(() => undefined).then(executeSettlement);
          observed.settlementQueue = current;
          return current;
        },
      };
    },
  };

  return {
    admission,
    snapshot(snapshotInput) {
      const request = z.strictObject({
        latencyMs: z.number().min(0).max(120_000),
        providerRequestCount: z.number().int().min(0).max(MAX_PROVIDER_REQUESTS),
      }).parse(snapshotInput);
      if (reservationsInFlight > 0) {
        throw new TypeError("A budget reservation is still in progress.");
      }
      if (request.providerRequestCount > 0 && reservations.length === 0) {
        throw new TypeError("Observed provider requests require a budget reservation.");
      }

      const copiedReservations = reservations.map((reservation) => ({
        profileId: reservation.profileId,
        inputBound: reservation.inputBound,
        outputBound: reservation.outputBound,
        inputTokens: reservation.inputTokens,
        outputTokens: reservation.outputTokens,
        estimatedCostUsd: reservation.estimatedCostUsd,
        pricingBasis: reservation.pricingBasis,
        settlement: reservation.settlement,
      }));
      const notDispatched = copiedReservations.length === 0 && request.providerRequestCount === 0;
      const complete = !notDispatched && copiedReservations.every((reservation) => reservation.settlement === "reported");
      const result: ProviderMeasurements = {
        kind: "provider_reported",
        latencyMs: request.latencyMs,
        providerRequestCount: request.providerRequestCount,
        currency: "USD",
        costKind: "token_usage_at_configured_rates",
        usageStatus: notDispatched ? "not_dispatched" : complete ? "complete" : "unknown",
        inputTokens: notDispatched ? 0 : complete ? safeAggregateTotal(copiedReservations.map((reservation) => requiredReportedValue(reservation.inputTokens))) : null,
        outputTokens: notDispatched ? 0 : complete ? safeAggregateTotal(copiedReservations.map((reservation) => requiredReportedValue(reservation.outputTokens))) : null,
        estimatedCostUsd: notDispatched ? 0 : complete
          ? copiedReservations.reduce((total, reservation) => total + requiredReportedValue(reservation.estimatedCostUsd), 0)
          : null,
        cacheStatus: "unknown",
        reservations: copiedReservations,
      };
      return providerMeasurementsSchema.parse(result);
    },
  };
}
