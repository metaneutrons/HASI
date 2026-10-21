# Supplying prebuilt reference artifacts to the held journey

This is a synthetic local qualification tool. It does not install production
plugins or accept arbitrary repository build scripts. The full P5/P6 matrix and
publisher provenance remain separate acceptance obligations.

Use a clean operator environment with an isolated HOME/config directory, no
model credentials or repository dotenv files, and the existing explicitly
admitted disposable loopback `hasi_topology_test` database. Retain caller-owned
Docker/PostgreSQL resources. Set `HASI_PLUGIN_JOURNEY=1`, `TEST_DATABASE_URL` and
the approved local `DOCKER_HOST`. Prepare the backend and dependency cache:

```sh
pnpm build:backend
pnpm reference:prepare
```

Supply **all four** absolute paths through these existing qualifier variables:

| Variable | Meaning |
| --- | --- |
| `HASI_GATEWAY_QUALIFY_ARTIFACT_A_DIR` | Prebuilt reference 1.0.0 directory |
| `HASI_GATEWAY_QUALIFY_ARTIFACT_A_EVIDENCE` | Separate JSON sidecar for A |
| `HASI_GATEWAY_QUALIFY_ARTIFACT_B_DIR` | Prebuilt reference 1.0.1 directory |
| `HASI_GATEWAY_QUALIFY_ARTIFACT_B_EVIDENCE` | Separate JSON sidecar for B |

Directories and sidecars must be outside the HASI checkout, distinct and
non-overlapping. The [shared admission contract](../../scripts/plugin-gateway-qualification-artifacts.ts)
checks exact payload/manifest/license inventory identities and a common declared
repository with distinct revisions/tags. Sidecars use `schemaVersion: 1`, a
`source` object containing `repository`, `revision`, `tag`, and complete
`artifactEvidence`. Those source fields are operator declarations, not verified
publisher provenance. No source URL is fetched and no trust grant is inferred.

The admitted source commit, payload and license inventory are propagated into
the version-2 release envelope and the canonical image label. The qualifier's
ephemeral synthetic signing key authenticates that local assertion; it does not
turn an unsigned sidecar into an independently trusted publisher release. Local
workspace mode records actual temporary Git commits with their file URL. See
the [publisher contract and breaking transition](../architecture/plugin-release-provenance.md).

Both manifests must already declare the expected reference managed-state
profile. The qualifier will not patch a supplied artifact to make it pass.
Only the held managed fixture uses this exact version/profile pair; production
plugin compatibility remains governed by its normal release contracts.

```sh
pnpm journey:serve --managed --optimized
```

The [recorded startup](../verification/2026-10-21/journey-external-artifact-inputs.md)
executed these commands against full prebuilt fixtures; it does not claim a
complete browser lifecycle. Once ready, use the existing managed administrator
flow to install/review/activate the reference plugin. `stats` prints bounded
fixture state; `quit` performs normal owned cleanup. Keep supplied directories
and sidecars available until shutdown, then independently verify their hashes.
Do not delete caller artifacts during journey cleanup.

For protected-history recovery, `unavailable-history-authority` makes only the
synthetic APIs' `GET /api/history/authority` return a generic 503.
`available-history-authority` restores the normal route. Both commands wait
for matching acknowledgements from both distinct API replicas before reporting
completion. They neither revoke permissions nor change stored content. These
controls exist only in the explicitly admitted local journey, not in the
production API. Save an authorized chat first, retain its database revision and
content fingerprint, then verify denial during the outage and recovery after
restoration. A temporary outage must not be mistaken for a verified revocation.

Evidence reports `artifactInputMode: external-prebuilt-pair`, the declared source
identities, and `independentDistributionAcceptance: false`. Without the four
variables the existing workspace packaging path remains available and is
labelled `workspace-reference-fixture`. Partial inputs or external paths without
`--managed` fail before runtime startup; input paths never enter child processes,
web builds, model requests or log output. A safe diagnostic identifies invalid
payloads without printing the underlying external reader error.
