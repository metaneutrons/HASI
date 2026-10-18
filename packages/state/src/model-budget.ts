import { createHash } from 'node:crypto';
import type { JsonStore } from './store.js';

const VERSION = 1;
const MAX_POLICY_INTEGER = 1_000_000_000_000;
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_RESERVATIONS = 2_048;
const MAX_RECONCILABLE_PRIOR_RESERVATIONS = 512;
const MAX_CAS_ATTEMPTS = 12;
const MICRO_USD_PER_USD = 1_000_000;

export type ModelBudgetErrorCode = 'exhausted' | 'unavailable' | 'conflict' | 'invalid';

const ERROR_MESSAGES: Record<ModelBudgetErrorCode, string> = {
  exhausted: 'Model budget is exhausted.',
  unavailable: 'Model budget state is unavailable.',
  conflict: 'Model budget operation conflicts with existing state.',
  invalid: 'Invalid model budget policy or request.',
};

/** A sanitized failure from the conservative model-call admission ledger. */
export class ModelBudgetError extends Error {
  readonly code: ModelBudgetErrorCode;

  constructor(code: ModelBudgetErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ModelBudgetError';
    this.code = code;
  }
}

export interface ModelBudgetLedgerOptions {
  readonly scope: string;
  readonly windowMs: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly microUsdLimit: number;
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  readonly now?: () => number;
  /** Deployed callers require an operator-initialized record; absence fails closed. */
  readonly requireExistingState?: boolean;
}

export interface ModelBudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelBudgetSnapshot {
  readonly initialized: boolean;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
  readonly microUsdUsed: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly microUsdLimit: number;
  readonly reservationsInWindow: number;
  readonly unresolvedReservations: number;
  readonly unknownUsageReservations: number;
  /** Cumulative upper bounds archived after their per-reservation reconciliation window expired. */
  readonly archivedUnknown: ArchivedUnknownUsage;
}

export interface ArchivedUnknownUsage {
  readonly reservations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly microUsd: number;
}

type ReservationStatus = 'reserved' | 'unknown' | 'settled' | 'released';

interface Reservation {
  readonly idDigest: string;
  readonly windowStart: number;
  readonly inputUpperBound: number;
  readonly outputUpperBound: number;
  readonly microUsdUpperBound: number;
  inputCharged: number;
  outputCharged: number;
  microUsdCharged: number;
  status: ReservationStatus;
}

interface LedgerState {
  readonly version: number;
  readonly policyDigest: string;
  windowStart: number;
  inputTokensUsed: number;
  outputTokensUsed: number;
  microUsdUsed: number;
  reservations: Reservation[];
  /** Optional for backward-compatible reads of existing v1 records. */
  archivedUnknown?: ArchivedUnknownUsage;
}

interface Policy {
  readonly windowMs: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly microUsdLimit: number;
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  readonly digest: string;
  readonly storeKey: string;
}

/**
 * A durable, CAS-backed admission ledger. Reservations charge their declared
 * input/output upper bounds until verified usage settles them. A caller must
 * use opaque IDs and call release only when it knows no provider call began.
 */
export class ModelBudgetLedger {
  private readonly policy: Policy;
  private readonly now: () => number;
  private hasObservedState = false;
  private readonly requireExistingState: boolean;

  constructor(private readonly store: JsonStore, options: ModelBudgetLedgerOptions) {
    this.policy = makePolicy(options);
    if (options.now !== undefined && typeof options.now !== 'function') throw new ModelBudgetError('invalid');
    this.now = options.now ?? Date.now;
    this.requireExistingState = options.requireExistingState === true;
  }

  /** Explicit deployment bootstrap. Never called by a model request. Existing usage is preserved. */
  async initialize(): Promise<void> {
    await this.transact((current) => current ?? this.emptyState(this.currentWindowStart()), true, true);
  }

