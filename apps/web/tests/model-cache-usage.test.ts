import { describe, expect, it } from "vitest";
import { measuredInputCache } from "../src/lib/server/model-cache-usage";

describe("provider-reported input cache usage", () => {
  it("distinguishes reuse from an explicitly reported miss", () => {
    expect(measuredInputCache(1600, 1200)).toEqual({ readTokens: 1200, uncachedTokens: 400, readRatio: 0.75 });
    expect(measuredInputCache(1600, 0)).toEqual({ readTokens: 0, uncachedTokens: 1600, readRatio: 0 });
    expect(measuredInputCache(1600, 1600)).toEqual({ readTokens: 1600, uncachedTokens: 0, readRatio: 1 });
  });

  it.each([
    [undefined, 0], [null, 0], [100, undefined], [100, null], [100, "0"],
    [-1, 0], [100, -1], [100, 101], [100, 0.5], [1.5, 1],
    [Number.NaN, 0], [100, Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 1, 0],
  ])("does not turn absent or invalid counters (%s, %s) into a cache miss", (total, read) => {
    expect(measuredInputCache(total, read)).toBeUndefined();
  });

  it("keeps explicit zero counts but omits the undefined zero-input ratio", () => {
    const cache = measuredInputCache(0, 0);
    expect(cache).toEqual({ readTokens: 0, uncachedTokens: 0 });
  });
});
