import test from "node:test";
import assert from "node:assert/strict";
import { verifyImageMetadata, verifyPulledImage } from "./verify-image-labels.mjs";

const expected = {
  Os: "linux",
  Architecture: "amd64",
  Config: {
    User: "node:node",
    Labels: {
      "org.opencontainers.image.source": "https://github.com/metaneutrons/HASI",
      "org.opencontainers.image.licenses": "GPL-3.0-only",
      "org.opencontainers.image.version": "0.1.0",
      "org.opencontainers.image.revision": "0123456789abcdef0123456789abcdef01234567",
    },
  },
};

test("accepts the exact source, license, version, revision, and native architecture", () => {
  assert.equal(verifyImageMetadata([expected], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), true);
});

test("requires docker image inspect's default JSON array shape", () => {
  assert.throws(() => verifyImageMetadata(expected, {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), /exactly one image/);
  assert.equal(verifyImageMetadata([expected], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), true);
});

test("rejects missing or changed image labels", () => {
  const changed = structuredClone(expected);
  changed.Config.Labels["org.opencontainers.image.revision"] = "unknown";
  assert.throws(() => verifyImageMetadata([changed], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), /revision/);
});

test("rejects platform mismatch and noncanonical release metadata", () => {
  assert.throws(() => verifyImageMetadata([expected], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "arm64",
  }), /platform/);
  assert.throws(() => verifyImageMetadata([expected], {
    version: "0.1.0-pipeline.1",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), /canonical/);
});

test("requires the release image to run as node:node", () => {
  assert.throws(() => verifyImageMetadata([{ ...expected, Config: { ...expected.Config, User: "root" } }], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), /non-root node:node/);
  assert.throws(() => verifyImageMetadata([{ ...expected, Config: { Labels: expected.Config.Labels } }], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
  }), /non-root node:node/);
});

test("requires a pulled architecture tag to retain the exact qualified manifest digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const pulled = [{ ...expected, RepoDigests: [`ghcr.io/metaneutrons/hasi@${digest}`] }];
  assert.equal(verifyPulledImage(pulled, {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
    imageRepository: "ghcr.io/metaneutrons/hasi",
    expectedDigest: digest,
  }), true);
  assert.throws(() => verifyPulledImage([{ ...expected, RepoDigests: [`ghcr.io/metaneutrons/hasi@sha256:${"b".repeat(64)}`] }], {
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    architecture: "amd64",
    imageRepository: "ghcr.io/metaneutrons/hasi",
    expectedDigest: digest,
  }), /exact qualified OCI archive digest/);
});