  /** Atomically charges the full admitted upper bound before a provider call. */
  async reserve(request: { readonly id: string; readonly inputTokens: number; readonly outputTokens: number }): Promise<void> {
    assertUsage(request);
    const idDigest = digestIdentifier(request.id);
    const windowStart = this.currentWindowStart();

    await this.transact((current) => {
      const state = current ?? this.emptyState(windowStart);
      this.assertPolicy(state);
      this.advanceWindow(state, windowStart);

      if (state.reservations.some((reservation) => reservation.idDigest === idDigest)) {
        throw new ModelBudgetError('conflict');
      }
      if (request.inputTokens > this.policy.inputTokenLimit || request.outputTokens > this.policy.outputTokenLimit) {
        throw new ModelBudgetError('exhausted');
      }
      const reservedCost = this.cost(request.inputTokens, request.outputTokens);
      if (
        state.inputTokensUsed + request.inputTokens > this.policy.inputTokenLimit
        || state.outputTokensUsed + request.outputTokens > this.policy.outputTokenLimit
        || BigInt(state.microUsdUsed) + reservedCost > BigInt(this.policy.microUsdLimit)
      ) {
        throw new ModelBudgetError('exhausted');
      }
      if (state.reservations.length >= MAX_RESERVATIONS) throw new ModelBudgetError('exhausted');

      const microUsdUpperBound = Number(reservedCost);
      state.reservations.push({
        idDigest,
        windowStart,
        inputUpperBound: request.inputTokens,
        outputUpperBound: request.outputTokens,
        microUsdUpperBound,
        inputCharged: request.inputTokens,
        outputCharged: request.outputTokens,
        microUsdCharged: microUsdUpperBound,
        status: 'reserved',
      });
      state.inputTokensUsed += request.inputTokens;
      state.outputTokensUsed += request.outputTokens;
      state.microUsdUsed += microUsdUpperBound;
      return state;
    }, true);
  }

  /**
   * Settles to verified provider usage. Missing usage marks the reservation
   * unknown and leaves the full reservation charged; a later verified value
   * may reconcile that hold downward.
   */
  async settle(id: string, usage?: ModelBudgetUsage): Promise<void> {
    const idDigest = digestIdentifier(id);
    if (usage !== undefined) assertUsage(usage);
    const requestedWindowStart = this.currentWindowStart();

    await this.transact((current) => {
      if (current === null) throw new ModelBudgetError('conflict');
      this.assertPolicy(current);
      this.advanceWindow(current, requestedWindowStart, idDigest);
      const reservation = current.reservations.find((item) => item.idDigest === idDigest);
      if (reservation === undefined) throw new ModelBudgetError('conflict');
      if (reservation.status === 'released') throw new ModelBudgetError('conflict');

      if (usage === undefined) {
        if (reservation.status === 'reserved') reservation.status = 'unknown';
        return current;
      }

      if (reservation.status === 'settled') {
        if (reservation.inputCharged !== usage.inputTokens || reservation.outputCharged !== usage.outputTokens) {
          throw new ModelBudgetError('conflict');
        }
        return current;
      }
      if (usage.inputTokens > reservation.inputUpperBound || usage.outputTokens > reservation.outputUpperBound) {
        throw new ModelBudgetError('conflict');
      }

      const microUsdCharged = Number(this.cost(usage.inputTokens, usage.outputTokens));
      if (reservation.windowStart === current.windowStart) {
        current.inputTokensUsed += usage.inputTokens - reservation.inputCharged;
        current.outputTokensUsed += usage.outputTokens - reservation.outputCharged;
        current.microUsdUsed += microUsdCharged - reservation.microUsdCharged;
      }
      reservation.inputCharged = usage.inputTokens;
      reservation.outputCharged = usage.outputTokens;
      reservation.microUsdCharged = microUsdCharged;
      reservation.status = 'settled';
      return current;
    }, false);
  }

