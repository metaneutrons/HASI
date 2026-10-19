import { randomUUID } from 'node:crypto';
import { PostgresJsonStore } from '@hasi/state';
import { z } from 'zod';
import { createDockerPluginDriver } from '../apps/api/src/docker-plugin-driver.js';
import { PluginRouteController } from '../apps/api/src/plugin-route-controller.js';
import { createPluginDeploymentGateway, type PluginDeploymentGateway } from '../apps/api/src/plugin-deployment-proxy.js';
import { assertNoPostgresEnvironment, qualificationDatabase } from './plugin-gateway-qualification-config.js';

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const configSchema = z.strictObject({
  databaseUrl: z.string().max(2048), namespace: opaque, ownerId: opaque, installationId: opaque,
  socketPath: z.string().regex(/^\/[A-Za-z0-9/._-]+$/u).max(1024),
  internalNetworks: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u)).min(1).max(8),
  relayNetwork: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  serviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

let gateway: PluginDeploymentGateway | undefined;
let store: PostgresJsonStore | undefined;
let stopping = false;
const isStopping = () => stopping;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await gateway?.close(); } finally { await store?.close(); }
}
process.once('SIGTERM', () => { void stop().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); });
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 16384) { process.stdin.destroy(); process.exitCode = 1; }
});
process.stdin.once('end', () => {
  void (async () => {
    if (process.env.HASI_DOCKER_QUALIFY !== '1' || stopping) throw new Error('worker_not_explicitly_enabled');
    assertNoPostgresEnvironment();
    const config = configSchema.parse(JSON.parse(input) as unknown);
    input = '';
    store = new PostgresJsonStore(config.namespace, { poolConfig: qualificationDatabase(config.databaseUrl) });
    await store.initialize();
    const routes = new PluginRouteController({ store, scope: config.namespace, ownerId: config.ownerId });
    const driver = createDockerPluginDriver({
      enabled: true, deploymentTarget: 'operator-local', socketPath: config.socketPath, ownerId: config.ownerId,
      allowedInternalNetworks: config.internalNetworks, relayNetwork: config.relayNetwork, routing: routes,
      resolveSecret: () => undefined, healthPath: '/healthz', requestTimeoutMs: 5000,
    });
    gateway = await createPluginDeploymentGateway({
      port: 0, endpointResolver: driver,
      authorize: value => value.installationId === config.installationId && value.authorization === `Bearer ${config.serviceToken}`,
    });
    if (isStopping()) { await gateway.close(); await store.close(); return; }
    process.stdout.write(`${JSON.stringify({ event: 'ready', bootId: randomUUID(), pid: process.pid, origin: gateway.origin })}\n`);
  })().catch(async () => {
    process.stderr.write('gateway_worker_failed\n');
    await stop().catch(() => undefined);
    process.exitCode = 1;
  });
});
