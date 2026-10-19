# Automatic qualified-main deployment

Execution and qualification: [#79](https://github.com/metaneutrons/HASI/issues/79).
This is source deployment to the existing demo, independent of Release Please
container publication. No GHCR tag or GitHub release is created here.

## Admission and execution

The outbound-only TypeScript controller checks the public GitHub repository at
most once every 120 seconds. Git smart-HTTP resolves current `main`; the fixed
GitHub API supplies that exact revision's CI run and attempt-specific jobs.
The controller requires the HASI repository ID, the fixed CI workflow ID/path,
a `push` on `main`, a completed successful run and successful Node 24/26,
security and aggregate checks. PR, fork, failed, incomplete, stale and replayed
attempts cannot authorize deployment. Moving `main` during admission prevents
the older request from being submitted. There are no changed-path exclusions,
so documentation-only merges are eligible too.

The controller pins the exact admitted SHA in the native Coolify Git/Dockerfile
application, then invokes its private deployment API. Native Git push
auto-deploy and previews stay disabled. Coolify builds the repository Dockerfile
on the existing server and retains three images. Runtime credentials are not
build variables. Enable Coolify's **Source commit availability** setting
(`include_source_commit_in_build=true`) and use manually declared Dockerfile
arguments (`inject_build_args_to_dockerfile=false`). Without the source-commit
setting the image fails readiness rather than reporting an unbound revision.
The source commit is a build argument and immutable runtime
image metadata, exposed by `GET /api/health` with `Cache-Control: no-store`.
That route also checks durable storage and existing budget admission; it makes
no inference call and does not initialize or reset a missing budget.

A durable journal records authorization before effects and submission before
the deployment POST. Restarts reconcile a known deployment or an uncertain
submission instead of blindly repeating it. An ambiguous outcome remains
blocked for operator reconciliation. A successful Coolify job alone is not
completion: public HTTPS readiness must report the admitted revision. A corrupt
or missing journal fails closed. Never recreate it empty to clear an incident.

Only the latest current-main candidate is admitted. CI can cancel superseded
runs; cancelled or failed commits are not deployed. An in-progress qualified
deployment completes before admitting the next current revision. This prevents
out-of-order completion from rolling the demo backward.

## Private management and credentials

There is no inbound controller port, public deploy webhook, Actions deployment
secret, SSH key or ZeroTier controller credential. GitHub data is read through
fixed HTTPS endpoints with redirect rejection, response bounds and timeouts.
Ordinary polling uses the unauthenticated public API within its rate limit;
GitHub failures or rate exhaustion postpone deployment, never waive CI.

Coolify remains reachable only through host loopback/authorized ZeroTier
management. The controller's dedicated token has `read`, `write` and `deploy`,
without `root` or `read:sensitive`. Write permission is required to pin the
source revision. Coolify scopes tokens to its team, not an individual resource;
the controller itself fixes the one application UUID. A stolen token would
therefore have broader team write authority: keep the controller private and
its mounts inaccessible to HASI and plugins.

Custody is encrypted, exec-only fnox entry `HASI_COOLIFY_DEPLOY_TOKEN`, with a
root-owned `0600` runtime file at
`/data/hasi/secrets/coolify-deploy-token`. The initial token expires after 365
days. Rotate it before expiry: stop the controller, create a replacement with
the same minimal abilities, provision it through protected stdin to fnox and
the server, verify access, restart and revoke the old token. Never print a token
or pass it in an argument. The controller logs fixed status categories only.

## State boundary

| Component | Persistent identity |
| --- | --- |
| Native source application | `tjzdwweelb3zhjtfpgzvjs8k` |
| Existing data service | `64vadvq4uowpfrr9l0rlrcg1` |
| PostgreSQL container | `hasi-database-64vadvq4uowpfrr9l0rlrcg1` |
| PostgreSQL volume | `64vadvq4uowpfrr9l0rlrcg1_hasi-postgres-data` |
| Shared private network/destination | `64vadvq4uowpfrr9l0rlrcg1` |
| Demo namespace | `production:v1` |
| Shared budget namespace | `model-budgets:shared:v1` |
| Controller journal | `/var/lib/hasi-deploy/state.json` |

The source application owns no database volume. Keep the existing database
service, its rendered volume and initialization files intact. Do not run
`compose down --volumes`, create a replacement data resource, rotate the demo
secret, change namespaces, or run budget bootstrap as part of deployment.
Current signed testsessions, account consent, mock bookings and budget records
remain in the same database. Image rollback never rolls back database contents.

The original Compose web service is a bootstrap rollback target only and must
remain stopped after the native application takes over the public route. Disable
its restart policy and remove its web definition from the saved data-service
configuration when cutting over; retain the database and its existing service
identity. The old image may be retained separately. Wiki and Service-IT resources
are independent and their campus restrictions remain in force.

Protect the native application's host work directory
`/data/coolify/applications/tjzdwweelb3zhjtfpgzvjs8k` with root ownership and
mode `0700`; its generated `.env` starts at `0600`. The private parent directory
continues to protect regenerated runtime files. Do not display rendered Compose
or full container environment output when inspecting metadata.

## Controller installation and operation

Run `pnpm build:deployment-controller` at the reviewed revision. Install the
emitted `dist/deploy-controller/controller.js` as root-owned
`/opt/hasi-deploy/controller.mjs`, mode `0444`; the runtime needs no TypeScript
loader or dependency directory. CI compiles and checks it on Node 24 and 26.
Create root-only directories
`/etc/hasi` and `/var/lib/hasi-deploy`. Install this non-secret config at mode
`0600`:

```json
{"applicationUuid":"tjzdwweelb3zhjtfpgzvjs8k"}
```

For the first installation only, explicitly create mode-`0600` journal content
`{"version":1,"records":[]}`. For upgrades keep the existing file, ownership,
records and directory. Install the adjacent
[`hasi-deploy-controller.service`](hasi-deploy-controller.service) in
`/etc/systemd/system/`, then use:

```sh
systemctl daemon-reload
systemctl enable --now hasi-deploy-controller.service
systemctl status hasi-deploy-controller.service --no-pager
journalctl -u hasi-deploy-controller.service -n 20 --no-pager
```

The pinned Node container uses Docker's init process to forward stop signals;
exit 143 during an operator-requested stop is treated as clean. Unexpected exit
137 is still a failure and is not masked. It has a read-only filesystem, dropped capabilities,
bounded memory/CPU and no Docker socket. Only its journal directory is writable.
Host networking is used solely to reach Coolify loopback; it opens no listener.
Do not start a second copy: the fixed Docker container name is the instance
fence. Preserve the journal in controller recovery; a full journal requires
reviewed archival with replay history retained, never silent truncation.

An initial cutover needs one operator handoff: leave the old web container
serving while the new application builds and passes its internal Node readiness
command; verify state and credentials, then switch the public router and stop
the old web container. Subsequent admitted main revisions normally use native rolling
deployments on this same application. An incompatible signed-state reader change
requires the stop-before-start procedure below. No database restart is required.

## One-time core epoch cutover

The first CI-qualified main revision containing registry `lifecycleRevision`
and proposal invalidation is the minimum compatible core for this signed state.
Record that exact merged SHA and built image ID in the deployment evidence.
Older images reject the new signed registry field; restoring one is not a safe
rollback. This is a pre-release maintenance cutover, not a database reset or a
promise of rolling compatibility with old cores.

1. Persistently pause controller admission with
   `systemctl disable --now hasi-deploy-controller.service` before merging the
   state-writing change. Verify `is-enabled` reports disabled and `is-active`
   reports inactive; a simple stop would allow startup after a host reboot.
   Preserve its journal. Wait for any
   already submitted deployment to settle; do not race its build or activation.
2. Obtain the exact new main SHA's successful required CI and pin it as the
   source candidate. Before new code can serve or touch the database, take the
   public application out of service, set restart policy `no` on each verified old application/API container
   (`docker update --restart=no <verified-old-app-container>`), gracefully stop
   it and verify no old writer process remains. Preventing automatic restart
   also keeps old writers stopped across a host reboot. The retired bootstrap
   web container must also stay stopped. Let in-flight requests settle; retain
   uncertain business outcomes for reconciliation, never replay them.
3. Resume the controller with
   `systemctl enable --now hasi-deploy-controller.service` so its existing
   exact-main CI admission builds and deploys the new candidate. The maintenance interval may include build time.
   Keep the database service/volume, all namespaces, secrets and budget counters
   intact. Do not run bootstrap or remove state. A failed build leaves service
   unavailable pending a compatible forward fix; it does not authorize starting
   an old writer.
4. Verify the new running image, the public exact revision/readiness, existing
   test session/proposal state and unchanged shared budget accounting. Record
   the completed controller job and compatible image identity. Subsequent
   ordinary rolling deployments may overlap only cores that understand and
   preserve these signed epochs and terminal invalidations.

After the new core has started, recover with that qualified floor image or a
later reviewed compatible image. Private Coolify operators must not select a
pre-floor retained image, even if the UI offers it. An image built from the floor
commit may be rebuilt for forward recovery; the old image cannot undo the
signed-state transition. Controller admission has no automated schema rollback
and its journal must remain intact. This operator restriction is explicit;
there is no claim that an old binary understands a new database marker.

The managed plugin installer, plugin artifacts and active/previous route
revisions are separate. Do not reinstall workers or restore old configuration,
credentials or grants as part of this core cutover. The disposable PostgreSQL
process rehearsal is supporting evidence; actual Coolify stop/start, preserved
application state and exact-image readback remain a separate delivery step.

## Failure and rollback

Stop admission with `systemctl stop hasi-deploy-controller.service`. Inspect the
recorded deployment in private Coolify management and reconcile uncertain POSTs
against the fixed application's deployment history by source SHA and submission
time. Never retry an unknown outcome by clearing the journal. Missing storage,
missing budget, image/revision mismatches and failed builds remain failures.

Coolify keeps the previously healthy container during a failed Dockerfile
rolling update. For a completed deployment that needs reversal, use the
application's retained immutable image through Coolify's Rollback operation,
subject to the minimum compatible core floor above.
Coolify 4.4.6 may report a null `current`/false `is_current` in its rollback-image
API when containers have timestamped names. Use the running container's actual
image ID and public revision to identify the current version; do not infer it
from that flag. Verify the exact prior source/image identity, public readiness, the existing
signed test session and booking, the same database volume and unchanged budget
consumption. Restore the current qualified image with the same operation when
the incident is resolved, then resume the controller. A completed SHA is not
automatically resubmitted just because its CI was rerun.

This deployment introduces no schema migration. Future incompatible migrations
need their own reviewed compatibility/restore plan; an old app image cannot
reverse a database migration. A controller outage delays delivery and does not
stop the serving app or reset its state. The existing encrypted database backup
timer remains separate. Under Plan V5 the disposable demo has no backup/restore
acceptance requirement; production backup, off-host replication/failure monitoring
and restore qualification belong to M8-A8. Independent readiness monitoring,
incident handling and rollback remain M7.

## Independent demo readiness checks

The `Demo public health` GitHub Actions workflow (`.github/workflows/demo-health.yml`)
runs outside the HASI server. It first tests the monitor against offline positive
and failure fixtures, then probes the fixed public HTTPS readiness endpoint from
`main`. Its 30-minute schedule is best-effort; it is not an availability SLA.
Run the same workflow manually when investigating an incident:

```sh
gh workflow run demo-health.yml --ref main --repo metaneutrons/HASI
```

A failed run requires operator review in Actions; no separate notification
channel is configured. The probe checks bounded readiness/revision data and
exits nonzero on failure. It does not call a model, log in, modify a booking, or
establish that the reported revision is the latest main commit. Continue to use
the deployment controller's exact-revision check for delivery admission.
