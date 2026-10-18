import type { PluginRouteController, PluginRouteSnapshot } from './plugin-route-controller.js';

const MAX_SYNC_ATTEMPTS = 16;

export type ActiveConfigurationRevisionReader = (installationId: string) => Promise<number>;

export interface PluginDeploymentBindingOptions {
  /** Shared durable route authority used by the deployment driver. */
  readonly routes: Pick<PluginRouteController, 'read' | 'updateConfigurationRevision'>;
  /** Operator identity accepted by the route controller. */
  readonly ownerId: string;
  /** Must read the active revision from the authoritative settings store. */
  readonly readAuthoritativeRevision: ActiveConfigurationRevisionReader;
}

/** Fail-closed configuration/route disagreement or unavailable authority. */
export class PluginDeploymentBindingError extends Error {
  readonly status = 409;
  readonly code = 'PLUGIN_ROUTE_OUT_OF_SYNC';

  constructor(message = 'Plugin deployment routing is not synchronized with active configuration.') {
    super(message);
    this.name = 'PluginDeploymentBindingError';
  }
}

function parseRevision(revision: unknown): number {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new PluginDeploymentBindingError('The active plugin configuration revision is invalid.');
  }
  return revision;
}

function configurationRevision(revision: number): string {
  return String(parseRevision(revision));
}

/**
 * Bridges signed plugin settings to the independent deployment route store.
 * Settings remain authoritative; route state is converged only from a trusted
 * post-activation callback and every plugin invocation can verify both copies.
 */
export class PluginDeploymentBinding {
  constructor(private readonly options: PluginDeploymentBindingOptions) {
    if (!options.ownerId.trim() || options.ownerId.length > 128) {
      throw new TypeError('Plugin deployment binding requires an operator identity.');
    }
  }

  private async activeRevision(installationId: string): Promise<number> {
    try {
      return parseRevision(await this.options.readAuthoritativeRevision(installationId));
    } catch (error) {
      if (error instanceof PluginDeploymentBindingError) throw error;
      throw new PluginDeploymentBindingError('The active plugin configuration revision could not be read.');
    }
  }

  private async route(installationId: string): Promise<PluginRouteSnapshot> {
    try {
      return await this.options.routes.read({ ownerId: this.options.ownerId, installationId });
    } catch {
      throw new PluginDeploymentBindingError('The authoritative plugin route could not be read.');
    }
  }

  /**
   * Call immediately after the settings store commits activation. The callback
   * revision is checked against authoritative state, then route state converges
   * to the latest authoritative revision using the route controller's CAS.
   */
  async configurationActivated(installationId: string, activatedRevision: number): Promise<PluginRouteSnapshot> {
    const callbackRevision = parseRevision(activatedRevision);
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
      const authoritativeRevision = await this.activeRevision(installationId);
      if (authoritativeRevision < callbackRevision) {
        throw new PluginDeploymentBindingError('The settings activation callback is ahead of authoritative configuration.');
      }
      const targetRevision = configurationRevision(authoritativeRevision);
      const route = await this.route(installationId);
      if (route.configurationRevision === targetRevision) return route;

      try {
        await this.options.routes.updateConfigurationRevision({
          ownerId: this.options.ownerId,
          installationId,
          expectedRevision: route.configurationRevision,
          configurationRevision: targetRevision,
        });
      } catch {
        // A concurrent callback may have won the CAS. Re-read both authorities
        // before retrying; no stale route state is accepted as success.
        const latest = await this.route(installationId);
        const latestAuthoritativeRevision = await this.activeRevision(installationId);
        if (latest.configurationRevision === configurationRevision(latestAuthoritativeRevision)
          && latestAuthoritativeRevision >= callbackRevision) return latest;
        if (latest.configurationRevision === route.configurationRevision) {
          throw new PluginDeploymentBindingError();
        }
        continue;
      }

      const latest = await this.route(installationId);
      const latestAuthoritativeRevision = await this.activeRevision(installationId);
      if (latest.configurationRevision === configurationRevision(latestAuthoritativeRevision)
        && latestAuthoritativeRevision >= callbackRevision) return latest;
    }
    throw new PluginDeploymentBindingError('Plugin configuration changed repeatedly while routing was being synchronized.');
  }

  /**
   * Deployment and invocation gates use this check before any plugin call. It
   * reads settings on both sides of the route read to reject an observed race.
   */
  async assertCurrent(installationId: string, expectedRevision: number): Promise<void> {
    const expected = configurationRevision(expectedRevision);
    const before = await this.activeRevision(installationId);
    const route = await this.route(installationId);
    const after = await this.activeRevision(installationId);
    if (before !== after || String(before) !== expected || route.configurationRevision !== expected) {
      throw new PluginDeploymentBindingError();
    }
  }
}
