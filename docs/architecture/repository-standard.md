# Repository standard

## Scope

The public repository contains the HASI prototype and its public documentation.
It does not contain real identities, credentials, bookings, authenticated
source captures, or derived corpora. The demo uses synthetic data and does not
connect to real SSO, anny, or knowledge services.

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
Actions are pinned to commit SHAs. `CI Success` is the aggregate status intended
for branch protection; make it required only after an actual successful
workflow run reports that context.

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

## Release boundary

There is no release workflow, production tag, GitHub release, or package
publication in this prototype setup. The release-please configuration and
manifest record the future versioning format only; they have no workflow
trigger. Adding a release workflow or publishing artifacts requires a separate
review of the supported release contents, version, and distribution channel.
