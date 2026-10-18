import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { annyManifest, annyAppManifest } from '@hasi/anny-plugin';
import { knowledgeManifest } from '@hasi/knowledge-plugin';
import { digest } from '@hasi/plugin-sdk';

const children: ChildProcess[] = [];
const preview = process.argv.includes('--preview');
const testIdp = process.argv.includes('--test-idp');
const pluginApps = process.argv.includes('--plugin-apps');
let stopping = false;
const webPort = Number(process.env.HASI_WEB_PORT ?? '3001');
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535 || [4100, 4101, 4102, 4103].includes(webPort)) throw new Error('HASI_WEB_PORT must be a free unprivileged port, separate from the backend ports.');
const webOrigin = `http://127.0.0.1:${String(webPort)}`;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const baseEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
const start = (name: string, entry: string, env: Record<string, string>) => {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit', env: { ...baseEnv, ...env } });
  children.push(child);
  child.on('error', () => { console.error(`${name} could not start.`); process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} stopped (${String(code)}).`); process.exitCode = 1; stop(); } });
};
async function portFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => { reject(new Error(`Port ${String(port)} is occupied; stop the existing process or use another environment.`)); });
    probe.listen(port, '127.0.0.1', () => { probe.close(error => { if (error) reject(error); else resolve(); }); });
  });
}
async function ready(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping) throw new Error('Prototype startup interrupted.');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup is bounded below. */ }
    await delay(100);
  }
  throw new Error(`Service did not become ready: ${url}`);
}

try {
  for (const port of [webPort, 4100, 4101, 4102, 4103]) await portFree(port);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pluginToken = randomBytes(32).toString('base64url');
  const knowledgeToken = randomBytes(32).toString('base64url');
  const mockToken = randomBytes(32).toString('base64url');
  start('anny API mock', 'apps/anny-mock/src/server.ts', { HASI_MODE: 'development', ANNY_MOCK_TOKEN: mockToken });
  await ready('http://127.0.0.1:4102/health');
  start('anny plugin', 'apps/anny-plugin/src/server.ts', { HASI_MODE: 'development', HASI_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), HASI_PLUGIN_TOKEN: pluginToken, ANNY_MOCK_TOKEN: mockToken, ...(pluginApps ? { HASI_PLUGIN_APPS: '1' } : {}) });
  await ready('http://127.0.0.1:4101/health');
  start('knowledge plugin', 'apps/knowledge-plugin/src/server.ts', { HASI_MODE: 'development', HASI_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), HASI_KNOWLEDGE_TOKEN: knowledgeToken });
  await ready('http://127.0.0.1:4103/health');
  start('HASI API', 'apps/api/src/server.ts', { HASI_MODE: 'development', HASI_WEB_ORIGIN: webOrigin, HASI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), HASI_PLUGIN_TOKEN: pluginToken, HASI_PLUGIN_DIGEST: digest(pluginApps ? annyAppManifest : annyManifest), HASI_KNOWLEDGE_TOKEN: knowledgeToken, HASI_KNOWLEDGE_DIGEST: digest(knowledgeManifest), ...(testIdp ? { HASI_TEST_IDP: '1' } : {}), ...(pluginApps ? { HASI_PLUGIN_APPS: '1' } : {}) });
  await ready('http://127.0.0.1:4100/api/session');
  const web = spawn('pnpm', ['--filter', '@hasi/web', preview ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)], { stdio: 'inherit', env: { ...baseEnv, NODE_ENV: preview ? 'production' : 'development', ...(pluginApps ? { NEXT_PUBLIC_HASI_PLUGIN_APPS: '1' } : {}) } });
  children.push(web);
  web.on('exit', () => { if (!stopping) { process.exitCode = 1; stop(); } });
  web.on('error', () => { console.error('Web UI could not start.'); process.exitCode = 1; stop(); });
  console.log(`HASI local prototype: ${webOrigin} — synthetic identities and booking data only.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Prototype startup failed.');
  process.exitCode = 1;
  stop();
}
