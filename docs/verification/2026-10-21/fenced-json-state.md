# Fenced JSON state: storage-level qualification

Date: 2026-10-21 (Europe/Berlin). Related to #49 P5-A3/P5-A4 and technical M7
#54. Candidate based on `45c749cbed3b92b596a58227231a71f53b9a95b9`.

## Observed checks

Node24 local focused run: **18 passed, 2 files, 3.78 seconds** (12 PostgreSQL
cases, 6 memory cases). Command executed against the existing explicit disposable
loopback database:

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32775/hasi_topology_test pnpm exec vitest run packages/state/tests/fenced-postgres.integration.test.ts packages/state/tests/fenced-memory.test.ts
```

The PostgreSQL suite creates a unique schema and drops only that schema. It
retains the caller's database and other schemas. Children inherit only PATH;
test configuration travels over IPC and is restricted to an explicit literal
loopback PostgreSQL URL. No provider credentials, external service calls or
production state were used.

Positive checks cover read/create/update, expired-target replacement, namespace
isolation and caller-input snapshots while actual pool acquisition is blocked.
Counterprobes deny stale/missing/expired authority and stale target revisions
without target disclosure or mutation. Memory tests also reject malformed,
duplicate, self-referential and oversized fence sets and verify copy isolation.

Actual independent OS processes use separate database connections. Exactly one
of two competing target CAS writes succeeds; a replacement reader observes the
committed value. Lock tests observe `pg_blocking_pids`, rather than assuming
contention from a timer:

- Route replacement while the state writer waits invalidates its old fence.
- A state writer holding its route lock blocks an ordinary route CAS until its
  own target transaction finishes.
- A fence expiring during an observed lock wait is rejected after the wait.
- A missing authority row inserted after the locking snapshot is rejected,
  even when deliberately given the previously known revision.
- A held lock triggers a bounded database timeout; rollback restores the
  connection's previous timeout settings and a subsequent valid write works.

One child commits and deliberately omits its IPC acknowledgement, then exits.
A new child reads the persisted value; repeating the create CAS fails. This
proves storage recovery for that synthetic omitted acknowledgement. It does
not simulate a lost network response or prove business-action idempotency.

Affected ESLint, root TypeScript and whitespace checks passed. Full pre-push,
hosted CI and delivery are separate gates; this report alone makes no claim
about them.

## Scope limits

These are storage-level tests, not managed-plugin HTTP/token verification,
Docker deployment/update/rollback, migration compatibility, remote artifact
provenance, browser/mobile acceptance or human model evaluation. No runtime
endpoint or plugin storage wiring is introduced. See the
[architecture boundary](../../architecture/fenced-json-state.md).

## Tested source identities

| File | SHA-256 |
| --- | --- |
| `packages/state/src/store.ts` | `0b5d8c4f01f33a419ac9146483f7398dad46dc4f7ccd37e9fd6e29de0a974319` |
| `packages/state/src/memory.ts` | `040a5b0c3b16d09ea3c7a627143e379689ef8ca3f0f5b95f263bfa2c2f8e5728` |
| `packages/state/src/postgres.ts` | `1e8e852deb06a7ca4c894fb580a77b8bd6978767ef632d479f52318447d17922` |
| `packages/state/src/index.ts` | `2844acad0a4b53c399510a4388b9d5d1006bbfd8ed4f74e1615bef43ea09ef75` |
| `packages/state/tests/fenced-memory.test.ts` | `3b8cdf31fe768e1bb2d233a61eb2d8f7ac959c7f7e2bcdd098ca2cb2a42b3594` |
| `packages/state/tests/fenced-postgres.integration.test.ts` | `7213185addfb059e590b086751f6b4c641418d2048a07eaa39df9c24959f2858` |
| `packages/state/tests/fixtures/fenced-state-process.ts` | `e0e0b5710c85c25e9d076fb466f16d07c33adb04155bb1e32a40479af987c7b7` |
