# Booking confirmation feedback and status follow-ups

Date: 2026-10-22. Related to M8 #80 and the supplied Max Planck booking dialogue. This is a bounded regression repair, not institutional acceptance or a model-quality grade.

## Reported failure and change

The confirmation handler updated only the earlier proposal card. It appended the visible user button attempt but no new assistant acknowledgement. The exact follow-up “gibt es da keine Rückmeldung?” bypassed the existing closed status-question vocabulary and could reach model planning again. The supplied response then attempted preparation and described 08:00–10:00 as local time, although the selected interval was 10:00–12:00 Europe/Berlin (08:00–10:00 UTC). The pasted dialogue alone does not establish the final backend outcome of that historical booking.

A verified confirmation now appends an authority-backed current-action receipt after the user's button attempt. Booking, cancellation and generic plugin confirmation use this same display-only path. A repeated proposal reference renders a compact acknowledgement, not another execution control. The receipt stays outside model wire history; protected persistence resolves its reference against the actor-authorized server action and replaces browser-authored status/prose. The original full card remains available through “Aktionsbeleg anzeigen”. Completed/uncertain/failed cards no longer display the pending preview's future-execution wording.

Closed standalone status questions share one vocabulary between UI and initial-tool planning. When the chat has a proposal, the host reads its current authenticated status, checks identical action details and monotonic state, and replies without a model call, proposal preparation or execution. Unknown/unreadable/mismatched states do not become success. Mixed new tasks are not swallowed by the status vocabulary. The acknowledgement formats the bound interval with the existing Europe/Berlin helpers rather than asking a model to reinterpret UTC values.

New acknowledgements retain bottom-of-chat scroll priority. Lost confirmation-button focus can recover onto the new message; a status request does not send focus/scroll back to the old card or steal focus from the composer.

## Verification

- 76 focused tests passed across five files: closed status/help routing, initial tool planning, action receipt persistence/forgery/revocation, proposal status/identity, and pending-versus-completed preview copy. Both booking and cancellation acknowledgements retain their canonical receipt after the user attempt across protected save/reload; forged success text is discarded and revoked references disappear.
- Backend packages built; web TypeScript and lint checks passed after rebuilding stale local package declarations. Full normal pre-push/hosted CI and delivery remain separately observed steps.
- Actual local Next 16.4.2 development browser journey used only the embedded demo, a fresh disposable PostgreSQL database, a new synthetic employee persona/grant and explicitly selected Dialog-Demo. No provider credentials or real business data were supplied. The local development process explicitly resolved the pinned transitive dependency directory through NODE_PATH; this is not a clean production-build qualification.
- Tomorrow in 1J, 10:00–12:00, then “Einzelbüro”, produced availability-checked workplaces. Selecting Max Planck 1J.1.02 produced a pending preview; a separate click confirmed it once. A new acknowledgement appeared after the visible user attempt and received focus after the removed button.
- The exact reported follow-up returned a new confirmed receipt for 23 October, 10:00–12:00. Reload preserved it. “Meine Buchungen” showed exactly one confirmed Max Planck booking at 10:00–12:00. The server log (SHA-256 `43edf372e23c9b12accf90fdef5259422b4e8c6fda9d38767c29ee1b5338e094`) contains one proposal-preparation POST, one confirmation POST, and zero model-route POSTs for the whole journey. The follow-up performed only the current-proposal GET plus session/timestamp operations; no second preparation or confirmation occurred.
- The owned tab closed; the local process stopped; its entire owned PostgreSQL cluster and temporary HOME were removed. Next's generated type imports were restored. No shared or production state was changed by this browser journey.

This does not repeat the initial search with live Groq, qualify arbitrary paraphrases, prove real anny writes/delegation or satisfy actual iPhone/VoiceOver acceptance. The physical-device retest remains in M8-A7; model-answer assessment remains M8-A11/A12.

## Qualified product sources

| File | SHA-256 |
| --- | --- |
| `apps/web/src/components/assistant-page.tsx` | `7f5d303424310bb522a415311d5e2e3a4c3ed8fff193f24d4ecd0f76ec591327` |
| `apps/web/src/components/action-status.tsx` | `713d167f0ee8e5bddb17ec9676e2c3eed7ffd08fc77b669d231299a4c93406de` |
| `apps/web/src/lib/chat-action-guidance.ts` | `33d191edc7acc928f3213c6d5754fad218226191c0115a744df73532c26d6d66` |
| `apps/web/src/lib/initial-tool-plan.ts` | `db791115a825996e58c8650cc3d89da9310c3535fd0e2fc1f4c5b711e520705a` |
| `apps/web/src/app/globals.css` | `6dbc7341e7171b367a53031a8b30f3349788ffc30a61812b0e166cb6b65cd4cb` |

## Internal booking IDs

Following Fabian's clarification, Anny's internal booking ID is removed entirely from the user-facing overview. There is no identifier disclosure or copy control. Resource, date, interval and status remain visible. Backend IDs, status lookup and cancellation identity are unchanged. The earlier proposed optional support-reference component was withdrawn because the internal identifier is not useful as an Anny user-facing support reference.

A bounded isolated browser fixture rendered the actual `BookingsPage` against one synthetic read response that still contained an internal UUID. Initial rendering and a refresh showed the room, interval, status and count without that identifier or a Details control. The fixture used the current application CSS and a minimal Next environment shim; it is a component observation, not a new full application or actual-device test.
