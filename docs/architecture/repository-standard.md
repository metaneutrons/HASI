# Repository standard

## Scope

The public repository contains the HASI prototype and its public documentation.
It does not contain real identities, credentials, bookings, authenticated
source captures, or corpora derived from protected source text. An explicitly
authorized exception is the sanitized, read-only 30-room/9-service catalog
snapshot described in [room provenance](../evaluation/anny-room-snapshot.md).
Knowledge documents, identities, availability and bookings are synthetic. The
demo does not connect to real SSO, anny, or institutional knowledge services.

The pinned official anny OpenAPI specification is prepared by the explicit
`pnpm research:anny` command. CI runs that networked, checksum-verified
preparation on a clean checkout before contract tests. Test commands do not
perform implicit network access. Authenticated service research remains local
and is excluded from version control.

## Toolchain and checks

The workspace uses Node.js 24 LTS as its minimum and also checks Node.js 26 on
Ubuntu 24.04. pnpm 12.11.2 is pinned in the root package manifest and lockfile.
Build runs before type checks and tests because workspace package declarations
are generated into `dist`.

Pull requests and pushes to `main` run lint, hook-configuration validation,
build, type checking, schema preparation, coverage-enforced tests, a full
reachable-history secret scan, dependency audit, and commit hygiene. GitHub
Actions are pinned to commit SHAs. `CI Success` is an actual, required aggregate
status under the active default-branch ruleset; pull requests must be up to date
and pass it at their exact head before squash merge.

Local Lefthook checks provide fast feedback on staged files, commit messages,
and secrets. Pre-push checks build backend declarations before type checking and
tests. The explicit schema preparation command is not run by Git hooks. Hook
installation runs only in a local Git checkout; CI and deployment source
uploads without `.git` skip that step.

## Development dependency advisory

On 2026-10-16 the full dependency audit reports
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
for `braces@3.0.3`, reachable through the Next.js ESLint development toolchain.
The upstream advisory lists no patched release. The production dependency
audit passes; ESLint and its glob patterns are not exposed to demo visitors.
The CI gate explicitly audits production dependencies. This is not a claim
that the complete development dependency graph has no known advisories.

## Demo delivery and release boundary

Vercel's Git integration deploys `main` to `hasi.metaneutrons.cc`, including
documentation-only merges. It is separate from versioned container delivery.
The tracked ignore command continues every build; the project-level
skip-unaffected optimization is disabled. Preview protection remains enabled.

Release Please owns production versions, tags and draft GitHub releases. Its
dedicated GitHub App has the only creation bypass in a separate `v*` creation
ruleset. The existing immutable-tag ruleset still forbids updating or deleting
those tags without a bypass. Publication credentials reside in the `release`
environment, restricted to `main` and `v*`; no repository publication secret is
used. The App's installation token is narrowed to this repository.

The container workflow is dispatched at the exact tag by Release Please. Native
Linux amd64 and arm64 payloads must pass smoke checks, signing, provenance,
SBOM and draft readback before versioned GHCR publication and stable promotion.
Read-only qualification dispatches on `main` use an artifact label only;
they create no tag, GitHub Release or GHCR image and cannot move stable aliases. The current image is an explicit demo runtime; shipping it does
not provide institutional SSO or production authorization. Configuring this
workflow is separate from verifying its real Release Please and registry path.

The [delivery plan](../plans/releases-and-demo.md) defines the acceptance gates;
its linked issues record the exact merged, qualified and published states. No
stable release or GHCR image is claimed by this architecture document.

## Known Doctor findings (2026-10-16)

The read-only GitHub audit passed 17 API checks with no failures. At that audit,
the web TypeScript configuration did not yet inherit all shared strict options,
and its Next.js ESLint configuration was not type-aware strict ESLint. Coverage
thresholds applied to the selected backend/services, not the entire frontend.
At the 2026-10-16 audit, the older MVP plan lacked epic/milestone tracking.
That tracking gap is addressed by the [MVP epic #47](https://github.com/metaneutrons/HASI/issues/47)
and [roadmap epic #55](https://github.com/metaneutrons/HASI/issues/55) on 2026-10-18.
The TypeScript and ESLint statements above describe the 2026-10-16 audit state;
they were superseded by the later configuration migration below.

## WEB-A1 configuration reconciliation (2026-10-19)

At main `442897d`, [`apps/web/tsconfig.json`](../../apps/web/tsconfig.json)
extends [`tsconfig.base.json`](../../tsconfig.base.json) and keeps the shared
strict compiler options while overriding Next-compatible target, library,
module and bundler settings. The old finding that the web project did not inherit
the shared strict options is stale.

[`apps/web/eslint.config.mjs`](../../apps/web/eslint.config.mjs) combines Next
Core Web Vitals and TypeScript rules with `strictTypeChecked` and
`stylisticTypeChecked` rules for TypeScript files. It supplies the web tsconfig
as the type-aware ESLint project. The old finding that web lint was not
type-aware strict ESLint is also stale.

The coverage boundary is unchanged. [`vitest.config.ts`](../../vitest.config.ts)
discovers tests under `apps/**`, including web tests, but coverage thresholds
include shared packages, the API, the Anny plugin and the knowledge plugin; web
source is outside that threshold set. This records the actual gate and does not
set a blanket frontend-coverage target.

WEB-A1 is tracked in [M2 #49](https://github.com/metaneutrons/HASI/issues/49),
transferred from superseded #67. Its web compiler/lint configuration gap is
implemented. The plan still requires Node 24/26 CI and meaningful affected
workflow qualification; green configuration checks do not establish the full
admin/chat journey, native-device acceptance or M2 acceptance. The current
evidence and remaining qualifications are reconciled in the
[dated WEB-A1/BUD-A1/P2-A4 record](../verification/2026-10-19/m2-evidence-reconciliation.md).
