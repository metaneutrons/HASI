# Invocation-scoped managed plugin state

This optional v2 profile connects the plugin SDK to the host's fenced JSON store
over the existing host-initiated MCP connection. It grants no additional network
egress, filesystem mount, Docker socket access or browser-selected destination.
It is not enabled by the public demo's existing plugin manifests.

## Approved declaration

`managedState` contains `schemaVersion`, a bounded JSON `applicationSchema` and
an `accountIdentity`: `{ "kind": "subject" }`, `{ "kind": "customerId" }` or
`{ "kind": "claim", "name": "reference.account" }`. A claim must also occur in
`identity.claims`. `customerId` is projected only when explicitly selected by
this profile. Neither email nor display name is an implicit account identifier.
The operator must approve the identifier's stability; institutional claim
availability remains an M8 prerequisite.

The profile explicitly pins `mcpVersion: "2025-11-25"`. The installed MCP SDK
supports the required bidirectional requests through its sessionful legacy HTTP
transport. Other manifests retain their default `2026-07-28` stateless behavior.
Declaring state with the default version, or the legacy version without state,
is rejected. The legacy session alone establishes no user authority.

Personal-account integrations must select their actual stable external account
ID. Subject-only state is permitted only for installations without a personal
account service. Switching accounts therefore selects a different partition.
The host derives the physical namespace from operator scope, installation, package,
subject and account; the plugin sees only logical keys, never physical keys,
authority fences or storage credentials.

## Per-request authority and storage

Every tool/status request verifies its own signed invocation. Session
initialization does not capture the actor for later requests. The SDK binds
verified claims to that HTTP request's host-created authentication object and
passes an application `ExecutionStore` as the fourth tool-handler parameter:
`services.state`. Status reconciliation receives the same services as its third
parameter. Missing managed state fails closed; there is no local fallback.

The registry registers `hasi/state/read`, `hasi/state/compareAndSet` and
`hasi/state/consumeInvocation` on its invocation's MCP client. Callback parameters
contain the verified invocation's non-secret UUID, an application/journal area
and a logical address. The client is not shared across invocations. State access
opens immediately before the actual tool/status request and closes on response,
failure or cleanup. Initialization, discovery and UI resource requests cannot use it.

The host captures physical revisions from verified same-read snapshots of the
signed installation, settings, subject authority and personal-account row,
together with the route and optional connected-catalog record. These authorities
must use the same host store. Every callback rechecks current runtime/account
eligibility, and its target operation uses those fences in the storage
transaction. A short durable lease is an additional fence; its expiry is the
earliest of 30 seconds, invocation expiry and account-grant expiry. Closing the
invocation deletes the lease. External provider/credential systems are freshly
checked, but are not claimed to share the database's atomic transaction.

Application values, replay nonces and execution receipts share one CAS-protected
blob per partition. Logical entries have their own UUID revisions. Consuming the
invocation is mandatory before reading/writing entries, and its replay record
survives SDK/registry reconstruction. Read/prepare/status requests can read
application data; application writes require a host-authorized execute request.
Read requests still update the replay ledger. Status may reconcile a journal
receipt, but cannot mutate the application source or execute a business handler.

Journal access is restricted to the current execution's derived address and
binding. A missing receipt can start only as an authorized execution; status
reads cannot create one. Existing receipts cannot restart, and confirmed receipts
are immutable. Confirmed results must match the business tool's approved output
schema. `hasi/action-status` uses this same MCP connection and a separate signed
status proof; the profile does not fall back to the old HTTP status endpoint.

## Limits and updates

Each invocation permits 64 callbacks; each entry is at most 60 KiB. A partition
is at most 512 KiB, 256 logical entries and 128 unexpired invocation nonces.
CAS contention retries are bounded at eight. SDK reverse requests have a
five-second deadline; sessions have a one-minute idle timeout and a 16-session
process cap. Raw storage errors are not returned through state callbacks; adapter status
errors also use a fixed message.

Receipts have no automatic TTL or delete operation: removing an idempotency
tombstone could permit duplicate effects. Capacity exhaustion fails closed;
archival/compaction is not implemented. The reference source atomically stores
its counter and source receipt in one application value, allowing a lost
acknowledgment to be reconciled without incrementing again.

Compatible updates and rollback preserve the complete state declaration.
Changing the schema, account identifier or protocol on an existing managed
installation is blocked before staging; unavailable current approved contracts
also deny an assumed-compatible transition; a migration label or restore-plan ID
does not implement a migration. Ordinary compatible-update checks also include
the state contract. A stored contract mismatch never resets or exposes values.

[Technical evidence and remaining gates](../verification/2026-10-21/managed-plugin-state.md)
distinguish the current HTTP/SDK/PostgreSQL tests from independently packaged
Docker replacement, distribution and full M2/P5/P6/M7 acceptance.
