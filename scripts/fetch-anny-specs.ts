import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const references = [
  { name: 'admin', sha256: '7c7fe9113259802381c6e7b9d6cb350cba6b2638d54b2630f7f2ea2b836bd1d7' },
  { name: 'customer', sha256: '0097bae66aa5fdb29232a81a6b7027f48bf0db8295dfdff4b00648489476b976' },
] as const;
const directory = new URL('../docs/research/anny/current/', import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

await mkdir(directory, { recursive: true });
for (const reference of references) {
  const file = new URL(`${reference.name}.openapi.json`, directory);
  let existing: Buffer | undefined;
  try { existing = await readFile(file); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (existing) {
    if (sha256(existing) !== reference.sha256) throw new Error(`Existing ${reference.name} OpenAPI reference does not match its pin; refusing to replace it.`);
    console.log(`${reference.name} OpenAPI reference verified.`);
    continue;
  }
  const response = await fetch(`https://docs.anny.co/developers/openapi/${reference.name}.openapi.json`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`Cannot download ${reference.name} OpenAPI reference.`);
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid reference download.');
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Reference download exceeds its size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== reference.sha256) throw new Error(`Upstream ${reference.name} OpenAPI changed. Review the API changes and update the pin explicitly.`);
  await writeFile(file, bytes, { flag: 'wx' });
  console.log(`${reference.name} OpenAPI reference downloaded and verified.`);
}
