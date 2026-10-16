import { createPublicKey } from 'node:crypto';
import { createKnowledgePlugin } from './index.js';

const publicKey = process.env.HASI_PUBLIC_KEY;
const serviceToken = process.env.HASI_KNOWLEDGE_TOKEN;
if (process.env.HASI_MODE !== 'development' || !publicKey || !serviceToken) {
  throw new Error('Explicit prototype environment is required.');
}

const app = createKnowledgePlugin({ publicKey: createPublicKey(publicKey), serviceToken });
await app.listen({ port: 4103, host: '127.0.0.1' });
console.log('knowledge plugin ready at http://127.0.0.1:4103/mcp');
