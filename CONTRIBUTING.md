# Contributing

HASI is a public prototype, not a production service. Contributions should
preserve that boundary: use synthetic identities and bookings only, and do not
add real Hochschule credentials, bookings, confidential source captures, or
access to live identity or knowledge systems.

## Development setup

Use Node.js 24 LTS or 26 and pnpm 12.11.2. Install dependencies from the
repository root:

```sh
pnpm install --frozen-lockfile
```

Before running the client contract tests on a clean checkout, run the explicit
network preparation command. It downloads and verifies the pinned public anny
OpenAPI specification; the test suite itself does not fetch external data:

```sh
pnpm research:anny
```

Then run the project checks:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test:coverage
```

Build first because workspace packages expose generated declarations from
`dist`. The anny preparation command is also a separate prerequisite in CI,
before tests run on a clean checkout.

## Changes and pull requests

Use English and [Conventional Commits](https://www.conventionalcommits.org/)
for commit subjects and pull request titles. Supported types are `feat`,
`fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and
`revert`; keep subjects at or below 100 characters. Use short branch names such
as `feat/booking-history` or `fix/plugin-check`.

Keep a pull request focused on one kind of change. Explain the user-visible
effect, link related issues, update documentation when behavior or commands
change, and include the checks relevant to the change. Do not add credentials or
confidential source material to issues, commits, fixtures, or test output.

Git hooks run staged-file checks, commit-message checks, and local secret
scanning. Install Gitleaks locally (`brew install gitleaks`). In a local Git
checkout, `pnpm install` installs Lefthook; CI and deployment source uploads
without a `.git` directory skip hook installation. Do not use hook bypasses for
routine work.

## Substantial initiatives

For work with independently reviewable stages, keep goals and acceptance criteria
in a versioned `docs/plans/` document, link one epic and one issue per milestone,
and record execution state and measured evidence in those issues. Small fixes
need no epic. Implementation PRs link their milestone without closing it while
required post-merge or publication checks remain open. See the
[delivery plan](docs/plans/releases-and-demo.md) for the current example.
