import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReleaseTag,
  validateAppEnvironment,
  validateConfiguration,
  validateQualificationRun,
  validateTagAgainstConfiguration,
} from "./metadata.mjs";

const configuration = {
  releaseConfig: {
    packages: {
      ".": {
        "release-type": "node",
        "bump-minor-pre-major": true,
        draft: true,
        "force-tag-creation": true,
        "include-component-in-tag": false,
      },
    },
  },
  releaseManifest: { ".": "0.1.0" },
  packageJson: { version: "0.1.0" },
};

test("accepts the stable root version only when package and Release Please agree", () => {
  const manifestVersion = validateConfiguration(configuration);
  assert.equal(manifestVersion, "0.1.0");
  assert.deepEqual(validateTagAgainstConfiguration("v0.1.0", { manifestVersion }), {
    tag: "v0.1.0",
    version: "0.1.0",
  });
});

test("rejects noncanonical tags and pipeline prereleases from the production release route", () => {
  for (const tag of ["v00.1.0", "v0.1.0-rc.1", "v0.1.0-pipeline.1", "v0.1.0-pipeline.0", "0.1.0", "v0.1.0+build.2"]) {
    assert.throws(() => parseReleaseTag(tag), /production release tag must be/);
  }
});

test("rejects mismatched package and manifest versions", () => {
  assert.throws(() => validateConfiguration({
    ...configuration,
    packageJson: { version: "0.2.0" },
  }), /versions differ/);
});

test("rejects tag cores that differ from the package version", () => {
  assert.throws(() => validateTagAgainstConfiguration("v0.2.0", { manifestVersion: "0.1.0" }), /does not match root manifest/);
});

test("accepts read-only qualification only from a dispatched main branch run", () => {
  assert.deepEqual(validateQualificationRun({
    eventName: "workflow_dispatch",
    refType: "branch",
    refName: "main",
    sha: "a".repeat(40),
    runNumber: "42",
    manifestVersion: "0.1.0",
  }), {
    artifactLabel: "v0.1.0-pipeline.42",
    version: "0.1.0",
    qualificationOnly: true,
  });
});

test("rejects qualification from tags, other branches, non-dispatch events, or malformed identities", () => {
  const base = {
    eventName: "workflow_dispatch",
    refType: "branch",
    refName: "main",
    sha: "a".repeat(40),
    runNumber: "42",
    manifestVersion: "0.1.0",
  };
  for (const changes of [
    { eventName: "push" },
    { refType: "tag" },
    { refName: "release-test" },
    { sha: "not-a-commit" },
    { runNumber: "0" },
    { runNumber: "042" },
    { manifestVersion: "0.1" },
  ]) {
    assert.throws(() => validateQualificationRun({ ...base, ...changes }));
  }
});

test("rejects release configuration that no longer creates draft root releases", () => {
  assert.throws(() => validateConfiguration({
    ...configuration,
    releaseConfig: {
      packages: {
        ".": {
          ...configuration.releaseConfig.packages["."],
          draft: false,
        },
      },
    },
  }), /approved production release policy/);
});

test("checks App environment names only in the App-token workflow", () => {
  assert.equal(validateAppEnvironment({
    RELEASE_PLEASE_CLIENT_ID: "4222966",
    RELEASE_PLEASE_APP_PRIVATE_KEY: "configured",
  }), true);
  assert.throws(() => validateAppEnvironment({ RELEASE_PLEASE_CLIENT_ID: "4222966" }), /PRIVATE_KEY is not configured/);
});
