# Proposal invalidation and preflight recovery UI slice

Date: 2026-10-19. Local implementation with bounded synthetic browser checks; no hosted or M2 acceptance claim.

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

Root browser qualification used the actual Conversation component compiled at
`55b2f1a348291b5d5f161c0df1561885cd78b164` plus the focus correction in
`assistant-page.tsx` (source SHA-256
`f050022da9e6f1c3c429ffba8b9c03808ddb1eab91efc007c2b5808bfcf29c6f`).
A disposable loopback-only harness supplied fictional proposal/session replies;
its only component transformation exported Conversation, and Next Link used a
plain anchor. This is not the deployed API/auth/database topology. No provider,
real booking or protected data was used.

At 390 px/light, exact 409 invalidation removed confirmation controls, focused
the labeled invalidated group and made zero confirmation POSTs. Reload from the
stored snapshot preserved invalidation and zero confirmation POSTs. At
320 px/dark, a preflight 503 retained the enabled confirmation button and restored
keyboard focus to it, with zero confirmation POSTs. The harness then recovered
the service without resetting the iframe, stored chat, request log or counters.
The original error message remained; no automatic confirmation occurred. An
explicit Enter on the same confirmation button produced exactly one
confirmation POST and the confirmed receipt. The visible request log showed the
503 preflight, then the fresh 200 preflight and single 200 confirm. No rendered
element exceeded the frame bounds (390 frame: 388/388 client/scroll width;
320 frame: 318/320, no element beyond client width + 1 px).

The original error paths lost focus to body. The correction waits for the final
idle render and restores only a visible, connected card in the active chat when
focus is still on body. It does not take focus from a newer user target or an
inactive chat. Independent review found no blocker; root web typecheck and
component ESLint passed. Successful completion focus and the wider journey are
not qualified by these error-path checks.

Native iPhone/Android, assistive-technology and participant acceptance remain
M8-A7. The whole feature remains unshipped pending the compatible-core
cutover/recovery and other open server-side gates.