  /** Releases only a reservation the caller knows was cancelled pre-provider. */
  async release(id: string): Promise<void> {
    const idDigest = digestIdentifier(id);
    const requestedWindowStart = this.currentWindowStart();

    await this.transact((current) => {
      if (current === null) throw new ModelBudgetError('conflict');
      this.assertPolicy(current);
      this.advanceWindow(current, requestedWindowStart, idDigest);
      const reservation = current.reservations.find((item) => item.idDigest === idDigest);
      if (reservation === undefined) throw new ModelBudgetError('conflict');
      if (reservation.status === 'released') return current;
      if (reservation.status !== 'reserved') throw new ModelBudgetError('conflict');

      if (reservation.windowStart === current.windowStart) {
        current.inputTokensUsed -= reservation.inputCharged;
        current.outputTokensUsed -= reservation.outputCharged;
        current.microUsdUsed -= reservation.microUsdCharged;
      }
      reservation.inputCharged = 0;
      reservation.outputCharged = 0;
      reservation.microUsdCharged = 0;
      reservation.status = 'released';
      return current;
    }, false);
  }

  /** Returns aggregate budget state without reservation IDs or request content. */
  async snapshot(): Promise<ModelBudgetSnapshot> {
    const requestedWindowStart = this.currentWindowStart();
    let current: { revision: string; value: unknown } | undefined;
    try {
      current = await this.store.read(this.policy.storeKey);
    } catch {
      throw new ModelBudgetError('unavailable');
    }
    if (current === undefined) {
      if (this.hasObservedState || this.requireExistingState) throw new ModelBudgetError('unavailable');
      return this.makeSnapshot(null, requestedWindowStart);
    }

    this.hasObservedState = true;
    const state = this.parseState(current.value);
    this.assertPolicy(state);
    if (requestedWindowStart < state.windowStart) throw new ModelBudgetError('conflict');
    if (requestedWindowStart === state.windowStart) return this.makeSnapshot(state, requestedWindowStart);
    return this.makeSnapshot(
      null,
      requestedWindowStart,
      state.reservations.filter(isUnresolved).length,
      true,
      state.reservations.filter((item) => item.status === 'unknown').length,
      state.archivedUnknown ?? emptyArchivedUnknown(),
    );
  }

