import { digest } from '@hasi/plugin-sdk';
import { z } from 'zod';
import { extractContentHtml } from './html.js';
import { ContentAcquisitionError, approvedContentUrl, requireContentSuccess,
  type AcquiredContent, type ContentAdapter, type ContentPage, type ContentResponse, type ContentTransport } from './contracts.js';

const selector = z.strictObject({ kind: z.enum(['id', 'tag', 'class']), value: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u) });
export const contentAdapterConfigurationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('mediawiki'), apiUrl: z.url(), requireAuthenticated: z.boolean() }),
  z.strictObject({ type: z.literal('web'), container: selector.optional() }),
]);
export type ContentAdapterConfiguration = z.infer<typeof contentAdapterConfigurationSchema>;

const capabilitiesSchema = z.object({ paraminfo: z.object({ modules: z.array(z.object({
  path: z.string(), prefix: z.string(), parameters: z.array(z.object({ name: z.string() })).max(200),
})).max(10) }) });
const pageInfoSchema = z.object({ query: z.object({ pages: z.array(z.object({
  pageid: z.number().int().positive(), ns: z.number().int(), title: z.string().min(1).max(500),
  fullurl: z.url(), revisions: z.array(z.object({ revid: z.number().int().positive(), timestamp: z.iso.datetime() })).length(1),
})).length(1) }) });
const parseSchema = z.object({ parse: z.object({ title: z.string().min(1).max(500),
  pageid: z.number().int().positive(), revid: z.number().int().positive(), text: z.string().max(2 * 1024 * 1024),
  templates: z.array(z.object({ title: z.string().min(1).max(500) })).max(1000) }) });

function parseApi(response: ContentResponse, capabilityProbe = false): unknown {
  requireContentSuccess(response);
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/iu.test(response.contentType)) throw new ContentAcquisitionError('invalid_content');
  let value: unknown;
  try { value = JSON.parse(response.body) as unknown; } catch { throw new ContentAcquisitionError('invalid_content'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContentAcquisitionError('invalid_content');
  const record = value as Record<string, unknown>;
  if (record.error || record.errors) {
    const error = record.error;
    const code = error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).code : undefined;
    if (typeof code === 'string' && /^(?:assert|readapidenied|rvaccessdenied|permissiondenied|badaccess|notloggedin|blocked|mwoauth)/iu.test(code))
      throw new ContentAcquisitionError('unauthorized');
    if (code === 'maxlag' || code === 'ratelimited') throw new ContentAcquisitionError('rate_limited');
    if (code === 'missingtitle' || code === 'nosuchrevid') throw new ContentAcquisitionError('not_found');
    throw new ContentAcquisitionError('invalid_content');
  }
  // Unsupported parameters can silently change MediaWiki behavior: do not ignore warnings.
  if ((!capabilityProbe && record.warnings) || record.continue || record.batchcomplete === false) throw new ContentAcquisitionError('invalid_content');
  return value;
}

function validateOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new TypeError('Invalid content origin.');
  return url.origin;
}

export class MediaWikiContentAdapter implements ContentAdapter {
  readonly id = 'mediawiki';
  private readonly api: URL;
  private readonly origin: string;
  constructor(private readonly options: { origin: string; apiUrl: string; transport: ContentTransport;
    requireAuthenticated: boolean; clock?: () => Date }) {
    this.origin = validateOrigin(options.origin);
    this.api = approvedContentUrl(options.apiUrl, this.origin);
    if (!this.api.pathname.endsWith('/api.php')) throw new TypeError('MediaWiki requires an approved api.php endpoint.');
  }
  private async query(parameters: Record<string, string>, signal: AbortSignal): Promise<ContentResponse> {
    const url = new URL(this.api);
    url.search = new URLSearchParams({ ...parameters, format: 'json', formatversion: '2', maxlag: '5',
      ...(this.options.requireAuthenticated ? { assert: 'user' } : {}) }).toString();
    return this.options.transport.get(url, 'json', signal);
  }
  async read(page: ContentPage, signal: AbortSignal): Promise<AcquiredContent> {
    const canonical = approvedContentUrl(page.url, this.origin);
    if (!page.title?.trim() || page.title.length > 500 || Array.from(page.title).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '|'))
      throw new ContentAcquisitionError('invalid_content');
    // Only a valid capability response can establish unsupported API modules.
    // HTTP 404/403, login pages, network errors and malformed JSON never permit fallback.
    const probe = await this.query({ action: 'paraminfo', modules: 'parse|query+info|query+revisions' }, signal);
    const capabilities = capabilitiesSchema.safeParse(parseApi(probe, true));
    if (!capabilities.success) throw new ContentAcquisitionError('invalid_content');
    const required: Record<string, { prefix: string; parameters: string[] }> = { parse: { prefix: '', parameters: ['oldid', 'prop'] },
      'query+info': { prefix: 'in', parameters: ['prop'] }, 'query+revisions': { prefix: 'rv', parameters: ['prop', 'limit'] } };
    for (const [path, requirement] of Object.entries(required)) {
      const module = capabilities.data.paraminfo.modules.find(entry => entry.path === path);
      if (module?.prefix !== requirement.prefix || !requirement.parameters.every(name => module.parameters.some(parameter => parameter.name === name)))
        throw new ContentAcquisitionError('unsupported');
    }
    const parameters = { action: 'query', prop: 'info|revisions', inprop: 'url', titles: page.title,
      rvprop: 'ids|timestamp', rvlimit: '1' };
    const beforeResult = pageInfoSchema.safeParse(parseApi(await this.query(parameters, signal)));
    if (!beforeResult.success) throw new ContentAcquisitionError('invalid_content');
    const before = beforeResult.data.query.pages[0];
    if (!before) throw new ContentAcquisitionError('invalid_content');
    // Redirects are not resolved automatically. The inventory must identify the canonical page.
    if (approvedContentUrl(before.fullurl, this.origin).href !== canonical.href) throw new ContentAcquisitionError('invalid_content');
    const revision = before.revisions[0];
    if (!revision) throw new ContentAcquisitionError('invalid_content');
    const parsed = parseSchema.safeParse(parseApi(await this.query({ action: 'parse', oldid: String(revision.revid),
      prop: 'text|revid|templates', disableeditsection: '1', disablelimitreport: '1' }, signal)));
    if (!parsed.success || parsed.data.parse.pageid !== before.pageid || parsed.data.parse.revid !== revision.revid
      || parsed.data.parse.title !== before.title) throw new ContentAcquisitionError('changed');
    const after = pageInfoSchema.safeParse(parseApi(await this.query(parameters, signal)));
    if (!after.success || digest(after.data.query.pages) !== digest(beforeResult.data.query.pages)) throw new ContentAcquisitionError('changed');
    const extracted = extractContentHtml(parsed.data.parse.text, { fragment: true });
    return { adapter: this.id, canonicalUrl: canonical.href, title: before.title, text: extracted.text,
      acquiredAt: (this.options.clock?.() ?? new Date()).toISOString(), sourceRevision: String(revision.revid),
      sourceUpdatedAt: revision.timestamp, images: extracted.images, requiresContentReview: true };
  }
}

