#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

const canonicalTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

export function validateConfiguration({ releaseConfig, releaseManifest, packageJson }) {
  const packages = releaseConfig?.packages;
  if (!packages || Object.keys(packages).length !== 1 || !packages["."]) {
    fail("release-please must configure only the root package.");
  }

  const root = packages["."];
  if (root["release-type"] !== "node"
      || root["bump-minor-pre-major"] !== true
      || root.draft !== true
      || root["force-tag-creation"] !== true
      || root["include-component-in-tag"] !== false) {
    fail("release-please root settings differ from the approved production release policy.");
  }

  const manifestVersion = releaseManifest?.["."];
  if (typeof manifestVersion !== "string" || !canonicalVersionPattern.test(manifestVersion)) {
    fail("release-please root manifest must contain a canonical stable version.");
  }
  if (packageJson?.version !== manifestVersion) {
    fail("root package.json and release-please manifest versions differ.");
  }

  return manifestVersion;
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") fail("release tag is missing.");
  const match = canonicalTagPattern.exec(tag);
  if (!match) {
    fail("production release tag must be canonical vMAJOR.MINOR.PATCH SemVer.");
  }

  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function validateTagAgainstConfiguration(tag, configuration) {
  const parsed = parseReleaseTag(tag);
  if (parsed.version !== configuration.manifestVersion) {
    fail(`release tag core ${parsed.version} does not match root manifest ${configuration.manifestVersion}.`);
  }
  return parsed;
}

export function validateQualificationRun({ eventName, refType, refName, sha, runNumber, manifestVersion }) {
  if (eventName !== "workflow_dispatch") fail("read-only qualification requires an explicit workflow_dispatch.");
  if (refType !== "branch" || refName !== "main") fail("read-only qualification can run only from the main branch.");
  if (!/^[a-f0-9]{40,64}$/.test(sha ?? "")) fail("qualification source must be a full Git commit SHA.");
  if (!canonicalVersionPattern.test(manifestVersion ?? "")) fail("qualification version must match the canonical root manifest version.");
  if (!/^[1-9]\d*$/.test(runNumber ?? "")) fail("qualification run number must be a positive canonical integer.");

  return {
    artifactLabel: `v${manifestVersion}-pipeline.${runNumber}`,
    version: manifestVersion,
    qualificationOnly: true,
  };
}

export function validateAppEnvironment(environment) {
  if (!environment.RELEASE_PLEASE_CLIENT_ID?.trim()) {
    fail("RELEASE_PLEASE_CLIENT_ID is not configured in the release environment.");
  }
  if (!environment.RELEASE_PLEASE_APP_PRIVATE_KEY?.trim()) {
    fail("RELEASE_PLEASE_APP_PRIVATE_KEY is not configured in the release environment.");
  }
  return true;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`required release metadata is missing or invalid JSON: ${path}`);
  }
}

export function loadConfiguration(cwd = process.cwd()) {
  const releaseConfig = readJson(`${cwd}/release-please-config.json`);
  const releaseManifest = readJson(`${cwd}/.release-please-manifest.json`);
  const packageJson = readJson(`${cwd}/package.json`);
  const manifestVersion = validateConfiguration({ releaseConfig, releaseManifest, packageJson });
  return { releaseConfig, releaseManifest, packageJson, manifestVersion };
}

function writeOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) fail("GITHUB_OUTPUT is required to publish validated release metadata.");
  appendFileSync(outputPath, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function main() {
  const [mode, tag] = process.argv.slice(2);
  const configuration = loadConfiguration();

  if ((mode === "config" || mode === "app-config") && tag === undefined) {
    if (mode === "app-config") validateAppEnvironment(process.env);
    process.stdout.write(`Validated release configuration for ${configuration.manifestVersion}.\n`);
    return;
  }
  if (mode === "tag" && tag) {
    const parsed = validateTagAgainstConfiguration(tag, configuration);
    writeOutput({
      artifact_label: parsed.tag,
      version: parsed.version,
      qualification_only: "false",
    });
    process.stdout.write(`Validated ${parsed.tag} against the root package and release-please manifest.\n`);
    return;
  }
  if (mode === "qualification" && tag === undefined) {
    const qualification = validateQualificationRun({
      eventName: process.env.GITHUB_EVENT_NAME,
      refType: process.env.GITHUB_REF_TYPE,
      refName: process.env.GITHUB_REF_NAME,
      sha: process.env.GITHUB_SHA,
      runNumber: process.env.GITHUB_RUN_NUMBER,
      manifestVersion: configuration.manifestVersion,
    });
    writeOutput({
      artifact_label: qualification.artifactLabel,
      version: qualification.version,
      qualification_only: "true",
    });
    process.stdout.write(`Validated read-only qualification for main at ${qualification.version}.\n`);
    return;
  }
  fail("usage: metadata.mjs config | app-config | tag <release-tag> | qualification");
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release metadata validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
