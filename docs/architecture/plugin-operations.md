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

The current form editor supports bounded primitive fields. Unsupported nested
or conditional forms are explicitly withheld rather than submitted unchecked.
Full schema-driven conditional setup and personal OAuth consent/renewal remain
P4 work; do not present central service configuration as personal consent.

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
| Unknown action outcome | Do not repeat the write. Check the authoritative source/receipt with the responsible operator. A readable old card or a timeout does not prove failure. Generic automatic reconciliation is not yet qualified. |

Personal disconnect, renewal and retained-data lifecycle are not equivalent to
central disable/removal. Their complete UI and revocation flow remains open.

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
configuration, and retains a previous artifact. Supply an approved secret
resolver and an atomic route controller with a durable, operation-specific
journal. `committed`/`not-committed` must be terminal and fenced against later
commits. Pending or unknown outcomes remain unresolved; an old-route snapshot
alone does not authorize a retry. Trust revocation discards a staged candidate;
failed cleanup remains pending for reconciliation.

Rollback revalidates current publisher, credential, configuration and review
authority. Irreversible migrations require an approved restore/forward-recovery
plan; an old image cannot reverse migrated state. The remote registry alone has
no automatic artifact rollback operation. The production route controller,
healthy independent image, runtime denial and actual recovery exercises remain
qualification gates. Never mount the Docker Engine socket into a plugin or
expose it to the demo admin. Vercel functions cannot host this installer.

See [v2 contracts](plugin-contract-v2.md), [budget provisioning](model-budget.md),
[criterion evidence](../verification/2026-10-18/m2-foundation.md),
[Docker evidence](../verification/2026-10-18/m2-container-driver.md) and
[external process evidence](../verification/2026-10-18/reference-plugin.md).
