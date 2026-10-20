# Protected chat live room availability

Date: 2026-10-20. Baseline: `af5438578c50b5ff7ec523b27ca449a3f01e6c59`.
Scope: one M2/P6 persistence and interaction repair, not milestone acceptance.
The delivery PR records the final code revision and mandatory integration gate.

## Failure and boundary

The real local TestIdP/OIDC browser could search rooms but own PostgreSQL
workspace autosave replaced checked live cards with historical unchecked cards.
That historical projection is correct for storage/reload, not a reason to lose
a just-completed interaction. A second browser observation found that the
projection remounted the composer and lost its focus/selection.

A mounted protected workspace now owns display-only room observation leases.
An own-save acknowledgement can retain only the observation's intervals and
checked flag, intersected with the current server-authorized resource identity,
complete normalized metadata and requested time window. Names, source bodies,
model evidence/history and action proposals remain server-owned. The live card
uses fixed host text rather than restoring arbitrary old assistant text. GET,
reload, conflict, unavailable storage and source/metadata changes cannot restore
this lease. It is not execution, model-history or permission authority.

Leases last 30 seconds from first capture; repeated snapshots, draft edits and
own acknowledgements do not renew them. Idle sessions expire independently.
Expiry and an own acknowledgement containing only historical room formatting
do not remount a pending action in the same chat; completion expires its display.
A real source/metadata/history change is not covered by this exception. A fresh search uses a fresh message identity.
Only the affected conversation remounts on an authorized projection change.
The account-owned composer selection cache contains positions, not text, and
restores focus only for the active chat if no other control has acquired it.

Serial writes capture the latest view when they start, not an obsolete snapshot
queued behind another acknowledgement. Drafts, navigation, renames, deletion and
new-chat activity remain local until their write is acknowledged. Concurrent
work in an existing chat can survive another chat's acknowledgement only when
the current snapshot is covered by the acknowledgement. New messages/history
trigger an immediate fresh serial save, not acceptance through an older result.
Only an unchanged, currently reauthorized submitted baseline permits that retry;
up to three attempts are allowed, then the store fails closed. Historical native
formatting may differ only when every target, metadata field and requested window
still matches. Actual revocation is hidden immediately. Empty new chats and
draft-only changes contain no extra protected result requiring reauthorization.

Native room reconstruction retains the bounded host card-grouping interaction
ID, so normal model-tool results still match their active-result controls. The
ID alone conveys no permission and disappears with an unauthorized room card.
Stored availability is still always unchecked and business actions still use
current server checks and separate confirmation.

## Verification

The real protected-server projection is composed with the client store in
`live-room-workspace.test.ts`, using a disposable in-memory JSON store and
synthetic authority. Together with the existing workspace and protected-history
suites, **51 tests pass on Node 24.21.0 and 26.11.1**. This is not PostgreSQL or
browser evidence by itself. Cases cover own-save survival, unchecked reload,
current revoke/unavailable/metadata-change rejection, model-card grouping and
revocation, expiry without extra HTTP/model calls, draft edits without lease
renewal, delayed queued saves, new-session activity, an existing second request
remaining busy without remount, a concurrently revoked baseline, offline/CAS
conflict, unrelated busy sessions, same-chat pending actions, unsigned text,
changed request windows, clock rollback, immediate reauthorization of a new
result absent from the older acknowledgement, bounded repeated races and ignoring late acknowledgements after explicit authority redaction.
An independent code review found the cross-session races; explicit regression
and revocation countercases were added before final qualification.

The actual local Node 26.11.1 TestIdP launcher, PostgreSQL and browser completed:

1. OIDC login and explicitly selected Dialog-Demo, with no provider credentials.
2. Room search for 21 October 2026, 14:00–15:00, four people; checked cards and
   exact-time preparation buttons remained after the protected autosave.
3. Full reload restored the draft and current authorized resources as unchecked
   history. Selecting one historical room performed a new availability check.
4. Selecting its fresh slot produced a pending proposal. Separate explicit
   confirmation created one synthetic booking, then the personal bookings page
   showed that room and interval as confirmed.
5. After a draft edit, actual composer focus stayed true with selection start/end
   39 and the complete 39-character draft, before and after autosave.

No live model generation, provider-cache experiment, real institutional data or
real Anny write was performed. These are one local desktop-browser journey and
focused component cases, not the complete P6/mobile/assistive-technology matrix,
the UI ≤200 ms measurement or a provider quality/cost benchmark. The browser
run preceded a type-only ref-container/null-guard correction to the same focus
logic and an additive server card-group ID repair; the final focused suites,
full gate and production build qualify those exact final sources separately.

## Remaining findings

The reviewed experimental MCP App initialization timeout is still open. The
post-confirmation host helper/link is rewritten as unavailable free text by
history sanitation, although the current proposal receipt and personal booking
remain available; the closed proposal presentation also still needs a clearer
completed-state heading. These require a separate authority-backed receipt/UI
repair, not restoring unsigned success text. They are not accepted by this PR.
Full joined plugin/install/configure/update/rollback/reconnect/admin journeys,
broader simulated mobile/accessibility checks and measured local UI feedback
remain M2/M7 work. Real devices/institutional acceptance remain M8.

## Related deployed baseline

PR #128 passed exact-head CI 39321459111 and main CI 39322212072, merged as
`af5438578c50b5ff7ec523b27ca449a3f01e6c59`. Coolify delivery
`bxmtl2fnmzsf0bozooqu6wql` completed at 2026-10-19T20:55:03.785Z; the independent
HTTPS health response later reported that exact ready revision. At the
2026-10-20 continuity read, 325 of the prior 345 baseline rows remained active,
20 had normally expired, zero active baseline rows were missing/changed, and
PostgreSQL identity/volumes and the budget fingerprint were unchanged.
This is baseline deployment evidence, not publication of the current repair.

## Qualified source identities

| File | SHA-256 |
| --- | --- |
| `apps/web/src/lib/live-room-availability.ts` | `12ccc681598f7be1d199490a238b7e8b335e0d3e206d1cadb71d17be780585de` |
| `apps/web/src/lib/chat-workspace-store.ts` | `1ce60ad7969e51912bfb0013786a316e0f21dad4872d6cc23f0f15793c74c37f` |
| `apps/web/src/lib/server/protected-workspaces.ts` | `9f986c50e7d6aad6a81dcb35aef9dcb62dafa65da0a5e246ec0d24033c196e5a` |
| `apps/web/src/components/assistant-page.tsx` | `02c61e6d275e4a1a97fb48a565b9bc07872a8f1aeac07051348ba1c6266b8a54` |
| `apps/web/tests/live-room-workspace.test.ts` | `37b8ad8296bfb9fda9ce96b197a3bdb05e51075c20a48addd61676b18da247c0` |
