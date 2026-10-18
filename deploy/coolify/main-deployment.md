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

The pinned Node container has a read-only filesystem, dropped capabilities,
bounded memory/CPU and no Docker socket. Only its journal directory is writable.
Host networking is used solely to reach Coolify loopback; it opens no listener.
Do not start a second copy: the fixed Docker container name is the instance
fence. Preserve the journal in controller recovery; a full journal requires
reviewed archival with replay history retained, never silent truncation.

An initial cutover needs one operator handoff: leave the old web container
serving while the new application builds and passes its internal Node readiness
command; verify state and credentials, then switch the public router and stop
the old web container. Subsequent admitted main revisions use native rolling
deployments on this same application. No database restart is required.

## Failure and rollback

Stop admission with `systemctl stop hasi-deploy-controller.service`. Inspect the
recorded deployment in private Coolify management and reconcile uncertain POSTs
against the fixed application's deployment history by source SHA and submission
time. Never retry an unknown outcome by clearing the journal. Missing storage,
missing budget, image/revision mismatches and failed builds remain failures.

Coolify keeps the previously healthy container during a failed Dockerfile
rolling update. For a completed deployment that needs reversal, use the
application's retained immutable image through Coolify's Rollback operation.
Verify the exact prior source/image identity, public readiness, the existing
signed test session and booking, the same database volume and unchanged budget
consumption. Restore the current qualified image with the same operation when
the incident is resolved, then resume the controller. A completed SHA is not
automatically resubmitted just because its CI was rerun.

This deployment introduces no schema migration. Future incompatible migrations
need their own reviewed compatibility/restore plan; an old app image cannot
reverse a database migration. A controller outage delays delivery and does not
stop the serving app or reset its state. The existing encrypted database backup
timer remains separate; off-host operational qualification remains M7.
