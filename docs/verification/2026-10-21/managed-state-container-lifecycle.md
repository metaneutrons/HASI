# Managed state across independently packaged container versions

Date: 2026-10-21. Base: `288b783425e4d44efe55509311f894082d535f57`.
Supporting evidence for M2 P5-A4/P6-A2 and M7; not milestone acceptance.

## Construction and authority

The isolated opt-in lifecycle qualifier packages two independent reference
source snapshots, signs their manifests/releases and builds local digest-pinned
Docker artifacts offline. It uses an actual separate managed worker, private
signed admin/contract RPC, the deployment gateway, PostgreSQL and the local TestIdP.
The API uses its normal registry, personal-account consent and authority directory.
Only the declared synthetic student can acquire the projected `reference.account`
claim; an unverified actor claim is not used as account-link authority.

Before packaging, both manifests declare the same explicitly approved managed
state schema and MCP protocol. The v2 derivative alone has one reviewed fault:
`process.exit(73)` immediately after the awaited atomic source mark. This is
immutable qualification source, not an HTTP/model control or production feature.
It terminates the actual owned plugin process before the SDK finalizes its
execution acknowledgement. The ordinary joined browser fixture enables the
same state profile but does not include this crash derivative.

Host-side evidence validates the persisted contract, physical entry addresses,
revision UUIDs, account/subject/installation, source receipt identities, exact
argument hashes, consecutive action counts and matching journal bindings/results.
The qualifier no longer accepts plugin-reported SQLite statistics as proof of
managed state. Nonce-only initial blobs have zero effects. Corrupt/foreign state,
or a journal without a reconstructable authoritative source binding, fails the
oracle rather than being counted as a successful action.

## Required observed journey

The run must prove a confirmed v1 effect before update, a v2 read of that effect,
and a second source commit followed by actual exit 73. The durable proposal must
remain `outcome_unknown` with its original execution ID. The HTTP confirmation
returns a specific 409 while the managed runtime contract is unavailable: this is neither success nor
permission to retry. After restarting only that observed container, a fresh
TestIdP login must read the retained state and reconcile the same execution ID
without a new effect. Disable/re-enable and rollback must preserve both receipts;
a final separately confirmed v1 action must produce exactly three effects.
Repeated confirmation and status reads must not replay execution.

The earlier pending-proposal update/disable/re-enable/rollback denials remain in
the journey. Configuration stays active across compatible artifact transitions.
This is explicit API-route confirmation evidence, not a browser-click claim.

## Cleanup boundaries

Containers are recorded by full ID after trusted staging, with their complete
label digest, installation/plugin/release/role and known operation identity.
The complete removal batch is validated before any deletion. A new unrelated
container is preserved; an unobserved or changed container with this run's owner
label causes cleanup to fail rather than being adopted. Caller baseline IDs
must remain. Images/networks retain their existing exact-owner checks.

State removal uses concrete host-derived keys for the exact managed partition,
observed invocation leases, personal account, demo grant and consent challenge,
plus the existing command/route/authority/proposal/OIDC inventory. All selected
physical rows, including expired rows, are validated before deletion under the
owner/nonce marker transaction. Signed account/grant/challenge values are verified
against the generated Ed25519 public key. Unknown rows prevent whole-namespace
cleanup confirmation. No database reset, wildcard deletion or prefix adoption is
permitted. The caller's database and unrelated resources are retained.

## Verification status and limits

Three development attempts reached the durable v2 source commit but stopped at
the confirmation HTTP assertion. The first two reports did not retain the actual
confirmation status. The third records HTTP 409. Source inspection establishes
the failure boundary: `refreshManaged` retains the connected record but removes
stale advertised capabilities and throws its fixed unavailable-contract message
when the stopped container cannot supply current runtime authority. No durable
release transition follows from that catch. All three verified cleanup and remain
failed attempts. The revised oracle accepts that specific 409 only with the exact
fixed unavailable-contract message; it still requires the owned durable unknown
proposal, actual exit, restart and authoritative reconciliation. It does not
accept arbitrary conflicts, bypass current rights or treat an HTTP error as a
successful action.

The fourth actual run completed successfully. Its [machine result](managed-state-container-lifecycle-result.json)
records qualifier source SHA `56dc8fa23bc93adba78be5f98631263aca3cc5d127573e0a800e8f8ead162284` and raw report SHA
`b8489562a6b64c7a97d5b94c3e43beb8d9906db95f2490968b46504bf51aec4e`.
The public export omits the redundant `apiExecutionId` field; the same synthetic
execution IDs remain in the individually bound receipts. The raw-report digest
above identifies the unmodified private result, not the projected public JSON.
The source counter was 1 before/after update, 2 after the real exit and same-ID
reconciliation, 2 after disable/re-enable and rollback, then exactly 3 after the
final confirmation. All three source receipts and host journals were confirmed;
confirmation replay/status did not add a gateway request or source effect.
The recorded confirmation response during the v2 outage was the expected specific
409, and its owned container exit code was 73. Cleanup verified removal of
4 containers, 3 networks, 2 images and 43 physical state rows. The owned
namespace was physically empty and caller baseline resources were retained.
These are synthetic explicit-API lifecycle observations, not browser confirmation
or publication evidence. Focused schema/evidence/ownership countercases, full regression,
review and CI/delivery are separate gates. No real model or institutional service
is called. Linux/arm64 containers on a macOS host do not prove Linux/amd64 or OS
privilege separation between the local API and installer. Independent artifact
publication, complete joined browser/admin/mobile/reauthentication/hostile-input
qualification, protected-history operational rollback, M6 model grounding and
M8 institutional/device acceptance remain separate.

Local supporting gates passed: 39 focused tests across five files, affected
ESLint, root TypeScript and diff hygiene. The actual PostgreSQL cleanup
counterprobe rejects the wrong owner nonce and a malformed selected row without
deleting either batch, then removes the valid active/expired rows and its marker.
The offline OIDC partial-second-login/expired-row planner probe also passes.
Environment: Node 24.21.0, macOS 26.5.1 arm64, Docker 29.2.1 with Linux/aarch64.

The packaging test reads each independent source Git HEAD with a minimal Git
environment. A second case injects unrelated `GIT_DIR`/`GIT_WORK_TREE` values;
both committed/package manifest comparisons must still use the fixture repository.
This covers the hook environment that exposed the initial full-gate test failure.
