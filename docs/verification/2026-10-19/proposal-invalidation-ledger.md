# Proposal invalidation ledger preparation

Date: 2026-10-19. Scope: local M2/P5 supporting primitive, not integrated API
behavior or milestone acceptance.

`ProposalInvalidationLedger` accepts a server-signed, domain-separated descriptor
for a definitive binding change. It verifies scope, proposal, plugin, subject
and previous binding identities. Only a pending proposal can transition to
invalidated. Its CAS stores the terminal status and signed event together;
an unavailable observation performs no state access or mutation. Claimed,
unknown and other non-pending outcomes retain their execution identity.

A deterministic audit key is created with insert-only CAS, and an existing
projection must have the same verified event. Projection failure leaves the
event in the proposal outbox; a later exact-key read retries it. These are not
atomic writes across two keys. There is no eager index/sweep or guaranteed
background drain. Proposals expire under a required server-owned retention
callback, validated before mutation; confirmation expiry is not misused as
data retention. The separate digest-only audit has no expiry in this primitive;
its eventual operational retention policy is still unaccepted.

Independent review reran the initial 18 tests and found no blocker within this
scope. A subsequent explicit claim-versus-invalidation race test passes: the
claim wins the CAS, its execution ID remains, and no audit event or invalidation
is fabricated. The final focused suite passes 19 tests; scoped ESLint passes.
No provider call, external business write or budget mutation is made.

This is not yet composed into proposal routes or the registry. It needs trusted
signer wiring, authoritative changed/withdrawn/unavailable classification,
host-owned status presentation and integrated concurrency/unknown-outcome tests.
Dormant proposal materialization and outbox retention/drain semantics need an
explicit reviewed acceptance decision. The separate active-epoch candidate also
has an unresolved mixed-version/old-binary recovery gate. None of these local
artifacts is approved for deployment merely because unit tests pass.
