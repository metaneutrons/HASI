# Successful-run / pending-job consistency

Date: 2026-10-19. Baseline `11148d29cc1bb024c8c6110317c78ad65086da7f`
with the source identities below. Scope: the separate deployment controller's
technical CI authorization gate, using synthetic transport fixtures.

## Observed deployment blocker

The live controller recorded main run `39283986510`, attempt 1, commit
`11148d29cc1bb024c8c6110317c78ad65086da7f` as rejected with
`ci_jobs_invalid`. A subsequent read of GitHub's overall run reported
`completed / success`, while its attempt-scoped job view still reported
`CI Success` as `in_progress` with a null conclusion. Other displayed required
jobs had succeeded; main-only commit hygiene was skipped. The controller's
original exact response was not retained, so the particular pending job at its
rejection time is not proven. The inconsistent combination itself is observed
and reproduced by the fixture.

Rejecting authorization was safe; recording that potentially temporary view as
a final rejection prevented this same attempt from being reconsidered when the
job view converged. Public HASI remained ready on the previous `bd59928` image.
No deployment was submitted for the rejected attempt.

## Change and checks

A well-formed complete set of required job identities may now contain queued or
in-progress entries with null conclusions. That yields `waiting /
ci_jobs_pending`, without a journal write, Coolify request, SHA pin or deployment
submission. A later poll must still obtain the exact trusted run, attempt,
current main commit and fully successful required jobs before normal deployment
authorization. The public boolean verifier remains false for pending jobs.

Malformed values, duplicate names, foreign attempts, missing required jobs and
terminal failures remain invalid. A terminal failure is not concealed by
another pending entry. Existing main-movement, application-binding, uncertain
submission, replay and exact-revision readiness checks are unchanged.

The focused controller suite passes 18 tests, including a pending-to-success
transition with no pending-state side effects and one subsequent submission,
and mixed invalid/pending views. Controller compilation, `node --check`, scoped
lint and whitespace checks pass. Full PostgreSQL pre-push passed 1,071 tests with one platform skip across
114 files, backend build, root/web types and secret checks. All five exact-head
checks passed in CI `39288085139`. PR #119 merged as `31fbf29`; exact-main
CI `39289119670` passed. The head and merge have identical trees.

Historical rejected journal records are not deleted or automatically reopened.
The live old attempt remains rejected until an explicitly justified operational
recovery or a fresh qualified main attempt. This change alone does not establish
that the current daemon has been updated, that a newer image is deployed, or
that M7 is accepted.

## Tested source identities

| File | SHA-256 |
| --- | --- |
| `scripts/deploy/controller.ts` | `ccaddf0f7b077353893a43231b2a509dca08825b013f0a5d8ebbb107af03d5e2` |
| `tests/deploy-controller.test.ts` | `a0f73fc5d952b1ad915d984f9e64e7854caaa1839df8ce2a21124d48539856ca` |


## Live daemon and deployment observation

The old controller was stopped before the reviewed merge, to avoid recording
another permanent rejection from a temporarily inconsistent job view. The
compiled controller passed the pinned Linux Node syntax check and was installed
atomically. Its SHA-256 is
`44ffce5e3cf7b7946429f6aa1570c9fe6b244aaa432a2fe31bb919a1e052b74e`;
the running read-only mounted file matched. The systemd service was resumed
and remains enabled. Historical rejected records were retained.

After complete exact-main CI, the controller automatically submitted Coolify
`vojaxrkvluldntcurh6iq5oq` for `31fbf29c83ba587bc2028f3adafe321a0bb5aaae`.
Public readiness returned that exact revision. A later disk-full incident
interrupted PostgreSQL and the control plane; this job ultimately failed rather
than receiving an invented success or journal reset. See
[the disk recovery record](demo-disk-recovery.md). Public HASI recovered on
`31fbf29`. The next ordinary main revision, PR #118's `e2d6b7c`, is the pending
fresh complete automatic-delivery proof. This observed submission does not by
itself establish completed delivery or M7 acceptance.
