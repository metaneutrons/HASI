import { digest } from '@hasi/plugin-sdk';
import type { JsonStore, StateFence } from '@hasi/state';
import { z } from 'zod';
import { DeploymentDriverError, type DeploymentObservation } from './plugin-artifacts.js';
import type { DockerPluginRoutingController } from './docker-plugin-driver.js';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CAS_ATTEMPTS = 16;
export const MAX_PLUGIN_ROUTE_OPERATIONS_PER_INSTALLATION = 512;

const routeTargetSchema = z.strictObject({
  deploymentId: z.string().min(1).max(128).regex(OPAQUE_ID),
  releaseDigest: z.string().regex(SHA256),
});

const operationSchema = z.strictObject({
  fingerprint: z.string().regex(SHA256),
  outcome: z.enum(['committed', 'not-committed']),
  routeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const routeStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerId: z.string().min(1).max(128).regex(OPAQUE_ID),
  installationId: z.string().min(1).max(128).regex(OPAQUE_ID),
  configurationRevision: z.string().min(1).max(256),
  routeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  active: routeTargetSchema.nullable(),
  operations: z.record(z.string().regex(OPAQUE_ID), operationSchema)
    .refine(operations => Object.keys(operations).length <= MAX_PLUGIN_ROUTE_OPERATIONS_PER_INSTALLATION),
});

type RouteState = z.infer<typeof routeStateSchema>;
type RouteTarget = z.infer<typeof routeTargetSchema>;

export class PluginRouteControllerError extends DeploymentDriverError {
  constructor(outcome: 'failed' | 'unknown') {
    super(outcome);
    this.name = 'PluginRouteControllerError';
  }
}

export interface PluginRouteSnapshot {
  readonly ownerId: string;
  readonly installationId: string;
  readonly configurationRevision: string;
  readonly routeRevision: number;
  readonly active: Readonly<RouteTarget> | null;
}

export interface PluginRouteControllerOptions {
  /** Shared durable state used by every host instance that may serve the route. */
  readonly store: JsonStore;
  /** Server-owned namespace; never derive this from plugin or client input. */
  readonly scope: string;
  /** The operator identity accepted by this controller. */
  readonly ownerId: string;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function validConfigurationRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
}

function snapshot(state: RouteState): PluginRouteSnapshot {
  return Object.freeze({
    ownerId: state.ownerId,
    installationId: state.installationId,
    configurationRevision: state.configurationRevision,
    routeRevision: state.routeRevision,
    active: state.active ? Object.freeze({ ...state.active }) : null,
  });
}

function parseRouteState(value: unknown, ownerId: string, installationId: string): RouteState {
  const parsed = routeStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== ownerId || parsed.data.installationId !== installationId) {
    throw new PluginRouteControllerError('unknown');
  }
  return parsed.data;
}

/**
 * Durable route authority for operator-managed plugin deployments. Route state
 * and terminal operation outcomes share one CAS record, so separate API
 * instances cannot observe a committed route without its operation fence.
 */
export class PluginRouteController implements DockerPluginRoutingController {
  private readonly keyPrefix: string;

  constructor(private readonly options: PluginRouteControllerOptions) {
    if (!validOpaqueId(options.ownerId)) throw new TypeError('Plugin route owner identity is invalid.');
    if (!options.scope.trim() || options.scope.length > 128 || options.scope.includes('\0')) {
      throw new TypeError('Plugin route scope must be a non-empty server-owned identifier.');
    }
    this.keyPrefix = `hasi:plugin-route:v1:${digest(options.scope)}:`;
  }

  usesStateStore(store: JsonStore): boolean { return this.options.store === store; }

  private key(installationId: string): string {
    if (!validOpaqueId(installationId)) throw new PluginRouteControllerError('failed');
    return `${this.keyPrefix}${digest([this.options.ownerId, installationId])}`;
  }

  private assertOwner(ownerId: string): void {
    if (!validOpaqueId(ownerId) || ownerId !== this.options.ownerId) throw new PluginRouteControllerError('failed');
  }

  private async readState(installationId: string): Promise<{ readonly key: string; readonly revision: string; readonly state: RouteState }> {
    const key = this.key(installationId);
    let entry: Awaited<ReturnType<JsonStore['read']>>;
    try {
      entry = await this.options.store.read(key);
    } catch {
      throw new PluginRouteControllerError('unknown');
    }
    if (!entry) throw new PluginRouteControllerError('unknown');
    return { key, revision: entry.revision, state: parseRouteState(entry.value, this.options.ownerId, installationId) };
  }

