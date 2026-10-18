import type { HtmlExtraction } from './html.js';

/** Adapter output is untrusted source material, never an authorization assertion. */
export interface AcquiredContent {
  adapter: string;
  canonicalUrl: string;
  title: string;
  text: string;
  language?: 'de' | 'en';
  sourceRevision: string;
  sourceUpdatedAt?: string;
  acquiredAt: string;
  images: HtmlExtraction['images'];
  /** Expanded/opaque rendering needs an exact-content access review before publication. */
  requiresContentReview?: boolean;
}

export interface ContentPage {
  /** Exact operator-approved URL, not an LLM argument or discovered crawl link. */
  url: string;
  /** MediaWiki title, including any explicitly approved namespace. */
  title?: string;
}

export interface ContentResponse {
  status: number;
  contentType: string;
  body: string;
  lastModified?: string;
}

/** Host owns DNS/origin policy, bounded bytes, deadlines and credential custody. */
export interface ContentTransport {
  get(url: URL, accept: 'json' | 'html', signal: AbortSignal): Promise<ContentResponse>;
}

export interface ContentAdapter {
  readonly id: string;
  read(page: ContentPage, signal: AbortSignal): Promise<AcquiredContent>;
}

export type ContentErrorCode = 'unsupported' | 'unauthorized' | 'not_found' | 'rate_limited'
  | 'unavailable' | 'invalid_content' | 'changed' | 'review_required' | 'conflict';

/** No source body, URL query, API message or credential is included in errors. */
export class ContentAcquisitionError extends Error {
  constructor(readonly code: ContentErrorCode) {
    super(`Content acquisition failed (${code}).`);
    this.name = 'ContentAcquisitionError';
  }
}

export function approvedContentUrl(raw: string, origin: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ContentAcquisitionError('invalid_content'); }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new ContentAcquisitionError('invalid_content'); }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash
    || url.href !== raw || (Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || path.includes('\\'))
    || /(?:^|\/)(?:login|logout|auth|sso|saml|oauth|admin|edit|delete)(?:[/.]|$)/iu.test(path)
    || /(?:^|\/)(?:Spezial|Special):/iu.test(path)) throw new ContentAcquisitionError('invalid_content');
  return url;
}

export function requireContentSuccess(response: ContentResponse): void {
  if (response.status === 401 || response.status === 403) throw new ContentAcquisitionError('unauthorized');
  if (response.status === 404 || response.status === 410) throw new ContentAcquisitionError('not_found');
  if (response.status === 429 || response.status === 503) throw new ContentAcquisitionError('rate_limited');
  if (response.status < 200 || response.status >= 300) throw new ContentAcquisitionError('unavailable');
}
