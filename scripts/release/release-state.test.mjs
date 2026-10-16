import assert from "node:assert/strict";
import test from "node:test";
import { expectedReleaseAssetNames } from "./assets.mjs";
import {
  assertNoNewerStableRelease,
  compareStableVersions,
  validatePublishedPrerelease,
  validatePublishedStableRelease,
  validateReleaseRecord,
} from "./release-state.mjs";

const tag = "v0.1.0";
const expectedActor = "metaneutrons-release-please[bot]";

function record(overrides = {}) {
  return {
    id: 12,
    tag_name: tag,
    author: { login: expectedActor },
    draft: true,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

test("accepts a Release Please stable draft created by the dedicated App", () => {
  assert.deepEqual(validateReleaseRecord(record(), {
    tag,
    expectedActor,
  }), { exists: true, id: 12 });
});

test("requires a Release Please stable draft for every production release tag", () => {
  assert.throws(() => validateReleaseRecord(null, {
    tag,
    expectedActor,
  }), /stable release tag has no Release Please draft/);
});

test("rejects a human-authored or already-published stable release", () => {
  assert.throws(() => validateReleaseRecord(record({ author: { login: "fabian" } }), {
    tag,
    expectedActor,
  }), /not authored by the release App bot/);
  assert.throws(() => validateReleaseRecord(record({ draft: false }), {
    tag,
    expectedActor,
  }), /already published/);
});

test("rejects a tag mismatch, an unexpected release state, and an incomplete inventory", () => {
  assert.throws(() => validateReleaseRecord(record({ tag_name: "v0.2.0" }), {
    tag,
    expectedActor,
  }), /does not match/);
  assert.throws(() => validateReleaseRecord(record({ prerelease: true }), {
    tag,
    expectedActor,
  }), /unexpectedly marked as a prerelease/);
  assert.throws(() => validateReleaseRecord(record({ assets: [{ name: "extra.txt" }] }), {
    tag,
    expectedActor,
  }), /already contains assets/);
  assert.doesNotThrow(() => validateReleaseRecord(record({
    draft: true,
    prerelease: false,
    assets: [...expectedReleaseAssetNames(tag), "SHA256SUMS"].map((name) => ({ name })),
  }), {
    tag,
    expectedActor,
    requireAssets: true,
  }));
});

test("blocks an older release from becoming latest after a newer stable release exists", () => {
  assert.equal(compareStableVersions("v0.10.0", "v0.9.0"), 1);
  assert.equal(compareStableVersions("v1.0.0", "v1.0.0"), 0);
  assert.equal(compareStableVersions("v1.2.0", "v1.10.0"), -1);
  assert.equal(assertNoNewerStableRelease("v1.2.0", [
    { tag_name: "v2.0.0", draft: true, prerelease: false },
    { tag_name: "v3.0.0-rc.1", draft: false, prerelease: true },
    { tag_name: "notes", draft: false, prerelease: false },
    { tag_name: "v1.1.0", draft: false, prerelease: false },
  ]), true);
  assert.throws(() => assertNoNewerStableRelease("v1.2.0", [
    { tag_name: "v1.10.0", draft: false, prerelease: false },
  ]), /newer than candidate/);
  assert.throws(() => compareStableVersions("v1.2.0-pipeline.1", "v1.0.0"), /canonical/);
});

test("recognizes only the exact App-authored prerelease and stable release as safe promotion retries", () => {
  const assets = [...expectedReleaseAssetNames(tag), "SHA256SUMS"].map((name) => ({ name }));
  const publishedPrerelease = record({ draft: false, prerelease: true, assets });
  const publishedStable = record({ draft: false, prerelease: false, assets });

  assert.equal(validatePublishedPrerelease(publishedPrerelease, { tag, expectedActor }), true);
  assert.equal(validatePublishedStableRelease(publishedStable, { tag, expectedActor }), true);
  assert.throws(() => validatePublishedPrerelease({ ...publishedPrerelease, author: { login: "fabian" } }, {
    tag,
    expectedActor,
  }), /not authored by the release App bot/);
  assert.throws(() => validatePublishedStableRelease({ ...publishedStable, assets: [] }, {
    tag,
    expectedActor,
  }), /stable release assets differ/);
  assert.throws(() => validatePublishedPrerelease({ ...publishedPrerelease, prerelease: false }, {
    tag,
    expectedActor,
  }), /not the expected published prerelease/);
});
