# Plugin operator runbook

Status: M2 candidate, 2026-10-18. Supported operations below do not establish
institutional approval or complete the P4/P5/P6 acceptance criteria.

## Connect and configure an approved service

1. The operator reviews the package identity, exact manifest digest, endpoint,
   network destinations, effect/permission declarations, identity projection,
   configuration schema and credential custody. Remote services must implement
   the HASI signed invocation/effect contract. Plain MCP needs a reviewed adapter;
   it cannot be enabled by merely entering a URL.
2. Supply a server-owned `ApprovedPluginSource` to the registry catalogue, with
   its unique installation ID, approved manifest digest, endpoint policy and
   resolved service credential. Keep the credential in the executing server's
   secret store. No secret belongs in a public configuration draft, browser
   payload, model prompt or command argument. `configureCatalog` and
   `restoreConnections` are integration APIs, not a general public installer.
3. An authenticated administrator with `plugins:manage` opens **Verwaltung**
   and connects the labelled approved source. The public demo administrator is
   scoped to that browser workspace; it has no operator or Docker access.
4. Open the instance configuration. Review the installation, active revision,
   available fields, help and missing logical credential slots. Save a valid
   draft, then activate it separately. Saving does not change active behaviour.
   Per-tool restrictions are independent of the instance enable switch.
5. Use the explicit connection check after activation. It probes the active
   configuration and approved MCP contract without executing a business tool.
   Transport reachability is not proof that a credential was validated, and it
   does not establish a user's upstream account rights. Missing or unverified
   stages remain visible. Unsaved local field edits are retained.
6. Exercise the specific read/action workflow with a permitted synthetic user.
   Confirm an exact proposal only through the trusted host confirmation card.
   Neither a model nor an embedded view can grant confirmation.

The form editor supports bounded nested objects/arrays, primitive/enum fields,
if/then/else and uniquely discriminated oneOf/anyOf branches. Unsupported rules
are reported explicitly and preserve stored values. Branch-specific drafts
survive switching; inactive values are omitted from submissions. Field and
unmapped server diagnostics remain visible. Central setup never substitutes
for personal consent.

## Conflicts, disable and removal

| State | Operator/user action |
| --- | --- |
| Concurrent configuration change | Keep local edits, deliberately load the new revision and reapply/review the draft. Never force an old revision over another administrator's work. |
| Missing logical credential | Provision the approved slot server-side; the UI cannot retrieve or select arbitrary secret-store references. |
| Unreachable or changed contract | Check the approved destination and service deployment. Renew manifest approval explicitly; the connection test does not approve an update. |
| Disabled tool | Review the per-tool policy separately from the instance switch. Enabling the instance does not remove tool restrictions. |
| Disabled instance | New calls are denied and pending approvals become stale. Existing transcript text remains readable; no historical card executes automatically. |
| Removed catalogue connection | Other replicas reject calls after their next authoritative refresh. Stored configuration/history is retained; removal is not a data-purge operation. Reconnection requires explicit administration. |
| Expired login or changed account/grants | Reauthenticate through the trusted IdP, return to the retained chat/draft, read current state and prepare a new proposal. Old account/configuration approval cannot be reused. |
| Unknown action outcome | Do not repeat the write. Use the explicit host status check. It reads the signed receipt or a reviewed authoritative source adapter without replaying the write. Missing/uncertain receipts remain unknown; a timeout does not prove failure. |

Personal disconnect, renewal and retained-data lifecycle are distinct from
central disable/removal. Open **Verbundene Dienste** to connect/renew/disconnect
the current account. The trusted adapter owns provider authorization and returns
to the retained task. Local disconnect invalidates authority before provider
revocation; if the provider is unavailable, use the explicit revocation retry.
Do not recreate a write to recover an unknown outcome after renewal. Receipt
access requires the same current projected account and rights. Existing chat
text/bookings are not purged or cancelled by disconnect. The synthetic consent
screen exists only in demo mode; production requires a trusted provider adapter.
Actual-device return-to-task and provider recovery qualification is deferred.

