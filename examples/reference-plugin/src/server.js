import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReferenceState } from './state.js';

if (process.env.HASI_REFERENCE_PLUGIN_TEST_MODE !== '1') {
  throw new Error('The reference plugin is available only in explicit local test mode.');
}

const serviceToken = process.env.HASI_REFERENCE_PLUGIN_TOKEN;
const publicKeyPem = process.env.HASI_REFERENCE_PLUGIN_PUBLIC_KEY;
const port = Number(process.env.HASI_REFERENCE_PLUGIN_PORT);
if (!serviceToken || !publicKeyPem || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('The reference plugin local test configuration is incomplete.');
}

// The package script places the complete SDK runtime tree beside this source.
// The plugin can therefore start from its distributed directory without a
// checkout, workspace alias, package install or host SDK path.
const sdk = await import(new URL('../vendor/plugin-sdk/dist/index.js', import.meta.url).href);
const { createPluginServer, ExecutionJournal } = sdk;
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const installationId = process.env.HASI_PLUGIN_INSTALLATION_ID ?? manifest.id;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(installationId)) {
  throw new Error('The reference plugin installation binding is invalid.');
}
const state = createReferenceState(process.env.HASI_REFERENCE_STATE_FILE ?? ':memory:');
let sourceUnavailable = false;
let loseNextExecutionAck = false;
let shuttingDown = false;
const server = createPluginServer({
  executionJournal: new ExecutionJournal(state.executionStore, 'local-reference-test'),
  consumeInvocation: (jti, expiresAt) => state.consumeInvocation(jti, expiresAt),
  reconcileExecution: async (binding, actor) => {
    if (sourceUnavailable) throw new Error('Reference source unavailable');
    return state.resolve(binding, actor);
  },
  manifest,
  acceptedInstallationIds: [installationId],
  publicKey: createPublicKey(publicKeyPem),
  serviceToken,
  handlers: {
    read_status: async (_arguments, actor, context) => ({
      label: context?.configuration.label,
      account: typeof actor.claims?.['reference.account'] === 'string' ? actor.claims['reference.account'] : 'unscoped',
      version: manifest.version,
      actionCount: await state.count(context?.installationId ?? installationId, actor),
    }),
    prepare_mark: (_arguments, _actor, context) => {
      const label = context?.configuration.label;
      if (typeof label !== 'string') throw new Error('The public label is not configured.');
      return Promise.resolve({ draft: { executionTool: 'execute_mark', arguments: { label }, resourceName: label } });
    },
    execute_mark: async (arguments_, actor, context) => {
      if (!context?.executionId) throw new Error('Missing execution context');
      if (sourceUnavailable) throw new Error('Reference source unavailable');
      const binding = {
        subject: actor.subject,
        installationId: context.installationId,
        executionId: context.executionId,
        tool: 'execute_mark',
        argsHash: sdk.digest(arguments_),
        configurationRevision: context.configurationRevision,
      };
      const result = await state.mark(binding, arguments_, actor);
      if (loseNextExecutionAck) {
        loseNextExecutionAck = false;
        throw new Error('Reference execution acknowledgement lost');
      }
      return result;
    },
  },
});
server.addHook('onClose', async () => state.close());
server.get('/healthz', async () => ({ status: 'ok' }));

const commandNames = new Set(['lose-next-execution-ack', 'source-unavailable', 'source-available', 'stats']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
process.on('message', (message) => {
  if (!process.connected || shuttingDown || typeof message !== 'object' || message === null || Array.isArray(message)) return;
  const keys = Object.keys(message).sort();
  if (keys.join(',') !== 'command,commandId,type' || message.type !== 'reference-command' ||
    typeof message.commandId !== 'string' || !uuidPattern.test(message.commandId) || !commandNames.has(message.command)) return;

  if (message.command === 'lose-next-execution-ack') loseNextExecutionAck = true;
  if (message.command === 'source-unavailable') sourceUnavailable = true;
  if (message.command === 'source-available') sourceUnavailable = false;
  const acknowledgement = {
    event: 'reference-command-applied',
    commandId: message.commandId,
    command: message.command,
    ...(message.command === 'stats' ? { stats: state.stats() } : {}),
  };
  if (process.connected) process.send?.(acknowledgement);
});

process.once('SIGTERM', () => {
  shuttingDown = true;
  void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }).finally(() => {
    if (process.connected) process.disconnect();
  });
});
await server.listen({ host: process.env.HASI_REFERENCE_PLUGIN_HOST ?? '0.0.0.0', port });
