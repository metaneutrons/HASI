# Qualified main deployment — implementation checkpoint

Work started 2026-10-18 for #79, against main
`b815fa43ee202c5161db71704c5660c3f4a4b8f9`. Acceptance authority is
[CD-A1–CD-A6](../../plans/releases-and-demo.md#qualified-main-deployment--79).
This checkpoint records implementation/local evidence, not completed runtime
acceptance. #79 owns subsequent exact-revision rollout and rollback evidence.

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

## Pending runtime qualification

Merge only after exact-head CI passes. Then prove private controller startup,
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