## Rotate credentials

Provision the replacement credential in the approved server secret store.
Update the operator-owned non-secret `credentialRevision` and deploy the affected
connection/service. Verify the intended read path, then revoke the superseded
credential and retire deployments still using it. Recheck pending proposals:
the changed connection binding requires a new preparation. Never derive the
revision marker from the credential or return an existing credential suffix.
If compromise is suspected, revoke immediately before routine verification.

## Updates and recovery

The registry's **Updates prüfen** checks an already-running approved remote
endpoint. A compatible candidate is activated explicitly. Changed configuration,
schemas, effects, permissions, UI or identity contract require renewed operator
approval. This operation changes a contract pin; it does not install an image
or make an arbitrary repository trustworthy.

The separate operator-local artifact coordinator verifies signed publisher and
immutable image identities, stages an isolated candidate, checks health and
configuration, and retains a previous artifact. `PluginRouteController` in
`apps/api/src/plugin-route-controller.ts` supplies the CAS-backed route authority
for an operator integration. Construct it with a shared durable `JsonStore`, a
server-owned scope and owner ID. Initialize each installation before exposing
it, and update its configuration revision from the trusted configuration
activation path. Each route swap and its terminal operation result are stored
in one CAS record; separate controller instances over that store therefore
observe the same route and operation fence. Each installation retains at most
512 route-operation records. It never prunes a terminal fence: at capacity,
new route mutations fail closed until an operator rotates the route scope.

`PluginDeploymentBinding` in `apps/api/src/plugin-deployment-binding.ts` joins
the route's configuration revision to the authoritative settings store. Call
`configurationActivated(installationId, activatedRevision)` immediately after
trusted settings activation; it reads the current active revision and
converges route state using CAS. Gate deployment and invocation with
`assertCurrent(installationId, revision)`. A missing route, failed settings
read, or revision mismatch denies the operation.

`createPluginDeploymentGateway` in
`apps/api/src/plugin-deployment-proxy.ts` starts a separate service bound only
to `127.0.0.1`. Start it before registry connection restoration or manifest
refresh, then configure managed registration endpoints as
`<gateway-origin>/api/plugin-deployments/<installation-id>/mcp`. Its
server-owned authorization callback compares the incoming service credential
with the installation's configured credential. Do not register this gateway
inside the public API listener: public session/CSRF hooks can reject host
service traffic, and registration restoration needs the gateway before the API
starts listening. The proxy accepts only MCP, the signed manifest, action
status and health paths. For every request the Docker driver reads the active
digest-pinned route, inspects managed container labels and loopback port,
checks health, then rechecks the route immediately before forwarding. It
rejects redirects, queries and cookies and bounds both request and response
bodies. This narrows route-switch races; action receipts remain the authority
for ambiguous writes.

The production runtime must supply the shared durable state store, the
server-owned secret resolver and an authorization callback over trusted
installation data. Recheck release, credential, configuration and review trust
at stage and activation. `committed`/`not-committed` are terminal and fenced
against later commits. Pending or unknown outcomes remain unresolved; an
old-route snapshot alone does not authorize a retry. Trust revocation discards
a staged candidate; failed cleanup remains pending for reconciliation.

To rotate a route scope after its 512-operation journal fills, quiesce plugin
traffic and deployment writes on every host, resolve every pending or unknown
operation, and record the verified active deployment ID, release digest and
configuration revision. Inspect the active container through the Docker
driver. Create a new server-owned scope and initialize the same installation
ID there with that exact active target and configuration revision. Switch all
hosts to the new scope while still quiesced, verify the route and configuration
gate from each host, then resume traffic. Keep the old scope read-only for
audit; never clear the journal or run mixed scopes during the switch.

