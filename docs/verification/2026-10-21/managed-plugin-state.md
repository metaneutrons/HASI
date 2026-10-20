# Managed plugin state callback wire

Date: 2026-10-21. Base: `9ea7c034f08fe8ca59ae648cb7689be161e126d6`.
Related criteria: M2/P5-A4 and P6-A2 in [#49](https://github.com/metaneutrons/HASI/issues/49);
technical delivery remains [#54](https://github.com/metaneutrons/HASI/issues/54).

## Implemented boundary

The explicit v2 managed-state declaration now connects SDK application stores,
replay consumption and execution journals to a host-owned fenced store through
the existing MCP connection. The host derives the scope, package, installation,
subject, account and authority fences. The wire accepts only a bound invocation
UUID and logical addresses. Per-request verified authority replaces any use of
initialization-time actor capture in this sessionful profile.

Current account/configuration/route/installation/subject eligibility is checked
before callbacks; actual storage operations retain the corresponding physical
authority revisions and a short invocation lease in the transaction. Application
writes are execute-only; status reads can reconcile an existing journal but
cannot create an execution or change application source state. Confirmed receipts
cannot be replaced. Replay and receipt data have no local fallback. Compatible
updates retain the state declaration; changed declarations or unavailable
current approved contracts cannot assume compatibility.

The independent reference source has an optional host-store mode with one atomic
counter/source-receipt CAS. Its default manifest and existing managed browser
fixture still use their previous transport/storage profile. No public plugin
manifest, mount, egress policy, secret, provider or public data was changed.
See [contract, limits and operator responsibilities](../../architecture/managed-plugin-state.md).

## Focused verification

Node 24.21.0 passed **65 tests across nine files**, with an explicit disposable
loopback `TEST_DATABASE_URL`. Root TypeScript checking, affected lint and full
repository lint passed. Full required integration and hosted CI are recorded on
the eventual pull request; this record does not infer their result.

- [Host callbacks](../../../tests/managed-plugin-state.test.ts): signed then
  verified invocation proofs, activation/close/expiry, mandatory consume,
  replay, logical CAS conflicts, input snapshots, schema and capacity limits,
  subject/account/package isolation, changed/missing authority, a mutation race,
  journal binding/result/transition rules and immutable confirmation.
- [SDK transport](../../../packages/plugin-sdk/tests/managed-state-server.test.ts):
  actual HTTP and pinned MCP clients, per-request proof rather than session
  actor capture, mandatory host replay guard, journal/status requests, legacy
  opt-in and shutdown while the client remains connected. A synthetic private
  adapter error is replaced by a fixed status error without another business
  invocation; the counterprobe failed before this boundary was added.
- [Manifest admission](../../../packages/plugin-sdk/tests/managed-state-manifest.test.ts):
  explicit profile/declaration matching, declared account claims, customer-ID
  minimization, strict schema compilation with immutable cached inputs, and
  changed-contract update denial.
- [Authority snapshots](../../../tests/state-authority-snapshots.test.ts):
  signed subject/settings/account state, tombstones/tampering, same-read physical
  revisions, route owners, live account checks and CAS initialization.
- [Reference source](../../../tests/reference-managed-state.test.ts): atomic
  counter/receipt update, bounded conflict retry, source idempotency, scope and
  malformed-record rejection. Existing SQLite behavior remains separately tested.
- [Registry/gateway/SDK](../../../tests/managed-state-registry.test.ts): v1 write,
  v2 read, rollback read and registry reconstruction retain the same application
  value and receipt. A lost source acknowledgment is reconciled with exactly one
  handler effect. Switching linked accounts exposes an empty separate partition;
  withdrawing the account inside the execution handler denies the source mutation.
- [PostgreSQL wire](../../../packages/state/tests/managed-state-wire.integration.test.ts):
  the same actual registry/gateway/SDK path reads committed state through update,
  rollback and registry reconstruction, and reconciles a lost acknowledgment
  without another effect. Each run creates and drops only its uniquely owned
  schema; the caller's database remains intact.
- [Installer](../../../tests/managed-plugin-installer.test.ts) and
  [preflight](../../../tests/managed-plugin-preflight.test.ts) retain their existing
  admission/activation counterprobes. A signed candidate that changes the state
  profile is refused before another stage operation; the active route remains
  unchanged, and an unchanged compatible candidate can still be staged.

An independent bounded code review found a real `customerId` projection defect.
The actual registry counterprobe failed with `Stable state account identity
unavailable` before the fix and passed afterward. The field is now included only
for the explicit customer-ID state declaration. Subsequent bounded review found
no actionable blocker in the reviewed authority, transport, journal and reference
paths. This is source review, not a substitute for runtime checks.

## Remaining qualification

The wire tests use actual loopback HTTP, SDK transports and PostgreSQL, with
synthetic identities and business data. The plugin servers run in the test
process. Reconstructing the registry is not an OS-process or container restart.
No independently packaged Docker artifact, external distribution, installer UI,
real IdP/account, physical phone, source-owner approval or model call was used.

Next qualification must enable this declaration in independently versioned,
digest-pinned reference artifacts, then demonstrate the stateful admin/chat/
update/rollback/restart/lost-reply journeys in the actual isolated topology.
State migrations/archival are not implemented; changed contracts and capacity
exhaustion fail closed. Full M2/P5/P6, M6 and M7 remain open. The supplied failing
booking → VPN → missing-confirmation conversation and generated FAQ titles remain
separate M6 defects; this storage slice does not accept that conversation.
