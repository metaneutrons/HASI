import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

test("pushes only each previously qualified native leaf before assembling the final index", () => {
  assert.match(workflow, /docker push --platform "linux\/\$\{architecture\}" "\$image"/);
  assert.match(workflow, /docker pull --platform "linux\/\$\{architecture\}" "\$image"/);
  assert.doesNotMatch(workflow, /^\s*docker push "\$image"\s*$/m);
});

test("only retries stable registry tags after exact qualified digest checks", () => {
  assert.match(workflow, /registry-preflight\.mjs candidate/);
  assert.match(workflow, /candidate_amd64_exists/);
  assert.match(workflow, /candidate_arm64_exists/);
  assert.match(workflow, /CANDIDATE_VERSION_DIGEST/);
  assert.match(workflow, /if \[ "\$CANDIDATE_VERSION_EXISTS" = true \]; then[\s\S]*?docker buildx imagetools create/);
  assert.match(workflow, /Check release order before mutable alias writes[\s\S]*?release-state\.mjs assert-monotonic/);
});

test("serializes production release workflows while isolating read-only qualification runs", () => {
  assert.match(workflow, /group: \$\{\{ inputs\.qualification_only && format\('container-release-qualification-\{0\}', github\.sha\) \|\| 'container-release-production' \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});
