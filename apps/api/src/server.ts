import { createPrivateKey } from 'node:crypto';
import { MemoryJsonStore } from '@hasi/state';
import { hshDemoCatalog } from '@hasi/demo-fixtures/catalog';
import { createApi, PluginRegistry, MockIdentityProvider, OidcIdentityProvider, startTestIdp, personas, withDemoPluginClaims } from './index.js';

const mode = process.env.HASI_MODE;
if (mode !== 'development') throw new Error('Prototype server requires explicit HASI_MODE=development.');
const key = process.env.HASI_PRIVATE_KEY;
const token = process.env.HASI_PLUGIN_TOKEN;
const expectedManifestDigest = process.env.HASI_PLUGIN_DIGEST;
if (!key || !token || !expectedManifestDigest) throw new Error('Prototype plugin trust configuration is missing.');
const reviewedAppDigests: string[] = [];
if (process.env.HASI_PLUGIN_APPS === '1') {
  const reviewedDigest = process.env.HASI_REVIEWED_APP_DIGEST;
  if (!reviewedDigest || !/^[a-f0-9]{64}$/.test(reviewedDigest)) throw new Error('Plugin App mode requires an operator-reviewed resource digest.');
  reviewedAppDigests.push(reviewedDigest);
}
const registry = new PluginRegistry(createPrivateKey(key), { reviewedAppDigests });
await registry.install({ endpoint: process.env.HASI_PLUGIN_URL ?? 'http://127.0.0.1:4101/mcp', serviceToken: token, expectedManifestDigest, allowLoopback: true });
if (process.env.HASI_KNOWLEDGE_TOKEN && process.env.HASI_KNOWLEDGE_DIGEST) await registry.install({ endpoint: 'http://127.0.0.1:4103/mcp', serviceToken: process.env.HASI_KNOWLEDGE_TOKEN, expectedManifestDigest: process.env.HASI_KNOWLEDGE_DIGEST, allowLoopback: true });
const store = new MemoryJsonStore('test-oidc');
const oidcTest = process.env.HASI_TEST_IDP === '1';
const webOrigin = process.env.HASI_WEB_ORIGIN ?? 'http://127.0.0.1:3001';
const testIdp = oidcTest ? await startTestIdp({ mode: 'test', clientId: 'hasi-local-test', redirectUri: `${webOrigin}/api/auth/callback`, subject: 'synthetic-admin' }) : undefined;
const identity = testIdp ? new OidcIdentityProvider({ mode: 'test', issuer: testIdp.issuer, clientId: testIdp.clientId, redirectUri: testIdp.redirectUri, store, mapIdentity: ({ subject }) => {
  if (subject !== 'synthetic-admin') throw new Error('Unknown test identity.');
  const template = personas.find(persona => persona.id === 'admin');
  if (!template) throw new Error('Test administrator missing.');
  const user = structuredClone(template);
  user.id = 'oidc-test-admin'; user.displayName = 'Test-IdP · Administration';
  user.actor.resourceIds = hshDemoCatalog.resources.map(resource => resource.id);
  user.actor = withDemoPluginClaims(user.actor);
  return user;
} }) : new MockIdentityProvider(mode, hshDemoCatalog.resources.map(resource => resource.id));
const app = await createApi({ mode, registry, identity, store, ...(process.env.HASI_WEB_ORIGIN ? { origin: process.env.HASI_WEB_ORIGIN } : {}) });
if (testIdp) app.addHook('onClose', async () => { await testIdp.close(); });
await app.listen({ port: 4100, host: '127.0.0.1' });
console.log('HASI API ready at http://127.0.0.1:4100');
