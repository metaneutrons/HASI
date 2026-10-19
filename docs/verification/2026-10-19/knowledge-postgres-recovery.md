# PostgreSQL-backed knowledge recovery evidence

Date: 2026-10-19. Branch baseline: `afb1cca` (`test/knowledge-postgres-recovery`).
Scope: technical M3 evidence for durable source availability, stale-refresh fencing,
and retained-context authority across PostgreSQL store reconstruction. This does
not accept M3 as a whole or qualify M8 institutional acceptance.

`tests/knowledge-postgres-recovery.test.ts` composes the actual
`PostgresJsonStore`, `ContentSnapshotProducer`, `KnowledgeIngestionWorker`,
`InstitutionalKnowledgeRepository`, and `KnowledgeContextStore`. It uses
synthetic Ed25519 source keys, signed content snapshots and actor/source grants,
with a deterministic fake embedding transport. It contacts no content provider,
model provider, or institutional service.

The scenario ingests two synthetic sources, verifies a permitted employee's
citation and retained context, and denies a second actor. A failed source
acquisition suspends that source. After closing the worker and PostgreSQL pool,
the test constructs a new store, worker, repository, and context store; the
source remains unavailable and the former context cannot be resolved. It then
interleaves a prepared refresh with a later failed refresh and verifies that the
stale refresh cannot reopen the source. A fresh signed snapshot removes the former
employee grant and grants a replacement synthetic employee. The replacement
actor can search and retrieve the fresh document citation; the former employee
and student receive no search result, the old citation is unavailable, and the
old context remains unavailable. The synthetic unchanged documents are not
re-embedded during refresh.

The database is the explicitly supplied disposable local test database; every
test uses a random namespace and removes only its own known keys, then asserts
those keys are absent before closing the pool. Evidence was collected with:

```sh
TEST_DATABASE_URL=<disposable PostgreSQL database> \
  pnpm exec vitest run tests/knowledge-postgres-recovery.test.ts
pnpm exec eslint tests/knowledge-postgres-recovery.test.ts --max-warnings=0
```

The targeted PostgreSQL test passed (1 test) and the scoped ESLint check passed.
Without `TEST_DATABASE_URL`, the test is skipped and provides no persistence
evidence.

Closing and reconstructing the pool and application objects occurs within one
Node process. This is not an OS process or container restart, nor does it qualify
the production launcher, network transport, source freshness under a live
institutional feed, embedding quality, institutional rights, or M8 acceptance.
It supplies bounded evidence for the M3 worker's durable suspension and recovery
path only.
