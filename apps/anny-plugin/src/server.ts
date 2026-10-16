import { createPublicKey } from 'node:crypto';
import { AnnyClient } from '@hasi/anny-client';
import { createAnnyPlugin, demoPresentation } from './index.js';

const key = process.env.HASI_PUBLIC_KEY;
const serviceToken = process.env.HASI_PLUGIN_TOKEN;
const token = process.env.ANNY_MOCK_TOKEN;
if (process.env.HASI_MODE !== 'development' || !key || !serviceToken || !token) throw new Error('Explicit prototype environment is required.');
const client = new AnnyClient({ baseUrl: 'http://127.0.0.1:4102', organizationId: '00000000-0000-4000-8000-000000000001', token, allowLoopback: true, allowWrites: true });
const app = createAnnyPlugin({ client, publicKey: createPublicKey(key), serviceToken, presentation: demoPresentation });
await app.listen({ port: 4101, host: '127.0.0.1' });
console.log('anny plugin ready at http://127.0.0.1:4101/mcp');
