#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const knownArchitectures = ["amd64", "arm64"];
const indexMediaType = "application/vnd.oci.image.index.v1+json";
const manifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function fail(message) {
  throw new Error(message);
}

function validDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertIndex(index) {
  if (index?.schemaVersion !== 2 || !Array.isArray(index.manifests)) {
    fail("OCI archive index is missing its schema version or manifests.");
  }
}

function assertBoundAttestations(descriptors, imageDigest) {
  for (const descriptor of descriptors) {
    const platform = descriptor?.platform;
    if (platform?.os !== "unknown" || platform?.architecture !== "unknown"
        || descriptor.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
        || descriptor.annotations?.["vnd.docker.reference.digest"] !== imageDigest
        || !validDigest(descriptor.digest)) {
      fail("OCI archive contains an unknown platform descriptor not bound to the qualified image.");
    }
  }
}

function validatePlatformIndex(index, architecture) {
  assertIndex(index);
  const images = [];
  const attestations = [];
  for (const descriptor of index.manifests) {
    const platform = descriptor?.platform;
    if (platform?.os === "linux" && platform.architecture === architecture) {
      images.push(descriptor);
    } else if (platform?.os === "unknown" && platform.architecture === "unknown") {
      attestations.push(descriptor);
    } else {
      fail("OCI archive index contains a missing or unexpected platform descriptor.");
    }
  }
  if (images.length !== 1) fail(`OCI archive must contain exactly one linux/${architecture} image descriptor.`);
  const image = images[0];
  if (!validDigest(image.digest)) fail("OCI archive image descriptor digest is malformed.");
  if (image.mediaType && !manifestMediaTypes.has(image.mediaType)) {
    fail("OCI archive platform descriptor is not an image manifest.");
  }
  assertBoundAttestations(attestations, image.digest);
  return image.digest;
}

export function inspectOciArchiveIndex(rootIndex, architecture, readIndexBlob = undefined) {
  if (!knownArchitectures.includes(architecture)) fail("OCI archive architecture must be amd64 or arm64.");
  assertIndex(rootIndex);

  const platformDescriptors = rootIndex.manifests.filter((descriptor) => descriptor?.platform !== undefined);
  if (platformDescriptors.length > 0) return validatePlatformIndex(rootIndex, architecture);

  if (rootIndex.manifests.length !== 1) {
    fail("platform-less OCI archive index must contain exactly one known image descriptor.");
  }
  const descriptor = rootIndex.manifests[0];
  if (!validDigest(descriptor.digest)) fail("platform-less OCI descriptor digest is malformed.");
  if (descriptor.mediaType === indexMediaType) {
    if (typeof readIndexBlob !== "function") fail("nested OCI index reader is required for this archive.");
    const nestedIndex = readIndexBlob(descriptor.digest);
    return validatePlatformIndex(nestedIndex, architecture);
  }
  if (!manifestMediaTypes.has(descriptor.mediaType)) {
    fail("platform-less OCI archive descriptor has an unsupported media type.");
  }
  return descriptor.digest;
}

function runTar(args, description) {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`could not read ${description} from the OCI archive.`);
  return result.stdout;
}

function readUniqueTarMember(archivePath, member, members) {
  const count = members.filter((name) => name === member).length;
  if (count !== 1) fail(`OCI archive must contain exactly one ${member} entry.`);
  return runTar(["-xOf", archivePath, member], member);
}

export function inspectOciArchive(archivePath, architecture) {
  const members = runTar(["-tf", archivePath], "member list").split("\n").filter(Boolean);
  const rootBytes = readUniqueTarMember(archivePath, "index.json", members);
  let rootIndex;
  try {
    rootIndex = JSON.parse(rootBytes);
  } catch {
    fail("OCI archive root index is invalid JSON.");
  }
  const readIndexBlob = (digest) => {
    if (!validDigest(digest)) fail("nested OCI index digest is malformed.");
    const member = `blobs/sha256/${digest.slice("sha256:".length)}`;
    const bytes = readUniqueTarMember(archivePath, member, members);
    try {
      return JSON.parse(bytes);
    } catch {
      fail("nested OCI index blob is invalid JSON.");
    }
  };
  return inspectOciArchiveIndex(rootIndex, architecture, readIndexBlob);
}

function main() {
  const [archivePath, architecture] = process.argv.slice(2);
  if (!archivePath || !architecture) fail("usage: verify-oci-archive.mjs <oci-archive.tar> <amd64|arm64>");
  const digest = inspectOciArchive(archivePath, architecture);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `archive_digest=${digest}\narchive_digest_${architecture}=${digest}\n`);
  }
  process.stdout.write(`Verified OCI archive linux/${architecture} image descriptor at ${digest}.\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`OCI archive verification failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