  /** Initializes the operator-owned route before the installation is exposed. */
  async initializeInstallation(input: {
    readonly installationId: string;
    readonly configurationRevision: string;
    readonly activeDeploymentId?: string | null;
    readonly activeReleaseDigest?: string | null;
  }): Promise<PluginRouteSnapshot> {
    if (!validOpaqueId(input.installationId) || !validConfigurationRevision(input.configurationRevision)) {
      throw new PluginRouteControllerError('failed');
    }
    const deploymentId = input.activeDeploymentId ?? null;
    const releaseDigest = input.activeReleaseDigest ?? null;
    if ((deploymentId === null) !== (releaseDigest === null)
      || (deploymentId !== null && !validOpaqueId(deploymentId))
      || (releaseDigest !== null && !SHA256.test(releaseDigest))) {
      throw new PluginRouteControllerError('failed');
    }
    const initial: RouteState = {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      installationId: input.installationId,
      configurationRevision: input.configurationRevision,
      routeRevision: 0,
      active: deploymentId && releaseDigest ? { deploymentId, releaseDigest } : null,
      operations: {},
    };
    const key = this.key(input.installationId);
    try {
      if (await this.options.store.compareAndSet(key, null, initial)) return snapshot(initial);
      const existing = await this.options.store.read(key);
      if (existing) {
        const state = parseRouteState(existing.value, this.options.ownerId, input.installationId);
        if (digest(state) === digest(initial)) return snapshot(state);
      }
    } catch (error) {
      if (error instanceof PluginRouteControllerError) throw error;
      throw new PluginRouteControllerError('unknown');
    }
    throw new PluginRouteControllerError('failed');
  }