export class WebContentAdapter implements ContentAdapter {
  readonly id = 'web';
  private readonly origin: string;
  constructor(private readonly options: { origin: string; transport: ContentTransport;
    container?: { kind: 'id' | 'tag' | 'class'; value: string }; clock?: () => Date }) {
    this.origin = validateOrigin(options.origin);
    if (options.container) selector.parse(options.container);
  }
  async read(page: ContentPage, signal: AbortSignal): Promise<AcquiredContent> {
    const url = approvedContentUrl(page.url, this.origin);
    const response = await this.options.transport.get(url, 'html', signal);
    requireContentSuccess(response);
    if (!/^text\/html(?:\s*;|\s*$)/iu.test(response.contentType)) throw new ContentAcquisitionError('invalid_content');
    const extracted = extractContentHtml(response.body, { ...(this.options.container ? { container: this.options.container } : {}) });
    const sourceUpdatedAt = extracted.sourceUpdatedAt ?? (response.lastModified && Number.isFinite(Date.parse(response.lastModified))
      ? new Date(response.lastModified).toISOString() : undefined);
    return { adapter: this.id, canonicalUrl: url.href, title: extracted.title, text: extracted.text,
      sourceRevision: digest({ title: extracted.title, text: extracted.text, images: extracted.images }),
      acquiredAt: (this.options.clock?.() ?? new Date()).toISOString(), images: extracted.images, requiresContentReview: true,
      ...(extracted.language ? { language: extracted.language } : {}), ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}) };
  }
}

/** Ordered, explicitly configured adapters; only unsupported API discovery permits fallback. */
export class ContentAdapterChain implements ContentAdapter {
  readonly id = 'chain';
  private readonly adapters: readonly ContentAdapter[];
  constructor(adapters: readonly ContentAdapter[]) {
    if (adapters.length < 1 || adapters.length > 8 || new Set(adapters.map(adapter => adapter.id)).size !== adapters.length)
      throw new TypeError('Configure unique content adapters.');
    this.adapters = [...adapters];
  }
  async read(page: ContentPage, signal: AbortSignal): Promise<AcquiredContent> {
    for (const adapter of this.adapters) {
      if (signal.aborted) throw new ContentAcquisitionError('unavailable');
      try { return await adapter.read(page, signal); }
      catch (error) {
        if (!(error instanceof ContentAcquisitionError) || error.code !== 'unsupported') throw error;
      }
    }
    throw new ContentAcquisitionError('unsupported');
  }
}

export interface ContentAdapterContext { origin: string; transport: ContentTransport }
export type ContentAdapterFactory<T> = (config: T, context: ContentAdapterContext) => ContentAdapter;

/** Application-owned registry; configuration never supplies executable factories. */
export class ContentAdapterRegistry {
  private readonly factories = new Map<string, (raw: unknown, context: ContentAdapterContext) => ContentAdapter>();
  constructor() {
    this.register('mediawiki', contentAdapterConfigurationSchema.options[0], (config, context) =>
      new MediaWikiContentAdapter({ ...context, ...config }));
    this.register('web', contentAdapterConfigurationSchema.options[1], (config, context) =>
      new WebContentAdapter({ ...context, ...(config.container ? { container: config.container } : {}) }));
  }
  register<T extends { type: string }>(type: string, schema: z.ZodType<T>, factory: ContentAdapterFactory<T>): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(type) || this.factories.has(type)) throw new TypeError('Content adapter is already registered or invalid.');
    this.factories.set(type, (raw, context) => {
      const config = schema.parse(raw);
      if (config.type !== type) throw new TypeError('Invalid content adapter discriminator.');
      const adapter = factory(config, context);
      if (adapter.id !== type) throw new TypeError('Content adapter identity does not match configuration.');
      return adapter;
    });
  }
  create(configurations: readonly unknown[], context: ContentAdapterContext): ContentAdapterChain {
    return new ContentAdapterChain(configurations.map(raw => {
      const { type } = z.object({ type: z.string() }).parse(raw);
      const factory = this.factories.get(type);
      if (!factory) throw new TypeError('Unknown content adapter.');
      return factory(raw, context);
    }));
  }
}
