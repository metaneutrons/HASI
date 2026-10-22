# M8-A8 encrypted restore exercise — 2026-10-22

**Result:** the local synthetic encrypted-dump/restore check passed. M8-A8
production continuity remains open; this exercise makes no institutional or
production acceptance claim.

The [M8-A8 criterion](../../plans/hasi-mvp.md) requires an encrypted backup
artifact to be restored into an isolated database with complete state,
revisions, expiries and budget ledger compared. It separately requires
continuing off-host replication, independent missing/failed-backup monitoring,
accountable operators and a reviewed
incident/recovery procedure.

## Exercise

At repository revision `b52598d705f938e52213c5bbd7691735bf7e3399`, the proof
script used the current `PostgresJsonStore` and `ModelBudgetLedger` classes to
populate a fresh local database with four synthetic state entries and one
shared-budget row. The state entries included null, future and already-expired
timestamps. The ledger contained one each of `reserved`, `unknown`, `settled`
and `released` reservations.

The script started its own PostgreSQL 16.15 cluster with no TCP listener and a
private Unix socket. It streamed `pg_dump` custom format through age into a
mode-0600 encrypted artifact, then streamed age decryption directly into
`pg_restore` for a second database in that cluster. It compared every normalized
row from `hasi_state_v1`, including JSON values, UUID revisions and expiry
timestamps. Both complete-row SHA-256 digests were
`2fbbfc61e0accf78107f12e761122efecf6554184013a6e745e098f1af5d0593`.

The encrypted artifact SHA-256 was
`7c95c503b057d934d4a96a908f7cd4d05b5e1c8728a97096aba06141625b5597`
(3,347 bytes). A separate copy had its final byte changed; age rejected it with exit code `1`,
no signal, and the bounded diagnostic `failed to decrypt and authenticate payload
chunk, file may be corrupted or tampered with`. This is classified as an
authenticated ciphertext-integrity failure. `pg_restore` was not started for that
copy, and its isolated target database remained empty. The ephemeral age identity
was mode `0600` inside a mode-`0700` temporary directory. The encrypted artifact,
corrupted copy, identity and local cluster were removed after verification.
The machine-readable details are in
[`m8-encrypted-restore-result.json`](m8-encrypted-restore-result.json).

The exact executed one-off operator source is archived as text, outside the maintained application/toolchain sources. It is evidence of this local exercise, not an installed or supported backup command. The archive is
[`m8-encrypted-restore-proof.ts.txt`](m8-encrypted-restore-proof.ts.txt), SHA-256
`f0136d87e97059c35de75c2746b6ad40587fb45989bf1ef87323ae985d3b115d`.
It requires explicit `--execute`, rejects inherited application database URL
variables, refuses to run if a worktree file named `-` exists, uses only
databases it creates itself, and removes its exact temporary cluster and key.

## Existing backup evidence and boundary

The [PostgreSQL cutover record](../2026-10-18/local-postgres-cutover.md)
describes PostgreSQL 18.6 and a prior restore of 201 rows. That restore tested
the dump contents **before** encryption. It also records an encrypted local
backup routine and a one-time encrypted copy to the Mac; decrypting and
restoring that encrypted artifact remained open.

The inspected [`backup-postgres.sh`](../../../deploy/coolify/backup-postgres.sh)
streams `pg_dump` through age into a host-local pending file, atomically renames
the completed artifact under `/data/hasi/backups/postgres`, and deletes local
artifacts older than 14 days. The accompanying
[service](../../../deploy/coolify/hasi-postgres-backup.service) and
[timer](../../../deploy/coolify/hasi-postgres-backup.timer) describe a daily
03:15 UTC host job with a randomized delay and persistent timer behavior. This
exercise did not invoke that script or inspect the deployed service state.

The local toolchain was PostgreSQL/`pg_dump`/`pg_restore` 16.15 and age 1.3.2;
the documented database is PostgreSQL 18.6. The synthetic run verifies an
encrypted artifact pipeline against the current schema, but does not qualify
version compatibility with the production server, its configured recipients,
its installed backup job, or recovery of its operator-held key.

The reviewed script and unit files contain no off-host replication or
independent backup-failure monitoring configuration. This evidence also does
not establish recurring off-host delivery, independent detection of a missing
or failed backup, named institutional operators, or an institution-reviewed
incident/recovery procedure. Those items and a production-version encrypted
artifact restore remain required before M8-A8 can pass.

## Harness corrections

An earlier harness attempt passed `-` as a filename to `pg_dump`; PostgreSQL
created a local plaintext custom-format dump while age received empty input.
That attempt was rejected as evidence. The exact generated file was verified
by its PostgreSQL custom-format signature and removed. The executed proof script
now uses the CLIs' default standard input/output with no filename, verifies the
encrypted output is non-empty beyond the populated-dump floor, and checks that
no worktree file named `-` appears.

A first strict corruption-checker attempt returned age exit code `1` with no
signal, but the then-current classifier did not recognize age 1.3.2’s exact
authenticated-chunk diagnostic, so that attempt was not accepted as evidence. The
classifier was tightened to require the observed authentication/integrity phrases,
exit code `1`, and no signal; the final run above then passed complete row
equality and recorded the sanitized diagnostic and process result.
