#!/usr/bin/env node

import { appendFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}

export function validateRegistryTokenResponse(status, payload) {
  if (status === 403) fail("GHCR denied the requested pull,push scope for the intended image.");
  if (status !== 200) fail(`GHCR credential preflight failed with HTTP ${status}.`);
  const token = payload?.token ?? payload?.access_token;
  if (typeof token !== "string" || token.length === 0) fail("GHCR returned no scoped registry token.");
  return token;
}

export function assertTagAbsentStatus(status, tag) {
  if (status === 404) return;
  if (status === 200) fail(`GHCR tag ${tag} already exists; stable version tags are immutable.`);
  fail(`GHCR tag preflight for ${tag} failed with HTTP ${status}.`);
}

export function validateCandidateLeafStatus(status, contentDigest, expectedDigest, tag) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "")) fail(`qualified digest for ${tag} is malformed.`);
  if (status === 404) return false;
  if (status !== 200) fail(`GHCR candidate tag preflight for ${tag} failed with HTTP ${status}.`);
  if (contentDigest !== expectedDigest) {
    fail(`existing GHCR architecture tag ${tag} does not match its qualified OCI archive digest.`);
  }
  return true;
}

export function validateCandidateIndexStatus(status, contentDigest, tag) {
  if (status === 404) return { exists: false, digest: "" };
  if (status !== 200) fail(`GHCR candidate index preflight for ${tag} failed with HTTP ${status}.`);
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest ?? "")) {
    fail(`existing GHCR version tag ${tag} has no valid Docker-Content-Digest.`);
  }
  return { exists: true, digest: contentDigest };
}

function imagePath(value) {
  const prefix = "ghcr.io/";
  if (!value?.startsWith(prefix)) fail("IMAGE_REPOSITORY must name a ghcr.io image.");
  const repository = value.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(repository) || repository.includes("//") || repository.endsWith("/")) {
    fail("IMAGE_REPOSITORY has an invalid GHCR path.");
  }
  return repository;
}

async function inspectManifest(registryToken, repository, tag) {
  return fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    method: "HEAD",
    redirect: "error",
    headers: {
      authorization: `Bearer ${registryToken}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
}

async function main() {
  const [mode = "absent"] = process.argv.slice(2);
  const imageRepository = imagePath(process.env.IMAGE_REPOSITORY);
  const version = process.env.RELEASE_VERSION;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    fail("RELEASE_VERSION must be the canonical root manifest version.");
  }
  const username = process.env.GITHUB_ACTOR;
  const password = process.env.GITHUB_TOKEN;
  if (!username || !password) fail("GitHub actor and token are required for the GHCR preflight.");

  const scope = `repository:${imageRepository}:pull,push`;
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", scope);
  const tokenResponse = await fetch(tokenUrl, {
    redirect: "error",
    headers: { authorization: `Basic ${basic}` },
  });
  if (tokenResponse.status !== 200) validateRegistryTokenResponse(tokenResponse.status, {});
  const tokenPayload = await tokenResponse.json();
  const registryToken = validateRegistryTokenResponse(tokenResponse.status, tokenPayload);

  if (mode === "absent") {
    for (const tag of [version, `${version}-amd64`, `${version}-arm64`]) {
      const response = await inspectManifest(registryToken, imageRepository, tag);
      assertTagAbsentStatus(response.status, tag);
    }
    process.stdout.write("GHCR accepted the repository pull,push scope request and version tags are absent.\n");
  } else if (mode === "candidate") {
    const amd64Digest = process.env.AMD64_DIGEST;
    const arm64Digest = process.env.ARM64_DIGEST;
    const indexResponse = await inspectManifest(registryToken, imageRepository, version);
    const index = validateCandidateIndexStatus(
      indexResponse.status,
      indexResponse.headers.get("docker-content-digest"),
      version,
    );
    const amd64Response = await inspectManifest(registryToken, imageRepository, `${version}-amd64`);
    const arm64Response = await inspectManifest(registryToken, imageRepository, `${version}-arm64`);
    const amd64Exists = validateCandidateLeafStatus(
      amd64Response.status,
      amd64Response.headers.get("docker-content-digest"),
      amd64Digest,
      `${version}-amd64`,
    );
    const arm64Exists = validateCandidateLeafStatus(
      arm64Response.status,
      arm64Response.headers.get("docker-content-digest"),
      arm64Digest,
      `${version}-arm64`,
    );
    const output = process.env.GITHUB_OUTPUT;
    if (output) {
      appendFileSync(output, [
        `candidate_version_exists=${index.exists}`,
        `candidate_version_digest=${index.digest}`,
        `candidate_amd64_exists=${amd64Exists}`,
        `candidate_arm64_exists=${arm64Exists}`,
      ].join("\n") + "\n");
    }
    process.stdout.write("GHCR candidate tags are absent or match the exact qualified native digests.\n");
  } else {
    fail("usage: registry-preflight.mjs [absent|candidate]");
  }

  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `image_repository=ghcr.io/${imageRepository}\n`);
  process.stdout.write("No registry writes were performed during preflight.\n");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`GHCR preflight failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
