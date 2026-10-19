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
filesystem assumptions. This result does not qualify the corresponding Linux
gateway run, public repository installation, complete admin/chat journeys,
hostile third-party execution or institutional acceptance. Hosted CI, merge
and delivery are separate observations.
