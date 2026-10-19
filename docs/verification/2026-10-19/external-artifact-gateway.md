# Externally packaged reference artifacts through the gateway

Date: 2026-10-19. Source baseline: `255afe8876eb46685d005a1fb6cee4856cdb48fb`
plus the qualification input changes identified below. This is a bounded
M2/P5/P6 technical exercise, not full milestone acceptance.

## Packaging and admission

A separate, local Git repository contains the reviewed reference server,
manifest, GPL-3.0-only license and its own 211-line Node packager. It consumes a
fixed HASI SDK dependency closure prepared once beforehand. Producing its two
releases does not invoke HASI's packager, rebuild HASI or access a package
registry. Its two source commits are:

- `v1.0.1`: `19553a3b8e3c4c6e49a5b05aa9ed242f43f61db0`.
- `v1.0.2`: `244d138c2703e22a6f5f090741971c6c76b140e8`.

Root independently verified both finalized artifacts using that producer with
an empty credential environment. The repository is clean and has no remote.
This is a HASI-derived test producer with independent packaging, not an
unrelated publisher, public distribution or cryptographic source attestation.
Source references in sidecars are declared metadata; the qualifier never
fetches them or grants publisher trust from them.

The gateway qualifier accepts an optional complete pair of absolute artifact
and sidecar paths through `HASI_GATEWAY_QUALIFY_ARTIFACT_{A,B}_{DIR,EVIDENCE}`.
It rejects partial inputs, paths inside the HASI checkout, overlapping inputs,
invalid identities, non-increasing versions and changed reference contracts.
The existing full payload verifier precedes manifest inspection. Sidecar,
raw/canonical manifest, inventory, package count and license identities must
agree. Each admitted artifact is copied into an owned temporary directory and
fully verified again before Docker receives that snapshot. Caller artifacts
are neither modified nor deleted.

macOS copies can change symlink modes. Only copied symlinks may be normalized
to their already admitted mode, after checking safe relative inventory paths,
real directory ancestors, link type and exact target. The final complete
verification remains mandatory. This is not protection against an adversarial
same-account process changing the filesystem concurrently; copying does not
bound concurrent source growth.

## Actual local lifecycle

The actual run used Node 24.21.0 on macOS arm64, Colima's Linux Docker engine
and the existing disposable loopback `hasi_topology_test` PostgreSQL database.
The qualifier used external artifacts throughout; it did not call the HASI
reference packager. Exact artifact and runtime image identities were:

| Version | Payload SHA-256 | Runtime image SHA-256 |
| --- | --- | --- |
| 1.0.1 | `10a8a03814e3ff6788a370092c7b9a3f959f30dea7a774479ebb9cb73ecce087` | `45a75bbc4743835f91d5ec4e335dd1d990257e3043d9ee062e2b2f2f9fc2137d` |
| 1.0.2 | `3b0b7f9ebc3f9f614619d8db29b3a784f5b926fe35c485ec44e00e193a6ac7cf` | `5cc1e1957b25387665291d8ebc3c9237d20b78f956aaa0862b9f4322e6a8b5b7` |

Two separate Node gateway processes completed ten native MCP reads and two
activation commits. Both served A; staging B kept A usable. B's committed
activation deliberately lost its reply and was reconciled without replay.
A replacement process restored B from PostgreSQL. An unavailable synthetic
credential failed preflight without replacing B. Candidate cancellation and
explicit configuration convergence preserved the active version. A real
gateway rollback restored A; revoked B could not be restored. Withdrawal
returned 503, unauthenticated access returned 401, and correctly signed
foreign-installation requests were denied.

The run reported `qualified: true`, `cleanupVerified: true`,
`fullP5P6Acceptance: false` and `independentDistributionAcceptance: false`.
Its owner was `gateway-qualifier-5dc9a1396c3d`; only its nonce-scoped state,
containers, networks, images and temporary snapshots were removed. The complete
container inventory matched its baseline afterward. No production database,
budget, provider or business service was used.

Tested source SHA-256 identities:

- `scripts/qualify-plugin-gateway.ts`:
  `c9d44ddeeb86f37c286e49948c444926f6e4dc900e6599feb001b22924db05de`.
- `scripts/plugin-gateway-qualification-artifacts.ts`:
  `68f4007d38bac008318b5860b44d4135a25dc3de007fc5ee23ded20c764ec944`.

Sixteen focused admission/snapshot tests, backend build and root/web typechecks
passed. Independent read-only review found no blocker within the stated local
filesystem assumptions. The Mac result alone does not qualify a Linux operator;
the separate Linux observation follows below. Public repository installation,
complete admin/chat journeys, hostile third-party execution and institutional
acceptance remain unqualified. Hosted CI, merge and delivery are separate
observations.

## Linux operator observation

The same two independently packaged artifacts also completed the actual gateway
lifecycle on Linux/amd64, using Node v24.22.0 and a separate disposable PostgreSQL
container exposed only on host loopback. The operator did not receive production
database credentials, model keys or application secrets. The running HASI
application stayed ready at `bd59928`.

The full result is preserved in
[`external-artifact-gateway-linux.json`](external-artifact-gateway-linux.json).
Root checked all fifteen reported source hashes against this branch and against
the transferred bundle. Its 20,198 inventory entries were verified locally and
again after transfer. The inventory verifier also accepted a known-good fixture
and rejected an isolated corrupted copy. Extraction's enclosing directory mode
was restored to the admitted `0700` before the successful complete verification;
artifact payload files were not repaired or changed.

The operator uses an esbuild bundle because the host has no project Node
toolchain. The only source launcher change selects the bundled worker instead
of `tsx`; original, transformed and bundled source hashes are retained. A
`createRequire` banner supports bundled CommonJS dependencies. Optional
`pg-native` fails closed. Verified host Docker CLI and Buildx executables are
mounted read-only. An owner-scoped shared temporary directory preserves the
host paths needed for Docker bind mounts. This qualifies that explicit Linux
operator arrangement, not a bare TypeScript checkout on the host.

The run completed ten native MCP reads, two activation commits and all eleven
reported checks: paired processes on A, foreign/unauthenticated denial, staged B
preserving A, lost activation reply reconciliation without replay, a replacement
process restoring B from PostgreSQL, failed preflight preserving B, configuration
convergence/cancel, actual rollback to A, revoked rollback denial and withdrawal.
The source qualification reported `qualified: true` and `cleanupVerified: true`.
Its process exited zero, independently verified from the unique owned-container
Docker exit event.

An earlier coordinator attempt stopped during disposable-database setup before
starting the gateway; its database/network were removed and the controller
resumed. The successful run's coordinator initially expected single-line JSON,
although the qualifier writes pretty-printed JSON. The complete result was
retained from that same owned container's log stream and its zero exit verified;
the capture format was corrected without changing or repeating the successful
qualification. Both observations are bounded operator-harness issues.

Qualification containers, networks, images and nonce-scoped database entries
were removed. The outer operator and temporary database/network were also
removed; the non-controller container baseline was restored. The deployment
controller was resumed and remains enabled. The original application database
and budget were not used by the qualification.

`fullP5P6Acceptance` and `independentDistributionAcceptance` remain false.
Source identity is operator-declared local repository metadata, and publisher
trust uses an ephemeral synthetic key. This is not public distribution or
cryptographic source provenance. Remaining M2 admin/chat, installation and
distribution gates are unchanged.
