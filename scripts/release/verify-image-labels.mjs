#!/usr/bin/env node

import { readFileSync } from "node:fs";

const expectedLabels = {
  "org.opencontainers.image.source": "https://github.com/metaneutrons/HASI",
  "org.opencontainers.image.licenses": "GPL-3.0-only",
};

function fail(message) {
  throw new Error(message);
}

export function verifyImageMetadata(imageInspect, { version, revision, architecture }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    fail("image version must be the canonical root manifest version.");
  }
  if (!/^[a-f0-9]{40,64}$/.test(revision ?? "")) fail("image revision must be a full Git commit SHA.");
  if (!["amd64", "arm64"].includes(architecture)) fail("image architecture must be amd64 or arm64.");
  if (!Array.isArray(imageInspect) || imageInspect.length !== 1) fail("docker inspect must return exactly one image.");

  const image = imageInspect[0];
  if (image.Os !== "linux" || image.Architecture !== architecture) {
    fail(`image platform must be linux/${architecture}.`);
  }
  if (image.Config?.User !== "node:node") fail("image must run as the non-root node:node user.");
  const labels = image.Config?.Labels;
  if (!labels || typeof labels !== "object") fail("image labels are missing.");
  const required = {
    ...expectedLabels,
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
  };
  for (const [name, value] of Object.entries(required)) {
    if (labels[name] !== value) fail(`image label ${name} does not match the release metadata.`);
  }
  return true;
}

export function verifyPulledImage(imageInspect, { version, revision, architecture, imageRepository, expectedDigest }) {
  verifyImageMetadata(imageInspect, { version, revision, architecture });
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "")) fail("expected registry digest is malformed.");
  if (typeof imageRepository !== "string" || !imageRepository.startsWith("ghcr.io/")) {
    fail("image repository must be the exact GHCR repository.");
  }
  const repoDigests = imageInspect[0].RepoDigests;
  const matching = Array.isArray(repoDigests)
    ? repoDigests.filter((value) => value.startsWith(`${imageRepository}@`))
    : [];
  if (matching.length !== 1 || matching[0] !== `${imageRepository}@${expectedDigest}`) {
    fail("pulled architecture tag does not resolve to its exact qualified OCI archive digest.");
  }
  return true;
}

function main() {
  const [inspectPath, version, revision, architecture, imageRepository, expectedDigest] = process.argv.slice(2);
  if (!inspectPath || !version || !revision || !architecture || Boolean(imageRepository) !== Boolean(expectedDigest)) {
    fail("usage: verify-image-labels.mjs <docker-inspect.json> <version> <revision-sha> <amd64|arm64> [ghcr-image expected-digest]");
  }
  let imageInspect;
  try {
    imageInspect = JSON.parse(readFileSync(inspectPath, "utf8"));
  } catch {
    fail("docker inspect output is missing or invalid JSON.");
  }
  if (imageRepository) verifyPulledImage(imageInspect, {
    version,
    revision,
    architecture,
    imageRepository,
    expectedDigest,
  });
  else verifyImageMetadata(imageInspect, { version, revision, architecture });
  process.stdout.write(`Verified linux/${architecture} image labels for ${version} at ${revision}.\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`image metadata verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
