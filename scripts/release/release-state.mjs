#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { expectedReleaseAssetNames } from "./assets.mjs";

function fail(message) {
  throw new Error(message);
}

function assertPublishedReleaseAssets(release, tag, state) {
  const expected = [...expectedReleaseAssetNames(tag), "SHA256SUMS"].sort();
  const actual = (release.assets ?? []).map((asset) => asset.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`GitHub ${state} assets differ from the verified inventory.`);
  }
}

export function validatePublishedPrerelease(release, { tag, expectedActor }) {
  if (!release || release.tag_name !== tag) fail("GitHub release tag does not match the dispatched ref.");
  if (release.author?.login !== expectedActor) fail("GitHub release was not authored by the release App bot.");
  if (release.draft !== false || release.prerelease !== true) fail("GitHub release is not the expected published prerelease.");
  assertPublishedReleaseAssets(release, tag, "prerelease");
  return true;
}

export function validatePublishedStableRelease(release, { tag, expectedActor }) {
  if (!release || release.tag_name !== tag) fail("GitHub release tag does not match the dispatched ref.");
  if (release.author?.login !== expectedActor) fail("GitHub release was not authored by the release App bot.");
  if (release.draft !== false || release.prerelease !== false) fail("GitHub release is not the expected published stable release.");
  assertPublishedReleaseAssets(release, tag, "stable release");
  return true;
}

function stableVersion(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? "");
  if (!match) return null;
  return match.slice(1).map((part) => BigInt(part));
}

