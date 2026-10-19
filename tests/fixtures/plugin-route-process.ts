import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { PostgresJsonStore } from '../../packages/state/src/index.js';
import { PluginRouteController, PluginRouteControllerError } from '../../apps/api/src/plugin-route-controller.js';

type ActivateInput = Parameters<PluginRouteController['activate']>[0];
type RollbackInput = Parameters<PluginRouteController['rollback']>[0];
type ConfigurationInput = Parameters<PluginRouteController['updateConfigurationRevision']>[0];

type ParentCommand =
  | { readonly kind: 'connect'; readonly databaseUrl: string; readonly namespace: string; readonly scope: string; readonly ownerId: string }
  | { readonly kind: 'initialize-installation'; readonly installationId: string; readonly configurationRevision: string }
  | { readonly kind: 'activate'; readonly input: ActivateInput }
  | { readonly kind: 'activate-and-exit'; readonly input: ActivateInput }
  | { readonly kind: 'rollback'; readonly input: RollbackInput }
  | { readonly kind: 'update-configuration'; readonly input: ConfigurationInput }
  | { readonly kind: 'inspect'; readonly installationId: string; readonly operationIds: readonly string[] }
  | { readonly kind: 'shutdown' };

interface ChildReply {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: 'invalid-command' | 'connect-failed' | 'command-failed';
}

let store: PostgresJsonStore | undefined;
let controller: PluginRouteController | undefined;
let ownerId: string | undefined;
let commandQueue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertLiteralLoopbackDatabaseUrl(value: string): void {
  if (value.length > 2_048) throw new TypeError('The PostgreSQL test URL is too long.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('The PostgreSQL test URL is invalid.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  const addressFamily = isIP(hostname);
  const loopback = addressFamily === 4 ? hostname.startsWith('127.') : addressFamily === 6 && hostname === '::1';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !loopback || !parsed.port || parsed.search || parsed.hash || parsed.pathname.length < 2) {
    throw new TypeError('The PostgreSQL test URL must use a literal loopback address, a database path, and no query or fragment.');
  }
}

function requireController(): PluginRouteController {
  if (!controller) throw new Error('The child route controller is not connected.');
  return controller;
}

async function mutation(operation: Promise<void>): Promise<{ status: 'resolved' } | { status: 'rejected'; outcome: string }> {
  try {
    await operation;
    return { status: 'resolved' };
  } catch (error) {
    return {
      status: 'rejected',
      outcome: error instanceof PluginRouteControllerError ? error.outcome : 'unexpected',
    };
  }
}

function send(reply: ChildReply, disconnect = false): void {
  if (typeof process.send !== 'function') return;
  process.send(reply, () => {
    if (disconnect && process.connected) process.disconnect();
  });
}

async function handleMessage(value: unknown): Promise<void> {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId.length > 128 || !isRecord(value.command)) return;
  const { requestId } = value;
  const command = value.command;
  if (typeof command.kind !== 'string' || ![
    'connect', 'initialize-installation', 'activate', 'activate-and-exit', 'rollback', 'update-configuration', 'inspect', 'shutdown',
  ].includes(command.kind)) {
    send({ requestId, ok: false, error: 'invalid-command' });
    return;
  }

  try {
    switch (command.kind as ParentCommand['kind']) {
      case 'connect': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'connect' }>;
        assertLiteralLoopbackDatabaseUrl(input.databaseUrl);
        if (store || controller) throw new Error('The child route controller is already connected.');
        const nextStore = new PostgresJsonStore(input.namespace, {
          poolConfig: {
            connectionString: input.databaseUrl,
            max: 1,
            connectionTimeoutMillis: 5_000,
            idleTimeoutMillis: 1_000,
          },
        });
        try {
          await nextStore.initialize();
        } catch {
          await nextStore.close();
          throw new Error('The child route store could not initialize.');
        }
        store = nextStore;
        ownerId = input.ownerId;
        controller = new PluginRouteController({ store, scope: input.scope, ownerId });
        send({ requestId, ok: true, result: { connected: true } });
        return;
      }
      case 'initialize-installation': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'initialize-installation' }>;
        const result = await requireController().initializeInstallation(input);
        send({ requestId, ok: true, result });
        return;
      }
      case 'activate': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'activate' }>;
        send({ requestId, ok: true, result: await mutation(requireController().activate(input.input)) });
        return;
      }
      case 'activate-and-exit': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'activate-and-exit' }>;
        await requireController().activate(input.input);
        await store?.close();
        if (process.connected) process.disconnect();
        return;
      }
      case 'rollback': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'rollback' }>;
        send({ requestId, ok: true, result: await mutation(requireController().rollback(input.input)) });
        return;
      }
      case 'update-configuration': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'update-configuration' }>;
        send({ requestId, ok: true, result: await requireController().updateConfigurationRevision(input.input) });
        return;
      }
      case 'inspect': {
        const input = command as unknown as Extract<ParentCommand, { kind: 'inspect' }>;
        const currentOwner = ownerId;
        if (!currentOwner || !Array.isArray(input.operationIds) || input.operationIds.length > 32 ||
            !input.operationIds.every(id => typeof id === 'string' && id.length <= 128)) {
          throw new Error('The inspection request is invalid.');
        }
        const target = requireController();
        const activeRoute = await target.readActiveRoute({ ownerId: currentOwner, installationId: input.installationId });
        const snapshot = await target.read({ ownerId: currentOwner, installationId: input.installationId });
        const operationIds = input.operationIds as readonly string[];
        const operations: Record<string, string> = {};
        for (const operationId of operationIds) {
          operations[operationId] = await target.readOperationStatus({ ownerId: currentOwner, installationId: input.installationId, operationId });
        }
        send({ requestId, ok: true, result: { activeRoute, snapshot, operations } });
        return;
      }
      case 'shutdown': {
        await store?.close();
        send({ requestId, ok: true, result: { closed: true } }, true);
        return;
      }
    }
  } catch {
    send({ requestId, ok: false, error: command.kind === 'connect' ? 'connect-failed' : 'command-failed' });
  }
}

process.on('message', message => {
  commandQueue = commandQueue.then(() => handleMessage(message)).catch(() => undefined);
});

if (typeof process.send === 'function') {
  process.send({ kind: 'ready', bootId: randomUUID(), pid: process.pid });
} else {
  process.exitCode = 1;
}
