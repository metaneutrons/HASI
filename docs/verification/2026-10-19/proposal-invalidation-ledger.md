# Proposal invalidation ledger

Date: 2026-10-19. Scope: local M2/P5 implementation evidence for proposal
binding invalidation. This is not milestone acceptance or production approval.

The API composes a server-owned signer, scope, durable store and trusted binding
observer into `ProposalBindingGuard`. The guard validates proposal ownership
before observation or projection. A definitive changed/withdrawn binding can
cause a pending-only CAS that stores the terminal `invalidated` state and its
signed, digest-only event in the proposal row. Unavailable authority is a
no-op. Claimed, unknown and other non-pending outcomes retain their execution
identity. GET and confirmation routes return the fixed invalidated response;
the event does not include raw proposal, plugin, subject or action data.

The event row is the canonical outbox. The audit projection is a separate,
insert-only CAS and must verify as the same signed event if the key already
exists. If projection storage fails, the response reports `pending`; an exact
owner read can retry while the canonical proposal remains readable. There is
no background index or guaranteed drain. A failure that lasts through expiry
can leave no readable projection after the outbox expires.

The signed change descriptor and the canonical audit event have distinct
strict schemas and signature domains. The descriptor carries no retention
metadata. On the successful invalidation CAS, the server-owned
`proposalRetentionUntil` callback's absolute deadline is included in the
canonical event payload before it is signed, then the signed event and terminal
proposal state are stored atomically. The projection expiry is read only from
that authenticated event field. Reads and retries verify the event signature
before projection and never call the retention callback again, so a database
edit to the deadline fails verification instead of extending the projection.
If the authenticated deadline has elapsed, projection retry is skipped. The
current API composition supplies
`proposal.expiresAt + 24 hours`; proposal `expiresAt` is initially five minutes
after creation. This deadline is therefore tied to the proposal lifecycle, not
24 hours after the signed event timestamp; a late invalidation can have less
than 24 hours of remaining retention. The callback is wired for the
store-backed API compositions, including production and public-demo. This is a
provisional implementation default, not institutional retention approval;
M8-A4 still requires the applicable data and retention approvals.

`JsonStore` expiry makes records unreadable at the absolute deadline. The
PostgreSQL store filters expired rows during reads; physical cleanup is a
separate explicit `deleteExpired` operation. This evidence does not claim
physical purge at the deadline. The focused ledger suite verifies equal
proposal/projection deadlines, failed-projection retry before expiry, no
sliding expiry on repeated reads, and both records becoming unreadable after
expiry without an exact-key read recreating the projection. The focused run
passes 49 tests across `proposal-invalidation.test.ts`,
`proposal-binding-guard.test.ts` and `plugin-lifecycle.test.ts`. The API project
typecheck and scoped ESLint pass. A repository-wide typecheck was also run, but
it currently reports two unresolved `isDeepStrictEqual` references in the
concurrent, root-owned `scripts/qualify-core-epoch-cutover.ts`; it does not
report an error in the assigned API files. Existing race and terminal-state
tests continue to cover execution claims and non-pending proposals. No
provider call, external business write or background drain is performed by
this primitive.

This remains bounded implementation evidence. It does not establish complete
institutional P5/P6 acceptance, indefinite immutable audit storage, production
retention approval, or a guaranteed projection-delivery SLA.
