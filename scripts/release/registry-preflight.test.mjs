import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTagAbsentStatus,
  validateCandidateIndexStatus,
  validateCandidateLeafStatus,
  validateRegistryTokenResponse,
} from "./registry-preflight.mjs";

test("accepts GHCR's opaque token after a successful repository pull,push scope exchange", () => {
  assert.equal(
    validateRegistryTokenResponse(200, { token: "v1.opaque-base64-registry-token" }),
    "v1.opaque-base64-registry-token",
  );
});

test("rejects GHCR scope denial and malformed successful responses", () => {
  assert.throws(() => validateRegistryTokenResponse(403, {}), /denied/);
  assert.throws(() => validateRegistryTokenResponse(401, {}), /HTTP 401/);
  assert.throws(() => validateRegistryTokenResponse(200, {}), /no scoped registry token/);
});

test("only a registry 404 proves an exact version tag is absent", () => {
  assert.doesNotThrow(() => assertTagAbsentStatus(404, "0.1.0"));
  assert.throws(() => assertTagAbsentStatus(200, "0.1.0"), /already exists/);
  assert.throws(() => assertTagAbsentStatus(401, "0.1.0"), /preflight.*HTTP 401/);
  assert.throws(() => assertTagAbsentStatus(503, "0.1.0"), /preflight.*HTTP 503/);
});

const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const indexDigest = `sha256:${"c".repeat(64)}`;

test("allows reuse only when an existing architecture tag equals its signed archive digest", () => {
  assert.equal(validateCandidateLeafStatus(404, null, amd64Digest, "0.1.0-amd64"), false);
  assert.equal(validateCandidateLeafStatus(200, amd64Digest, amd64Digest, "0.1.0-amd64"), true);
  assert.equal(validateCandidateLeafStatus(200, arm64Digest, arm64Digest, "0.1.0-arm64"), true);
  assert.throws(() => validateCandidateLeafStatus(200, arm64Digest, amd64Digest, "0.1.0-amd64"), /does not match/);
  assert.throws(() => validateCandidateLeafStatus(401, null, amd64Digest, "0.1.0-amd64"), /HTTP 401/);
  assert.throws(() => validateCandidateLeafStatus(200, amd64Digest, "sha256:bad", "0.1.0-amd64"), /malformed/);
});

test("reuses only an existing version index with a valid registry digest", () => {
  assert.deepEqual(validateCandidateIndexStatus(404, null, "0.1.0"), { exists: false, digest: "" });
  assert.deepEqual(validateCandidateIndexStatus(200, indexDigest, "0.1.0"), { exists: true, digest: indexDigest });
  assert.throws(() => validateCandidateIndexStatus(200, null, "0.1.0"), /no valid Docker-Content-Digest/);
  assert.throws(() => validateCandidateIndexStatus(503, indexDigest, "0.1.0"), /HTTP 503/);
});
