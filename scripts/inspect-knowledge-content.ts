import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentAdapterRegistry, contentReviewDigest } from '@hasi/knowledge-plugin';
import { createContentHttpClient, EnvironmentPluginSecretCustody } from '../apps/api/src/index.js';
import { knowledgeRuntimeConfiguration } from './knowledge-runtime-config.js';

// Operator-only read/review workflow: no database, signing operation, embedding or model call.
try {
  const path = process.env.HASI_KNOWLEDGE_CONFIG;
  const sourceId = process.env.HASI_KNOWLEDGE_REVIEW_SOURCE;
  const output = process.env.HASI_KNOWLEDGE_REVIEW_OUTPUT;
  if (!path || !sourceId || !output) throw new Error('Missing configuration.');
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  const location = relative(repository, destination);
  if (location === '' || (location !== '..' && !location.startsWith(`..${sep}`))) throw new Error('Private review files must be outside the repository.');
  const file = await readFile(path, 'utf8');
  if (Buffer.byteLength(file) > 65_536) throw new Error('Configuration is too large.');
  const configuration = knowledgeRuntimeConfiguration.parse(JSON.parse(file) as unknown);
  const source = configuration.sources.find(candidate => candidate.sourceSystem === sourceId);
  if (source?.input.type !== 'content_adapters') throw new Error('Source is not configured for adapters.');
  const input = source.input;
  const custody = new EnvironmentPluginSecretCustody(configuration.credentialSlots, process.env);
  if (input.credential && !custody.status(input.credential.slot).configured) throw new Error('Source credential unavailable.');
  const origin = new URL(source.origin).origin;
  const transport = createContentHttpClient({ origin, pageUrls: input.policy.pages.map(page => page.url),
    apiUrls: input.adapters.flatMap(adapter => adapter.type === 'mediawiki' ? [adapter.apiUrl] : []), minIntervalMs: input.minIntervalMs,
    ...(source.allowedPrivateCidrs ? { allowedPrivateCidrs: source.allowedPrivateCidrs } : {}),
    ...(input.credential ? { credential: { custody, ...input.credential } } : {}) });
  const controller = new AbortController();
  const abort = () => { controller.abort(); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timeout = setTimeout(abort, configuration.ingestionTimeoutMs);
  try {
    const adapter = new ContentAdapterRegistry().create(input.adapters, { origin, transport });
    const pages = [];
    let bytes = 0;
    for (const page of input.policy.pages) {
      if (controller.signal.aborted) throw new Error('Review interrupted.');
      const content = await adapter.read({ url: page.url, ...(page.title ? { title: page.title } : {}) }, controller.signal);
      const reviewedImages = page.reviews?.[content.adapter]?.images ?? [];
      const record = { id: page.id,
        contentReviewDigest: contentReviewDigest(content, page, source.policyRevision, reviewedImages),
        content, reviewedImages };
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (bytes > 16 * 1024 * 1024) throw new Error('Review exceeds the output bound.');
      pages.push(record);
    }
    if (controller.signal.aborted) throw new Error('Review interrupted.');
    const serialized = JSON.stringify({ version: 1, sourceSystem: source.sourceSystem, pages }, null, 2);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Review exceeds the output bound.');
    await writeFile(destination, serialized, { flag: 'wx', mode: 0o600 });
    console.log(`Private content review written (${String(pages.length)} pages). No embedding or model request made.`);
  } finally {
    clearTimeout(timeout); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    controller.abort(); await transport.close();
  }
} catch {
  // Neither provider errors nor filesystem errors may echo private content, URLs or credentials.
  console.error('Content review failed. Check operator configuration, source access and a new private output path outside the repository.');
  process.exitCode = 1;
}