  private async transact(
    update: (state: LedgerState | null) => LedgerState,
    initializeIfMissing: boolean,
    operatorInitialization = false,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      let current: { revision: string; value: unknown } | undefined;
      try {
        current = await this.store.read(this.policy.storeKey);
      } catch {
        throw new ModelBudgetError('unavailable');
      }

      let state: LedgerState | null;
      if (current === undefined) {
        if (this.hasObservedState || this.requireExistingState && !operatorInitialization) throw new ModelBudgetError('unavailable');
        if (!initializeIfMissing) throw new ModelBudgetError('conflict');
        state = null;
      } else {
        this.hasObservedState = true;
        state = this.parseState(current.value);
        this.assertPolicy(state);
      }

      const next = update(state);
      let committed: boolean;
      try {
        committed = await this.store.compareAndSet(
          this.policy.storeKey,
          current?.revision ?? null,
          next,
        );
      } catch {
        throw new ModelBudgetError('unavailable');
      }
      if (committed) {
        this.hasObservedState = true;
        return;
      }
    }
    throw new ModelBudgetError('conflict');
  }

  private emptyState(windowStart: number): LedgerState {
    return {
      version: VERSION,
      policyDigest: this.policy.digest,
      windowStart,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      microUsdUsed: 0,
      reservations: [],
      archivedUnknown: emptyArchivedUnknown(),
    };
  }

  private advanceWindow(state: LedgerState, windowStart: number, preserveIdDigest?: string): void {
    if (windowStart < state.windowStart) throw new ModelBudgetError('conflict');
    if (windowStart === state.windowStart) return;

    // Retain a bounded set of recent prior-window IDs for late reconciliation.
    // Older unresolved holds are archived at their full conservative values;
    // they never affect the new window's admission totals.
    const unresolved = state.reservations.filter(isUnresolved);
    const protectedReservation = preserveIdDigest === undefined
      ? undefined
      : unresolved.find((reservation) => reservation.idDigest === preserveIdDigest);
    const protectedDigest = protectedReservation?.idDigest;
    const newestLimit = MAX_RECONCILABLE_PRIOR_RESERVATIONS - (protectedReservation === undefined ? 0 : 1);
    const newest = unresolved.filter((reservation) => reservation.idDigest !== protectedDigest).slice(-newestLimit);
    const retainedIds = new Set(newest.map((reservation) => reservation.idDigest));
    if (protectedDigest !== undefined) retainedIds.add(protectedDigest);
    const retained = unresolved.filter((reservation) => retainedIds.has(reservation.idDigest));
    const archived = unresolved.filter((reservation) => !retainedIds.has(reservation.idDigest));
    this.archiveUnknown(state, archived);
    state.reservations = retained;
    state.windowStart = windowStart;
    state.inputTokensUsed = 0;
    state.outputTokensUsed = 0;
    state.microUsdUsed = 0;
  }

  private archiveUnknown(state: LedgerState, reservations: readonly Reservation[]): void {
    if (reservations.length === 0) return;
    const current = state.archivedUnknown ?? emptyArchivedUnknown();
    const inputTokens = reservations.reduce((total, reservation) => total + reservation.inputCharged, 0);
    const outputTokens = reservations.reduce((total, reservation) => total + reservation.outputCharged, 0);
    const microUsd = reservations.reduce((total, reservation) => total + reservation.microUsdCharged, 0);
    const next = {
      reservations: current.reservations + reservations.length,
      inputTokens: current.inputTokens + inputTokens,
      outputTokens: current.outputTokens + outputTokens,
      microUsd: current.microUsd + microUsd,
    };
    if (!isArchivedUnknown(next)) throw new ModelBudgetError('exhausted');
    state.archivedUnknown = next;
  }

  private assertPolicy(state: LedgerState): void {
    if (state.version !== VERSION || state.policyDigest !== this.policy.digest) {
      throw new ModelBudgetError('conflict');
    }
    if (!isSafeNonNegativeInteger(state.windowStart) || state.windowStart % this.policy.windowMs !== 0) {
      throw new ModelBudgetError('unavailable');
    }
    if (
      !isSafeNonNegativeInteger(state.inputTokensUsed)
      || !isSafeNonNegativeInteger(state.outputTokensUsed)
      || !isSafeNonNegativeInteger(state.microUsdUsed)
      || state.inputTokensUsed > this.policy.inputTokenLimit
      || state.outputTokensUsed > this.policy.outputTokenLimit
      || state.microUsdUsed > this.policy.microUsdLimit
      || !Array.isArray(state.reservations)
      || state.reservations.length > MAX_RESERVATIONS
    ) {
      throw new ModelBudgetError('unavailable');
    }

    const archivedUnknown = state.archivedUnknown ?? emptyArchivedUnknown();
    if (
      !isArchivedUnknown(archivedUnknown)
      || archivedUnknown.reservations === 0 && (archivedUnknown.inputTokens !== 0 || archivedUnknown.outputTokens !== 0 || archivedUnknown.microUsd !== 0)
      || archivedUnknown.reservations > 0 && (
        BigInt(archivedUnknown.reservations) > BigInt(archivedUnknown.inputTokens) + BigInt(archivedUnknown.outputTokens)
        || archivedUnknown.reservations > archivedUnknown.microUsd
      )
    ) {
      throw new ModelBudgetError('unavailable');
    }

    const totals = { input: 0, output: 0, microUsd: 0 };
    const ids = new Set<string>();
    for (const reservation of state.reservations) {
      if (!isReservation(reservation) || ids.has(reservation.idDigest)) throw new ModelBudgetError('unavailable');
      ids.add(reservation.idDigest);
      if (
        !isSafeNonNegativeInteger(reservation.windowStart)
        || reservation.windowStart > state.windowStart
        || !isSafeNonNegativeInteger(reservation.inputUpperBound)
        || !isSafeNonNegativeInteger(reservation.outputUpperBound)
        || !isSafeNonNegativeInteger(reservation.microUsdUpperBound)
        || !isSafeNonNegativeInteger(reservation.inputCharged)
        || !isSafeNonNegativeInteger(reservation.outputCharged)
        || !isSafeNonNegativeInteger(reservation.microUsdCharged)
        || reservation.inputUpperBound > this.policy.inputTokenLimit
        || reservation.outputUpperBound > this.policy.outputTokenLimit
        || BigInt(reservation.microUsdUpperBound) !== this.cost(reservation.inputUpperBound, reservation.outputUpperBound)
      ) {
        throw new ModelBudgetError('unavailable');
      }
      if (reservation.status === 'released') {
        if (reservation.inputCharged !== 0 || reservation.outputCharged !== 0 || reservation.microUsdCharged !== 0) {
          throw new ModelBudgetError('unavailable');
        }
        continue;
      }
      if (
        reservation.inputCharged > reservation.inputUpperBound
        || reservation.outputCharged > reservation.outputUpperBound
        || reservation.microUsdCharged > reservation.microUsdUpperBound
      ) {
        throw new ModelBudgetError('unavailable');
      }
      if (reservation.status === 'reserved' || reservation.status === 'unknown') {
        if (
          reservation.inputCharged !== reservation.inputUpperBound
          || reservation.outputCharged !== reservation.outputUpperBound
          || reservation.microUsdCharged !== reservation.microUsdUpperBound
        ) {
          throw new ModelBudgetError('unavailable');
        }
      } else if (
        reservation.microUsdCharged !== Number(this.cost(reservation.inputCharged, reservation.outputCharged))
      ) {
        throw new ModelBudgetError('unavailable');
      }
      if (reservation.windowStart === state.windowStart) {
        totals.input += reservation.inputCharged;
        totals.output += reservation.outputCharged;
        totals.microUsd += reservation.microUsdCharged;
      }
    }
    if (
      totals.input !== state.inputTokensUsed
      || totals.output !== state.outputTokensUsed
      || totals.microUsd !== state.microUsdUsed
    ) {
      throw new ModelBudgetError('unavailable');
    }
  }

  private parseState(value: unknown): LedgerState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ModelBudgetError('unavailable');
    }
    return value as LedgerState;
  }

  private makeSnapshot(
    state: LedgerState | null,
    windowStart: number,
    unresolvedReservations = 0,
    initialized = state !== null || unresolvedReservations > 0,
    unknownUsageReservations = 0,
    archivedUnknown = state?.archivedUnknown ?? emptyArchivedUnknown(),
  ): ModelBudgetSnapshot {
    const reservationsInWindow = state?.reservations.filter((item) => item.windowStart === windowStart).length ?? 0;
    const currentUnresolved = state?.reservations.filter(isUnresolved).length ?? unresolvedReservations;
    const unknownReservations = state?.reservations.filter((item) => item.status === 'unknown').length
      ?? unknownUsageReservations;
    return {
      initialized,
      windowStart,
      windowEnd: windowStart + this.policy.windowMs,
      inputTokensUsed: state?.windowStart === windowStart ? state.inputTokensUsed : 0,
      outputTokensUsed: state?.windowStart === windowStart ? state.outputTokensUsed : 0,
      microUsdUsed: state?.windowStart === windowStart ? state.microUsdUsed : 0,
      inputTokenLimit: this.policy.inputTokenLimit,
      outputTokenLimit: this.policy.outputTokenLimit,
      microUsdLimit: this.policy.microUsdLimit,
      reservationsInWindow,
      unresolvedReservations: currentUnresolved,
      unknownUsageReservations: unknownReservations,
      archivedUnknown,
    };
  }

  private currentWindowStart(): number {
    let now: number;
    try {
      now = this.now();
    } catch {
      throw new ModelBudgetError('invalid');
    }
    if (!isSafeNonNegativeInteger(now) || now > Number.MAX_SAFE_INTEGER - this.policy.windowMs) {
      throw new ModelBudgetError('invalid');
    }
    const windowStart = Math.floor(now / this.policy.windowMs) * this.policy.windowMs;
    if (!isSafeNonNegativeInteger(windowStart)) throw new ModelBudgetError('invalid');
    return windowStart;
  }

  private cost(inputTokens: number, outputTokens: number): bigint {
    return roundedMicroUsd(inputTokens, this.policy.inputMicroUsdPerMillion)
      + roundedMicroUsd(outputTokens, this.policy.outputMicroUsdPerMillion);
  }
}

