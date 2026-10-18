import { digest } from '@hasi/plugin-sdk';
import { knowledgeDocuments, SERVICE_IT_DEMO_ORIGIN } from '@hasi/demo-fixtures/knowledge-catalog';
import { WebContentAdapter } from './content/adapters.js';
import { ContentAcquisitionError, type ContentTransport } from './content/contracts.js';

export { SERVICE_IT_DEMO_ORIGIN } from '@hasi/demo-fixtures/knowledge-catalog';
const CONTAINER = { kind: 'id', value: 'service-it-document' } as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_READS = 4;
const MAX_TIMEOUT_MS = 15_000;
const MAX_CACHE_TTL_MS = 300_000;
const MAX_CONCURRENT_READS = 8;

interface DemoContentFixture {
  id: string;
  sourceSystem: 'service_it' | 'intranet';
  title: string;
  text: string;
}

export interface DemoAcquiredBody {
  text: string;
  acquiredAt: string;
  /** Stable digest of the locally approved rendered body, not remote metadata. */
  sourceRevision: string;
}

/** Host-owned, server-side transport for the fixed synthetic ServiceIT origin. */
export interface DemoContentCapability {
  transport: ContentTransport;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxConcurrentReads?: number;
  clock?: () => Date;
}

export interface DemoContentAcquirer {
  read(documentId: string): Promise<DemoAcquiredBody>;
}

const fixtures: readonly DemoContentFixture[] = knowledgeDocuments
  .filter((document) => document.sourceSystem === 'service_it');
const fixtureById = new Map(fixtures.map((document) => [document.id, document]));
const approvedUrls = new Map(fixtures.map((document) => [document.id, `${SERVICE_IT_DEMO_ORIGIN}/de/faqs/${document.id}/`]));
const approvedUrlSet = new Set(approvedUrls.values());

/** Restricts a host transport to the fixed ServiceIT HTTPS origin and local inventory. */
export function createServiceItDemoTransport(transport: ContentTransport): ContentTransport {
  return {
    get(url, accept, signal) {
      if (accept !== 'html' || url.protocol !== 'https:' || url.origin !== SERVICE_IT_DEMO_ORIGIN
        || url.username || url.password || url.search || url.hash || !approvedUrlSet.has(url.href)) {
        return Promise.reject(new ContentAcquisitionError('invalid_content'));
      }
      return transport.get(url, accept, signal);
    },
  };
}

/**
 * Builds the optional live body reader used only by the synthetic demo. Fixture
 * metadata remains authoritative; remote HTML must reproduce its approved
 * title-plus-body text exactly before any content is returned.
 */
export function createDemoContentAcquirer(capability: DemoContentCapability): DemoContentAcquirer {
  const timeoutMs = capability.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = capability.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxConcurrentReads = capability.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > MAX_CACHE_TTL_MS
    || !Number.isSafeInteger(maxConcurrentReads) || maxConcurrentReads < 1 || maxConcurrentReads > MAX_CONCURRENT_READS) {
    throw new TypeError('Invalid synthetic demo content limits.');
  }

  const adapter = new WebContentAdapter({
    origin: SERVICE_IT_DEMO_ORIGIN,
    transport: createServiceItDemoTransport(capability.transport),
    container: CONTAINER,
    ...(capability.clock ? { clock: capability.clock } : {}),
  });
  const cache = new Map<string, { value: DemoAcquiredBody; expiresAt: number }>();
  const pending = new Map<string, Promise<DemoAcquiredBody>>();
  const waiters: (() => void)[] = [];
  let activeReads = 0;

  const acquireSlot = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeReads >= maxConcurrentReads || waiters.length > 0) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } else {
      activeReads += 1;
    }
    try {
      return await operation();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else activeReads -= 1;
    }
  };

  const fetchApprovedBody = async (document: DemoContentFixture): Promise<DemoAcquiredBody> => acquireSlot(async () => {
    const url = approvedUrls.get(document.id);
    if (!url) throw new ContentAcquisitionError('not_found');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ContentAcquisitionError('unavailable'));
      }, timeoutMs);
      timeout.unref();
    });
    try {
      const acquired = await Promise.race([
        adapter.read({ url }, controller.signal),
        deadline,
      ]);
      if (acquired.canonicalUrl !== url || !Number.isFinite(Date.parse(acquired.acquiredAt))
        || acquired.images.length !== 0) throw new ContentAcquisitionError('invalid_content');
      const titlePrefix = `${document.title}\n`;
      const renderedBody = `${titlePrefix}${document.text}`;
      if (digest({ documentId: document.id, body: acquired.text })
        !== digest({ documentId: document.id, body: renderedBody })) {
        throw new ContentAcquisitionError('changed');
      }
      if (!acquired.text.startsWith(titlePrefix)) throw new ContentAcquisitionError('changed');
      return {
        text: acquired.text.slice(titlePrefix.length),
        acquiredAt: acquired.acquiredAt,
        sourceRevision: digest({ adapter: 'web', canonicalUrl: url, documentId: document.id, body: renderedBody }),
      };
    } catch (error) {
      if (error instanceof ContentAcquisitionError) throw error;
      throw new ContentAcquisitionError('unavailable');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });

  return {
    read(documentId) {
      const document = fixtureById.get(documentId);
      if (!document) return Promise.reject(new ContentAcquisitionError('not_found'));
      const now = (capability.clock?.() ?? new Date()).getTime();
      const cached = cache.get(documentId);
      if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);
      const existing = pending.get(documentId);
      if (existing) return existing;

      const current = fetchApprovedBody(document).then((value) => {
        cache.set(documentId, { value, expiresAt: (capability.clock?.() ?? new Date()).getTime() + cacheTtlMs });
        return value;
      }).finally(() => {
        if (pending.get(documentId) === current) pending.delete(documentId);
      });
      pending.set(documentId, current);
      return current;
    },
  };
}

