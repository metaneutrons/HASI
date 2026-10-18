# Qualified main deployment — implementation and runtime evidence

Work started 2026-10-18 for #79, against main
`b815fa43ee202c5161db71704c5660c3f4a4b8f9`. Acceptance authority is
[CD-A1–CD-A6](../../plans/releases-and-demo.md#qualified-main-deployment--79).
The first sections preserve the implementation checkpoint; subsequent sections
record actual rollout, restart and rollback evidence. #79 owns final acceptance
and readback of the last documentation-only main merge.

## Implemented boundary

- CD-A1/CD-A2: outbound-only fixed-repository controller, current-main and
  attempt-specific CI/job checks, durable authorization/submission journal,
  restart reconciliation and completed-SHA replay fencing. No public controller
  route, server credentials in Actions or native push-triggered deployment.
- CD-A3: native Coolify Git/Dockerfile app `tjzdwweelb3zhjtfpgzvjs8k`, pinned
  source commit, immutable image revision, runtime-only application secrets.
  The dedicated controller credential has read/write/deploy, without root or
  sensitive-read permission. Protected fnox and root-only runtime custody were
  provisioned; expiry is 2027-10-18.
- CD-A4: existing database service/container/volume and namespaces are retained.
  Native application uses the existing private resource network and owns no
  database volume. Original demo secret and provider/database credentials are
  reused. An existing signed test session with explicit mock consent and a
  confirmed synthetic booking is held in memory for the live continuity check.
- CD-A5: readiness reports the image revision after checking durable storage
  and existing budget admission, with no inference or budget bootstrap.
- CD-A6: operator runbook and retained-image rollback path are documented;
  actual rollback/rollforward is still pending at this checkpoint.

## Measured local and preparatory evidence

- 764 tests in 88 files passed with isolated PostgreSQL 18 and existing coverage
  thresholds. Includes 16 controller tests and eight readiness cases: wrong
  repository/workflow/branch/event, unsuccessful/incomplete CI, duplicate jobs,
  moved main, replay, corrupt journal, restart/rerun and uncertain submission,
  wrong revision and redacted storage/budget failures.
- Full lint, root/web type checks, backend build, actionlint, Lefthook validation
  and 48 release-script tests passed. The source lockfile did not change.
- Live read-only GitHub contract check resolved main through smart Git HTTP,
  selected successful CI run `39168714435` at `b815fa4`, and verified its actual
  attempt-specific jobs. No GitHub credential was used for this check.
- The compiled controller passes the pinned Node 24 container's syntax check.
  Raw-TypeScript `node --check` was not portable to that runtime, so CI now
  explicitly compiles the controller and checks emitted JavaScript on both
  supported Node versions; the service runs the compiled `.mjs`.
- The actual Node health command was exercised in an isolated Node 24 container:
  valid readiness exited 0; HTTP 503 and an unbound revision exited 1.
- Coolify's initial already-qualified-main standby build exposed its default
  curl/wget health probe, neither present in the minimal image. Those preparatory
  deployments were cancelled without changing the public app. The native
  application is now configured for the explicit Node health command included
  in this change. These cancelled jobs are not successful rollout evidence.
- A fresh encrypted PostgreSQL backup completed with systemd result success.
  Initial observation: 221 stored rows, two shared-budget records, unchanged
  original database container and volume. Test setup subsequently adds its own
  isolated records; a raw whole-database count is not a preservation assertion.

## Original runtime qualification checklist

The original checkpoint required a merge only after exact-head CI passed, then
private controller startup,
automatic admission of the exact successful main revision, first source-app
handoff, signed-session/booking continuity, unchanged database identity and
budget records, public revision readiness, unauthorized-trigger denial,
controller restart replay fencing and retained-image rollback/rollforward.
Record source/image/deployment identities in #79 and the follow-up evidence.

M7 encrypted-artifact restore/off-host operations and final institutional M8
remain separate. This work performs no model inference, real booking write,
budget reset, release tag or GHCR publication.

## Qualified main merge — 2026-10-19

[PR #82](https://github.com/metaneutrons/HASI/pull/82) merged after all exact-head
checks passed in [CI 39170490750](https://github.com/metaneutrons/HASI/actions/runs/39170490750).
Its main revision is `9378a1d9e9b4a5c3735244f1359b6c79cda789fd`;
[exact-main CI 39170758100](https://github.com/metaneutrons/HASI/actions/runs/39170758100)
also succeeded. The controller was enabled after the merge, while this main CI
was pending. Its journal remained empty and it reported `ci_pending`, without
a Coolify submission. Live missing/invalid bearer probes each returned HTTP 401.

At `2026-10-18T22:10:19Z`, the regular controller loop automatically submitted
Coolify deployment `xvtiktbl23onuypcust4feak` for that exact SHA and CI attempt 1.
No manual `/deploy` request authorized this revision. The durable journal bound
the CI run, source SHA, submission time and returned deployment identity.

## First source-app handoff

Deployment `xvtiktbl23onuypcust4feak` finished successfully. The healthy native
container is `tjzdwweelb3zhjtfpgzvjs8k-20261018T221019`, image
`sha256:330ff18ca091119c30b4671f1121defaaefe297ace5f36aa36673d25cea243e0`.
Both its OCI revision label and runtime readiness bind the exact main SHA.
The original web container was stopped only after internal readiness; the
public router and existing rate-limited chat routes now use `hasi-main@docker`.
Public HTTPS root returned 200 over IPv4; revision readiness also passed over
IPv6. Coolify now saves only the database definition under the original data
resource; its generated on-disk Compose retains the same actual volume.

The existing signed test session, linked mock-plugin consent and original
confirmed synthetic booking passed through the public API after handoff, using
the same cookie retained only in observer memory. Database container identity
`6d79e835e0ac43c41ee44058ae96664b2a3b934104f3ee3e1c9ce59d401b5c35`
and volume `64vadvq4uowpfrr9l0rlrcg1_hasi-postgres-data` remained unchanged.
Both shared-budget records retained digest
`af705c3a1077792bff30de1b7d8a7c66fba92446bd4b07a47be360e9dff80b19`.
Runtime credential equality was checked without printing values; the built
image contains none of the four database/session/provider credentials and the
app owns no mounts. Whole-store row counts are not a continuity assertion:
normal demo initialization cleans expired records; active state and the budget
ledger were checked independently.

A documentation-only main merge and actual retained-image rollback/rollforward
are the remaining qualification steps. Final identities and readback are kept
in [#79](https://github.com/metaneutrons/HASI/issues/79) to avoid a recursive
documentation/deployment loop. This record does not pre-claim those results.

A real controller restart resumed the submitted job and completed it after
public health verification, retaining the original deployment identity. This
also exposed Node PID 1 signal handling: Docker had to kill the original service
after its stop timeout. The follow-up service uses `--init` and recognizes clean
SIGTERM exit 143, while preserving failure handling for unexpected exit 137.
That service correction precedes the final documentation-only merge probe.

## Regular rolling update and controller stop — 2026-10-19

[PR #83](https://github.com/metaneutrons/HASI/pull/83) passed exact-head
[CI 39171424116](https://github.com/metaneutrons/HASI/actions/runs/39171424116)
and merged as `5aa22c096d18cf155969cc6bfb28eee7b97c3a29`. Its exact-main
[CI 39171629493](https://github.com/metaneutrons/HASI/actions/runs/39171629493)
also passed. The normal controller loop submitted deployment
`9ewrvjv7ef7r1pgsykcmxtfj` at `2026-10-18T22:22:00Z`, then Coolify completed
the regular rolling update without an operator traffic switch. The stable
healthy container was `tjzdwweelb3zhjtfpgzvjs8k-20261018T222200`, image
`sha256:265f30ee0ec41f55532d2b060a5ec3eeee056e4dc2ebf5c02ac0d1777cab4af9`.
Session, consent and original-booking checks passed through both versions during
the overlap; credentials, database identity and both budget records again matched.
Anonymous POSTs reached both rate-limited chat routes and returned HTTP 401,
without inference.

With the init-enabled unit running, an actual stop took 0.23 seconds and
reported systemd `Result=success`, `ExecMainStatus=143`. A first immediate
start/stop probe raced Docker container creation and was not a valid steady-state
stop measurement; it was repeated after verifying the named container was
running with init enabled. Subsequent restart reported replay, and Coolify's
history still contained exactly one deployment for the first qualified SHA.

## Immutable-image rollback and rollforward

With both automatic jobs completed in the durable journal, admission was
stopped without changing that journal. Coolify rollback deployment
`vzcmh7hjfgypolb2cmumixuy` finished at the first source SHA `9378a1d…` and reused
exact image ID `sha256:330ff18ca091119c30b4671f1121defaaefe297ace5f36aa36673d25cea243e0`.
The single remaining healthy container and public readiness reported that prior
revision. Rollforward deployment `wr38wcpunjmvzceu1gwuajw9` then finished at
`5aa22c0…`, reusing exact image ID
`sha256:265f30ee0ec41f55532d2b060a5ec3eeee056e4dc2ebf5c02ac0d1777cab4af9`.
The running original session/consent/booking observer passed through both
changes. Database container/volume identity and both complete budget records
matched before rollback and after rollforward. No budget policy, consumption,
secret or namespace was reset; no inference or real-system write occurred.

The controller resumed with its existing completed records. The native app's
root-only `0700` work directory remained protected across rollback/rollforward.
A second isolated signed session and synthetic booking, created before the final
documentation merge, observe that last update in memory. The original observer
can then finish without saving its cookie. Final exact-head/main CI, automatic
deployment, image/revision readiness and unchanged-ledger readback for that
**documentation-only** merge are recorded in #79 after they actually pass.
This avoids claiming evidence from a future merge or creating another evidence
commit that would recursively require a new deployment.

Limits: cancelled preparatory health-probe jobs are not successful deployment
proof. A real controller stop/restart and retained-image rollback were exercised;
no destructive database-restore experiment or deliberately broken main merge was
performed. Those operational restore and institutional acceptance gates remain
M7/M8. Future schema changes require a migration-specific compatibility plan.
