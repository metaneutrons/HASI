# Core registry epoch cutover qualification

Date: 2026-10-19. Supporting M2/P1-A4/P3-A3/P5-A3/A4 evidence;
not full M2 acceptance or a live Coolify cutover.

The signed registry field `lifecycleRevision` is an intentional pre-release
reader incompatibility. The operator procedure in
[the deployment runbook](../../../deploy/coolify/main-deployment.md#one-time-core-epoch-cutover)
requires a one-time stop-before-start handoff, no old writers, and recovery with
only the first qualified epoch-aware core or a later compatible image. Database,
secrets, namespaces, budget usage and existing sessions must remain in place.
The managed plugin installer and its route state are separate.

## Actual local process exercise

The guarded qualifier uses a passwordless loopback `hasi_topology_test` database,
a random owner-marked namespace, a real loopback MCP fixture and separate Node
processes. Synthetic signing keys and service credentials are passed over stdin
and are not printed. Its external legacy source root is an explicit operator
input; the clean registry source is pinned to commit
`e9a28743d5fe2338509d6c9e5f4bd4dda1c33501`. This is the pre-epoch main-tree
candidate from PR #112. The pin/clean check covers registry.ts, not a complete
historical dependency tree. Root made no concurrent registry-source edit during
the recorded run; this is a controlled exercise, not an untrusted build attestation. The current registry under test is from
`c10d3ee06c6bfd0700c68455d259ce341f093c74`.

Root's Node v24.21.0 run passed the following sequence:

1. A legacy process seeds and reads a signed record without an epoch and remains
   alive until explicitly drained.
2. SIGTERM completes cleanly and the old PID is gone before the new process
   starts. No old/new writer overlap is used.
3. The new registry validates the original signature without mutating that row.
   Disable/re-enable commits an epoch and changes the action binding. A signed
   native MCP read succeeds.
4. Another new OS process validates the same signed epoch and stable binding
   after reconstruction and performs another native MCP read.
5. Only after the new workers exit, an old decoder rejects the new signed row
   without changing its revision/value. It is a negative decoder probe, not an
   allowed old-writer recovery path.
6. Labeled synthetic session, budget and proposal sentinel values and UUID
   revisions remain unchanged. All five exact owned keys are removed and their
   absence verified. The database/namespace is not dropped.

The command was executed with an empty inherited environment apart from the
listed local operator inputs and normal executable paths:

```sh
HASI_CORE_EPOCH_CUTOVER_QUALIFY=1 \
HASI_CORE_EPOCH_LEGACY_ROOT=/absolute/path/to/reviewed-legacy-checkout \
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32775/hasi_topology_test \
pnpm exec tsx scripts/qualify-core-epoch-cutover.ts
```

The source-only qualifier is import-safe and requires explicit opt-in. Twelve
preflight tests reject missing opt-in, a relative legacy root, non-qualification
or authenticated/parameterized database targets and inherited production/PG
overrides. Root passed 61 focused cases across that suite, invalidation ledger,
proposal guard and lifecycle API; scoped lint and full TypeScript pass separately.
The signed deadline's tamper countercase makes zero audit projection writes.

## Limits and delivery boundary

The [sanitized result](core-epoch-cutover-result.json) records the exact
qualifier/worker/configuration/registry hashes and process identities. An
independent read-only review found no normal-path blocker. The worker emits one
fixed result; its parent does not enforce a general hostile multi-message
protocol. Cleanup validates an unguessable owner-marked namespace and then
deletes exact known keys; it is not revision-conditional deletion against a
concurrent hostile writer. Neither limitation is claimed as a production
isolation proof. Sentinels
are generic storage controls, not the real session or budget implementation;
those have separate topology evidence. The proposal check compares a stored
binding and does not call the confirmation API. The actual API pending/unknown,
claim race, changed-binding, retention and retry cases are separate tests.

This exercise uses source processes, not the deployed Coolify image, real
traffic, institutional SSO or a managed plugin worker. It authorizes no old-core
rollback. Required exact-head/main CI and the actual persistent controller pause,
old-container drain, retained database/session/budget checks and exact new-image
readiness remain the delivery step. No provider, real booking, production data,
credential rotation, budget reset or release occurred here.
