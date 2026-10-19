# Live core epoch maintenance cutover

Date: 2026-10-19. Source delivery and bounded synthetic behavior;
not complete M2/P1–P6 or institutional acceptance.

[PR #113](https://github.com/metaneutrons/HASI/pull/113), candidate
`6ed3996a704253485b33e73d4d4077cf21b6a448`, passed all five required checks in
[CI 39268884184](https://github.com/metaneutrons/HASI/actions/runs/39268884184).
Its squash merge `b53701abe4b5cd0bb51c3ef1f67ad7ca8a76d4cf` passed
[exact-main CI 39269556610](https://github.com/metaneutrons/HASI/actions/runs/39269556610).
Candidate and merge have the same tree
`25bc2efc650b0a33c9e638d34c5e501f30ac37b4`.
Local mandatory gates passed 1,067 tests plus one Linux-only macOS skip across
113 files, backend build, root/web types and secret checks. The production
standalone frontend build passed. The local process rehearsal is recorded in
[core epoch cutover](core-epoch-cutover.md).

## Controlled deployment

Before merge, controller admission was persistently disabled and verified
inactive/disabled. Its journal contained 29 settled records; no submitted job
was interrupted. The old public application continued serving while main CI ran.
After main CI succeeded, the old source application and retired bootstrap were
set to restart policy `no`; both were verified stopped with PID zero before
new code could start. The old application image was
`sha256:f45e8c7dcdc4ebe439dc1a688fd3f32f5e0059b055a992543af13da11d2aadff`.

The controller was then enabled and started with its existing journal. It
admitted exact main and submitted Coolify job `sihg6spjtso7usr0d84ehfev` at
`2026-10-19T14:38:47.332Z`. Coolify finished that exact revision at
`14:40:57 UTC`. Public HTTPS readiness returned `ready` and exact `b53701a`;
the controller recorded `completed`, one health check, at
`2026-10-19T14:42:47.808Z`. The running application's image is
`sha256:9b39587597f3e526ef04ac973afedf3101ef74fdfe6e906c17c4c77a3a1f32ad`.
The retired bootstrap stayed stopped and the old source container was removed
by normal deployment cleanup. No old writer was kept for rolling overlap.

This merge/image is the first compatible core floor. Recover only with this
qualified core or a later compatible image; a pre-epoch image is not a permitted
rollback target. Subsequent changes that preserve this state contract may use
normal rolling deployment. The controller is active/enabled again.

## Preserved state and user-visible checks

A root-only content-free fingerprint manifest was captured after old writers
stopped, at `2026-10-19T14:38:35.661Z`. It contained 185 active row identities,
UUID revisions, value digests and expiry timestamps, not database contents or
credentials. Before browser reload, the post-start comparison at
`14:41:44.063 UTC` found all 184 still-valid rows present with unchanged values
and revisions; one baseline row had normally expired. The same PostgreSQL
container and `64vadvq4uowpfrr9l0rlrcg1_hasi-postgres-data` volume remained.
The sole shared-budget record's fingerprint remained
`f41601fe2bec9119dca2ecd4946a782caf6ea0e177423ba18e6ba5ac7ad9eca1`.
This is state-preservation evidence, not a backup or a retention/purge guarantee.
The first comparison attempt had a local tuple-versus-JSON-list comparison
mistake in volume metadata; after normalizing representation, the unchanged
capture was verified. No database or application state was changed to pass it.

The actual public browser had a controlled synthetic employee session and anny
consent before the cutover. Reload loaded the new core while retaining identity,
two chat sessions, selected Dialog-Demo and prior conversation/proposal. A
pre-cutover proposal for a fictional booking returned the definitive invalidated
state on its read-only preflight. The status group received focus and its
confirmation control disappeared. Reload preserved that invalidated card.
The checked proposal's displayed expiry was in the same minute as this check;
this does not claim a separate unexpired-migration timing test.
The own-bookings page showed zero bookings without a connection error; the anny
account panel still showed connected. No model call or real booking was made.
An inactive historical conversation may retain a disabled proposal control;
that is not an enabled confirmation on the invalidated card.

After these browser operations, the same baseline comparison found zero missing
still-valid rows, one intentionally changed proposal row, and the unchanged
shared-budget fingerprint. New timestamp/audit records are outside the baseline
set. No database reset, namespace/secret rotation, budget bootstrap, worker
reinstallation, release or GHCR publication was used.

The operator state check uses read-only SQL hashes and selected Docker ID/mount
metadata; it does not retrieve container environment secrets. The metadata
manifest remains private to the operator. This exercise does not qualify live
institutional writes, native devices, complete managed-plugin lifecycle or all
M7 incident/rollback journeys.
