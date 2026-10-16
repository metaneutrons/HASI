import assert from "node:assert/strict";
import test from "node:test";
import { inspectOciArchiveIndex } from "./verify-oci-archive.mjs";

const imageDigest = `sha256:${"1".repeat(64)}`;
const attestationDigest = `sha256:${"2".repeat(64)}`;

test("accepts the exact native image descriptor and associated build attestations", () => {
  assert.equal(inspectOciArchiveIndex({
    schemaVersion: 2,
    manifests: [
      { digest: imageDigest, platform: { os: "linux", architecture: "arm64" } },
      {
        digest: attestationDigest,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": imageDigest,
        },
      },
    ],
  }, "arm64"), imageDigest);
});

test("follows the bounded platform-less root descriptor into the OCI index", () => {
  const nestedDigest = `sha256:${"3".repeat(64)}`;
  const root = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: nestedDigest }],
  };
  const nested = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { digest: imageDigest, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux", architecture: "amd64" } },
      {
        digest: attestationDigest,
        platform: { os: "unknown", architecture: "unknown" },
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": imageDigest,
        },
      },
    ],
  };
  assert.equal(inspectOciArchiveIndex(root, "amd64", (digest) => {
    assert.equal(digest, nestedDigest);
    return nested;
  }), imageDigest);
});

test("rejects missing, duplicate, or foreign platform descriptors", () => {
  const base = { schemaVersion: 2, manifests: [{ digest: imageDigest, platform: { os: "linux", architecture: "amd64" } }] };
  assert.throws(() => inspectOciArchiveIndex({ schemaVersion: 2, manifests: [] }, "amd64"), /exactly one/);
  assert.throws(() => inspectOciArchiveIndex({ ...base, manifests: [...base.manifests, ...base.manifests] }, "amd64"), /exactly one/);
  assert.throws(() => inspectOciArchiveIndex({ ...base, manifests: [...base.manifests, {
    digest: attestationDigest,
    platform: { os: "linux", architecture: "arm64" },
  }] }, "amd64"), /unexpected platform/);
});

test("rejects unbound unknown descriptors and malformed image digests", () => {
  const image = { digest: imageDigest, platform: { os: "linux", architecture: "amd64" } };
  assert.throws(() => inspectOciArchiveIndex({ schemaVersion: 2, manifests: [image, {
    digest: attestationDigest,
    platform: { os: "unknown", architecture: "unknown" },
  }] }, "amd64"), /not bound/);
  assert.throws(() => inspectOciArchiveIndex({ schemaVersion: 2, manifests: [{
    digest: "sha256:abcd",
    platform: { os: "linux", architecture: "amd64" },
  }] }, "amd64"), /malformed/);
});
