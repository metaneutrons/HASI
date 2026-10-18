import { createPublicKey, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
let actionCount = 0;
const journalRecords = new Map();
const executionStore = {
  async read(key) {
    const record = journalRecords.get(key);
    return record ? structuredClone(record) : undefined;
  },
  async compareAndSet(key, revision, value) {
    const current = journalRecords.get(key);
    if ((revision === null && current !== undefined) || (revision !== null && current?.revision !== revision)) return false;
    journalRecords.set(key, { revision: randomUUID(), value: structuredClone(value) });
    return true;
  },
};
const server = createPluginServer({
  executionJournal: new ExecutionJournal(executionStore, 'local-reference-test'),
  manifest,
  publicKey: createPublicKey(publicKeyPem),
  serviceToken,
  handlers: {
    read_status: (_arguments, actor, context) => Promise.resolve({
      label: context?.configuration.label,
      account: typeof actor.claims?.['reference.account'] === 'string' ? actor.claims['reference.account'] : 'unscoped',
      version: manifest.version,
      actionCount,
    }),
    prepare_mark: (_arguments, _actor, context) => {
      const label = context?.configuration.label;
      if (typeof label !== 'string') throw new Error('The public label is not configured.');
      return Promise.resolve({ draft: { executionTool: 'execute_mark', arguments: { label }, resourceName: label } });
    },
    execute_mark: (arguments_, actor) => {
      actionCount += 1;
      return Promise.resolve({
        confirmed: true,
        actionCount,
        label: arguments_.label,
        account: typeof actor.claims?.['reference.account'] === 'string' ? actor.claims['reference.account'] : 'unscoped',
      });
    },
  },
});
server.get('/healthz', async () => ({ status: 'ok' }));

process.once('SIGTERM', () => {
  void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
await server.listen({ host: process.env.HASI_REFERENCE_PLUGIN_HOST ?? '0.0.0.0', port });
