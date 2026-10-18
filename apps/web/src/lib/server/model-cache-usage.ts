export type InputCacheUsage = {
  readTokens: number;
  uncachedTokens: number;
  /** Share of input tokens reused, not a share of requests or a price discount. */
  readRatio?: number;
};

/** Missing/invalid provider counters are unknown, never a synthetic cache miss. */
export function measuredInputCache(total: unknown, read: unknown): InputCacheUsage | undefined {
  if (typeof total !== "number" || typeof read !== "number" || !Number.isSafeInteger(total) || !Number.isSafeInteger(read)
    || total < 0 || read < 0 || read > total) return undefined;
  return { readTokens: read, uncachedTokens: total - read, ...(total > 0 ? { readRatio: read / total } : {}) };
}