  /**
   * Fences future deployment changes against an operator configuration change.
   * Call this from the trusted configuration activation path, after reading the
   * authoritative new revision.
   */
  async updateConfigurationRevision(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly expectedRevision: string;
    readonly configurationRevision: string;
  }): Promise<PluginRouteSnapshot> {
    this.assertOwner(input.ownerId);
    if (!validConfigurationRevision(input.expectedRevision) || !validConfigurationRevision(input.configurationRevision)) {
      throw new PluginRouteControllerError('failed');
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { revision, state } = await this.readState(input.installationId);
      if (state.configurationRevision === input.configurationRevision) return snapshot(state);
      if (state.configurationRevision !== input.expectedRevision) throw new PluginRouteControllerError('failed');
      const next: RouteState = {
        ...state,
        configurationRevision: input.configurationRevision,
        routeRevision: state.routeRevision + 1,
      };
      try {
        if (await this.options.store.compareAndSet(this.key(input.installationId), revision, next)) return snapshot(next);
      } catch {
        throw new PluginRouteControllerError('unknown');
      }
    }
    throw new PluginRouteControllerError('unknown');
  }

  /** Reads the route snapshot for an operator-owned installation. */
  async read(input: { readonly ownerId: string; readonly installationId: string }): Promise<PluginRouteSnapshot> {
    return (await this.authoritySnapshot(input)).route;
  }

  async authoritySnapshot(input: { readonly ownerId: string; readonly installationId: string }): Promise<{ route: PluginRouteSnapshot; fence: StateFence }> {
    this.assertOwner(input.ownerId);
    const { key, revision, state } = await this.readState(input.installationId);
    return { route: snapshot(state), fence: { key, revision } };
  }

  async resolveActiveDeploymentId(input: { readonly ownerId: string; readonly installationId: string }): Promise<string | null> {
    this.assertOwner(input.ownerId);
    return (await this.readState(input.installationId)).state.active?.deploymentId ?? null;
  }

  async readActiveRoute(input: { readonly ownerId: string; readonly installationId: string }): Promise<{ readonly deploymentId: string; readonly releaseDigest: string } | null> {
    this.assertOwner(input.ownerId);
    const active = (await this.readState(input.installationId)).state.active;
    return active ? Object.freeze({ deploymentId: active.deploymentId, releaseDigest: active.releaseDigest }) : null;
  }

  async readActiveDeploymentId(input: { readonly ownerId: string; readonly installationId: string }): Promise<string | null> {
    return this.resolveActiveDeploymentId(input);
  }

  async readOperationStatus(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
  }): Promise<DeploymentObservation['routeOperationOutcome']> {
    try {
      this.assertOwner(input.ownerId);
      if (!validOpaqueId(input.operationId)) return 'unknown';
      const { state } = await this.readState(input.installationId);
      return state.operations[input.operationId]?.outcome ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async activate(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
    readonly candidateDeploymentId: string;
    readonly candidateReleaseDigest: string;
    readonly previousDeploymentId: string | null;
    readonly baseCurrentDigest: string | null;
    readonly configurationRevision: string;
  }): Promise<void> {
    this.assertOwner(input.ownerId);
    if (!validOpaqueId(input.installationId) || !validOpaqueId(input.operationId)
      || !validOpaqueId(input.candidateDeploymentId) || !SHA256.test(input.candidateReleaseDigest)
      || (input.previousDeploymentId !== null && !validOpaqueId(input.previousDeploymentId))
      || (input.baseCurrentDigest !== null && !SHA256.test(input.baseCurrentDigest))
      || (input.previousDeploymentId === null) !== (input.baseCurrentDigest === null)
      || !validConfigurationRevision(input.configurationRevision)) {
      throw new PluginRouteControllerError('failed');
    }
    const fingerprint = digest({ kind: 'activate', ...input });
    await this.commitOperation({
      installationId: input.installationId,
      operationId: input.operationId,
      fingerprint,
      apply: state => {
        const currentDeploymentId = state.active?.deploymentId ?? null;
        const currentReleaseDigest = state.active?.releaseDigest ?? null;
        if (state.configurationRevision !== input.configurationRevision
          || currentDeploymentId !== input.previousDeploymentId
          || currentReleaseDigest !== input.baseCurrentDigest
          || input.candidateDeploymentId === currentDeploymentId) return undefined;
        return { deploymentId: input.candidateDeploymentId, releaseDigest: input.candidateReleaseDigest };
      },
    });
  }

  async rollback(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
    readonly currentDeploymentId: string;
    readonly currentReleaseDigest: string;
    readonly previousDeploymentId: string;
    readonly previousReleaseDigest: string;
    readonly baseCurrentDigest: string;
    readonly configurationRevision: string;
  }): Promise<void> {
    this.assertOwner(input.ownerId);
    if (!validOpaqueId(input.installationId) || !validOpaqueId(input.operationId)
      || !validOpaqueId(input.currentDeploymentId) || !validOpaqueId(input.previousDeploymentId)
      || input.currentDeploymentId === input.previousDeploymentId
      || !SHA256.test(input.currentReleaseDigest) || !SHA256.test(input.previousReleaseDigest)
      || !SHA256.test(input.baseCurrentDigest) || input.currentReleaseDigest !== input.baseCurrentDigest
      || !validConfigurationRevision(input.configurationRevision)) {
      throw new PluginRouteControllerError('failed');
    }
    const fingerprint = digest({ kind: 'rollback', ...input });
    await this.commitOperation({
      installationId: input.installationId,
      operationId: input.operationId,
      fingerprint,
      apply: state => {
        if (state.configurationRevision !== input.configurationRevision
          || state.active?.deploymentId !== input.currentDeploymentId
          || state.active.releaseDigest !== input.currentReleaseDigest) return undefined;
        return { deploymentId: input.previousDeploymentId, releaseDigest: input.previousReleaseDigest };
      },
    });
  }

  /** Withdraws the active deployment only when its exact operator-owned base still matches. */
  async withdraw(input: {
    readonly ownerId: string;
    readonly installationId: string;
    readonly operationId: string;
    readonly currentDeploymentId: string;
    readonly currentReleaseDigest: string;
    readonly configurationRevision: string;
  }): Promise<void> {
    this.assertOwner(input.ownerId);
    if (!validOpaqueId(input.installationId) || !validOpaqueId(input.operationId)
      || !validOpaqueId(input.currentDeploymentId) || !SHA256.test(input.currentReleaseDigest)
      || !validConfigurationRevision(input.configurationRevision)) {
      throw new PluginRouteControllerError('failed');
    }
    const fingerprint = digest({ kind: 'withdraw', ...input });
    await this.commitOperation({
      installationId: input.installationId,
      operationId: input.operationId,
      fingerprint,
      apply: state => {
        if (state.configurationRevision !== input.configurationRevision
          || state.active?.deploymentId !== input.currentDeploymentId
          || state.active.releaseDigest !== input.currentReleaseDigest) return undefined;
        return null;
      },
    });
  }

  private async commitOperation(input: {
    readonly installationId: string;
    readonly operationId: string;
    readonly fingerprint: string;
    /** undefined preserves the route and records rejection; null commits a withdrawn route. */
    readonly apply: (state: RouteState) => RouteTarget | null | undefined;
  }): Promise<void> {
    const key = this.key(input.installationId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { revision, state } = await this.readState(input.installationId);
      const prior = state.operations[input.operationId];
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) throw new PluginRouteControllerError('failed');
        if (prior.outcome === 'committed') return;
        throw new PluginRouteControllerError('failed');
      }
      if (Object.keys(state.operations).length >= MAX_PLUGIN_ROUTE_OPERATIONS_PER_INSTALLATION) {
        // Never prune terminal operation fences. Once full, route mutations
        // remain disabled until the operator rotates the route scope.
        throw new PluginRouteControllerError('failed');
      }
      let active: RouteTarget | null;
      let outcome: 'committed' | 'not-committed';
      try {
        const target = input.apply(state);
        active = target === undefined ? state.active : target;
        outcome = target === undefined ? 'not-committed' : 'committed';
      } catch {
        throw new PluginRouteControllerError('failed');
      }
      const routeRevision = outcome === 'committed' ? state.routeRevision + 1 : state.routeRevision;
      const next: RouteState = {
        ...state,
        routeRevision,
        active,
        operations: {
          ...state.operations,
          [input.operationId]: { fingerprint: input.fingerprint, outcome, routeRevision },
        },
      };
      try {
        if (await this.options.store.compareAndSet(key, revision, next)) {
          if (outcome === 'not-committed') throw new PluginRouteControllerError('failed');
          return;
        }
      } catch (error) {
        if (error instanceof PluginRouteControllerError) throw error;
        throw new PluginRouteControllerError('unknown');
      }
    }
    throw new PluginRouteControllerError('unknown');
  }
}
