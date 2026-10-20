# Protected action-history recovery

The protected workspace keeps a server-only action-reference sidecar in its
owner/scope-bound signed envelope. Each record contains only a conversation ID,
message ID, server-issued proposal UUID and a read-only flag. It retains no
source text, target, arguments, account claims or old confirmation. References
share the workspace retention deadline; a load-time rewrite never extends it.

## Issuance and redemption

Only a sanitized, freshly authorized host proposal card can create a reference.
A browser cannot submit the sidecar. Saving a workspace reads its current signed
envelope at the expected CAS revision before carrying references forward; a
stale save cannot replace a newer reference or deleted conversation. Duplicate,
moved, deleted, user-role or repurposed message locations do not retain a handle.

When a source/account is unavailable, the persisted workspace removes the card,
its display data and unverified dependent model history. It retains the minimal
reference at that same conversation/message location. After renewal, the host
may redeem the UUID only through the existing authenticated proposal GET.
The Core API checks owner, current plugin/configuration binding and the complete
current projected source rights. Matching identity alone is insufficient.
Recovery IDs and visible proposal IDs share the existing 32-unique-ID limit for
the whole workspace; excessive or unavailable reads fail closed.

Reconstruction uses only the fresh authorized proposal and fixed host copy.
It does not restore the old answer, tool context, model attribution or cached
proposal fields. The reference and its signature never enter the client
workspace or model request. Rendering a card performs no preparation, execution
or automatic reconciliation. Unknown outcomes retain the separate explicit
status/reconciliation control and never trigger a replay.

## Pending actions and lifecycle changes

Once a reference has lost its visible authorization, recovery is read-only:
a still-pending historical card is shown as invalidated and its active
confirmation is cleared. Reposting the old card or active proposal cannot reset
that flag. Core GET independently projects expired, changed-policy or
revision-stale pending proposals as invalidated, including renewal without an
intermediate denied workspace read. The stored action is not mutated by GET;
the confirmation route still enforces its original current-authority contract.
A fresh proposal and explicit confirmation are required for a new action.
The synthetic consent callback uses a full same-origin document navigation, as
the real provider callback does, so protected storage is freshly read before
old chat controls can mount. Draft and active-conversation identity come from
the protected store rather than a pre-consent in-memory projection.

Read access may survive personal-account renewal only if the complete current
projected identity and permissions still match the proposal's reconciliation
binding. Changed rights, owner, plugin version or configuration do not gain
access through a retained handle. Current authority is fenced around protected
workspace reconstruction; a concurrent change aborts rather than returning a
mixed snapshot. Deleting the message or conversation discards its reference.

References are available only for cards that have already passed protected
storage. IDs irreversibly removed by older code cannot be reconstructed from
redacted text. Existing signed envelopes without a sidecar can be read and
acquire references on their next authorized reconstruction; no database,
session or budget reset is required. Older application images cannot be assumed
to understand the extended signed envelope. Immutable rollback and forward
recovery remain part of the M7 operational qualification.
