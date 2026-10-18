# Reference plugin offline packaging repair

Recorded 2026-10-18 for the PR #78 repair candidate. This record covers the
packaging CI blocker, not complete P6 acceptance. Current execution ownership
is M2 #49, P6-A1–P6-A4; former #74 retains historical evidence.

## Failure and repair boundary

Hosted CI 39166943626 and 39167620173 failed the reference qualification on
Node 24 and 26. The previous subprocess wrapper hid the pnpm failure category.
A controlled local reproduction used a fresh `XDG_CACHE_HOME`, no user npm
configuration and the existing package-content store: offline production
deployment failed with `ERR_PNPM_NO_OFFLINE_META` and
`ERR_PNPM_META_FETCH_FAIL`. Adding `--frozen-lockfile` alone still failed.
The workspace installation therefore did not establish a complete deployment
metadata cache, even with dependency content already present.

`pnpm reference:prepare` now explicitly deploys the SDK's production graph to
a temporary directory online, with a frozen lockfile and the normal pnpm
supply-chain policies. It removes that temporary deployment afterward. CI
shares a fresh job-local metadata cache between this step and qualification.
The pre-push test command and README specify the same preparation dependency.

Actual artifact packaging continues to use `--offline --frozen-lockfile
--ignore-scripts --ignore-pnpmfile`. There is no automatic network retry,
lockfile-trust override, skipped qualification or reduced assertion. Missing
offline inputs fail the build. Only fixed error categories, the command phase
and numeric exit status leave the subprocess wrapper; raw output is discarded.

## Local evidence

- Controlled fresh metadata cache: offline deployment failed before preparation;
  explicit online preparation succeeded, then offline deployment succeeded.
- Full artifact CLI succeeded under macOS `sandbox-exec` with
  `(version 1) (allow default) (deny network*)`, using the prepared metadata
  cache. This includes SDK compilation, offline deployment, manifest parsing,
  file inventory and license inventory, with all network access denied.
- Artifact: `hasi.reference` v1.0.0; 8,301 payload files and 72 runtime package
  inventory entries. Payload SHA-256:
  `a70e7e2aeab51848bcbddbf5c04716c39c5e9293891a5e6fb04818eab4844bd5`;
  artifact-manifest SHA-256:
  `54d23f63bda344745813b89bf4d940ddf420e6720fef7dbaedcbe879a4afb095`.
  These identify this local artifact, not a published container.
- Source `pnpm-lock.yaml` remained byte-identical, SHA-256
  `601065a0ffec48867ab5d5a59e1a0f24fbaf8c141efa79fd18d9667c6f9d2003`.
- 740 tests in 86 files passed with isolated PostgreSQL 18, including the real
  reference process lifecycle and 12 subprocess error/redaction cases.
  Coverage passed existing thresholds: statements 79.58%, branches 75.57%,
  functions 87.82%, lines 87.12% (configured backend/service scope).
- Full lint, TypeScript checks, Lefthook validation and actionlint passed;
  all 48 release-script tests passed. No release was created.

## Limits

Hosted Node 24/26 results for the pushed repair must be recorded in PR #78
and M2 #49 before merging; earlier failed runs are not acceptance evidence.
This repair does not qualify actual-device accessibility, deployed immutable
plugin isolation, multi-replica recovery or the remaining P1–P6 matrix.
Institutional acceptance remains final M8 #80. No model API calls, budget
reset, live source access, business writes or container publication were used.
