import { MemoryJsonStore } from '@hasi/state';
import { describe, expect, it } from 'vitest';
import { PluginDeploymentBinding, PluginDeploymentBindingError } from '../apps/api/src/plugin-deployment-binding.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';

const OWNER = 'operator-binding';
const INSTALLATION = 'installation-binding';

function setup(initialRevision = 1) {
  const store = new MemoryJsonStore(`plugin-binding-${String(Math.random())}`);
  const routes = new PluginRouteController({ store, scope: 'operator-scope', ownerId: OWNER });
  let authoritativeRevision = initialRevision;
  const binding = new PluginDeploymentBinding({
    routes,
    ownerId: OWNER,
    readAuthoritativeRevision: () => Promise.resolve(authoritativeRevision),
  });
  return { routes, binding, setRevision: (revision: number) => { authoritativeRevision = revision; } };
}

describe('plugin deployment configuration binding', () => {
  it('converges the route to the authoritative active revision through CAS', async () => {
    const { routes, binding, setRevision } = setup(1);
    await routes.initializeInstallation({ installationId: INSTALLATION, configurationRevision: '1' });
    setRevision(2);

    const snapshot = await binding.configurationActivated(INSTALLATION, 2);
    expect(snapshot.configurationRevision).toBe('2');
    await expect(binding.assertCurrent(INSTALLATION, 2)).resolves.toBeUndefined();
  });

  it('converges a delayed callback to current settings rather than an older activation', async () => {
    const { routes, binding, setRevision } = setup(1);
    await routes.initializeInstallation({ installationId: INSTALLATION, configurationRevision: '1' });
    setRevision(3);

    const snapshot = await binding.configurationActivated(INSTALLATION, 2);
    expect(snapshot.configurationRevision).toBe('3');
    await expect(binding.assertCurrent(INSTALLATION, 3)).resolves.toBeUndefined();
    await expect(binding.assertCurrent(INSTALLATION, 2)).rejects.toBeInstanceOf(PluginDeploymentBindingError);
  });

  it('fails closed when route state is absent or a settings revision changes during the check', async () => {
    const missing = setup(1);
    await expect(missing.binding.assertCurrent(INSTALLATION, 1)).rejects.toBeInstanceOf(PluginDeploymentBindingError);

    const store = new MemoryJsonStore(`plugin-binding-race-${String(Math.random())}`);
    const routes = new PluginRouteController({ store, scope: 'operator-scope', ownerId: OWNER });
    await routes.initializeInstallation({ installationId: INSTALLATION, configurationRevision: '1' });
    let reads = 0;
    const racing = new PluginDeploymentBinding({
      routes,
      ownerId: OWNER,
      readAuthoritativeRevision: () => Promise.resolve(++reads === 1 ? 1 : 2),
    });
    await expect(racing.assertCurrent(INSTALLATION, 1)).rejects.toBeInstanceOf(PluginDeploymentBindingError);
  });

  it('rejects invalid and unavailable authoritative revisions', async () => {
    const routes = new PluginRouteController({
      store: new MemoryJsonStore(`plugin-binding-invalid-${String(Math.random())}`),
      scope: 'operator-scope',
      ownerId: OWNER,
    });
    const invalid = new PluginDeploymentBinding({ routes, ownerId: OWNER, readAuthoritativeRevision: () => Promise.resolve(-1) });
    await expect(invalid.configurationActivated(INSTALLATION, 1)).rejects.toBeInstanceOf(PluginDeploymentBindingError);

    const unavailable = new PluginDeploymentBinding({
      routes,
      ownerId: OWNER,
      readAuthoritativeRevision: () => Promise.reject(new Error('store unavailable')),
    });
    await expect(unavailable.assertCurrent(INSTALLATION, 1)).rejects.toBeInstanceOf(PluginDeploymentBindingError);
  });
});
