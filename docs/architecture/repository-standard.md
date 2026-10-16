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

The read-only GitHub audit passed 17 API checks with no failures. The web
TypeScript configuration does not yet inherit all shared strict options, and
its Next.js ESLint configuration is not type-aware strict ESLint. Coverage
thresholds apply to the selected backend/services, not the entire frontend.
The older MVP plans still lack corresponding epic/milestone issue tracking;
the new delivery initiative has its own linked records. These findings are
reported, not silently repaired by the delivery work.