function makePolicy(optionsValue: unknown): Policy {
  if (typeof optionsValue !== 'object' || optionsValue === null) throw new ModelBudgetError('invalid');
  const options = optionsValue as ModelBudgetLedgerOptions;
  assertIdentifier(options.scope);
  assertPolicyInteger(options.windowMs, MAX_WINDOW_MS);
  assertPolicyInteger(options.inputTokenLimit, MAX_POLICY_INTEGER);
  assertPolicyInteger(options.outputTokenLimit, MAX_POLICY_INTEGER);
  assertPolicyInteger(options.microUsdLimit, MAX_POLICY_INTEGER);
  assertPolicyInteger(options.inputMicroUsdPerMillion, MAX_POLICY_INTEGER);
  assertPolicyInteger(options.outputMicroUsdPerMillion, MAX_POLICY_INTEGER);

  const configuration = [
    VERSION,
    options.scope,
    options.windowMs,
    options.inputTokenLimit,
    options.outputTokenLimit,
    options.microUsdLimit,
    options.inputMicroUsdPerMillion,
    options.outputMicroUsdPerMillion,
  ];
  const digest = hash(JSON.stringify(configuration));
  return {
    windowMs: options.windowMs,
    inputTokenLimit: options.inputTokenLimit,
    outputTokenLimit: options.outputTokenLimit,
    microUsdLimit: options.microUsdLimit,
    inputMicroUsdPerMillion: options.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: options.outputMicroUsdPerMillion,
    digest,
    storeKey: `model-budget:v${String(VERSION)}:${hash(options.scope)}`,
  };
}

