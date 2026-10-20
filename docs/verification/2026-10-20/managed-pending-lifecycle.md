# Managed plugin pending-action lifecycle

Date: 2026-10-20. Bounded technical M2/P5/P6 evidence; full milestone acceptance remains open.

## Composition and identities

The actual isolated run uses the source baseline
`c7d599220a53d217d5ac11393e32605099870d14`, Node 24.21.0 on macOS and
Docker 29.2.1 Linux/arm64. The exact qualifier SHA-256 is
`552665488640cf0ee72a460bca0643184eaec6239e374b1a811b7104f81c9e1b`.
The [machine-readable result](managed-pending-lifecycle.json) records the
original private report digest, five reference-source hashes, both packaged payloads,
manifest/image/release identities and the installer configuration digest.
The public result omits the synthetic execution UUID and retains the observed
identity-equality assertion; the private original is unchanged.

The qualifier copies the reference source into disposable directories and adds
read-only SQLite counters to its read tool and schema. It separately packages
versions 1.0.0 and 1.1.0 with the locked offline SDK/dependency tree. Images build
with network disabled and no pull. The real managed-worker entry point runs in a separate Node OS process and owns the Docker driver,
PostgreSQL state, publisher approvals, private signed administration RPC and
active contract. The API registry in the parent test driver accesses that contract and the actual managed
gateway with a guarded loopback transport. TestIdP authenticates separate admin
and student subjects against signed synthetic authority records.

Only the chosen existing loopback test database is used. The process receives
an allowlisted environment, fresh HOME, explicit local Docker socket and public
pnpm store/cache metadata. No provider key, HsH session, institutional document,
production service or model call is used. Synthetic transport/assigned bearer
material agrees end to end; invocation signatures use the registry's actual
public key. Tool calls address the installation ID, not the package ID.

## Observed journey

Both stages first require review; explicit approval changes each to
`candidate-ready` before activation. The journey observes:

- Activate v1, connect through the real API and read the configured label/account.
- Reject an attempted read using only the package ID with HTTP 403 before a
  successful gateway call; the installation-ID read succeeds.
- Prepare a pending proposal, activate v2, and persistently reject its old status
  and confirmation with HTTP 409 and `proposal_invalidated`.
- Prepare under v2, disable and re-enable the installation, and keep that old
  proposal invalid after re-enabling; a fresh read succeeds.
- Prepare another v2 proposal, roll back through the managed installer to the
  retained v1 artifact, and reject the superseded proposal.
- Prepare afresh after rollback and explicitly call the confirmation API.
  SQLite records exactly one mark, one source row and one execution journal row.
  Repeating confirmation returns the same execution identity; confirmation
  replay and status retrieval add zero successful gateway requests.

The 12 successful tool-API requests, one denied package-ID counterprobe and final
confirmation are distinct from MCP HTTP transport requests. The gateway sees 39
successful HTTP responses (26 × 200, 13 × 202) plus 13 × 400 and 13 × 405 responses from
transport protocol requests. The successful-request counter is not a count of
logical tool calls, model generations or source writes. All semantic API and
state assertions above passed; the exact status histogram is retained.

## Cleanup and counterprobes

The successful run removed four owned containers (plugins and relays), three
owned networks, two image tags and 35 physical state rows. Its unique namespace
is physically empty, the isolated HOME/workspace were removed, and the caller's
PostgreSQL database remains. Container cleanup compares full 64-character IDs
and verifies exact owner/managed/installation labels. Unknown ownership leaves
the run failed and retains recovery state.

State cleanup locks and verifies the namespace owner marker/nonce, selects only
known exact keys, validates their family/installation bindings and checks the
returned deleted keys. Physical selection includes expired rows. OIDC cleanup
validates the exact owned issuer prefix and expiry shape, then refuses success
if any other namespace row remains before removing its marker. API/worker and
TestIdP are closed before cleanup; no other writer owns the random namespace.

A separate actual PostgreSQL counterprobe proves that a wrong owner nonce and
an invalid selected row delete nothing; the valid case removes both active and
physically expired rows and then its marker. An offline partial-second-login
counterprobe proves immediate transaction tracking and expired OIDC planning.
Missing explicit opt-in fails before Docker/database work. These counterprobes
are separate from the successful lifecycle observation.

## Limits and operation

The entry point is `scripts/qualify-managed-plugin-lifecycle.ts`, executed with
Node's `--import tsx` loader and explicit `HASI_MANAGED_PLUGIN_QUALIFY=1`.
It requires the already prepared public offline pnpm cache, local Docker and a
`TEST_DATABASE_URL` accepted by the existing strict loopback qualification
validator. `HASI_MANAGED_PLUGIN_CLEANUP_PROBE=1` selects the offline OIDC probe;
`HASI_MANAGED_PLUGIN_STATE_CLEANUP_PROBE=1` additionally requires opt-in and the
isolated test database for physical cleanup counterchecks. Never target an
application database or expose the installer socket through a plugin.

This result is an instrumented derivative-reference/API journey. It does not
establish independent publication/distribution, a browser confirmation click,
complete mobile/admin/reauthentication or hostile-input coverage, production
API composition, Linux/amd64 execution, OS privilege confinement between API and installer on
this developer host, actual devices, institutional access or
the protected-history Coolify rollback exercise. M2/P5/P6, M6 and M7 remain open.
Full local regression, independent review and hosted CI/delivery are recorded
separately in the PR and milestone issues.