export function compareStableVersions(left, right) {
  const leftParts = stableVersion(left);
  const rightParts = stableVersion(right);
  if (!leftParts || !rightParts) fail("stable release comparison requires canonical vMAJOR.MINOR.PATCH tags.");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function assertNoNewerStableRelease(candidateTag, releases) {
  if (!Array.isArray(releases)) fail("GitHub release list is invalid.");
  for (const release of releases) {
    if (release?.draft !== false || release?.prerelease !== false) continue;
    if (!stableVersion(release.tag_name)) continue;
    if (compareStableVersions(release.tag_name, candidateTag) > 0) {
      fail(`stable release ${release.tag_name} is newer than candidate ${candidateTag}; refusing an older promotion.`);
    }
  }
  return true;
}

export function validateReleaseRecord(release, { tag, expectedActor, requireAssets = false }) {
  if (!release) fail("stable release tag has no Release Please draft.");
  if (release.tag_name !== tag) fail("GitHub release tag does not match the dispatched ref.");
  if (release.author?.login !== expectedActor) fail("GitHub release was not authored by the release App bot.");
  if (release.draft !== true) fail("GitHub release is already published; refusing an automatic retry.");
  if (release.prerelease !== false) fail("Release Please draft is unexpectedly marked as a prerelease.");

  const names = (release.assets ?? []).map((asset) => asset.name).sort();
  if (requireAssets) {
    const expected = [...expectedReleaseAssetNames(tag), "SHA256SUMS"].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail("GitHub draft asset names differ from the verified local inventory.");
  } else if (names.length > 0) {
    fail("GitHub draft already contains assets; refusing an automatic retry after an unknown upload outcome.");
  }

  return { exists: true, id: release.id };
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required.`);
  return value;
}

function releaseContext() {
  const tag = required("RELEASE_TAG");
  const repository = required("GITHUB_REPOSITORY");
  const expectedActor = required("EXPECTED_RELEASE_ACTOR");
  const token = required("GH_TOKEN");
  return { tag, repository, expectedActor, token };
}

async function request(path, { method = "GET", body, token, repository }) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${base}/repos/${repository}${path}`, {
    method,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "HASI-release-workflow",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { status: response.status, payload };
}

async function findRelease(context) {
  const response = await request(`/releases/tags/${encodeURIComponent(context.tag)}`, context);
  if (response.status === 404) return null;
  if (response.status !== 200) fail(`GitHub release lookup failed with HTTP ${response.status}.`);
  return response.payload;
}

async function listReleases(context) {
  const releases = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request(`/releases?per_page=100&page=${page}`, context);
    if (response.status !== 200 || !Array.isArray(response.payload)) {
      fail(`GitHub release list failed with HTTP ${response.status}.`);
    }
    releases.push(...response.payload);
    if (response.payload.length < 100) return releases;
  }
  fail("GitHub release list exceeded the 10,000-release verification bound.");
}

async function assertLatestStableCandidate(context) {
  const releases = await listReleases(context);
  assertNoNewerStableRelease(context.tag, releases);
  return releases;
}

function writeOutputs(values) {
  const output = required("GITHUB_OUTPUT");
  appendFileSync(output, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

async function preflight(context) {
  const release = await findRelease(context);
  const state = validateReleaseRecord(release, { ...context, requireAssets: false });
  writeOutputs({
    release_id: state.id,
  });
  process.stdout.write("Validated the Release Please stable draft and App author.\n");
}

async function requireDraft(context) {
  const release = await findRelease(context);
  const state = validateReleaseRecord(release, { ...context, requireAssets: false });
  writeOutputs({ release_id: state.id });
  process.stdout.write("Revalidated the Release Please draft before attaching release assets.\n");
}

async function updateRelease(context, releaseId, body) {
  const response = await request(`/releases/${encodeURIComponent(releaseId)}`, { ...context, method: "PATCH", body });
  if (response.status !== 200) fail(`GitHub release update failed with HTTP ${response.status}.`);
  return response.payload;
}

async function publishPrerelease(context) {
  const releaseId = required("RELEASE_ID");
  const response = await request(`/releases/${encodeURIComponent(releaseId)}`, context);
  if (response.status !== 200) fail(`GitHub draft lookup failed with HTTP ${response.status}.`);
  if (response.payload?.draft === false && response.payload?.prerelease === true) {
    validatePublishedPrerelease(response.payload, context);
    process.stdout.write("Verified the already-published prerelease and its exact asset inventory.\n");
    return;
  }
  validateReleaseRecord(response.payload, { ...context, requireAssets: true });
  const published = await updateRelease(context, releaseId, { draft: false, prerelease: true, make_latest: "false" });
  if (published.draft !== false || published.prerelease !== true || published.tag_name !== context.tag) {
    fail("GitHub did not publish the verified assets as a prerelease.");
  }
  process.stdout.write("Published the verified GitHub release assets as a prerelease.\n");
}

async function verifyAssets(context) {
  const releaseId = required("RELEASE_ID");
  const response = await request(`/releases/${encodeURIComponent(releaseId)}`, context);
  if (response.status !== 200) fail(`GitHub draft lookup failed with HTTP ${response.status}.`);
  validateReleaseRecord(response.payload, { ...context, requireAssets: true });
  process.stdout.write("Validated the App-authored draft's exact uploaded asset inventory.\n");
}

async function promoteStable(context) {
  const releaseId = required("RELEASE_ID");
  const response = await request(`/releases/${encodeURIComponent(releaseId)}`, context);
  if (response.status !== 200) fail(`GitHub prerelease lookup failed with HTTP ${response.status}.`);
  const release = response.payload;
  if (release?.draft === false && release?.prerelease === false) {
    validatePublishedStableRelease(release, context);
    await assertLatestStableCandidate(context);
    process.stdout.write("Verified that the exact stable release was already promoted.\n");
    return;
  }
  if (release.tag_name !== context.tag
      || release.author?.login !== context.expectedActor
      || release.draft !== false
      || release.prerelease !== true) {
    fail("GitHub release is not the expected App-authored prerelease; refusing promotion.");
  }
  assertPublishedReleaseAssets(release, context.tag, "prerelease");

  await assertLatestStableCandidate(context);

  const promoted = await updateRelease(context, releaseId, { prerelease: false, make_latest: "true" });
  if (promoted.draft !== false || promoted.prerelease !== false || promoted.tag_name !== context.tag) {
    fail("GitHub did not promote the verified prerelease to a stable release.");
  }
  process.stdout.write("Promoted the verified GitHub prerelease to a stable release.\n");
}

async function main() {
  const [mode] = process.argv.slice(2);
  const context = releaseContext();
  if (mode === "preflight") return preflight(context);
  if (mode === "require-draft") return requireDraft(context);
  if (mode === "verify-assets") return verifyAssets(context);
  if (mode === "publish-prerelease") return publishPrerelease(context);
  if (mode === "promote-stable") return promoteStable(context);
  if (mode === "assert-monotonic") {
    await assertLatestStableCandidate(context);
    process.stdout.write(`Verified that ${context.tag} is not older than any published stable release.\n`);
    return;
  }
  fail("usage: release-state.mjs preflight|require-draft|verify-assets|publish-prerelease|promote-stable|assert-monotonic");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`release state check failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
