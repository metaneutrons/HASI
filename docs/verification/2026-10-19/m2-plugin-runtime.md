# M2 durable plugin route qualification

Date: 2026-10-19. Baseline: `a9c47b5e8bbab3b4dfc46731d0f635e010b1ee69`.
Scope: technical M2 #49, P5-A3/A4 route metadata and operation fencing.
This is a bounded evidence record, not full P5/P6 acceptance.

## PostgreSQL with distinct operator processes

`tests/plugin-route-postgres.test.ts` starts two real Node child processes using
`tests/fixtures/plugin-route-process.ts`. Each has its own PostgreSQL client and
`PluginRouteController`, sharing one random test namespace/scope. The fixture
uses an IPC command protocol and an explicit environment allowlist. It never
inherits model/plugin credentials or prints database URLs. Both URL guards
require a literal loopback address, explicit port and database path, without
query or fragment overrides.

The database-backed run passed nine cases: eight URL admission/counter-cases and
one stateful multi-process route scenario. Root repeated it alongside the six
existing controller cases: **15 tests passed** against PostgreSQL 18.6 on Node
v26.11.1. Affected ESLint and the full root TypeScript check passed after root
integration. Without `TEST_DATABASE_URL`, the eight guards run and the database
scenario explicitly skips; CI supplies PostgreSQL and must run it.

The stateful scenario proves:

- Two processes compete from the same active base; exactly one activation
  commits and the other retains a terminal `not-committed` fence.
- Retrying an earlier committed operation after a later activation does not
  route traffic metadata back to the old deployment.
- A changed configuration revision fences stale activation; a rollback with
  mismatched deployment/digest pins fails and an exact matching rollback succeeds.
- A fixture commits an activation and disconnects before returning its IPC
  reply. The parent observes failure rather than assuming success. A replacement
  process reads the committed route and operation journal from PostgreSQL;
  replaying that operation changes neither the route nor its revision.

All child processes and temporary configuration files are removed with bounded
shutdown; failure to terminate is a test failure. No business tool, real vendor
mutation, model call or production database is involved. The caller-owned local
database is disposable.

## Remaining runtime gates

These are operator route-authority processes, not independently executing plugin
containers. The test does not prove container health, filesystem/credential/
network/resource confinement, real gateway traffic, external publisher/artifact
distribution, state migration, current credential revocation or full deployment
coordinator recovery. Those P5/P6 gates remain separate. The integrated model
budget and browser/admin matrices also remain M2 work; actual-device and
institutional acceptance remains M8-A1–A7.
