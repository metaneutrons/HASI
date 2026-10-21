# Prebuilt inputs for the managed browser journey

Date: 2026-10-21. Implemented revision:
`2cd140bd59d83eaa88e6718e69d393197a28f62c`.
Supports [M2 #49](https://github.com/metaneutrons/HASI/issues/49), still open.
The [machine result](journey-external-artifact-inputs-result.json) records the
exact source, input, image and release identities, counterprobe and limits.

The held managed journey previously always copied and repackaged the in-tree
reference source. It can now admit a complete prebuilt reference pair through
the existing gateway qualifier input contract, copy it into owned snapshots and
verify those snapshots before the managed runtime receives them. Supplied code
and manifests are not patched or rebuilt. The current fixture accepts versions
1.0.0/1.0.1 with the managed-state profile already declared; this is a synthetic
qualifier contract, not a production plugin-version restriction.

Opt-in, admitted loopback database configuration and dotenv absence precede
artifact reads. Non-managed mode rejects supplied paths before reading them.
The full existing payload/manifest/sidecar checks remain mandatory. A fixed
payload-invalid diagnostic prevents external reader errors exposing paths or
arbitrary text. Input paths are captured only for the launcher, scrubbed from
its child environment and excluded from the web build. Evidence labels local
fixtures separately from supplied inputs and explicitly declines independent
source/publisher provenance acceptance.

## Actual startup and counterprobe

The optimized invocation in the [operator instructions](../../operations/plugin-journey-artifacts.md)
was executed on Node 24.21.0/macOS arm64 against the existing disposable local
PostgreSQL database and Colima Linux/arm64 Docker 29.2.1. Full reference packages
were prepared beforehand from a separate owned Git fixture with the HASI
packager. These are structural input-control fixtures, not an independently
published source or publisher.

Both supplied package hashes and source revisions matched the journey evidence.
Two runtime images were built, the separate installer and two API replicas
started, and the protected TestIdP/web readiness probe passed. **The installer
remained empty:** no plugin was installed/activated, and no MCP read or action,
update/rollback or browser behavior is claimed by this startup check. Both
synthetic-model and real-provider call counts were zero.

Normal shutdown stopped owned processes, withdrew the route and removed three
owned networks and two images, with no plugin container to remove. The caller
database/namespace was retained. The installer/API PIDs and both image IDs were
independently checked absent afterward. Both caller artifacts were fully
reverified unchanged after shutdown.

A separate owned copy passed full snapshot verification before exactly one byte
was appended. Running the same CLI against that copy returned exit 1 and the
fixed `external_artifact_payload_invalid` diagnostic at `preflight`, before
`journey-preparing`. Caller inputs were left intact; the parent removed its own
fixture and isolated HOME only after recording the results.

Twenty-seven focused tests across the three named files, targeted lint, root/web
types and independent bounded static review passed. The review caught the
non-managed guard ordering; the corrected path and nonexistent-input counter
were then rerun before this frozen startup. The optimized build also passed.
Required pre-push/hosted CI and delivery are separately recorded in the PR.

Full independent distribution/publisher verification, joined admin/chat,
reauthentication, hostile/error/recovery matrices and P5/P6 acceptance remain
open. This change prepares a required input path; it does not close M2/M7 or
qualify model quality.