The local reference package is produced by
`scripts/package-reference-plugin.ts`. It contains the built SDK and its locked
production dependency tree, per-file SHA-256 records, the canonical manifest
digest, an artifact payload digest and the package-version/license inventory.
Run `pnpm reference:prepare` before qualification to populate pnpm's deployment
metadata and production dependency cache. This explicit online step uses a
frozen lockfile with the normal supply-chain policies enabled; it does not
change the source lockfile or distribute its temporary deployment. Use the
same pnpm store and `XDG_CACHE_HOME` for preparation and qualification.
Packaging itself uses `--offline --frozen-lockfile`, disables lifecycle scripts
and has no automatic online retry. A missing cache entry fails the build.
Subprocess failures expose only an allowlisted category, phase and exit status,
never raw registry responses, paths or credentials. The qualification runs
the packaged app from independent directories, checks its bounded `/healthz`
endpoint and exercises update/route recovery using a shared in-memory store.
The proxy has focused tests for service authentication, path allowlisting,
cookie/redirect rejection and bounded forwarding, but the reference process
qualification does not run the Docker endpoint resolver or production gateway
with an operator store. This does not qualify a production database, Docker
image build, deployed route proxy, or actual-device recovery.

Rollback revalidates current publisher, credential, configuration and review
authority. Irreversible migrations require an approved restore/forward-recovery
plan; an old image cannot reverse migrated state. The remote registry alone has
no automatic artifact rollback operation. Production shared-store wiring, a
healthy immutable image, runtime denial and actual recovery exercises remain
qualification gates. Never mount the Docker Engine socket into a plugin or
expose it to the demo admin. Vercel functions cannot host this installer.

### Operator-managed configuration and candidate cleanup

`synchronizeConfigurationRevision` updates deployment metadata only for a stable
empty/active installation. The trusted operator must first check configuration
compatibility, then supply the stored `expectedRevision` and the exact
`approvedConfigurationRevision`. The destination comes from the live server
authority. A changed compatibility target, in-flight deployment or CAS conflict
requires a fresh inspection; this operation neither renews release/review trust
nor substitutes secret references. An acknowledgement lost after a committed
write is accepted only after exact-state and live-authority readback.

To cancel a positively staged candidate, use `discardCandidate` with its digest,
original configuration revision and exposed `stagingOperationId`. Cleanup writes
a separate durable discard intent before driver I/O. A fresh coordinator resumes
that exact cleanup after a lost delete reply, even if configuration or trust has
since changed. It retains the active/previous artifacts. Unknown stages must be
reconciled: only a positively observed deployment from the exact pending stage
can be adopted for cleanup. Absence does not prove a timed-out create cannot
still complete. An active or foreign observation remains unresolved.

The route controller's trusted `withdraw` compares owner, installation, active
deployment/digest and configuration revision in the same CAS journal used for
activation. A committed withdrawal has an explicit null route; stale operations
cannot clear a newer route. Stop traffic before discarding an active runtime.
These operator APIs are not public admin/HTTP actions; production composition
must wire authorization, audit, compatibility preflight and pending-action
invalidation before exposing a complete update/disable journey.

The disposable local PostgreSQL/gateway exercise is:

```sh
HASI_DOCKER_QUALIFY=1 \
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32775/hasi_topology_test \
pnpm exec tsx scripts/qualify-plugin-gateway.ts
```

Use an existing isolated passwordless test database with that exact name and
adjust only its loopback port. The script rejects production database names,
non-loopback endpoints, passwords, URL options and ambient PostgreSQL overrides.
It runs two gateway processes with separate connections, paired containers and
two separately packaged versions; it tests committed lost-reply recovery,
restart, failed preflight, cancellation after configuration change, rollback,
revocation and route withdrawal. All authority and actions are synthetic. On
uncertain runtime cleanup it retains durable recovery rows and returns failure.
This does not qualify deployed Linux topology or independent distribution.

See [v2 contracts](plugin-contract-v2.md), [budget provisioning](model-budget.md),
[criterion evidence](../verification/2026-10-18/m2-foundation.md),
[Docker evidence](../verification/2026-10-18/m2-container-driver.md) and
[external process evidence](../verification/2026-10-18/reference-plugin.md).
