import { createPrivateKey } from 'node:crypto';
import { hshDemoCatalog } from '@hasi/demo-fixtures/catalog';
import { createApi, PluginRegistry, MockIdentityProvider } from './index.js';

const mode = process.env.HASI_MODE;
if (mode !== 'development') throw new Error('Prototype server requires explicit HASI_MODE=development.');
const key = process.env.HASI_PRIVATE_KEY;
const token = process.env.HASI_PLUGIN_TOKEN;
const expectedManifestDigest = process.env.HASI_PLUGIN_DIGEST;
if (!key || !token || !expectedManifestDigest) throw new Error('Prototype plugin trust configuration is missing.');
const registry = new PluginRegistry(createPrivateKey(key));
await registry.install({ endpoint: process.env.HASI_PLUGIN_URL ?? 'http://127.0.0.1:4101/mcp', serviceToken: token, expectedManifestDigest, allowLoopback: true });
if (process.env.HASI_KNOWLEDGE_TOKEN && process.env.HASI_KNOWLEDGE_DIGEST) await registry.install({ endpoint: 'http://127.0.0.1:4103/mcp', serviceToken: process.env.HASI_KNOWLEDGE_TOKEN, expectedManifestDigest: process.env.HASI_KNOWLEDGE_DIGEST, allowLoopback: true });
const app = await createApi({ mode, registry, identity: new MockIdentityProvider(mode, hshDemoCatalog.resources.map(resource => resource.id)), ...(process.env.HASI_WEB_ORIGIN ? { origin: process.env.HASI_WEB_ORIGIN } : {}) });
await app.listen({ port: 4100, host: '127.0.0.1' });
console.log('HASI API ready at http://127.0.0.1:4100');
