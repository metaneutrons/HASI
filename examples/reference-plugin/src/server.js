import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.HASI_REFERENCE_PLUGIN_TEST_MODE !== '1') {
  throw new Error('The reference plugin is available only in explicit local test mode.');
}

const serviceToken = process.env.HASI_REFERENCE_PLUGIN_TOKEN;
const publicKeyPem = process.env.HASI_REFERENCE_PLUGIN_PUBLIC_KEY;
const port = Number(process.env.HASI_REFERENCE_PLUGIN_PORT);
const sdkBuildPath = process.env.HASI_REFERENCE_PLUGIN_SDK_BUILD;
if (!serviceToken || !publicKeyPem || !sdkBuildPath || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('The reference plugin local test configuration is incomplete.');
}

const sdk = await import(pathToFileURL(resolve(sdkBuildPath)).href);
const { createPluginServer } = sdk;
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
let actionCount = 0;
const server = createPluginServer({
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

process.once('SIGTERM', () => {
  void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
await server.listen({ host: '127.0.0.1', port });
