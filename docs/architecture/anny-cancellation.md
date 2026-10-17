# Owned booking cancellation

The anny plugin's cancellation flow follows the same prepare/confirm boundary as
booking creation. `anny.propose_cancellation` takes only a booking ID. The plugin
resolves it through the authenticated actor's customer-scoped booking list and
resource grants, and permits active future bookings only. It captures the ID,
resource and original start/end dates in a five-minute server-side proposal.

`anny.execute_cancellation` is an execute-effect tool, excluded from the model
tool set and unavailable through ordinary `/api/tools/call`. The host invokes it
only after the authenticated UI re-reads the stored proposal, verifies that its
action/resource/interval match the displayed card, and confirms it. It rechecks the
customer's ownership, resource access, status and exact interval. A changed
booking requires a new proposal. Chat text, including “yes”, cannot confirm it.

Confirmation uses the existing atomic claim and persisted outcome state. Repeated
confirmation reuses the recorded result; ambiguous failures become
`outcome_unknown` and do not authorize a retry. If another confirmed proposal has
already canceled the booking, the plugin can establish that state without another
vendor mutation. A successful vendor response is followed by a customer-scoped
read requiring the canceled status before the host reports success.

The documented Admin action is a state-changing **GET** to
`/api/v1/bookings/{booking_id}/cancel?o={organization_id}`. It requires the
client's write opt-in, Admin authorization, an approved origin, no redirects and
no retry. It is distinct from deletion. The Admin lifecycle guide documents the
request but its current OpenAPI snapshot has no response schema. The client
therefore does not infer a response contract from the Customer API; verification
uses the subsequent booking read. See the [vendor research](../research/anny-api.md).

The mock implements this action with atomic workspace-scoped state, retaining the
booking with vendor status `canceled` and freeing its availability. Booking history
displays both `canceled` and legacy `cancelled` as “Storniert”. This is simulation:
live cancellation permissions, tenant-specific deadlines, refunds, invoices and
fees still require institutional configuration and live qualification. The demo
does not assert that a real cancellation is free or refundable.

## Contract migration

The plugin contract is version 0.4.0. The demo host explicitly approves migration
from the prior 0.3.0 manifest digest
`f730a360b3f108d5980994994c0fdbb740c1e624245b815af1f2339ef5a3ff45`.
Signed registry migration preserves the enabled flag and backs up the old slot.
Older pending proposals require fresh preparation after the version changes.
An alias-only rollback cannot undo the migrated registry slot; restore the
verified previous slot or deploy a forward fix as described in
[knowledge MCP migration](knowledge-mcp.md).

Legacy saved chat proposals without an action field remain booking proposals.
Cancellation cards carry an explicit server-issued `cancel_booking` action.