function assertPolicyInteger(value: unknown, maximum: number): asserts value is number {
  if (!isSafePositiveInteger(value) || value > maximum) throw new ModelBudgetError('invalid');
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new ModelBudgetError('invalid');
  }
}

function digestIdentifier(value: unknown): string {
  assertIdentifier(value);
  return hash(value);
}

function assertUsage(value: unknown): asserts value is ModelBudgetUsage {
  if (typeof value !== 'object' || value === null) throw new ModelBudgetError('invalid');
  const usage = value as Partial<ModelBudgetUsage>;
  if (
    !isSafeNonNegativeInteger(usage.inputTokens)
    || !isSafeNonNegativeInteger(usage.outputTokens)
    || (usage.inputTokens === 0 && usage.outputTokens === 0)
  ) {
    throw new ModelBudgetError('invalid');
  }
}

function emptyArchivedUnknown(): ArchivedUnknownUsage {
  return { reservations: 0, inputTokens: 0, outputTokens: 0, microUsd: 0 };
}

function isArchivedUnknown(value: unknown): value is ArchivedUnknownUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const archived = value as Partial<ArchivedUnknownUsage>;
  return isSafeNonNegativeInteger(archived.reservations)
    && isSafeNonNegativeInteger(archived.inputTokens)
    && isSafeNonNegativeInteger(archived.outputTokens)
    && isSafeNonNegativeInteger(archived.microUsd);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isReservation(value: unknown): value is Reservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const reservation = value as Partial<Reservation>;
  return typeof reservation.idDigest === 'string'
    && /^[0-9a-f]{64}$/.test(reservation.idDigest)
    && (reservation.status === 'reserved' || reservation.status === 'unknown'
      || reservation.status === 'settled' || reservation.status === 'released');
}

function isUnresolved(reservation: Reservation): boolean {
  return reservation.status === 'reserved' || reservation.status === 'unknown';
}

function roundedMicroUsd(tokens: number, ratePerMillion: number): bigint {
  const numerator = BigInt(tokens) * BigInt(ratePerMillion);
  return (numerator + BigInt(MICRO_USD_PER_USD - 1)) / BigInt(MICRO_USD_PER_USD);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
