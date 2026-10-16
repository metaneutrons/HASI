#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const expectedArchitectures = ["amd64", "arm64"];

function fail(message) {
  throw new Error(message);
}

export function inspectReleaseIndex(bytes, {
  version,
  imageRepository,
  readbackRepoDigests,
  expectedPlatformDigests,
  expectedIndexDigest,
}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    fail("release index version is not canonical SemVer.");
  }
  let index;
  try {
    index = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("registry returned invalid JSON for the image index.");
  }
  if (!Array.isArray(index.manifests)) fail("registry object is not an OCI or Docker image index.");

  const expectedDigests = expectedPlatformDigests;
  if (!expectedDigests || Object.keys(expectedDigests).sort().join(",") !== expectedArchitectures.join(",")
      || expectedArchitectures.some((architecture) => !/^sha256:[a-f0-9]{64}$/.test(expectedDigests[architecture] ?? ""))) {
    fail("qualified platform digests must contain exact sha256 values for amd64 and arm64.");
  }
  const byArchitecture = new Map(expectedArchitectures.map((architecture) => [architecture, []]));
  const attestations = [];
  for (const manifest of index.manifests) {
    const platform = manifest?.platform;
    if (!platform) fail("image index contains a descriptor without a platform.");
    if (platform.os === "linux" && byArchitecture.has(platform.architecture)) {
      byArchitecture.get(platform.architecture).push(manifest);
    } else if (platform.os === "unknown" && platform.architecture === "unknown") {
      attestations.push(manifest);
    } else {
      fail("image index contains an unexpected operating system or architecture.");
    }
  }
  for (const architecture of expectedArchitectures) {
    const manifests = byArchitecture.get(architecture);
    if (manifests.length !== 1) fail("image index must contain exactly one linux/amd64 and one linux/arm64 manifest.");
    const actualDigest = manifests[0].digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(actualDigest ?? "")) fail("image index contains a malformed platform digest.");
    if (actualDigest !== expectedDigests[architecture]) {
      fail(`linux/${architecture} index digest differs from the qualified OCI archive.`);
    }
  }
  if (new Set(expectedArchitectures.map((architecture) => expectedDigests[architecture])).size !== 2) {
    fail("qualified amd64 and arm64 OCI archives have duplicate platform digests.");
  }
  for (const manifest of attestations) {
    if (manifest.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
        || !expectedArchitectures.some((architecture) =>
          manifest.annotations?.["vnd.docker.reference.digest"] === expectedDigests[architecture])
        || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? "")) {
      fail("image index contains an unknown platform descriptor not bound to a qualified image.");
    }
  }

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (expectedIndexDigest && digest !== expectedIndexDigest) {
    fail("image index digest differs from the previously qualified release digest.");
  }
  const repositoryPrefix = `${imageRepository}@`;
  const readback = readbackRepoDigests.filter((value) => value.startsWith(repositoryPrefix));
  if (readback.length !== 1 || readback[0] !== `${repositoryPrefix}${digest}`) {
    fail("pulled version tag does not resolve to the exact inspected image index digest.");
  }

  return { digest, architectures: expectedArchitectures };
}

function main() {
  const [manifestPath, version, imageRepository, readbackPath, qualifiedDigestsPath, expectedIndexDigest] = process.argv.slice(2);
  if (!manifestPath || !version || !imageRepository || !readbackPath || !qualifiedDigestsPath) {
    fail("usage: verify-index.mjs <manifest.json> <version> <ghcr-image> <readback-repo-digests.json> <qualified-platform-digests.json> [expected-index-digest]");
  }
  const bytes = readFileSync(manifestPath);
  const readbackRepoDigests = JSON.parse(readFileSync(readbackPath, "utf8"));
  const expectedPlatformDigests = JSON.parse(readFileSync(qualifiedDigestsPath, "utf8"));
  if (!Array.isArray(readbackRepoDigests) || readbackRepoDigests.some((value) => typeof value !== "string")) {
    fail("docker image inspect returned an invalid RepoDigests list.");
  }
  const result = inspectReleaseIndex(bytes, { version, imageRepository, readbackRepoDigests, expectedPlatformDigests, expectedIndexDigest });
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `digest=${result.digest}\n`);
  process.stdout.write(`Verified ${result.architectures.map((arch) => `linux/${arch}`).join(", ")} at ${result.digest}.\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`image index verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
