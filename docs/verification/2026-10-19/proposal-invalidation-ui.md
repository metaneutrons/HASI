# Proposal invalidation and preflight recovery UI slice

Date: 2026-10-19. Local implementation; no browser, hosted or M2 acceptance claim.

The client admits only HTTP 409 with the exact server code
`proposal_invalidated` as a definitive invalidation. It marks the matching card
`invalidated`, clears its active confirmation, preserves that status in stored
chat snapshots and removes confirmation/reconciliation controls. The card label
is “Vorschlag ungültig”. The server's pending-only invalidation is the basis for
the message that this action was not executed; generic failures cannot establish
that fact.

A network or HTTP 502/503/504 failure before confirmation dispatch retains the
active proposal for a deliberate user retry. The dispatch marker is set after the
fresh session-owner check, immediately before the confirmation HTTP request.
Once dispatch starts, a generic failed response becomes outcome-unknown and
cannot enable an automatic execution retry. Read-only preflight and uncertain
execution are therefore separate states.

Root verification passed the five `proposal-failure.test.ts` cases and web
TypeScript/scoped ESLint. Countercases compare the same HTTP 503 before and after
dispatch; foreign 404 and unknown codes are not retryable authority. A restore
test uses a fixed clock: both proposal kinds retain invalidated status and an
invalidated action cannot remain active, while the corresponding pending
positive control does remain active. Independent read-only review found no
blocker. The author additionally reported 24 focused regression tests and full
web lint/typecheck passing; root's separately named tests are the direct evidence.

The remaining browser smoke must invalidate a proposal, observe the card, reload
and confirm the state persists; then simulate a preflight 503 and verify the card
remains actionable with zero confirmation POSTs. Unit/static review is not that
browser evidence. Native iPhone/Android, assistive-technology and participant
acceptance remain M8-A7. The whole feature remains unshipped pending the
compatible-core cutover/recovery and other open server-side gates.
