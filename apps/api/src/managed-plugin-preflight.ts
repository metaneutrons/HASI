import { request } from 'node:http';
import { digest, manifestSchema, managedStateValidator, type PluginManifest } from '@hasi/plugin-sdk';
import type { DockerPluginDriver } from './docker-plugin-driver.js';
import type { ManagedPluginInstallerOptions } from './managed-plugin-installer.js';

/** No caller-controlled URL, port, redirect, proxy, cookie, HTML or unbounded
 * response. Secret custody supplies the service credential only for this call.
 */
export function createManagedPluginPreflight(options: {
  driver: Pick<DockerPluginDriver, 'resolveCandidateEndpoint'>;
  useServiceCredential: <T>(id: string, operation: (credential: string) => Promise<T>) => Promise<T>;
}): ManagedPluginInstallerOptions['preflight'] {
  return async input => {
    if (!input.snapshot.candidate?.stagingOperationId || !input.snapshot.candidate.staged
      || input.snapshot.candidate.releaseDigest !== input.release.releaseDigest) return false;
    const pin = { installationId: input.installationId, operationId: input.snapshot.candidate.stagingOperationId,
      imageDigest: input.release.imageDigest, releaseDigest: input.release.releaseDigest, configurationRevision: input.snapshot.configurationRevision };
    try {
      const endpoint = await options.driver.resolveCandidateEndpoint(pin);
      if (endpoint?.host !== '127.0.0.1') return false;
      const received = await options.useServiceCredential(input.installationId, credential => fetchManifest(endpoint.port, credential));
      const manifest = manifestSchema.parse(received);
      if (manifest.manifestVersion === 2 && manifest.managedState) managedStateValidator(manifest.managedState.applicationSchema);
      if (!sameManifest(manifest, input.manifest) || digest(manifest) !== input.release.manifestDigest) return false;
      // Inspect again after I/O; a switched/restarted/active/foreign pair does
      // not inherit the preflight result from the previous endpoint.
      const after = await options.driver.resolveCandidateEndpoint(pin);
      return after !== null && digest(after) === digest(endpoint);
    } catch { return false; }
  };
}
function sameManifest(a: PluginManifest, b: PluginManifest) { return digest(a) === digest(b); }

function fetchManifest(port: number, credential: string): Promise<unknown> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !credential || /[\r\n\0]/u.test(credential)) return Promise.reject(new Error('invalid preflight'));
  return new Promise((resolve, reject) => {
    const outbound = request({ hostname: '127.0.0.1', port, path: '/.well-known/hasi-plugin.json', method: 'GET', agent: false,
      headers: { authorization: `Bearer ${credential}`, accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.toLowerCase().startsWith('application/json')) { response.destroy(); reject(new Error('invalid manifest response')); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) { response.destroy(new Error('manifest too large')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); } catch { reject(new Error('invalid manifest JSON')); } });
    });
    const timer = setTimeout(() => { outbound.destroy(new Error('manifest timeout')); }, 5000);
    outbound.once('close', () => { clearTimeout(timer); });
    outbound.once('error', reject);
    outbound.end();
  });
}
