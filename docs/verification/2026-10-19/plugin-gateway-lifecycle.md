# PostgreSQL gateway and deployment lifecycle

Date: 2026-10-19. Integration baseline:
`4727fd2b31e061195cd6a59bf100d382cc1165a0`.
Scope: a bounded M2/P5-A3/A4 technical exercise with synthetic publisher,
installation, credentials and actions. Full P5/P6, external distribution,
deployed Linux lifecycle, browser/admin and institutional acceptance remain open.

## Repair and runtime design

Stable deployment metadata can converge to a server-authoritative configuration
revision only with an exact original-revision guard and compatibility approval
for that same target. It retains the active/previous releases, review evidence
and logical secret assignments. It cannot approve an old candidate or renew
revoked authority. An uncertain CAS acknowledgement requires exact state and
fresh live-configuration readback before success.

Candidate cancellation persists a separate discard intent before Docker I/O.
The original stage operation remains the ownership token. Cleanup resumes after
restart/lost replies and configuration/trust changes without restoring the
candidate. An unknown stage is adopted only from a positive observation fenced
by the exact pending operation, digest, base and configuration. Missing or
foreign observations do not authorize deletion or release the pending fence.

The route controller supports an exact-owner/base/configuration withdrawal in
its existing CAS operation journal. Explicit null means a committed inactive
route; undefined retains the route and records rejection. Delayed replay cannot
clear a newer activation.

The first actual gateway run reached activation but failed its first native MCP
read (`native_mcp_read_failed`, zero successful reads); cleanup was verified.
The reference SDK accepted only its manifest ID while the signed context carried
the installed instance ID. The Docker driver now provides and inspects exactly
one server-owned `HASI_PLUGIN_INSTALLATION_ID`; the reference artifact binds the
SDK to it. Positive reads and correctly signed foreign-installation denials
exercise both sides of this boundary.

## Local runtime evidence

The [sanitized result](plugin-gateway-local-result.json) records the exact
artifact/image/manifest/release identities and SHA-256 hashes of the tested
implementation inputs. The host is macOS 26.5.1 arm64, Node 26.11.1, Colima 0.10.3
and Docker Engine 29.2.1 linux/arm64. Only the disposable local
`hasi_topology_test` PostgreSQL database was used; no production database,
provider budget or business service was accessed.

Two separate gateway Node processes, each with its own PostgreSQL pool and
Docker endpoint resolver, served two fully offline-packaged plugin versions.
The exercise verifies ten native MCP reads with pinned manifest and synthetic
account/configuration output, plus a valid signed foreign-installation denial
for each read. It covers:

- Both processes serve A; staging B leaves A usable.
- B activation commits in PostgreSQL but its reply is deliberately lost.
  A fresh coordinator reconciles the committed operation without replaying it.
- A newly started replacement gateway and the second process both serve B from
  shared durable state.
- An approved but unavailable synthetic credential fails preflight while B
  remains usable.
- A prepared candidate is cancelled after authoritative configuration changes;
  explicit metadata convergence preserves B.
- Retained A is rolled back through the real gateway under current configuration.
  Revoked B cannot be restored.
- Withdrawal stops subsequent gateway requests with HTTP 503; an unauthenticated
  manifest request receives 401.

Each run removes only its owned paired containers, networks, images and exact
nonce-scoped database keys, then compares complete before/after container
inventory. Unknown runtime cleanup retains durable recovery state and returns
failure. Store closure and temporary-artifact removal have independent cleanup
paths. The preserved result must report `qualified: true` and
`cleanupVerified: true`; broader acceptance flags remain false.

## Development evidence and limits

The 99 focused cases in artifact lifecycle, route control, Docker driver,
database-target guards and proxy tests pass. They include unknown stage
creation, absent-then-late observations, health/publisher/trust/configuration
loss, restart/lost deletion replies, active/foreign resources, sync CAS
commit-with-lost-reply, exact-target races, withdrawal replay/concurrency and
missing/duplicate/foreign runtime installation bindings. Independent focused
reviews found the stage-adoption and uncertain-sync-write defects; both were
corrected and re-reviewed. A separate script review corrected recovery-journal
deletion after uncertain cleanup and confirmed fixed-target credentials/DB
boundaries.

The production frontend/backend build and full lint pass. The operator bundle
preparation also passes its valid/copied prebuilt artifact, context mismatch,
corrupted payload and explicit opt-in counterchecks after the helper was split
into an import-safe module. The standalone container qualifier still passes
the packaged native read, environment/resource/filesystem isolation and public
egress positive/denial controls, with verified cleanup.

These are operator APIs and an actual local runtime exercise, not a completed
public admin update/disable journey. They do not prove Linux gateway lifecycle,
external artifact publication/distribution, all hostile-plugin/browser matrices,
or final M2/M7 acceptance. The earlier Linux paired-relay result remains scoped
to its recorded inputs. Physical devices and institutional participants remain
M8-A7. Hosted exact-candidate CI, merge and automatic exact-main delivery are
recorded separately in the tracking issues.
