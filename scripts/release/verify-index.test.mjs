import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectReleaseIndex } from "./verify-index.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function manifest(platforms) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: platforms.map(([os, architecture], index) => ({
      digest: digest(`platform-${index}`),
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      size: 120,
      platform: { os, architecture },
    })),
  }));
}

function expectedDigests() {
  return { amd64: digest("platform-0"), arm64: digest("platform-1") };
}

function inspect(bytes, overrides = {}) {
  const indexDigest = digest(bytes);
  return inspectReleaseIndex(bytes, {
    version: "0.1.0",
    imageRepository: "ghcr.io/metaneutrons/hasi",
    readbackRepoDigests: [`ghcr.io/metaneutrons/hasi@${indexDigest}`],
    expectedPlatformDigests: expectedDigests(),
    ...overrides,
  });
}

test("accepts the exact amd64 and arm64 index and matches the pulled tag digest", () => {
  const bytes = manifest([["linux", "amd64"], ["linux", "arm64"]]);
  assert.deepEqual(inspect(bytes).architectures, ["amd64", "arm64"]);
});

test("rejects a missing or duplicate architecture", () => {
  assert.throws(() => inspect(manifest([["linux", "amd64"]])), /exactly one linux\/amd64/);
  assert.throws(() => inspect(manifest([["linux", "amd64"], ["linux", "amd64"], ["linux", "arm64"]])), /exactly one linux\/amd64/);
});

test("rejects unexpected platforms and a readback digest mismatch", () => {
  assert.throws(() => inspect(manifest([["linux", "amd64"], ["linux", "arm64"], ["linux", "s390x"]])), /unexpected operating system/);
  const bytes = manifest([["linux", "amd64"], ["linux", "arm64"]]);
  assert.throws(() => inspectReleaseIndex(bytes, {
    version: "0.1.0",
    imageRepository: "ghcr.io/metaneutrons/hasi",
    readbackRepoDigests: ["ghcr.io/metaneutrons/hasi@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    expectedPlatformDigests: expectedDigests(),
  }), /exact inspected image index digest/);
});

test("binds each platform descriptor to its exact qualified archive and rejects swapped digests", () => {
  const bytes = manifest([["linux", "amd64"], ["linux", "arm64"]]);
  const swapped = { amd64: digest("platform-1"), arm64: digest("platform-0") };
  assert.throws(() => inspect(bytes, { expectedPlatformDigests: swapped }), /differs from the qualified OCI archive/);
});

test("allows only recognized attestations bound to a qualified platform digest", () => {
  const bytes = manifest([["linux", "amd64"], ["linux", "arm64"]]);
  const index = JSON.parse(bytes.toString("utf8"));
  index.manifests.push({
    digest: digest("attestation"),
    platform: { os: "unknown", architecture: "unknown" },
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": digest("platform-0"),
    },
  });
  assert.doesNotThrow(() => inspect(Buffer.from(JSON.stringify(index))));
  index.manifests[2].annotations["vnd.docker.reference.digest"] = digest("unqualified");
  assert.throws(() => inspect(Buffer.from(JSON.stringify(index))), /not bound/);
  delete index.manifests[2].platform;
  assert.throws(() => inspect(Buffer.from(JSON.stringify(index))), /without a platform/);
});

test("rejects malformed platform digests and version metadata", () => {
  const bytes = Buffer.from(JSON.stringify({
    manifests: [
      { digest: "sha256:bad", platform: { os: "linux", architecture: "amd64" } },
      { digest: digest("arm64"), platform: { os: "linux", architecture: "arm64" } },
    ],
  }));
  assert.throws(() => inspect(bytes), /malformed platform digest/);
  assert.throws(() => inspectReleaseIndex(bytes, {
    version: "v0.1.0",
    imageRepository: "ghcr.io/metaneutrons/hasi",
    readbackRepoDigests: [],
    expectedPlatformDigests: expectedDigests(),
  }), /version is not canonical/);
});
