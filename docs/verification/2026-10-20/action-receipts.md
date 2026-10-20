# Authority-backed chat action receipts

Date: 2026-10-20. Baseline: `0301545ec8b8d738504a5cc9edf511be37fc3ebf`.
Scope: a partial M2/#49 persistence and action-status repair under consolidated
plan V7 (`abd76038387b39c7342385473a5c56c6766c5afb`).

## Failure and repair

Successful booking/cancellation previously appended an unsigned free-text helper.
The protected workspace correctly removed that helper on save, while the retained
proposal card did not present its authoritative confirmed status. A frontend
schema also omitted the real `executing` proposal state. An own save observing
pending→executing could therefore discard the card or remount and abort a
confirmation that was still awaiting its reply.

The original proposal now becomes the receipt. Fixed host copy and visible
status derive from its structured, subject-authorized proposal GET; neither a
client `confirmed` flag nor arbitrary tool text establishes success. The card
retains the target, interval and action preview and links Anny completions to
bookings. Only pending proposals expose confirmation controls. Generic plugin
cards follow the same status behavior without Anny-specific booking links.
No result envelope or vendor booking identifier is added to retained receipts.

The own-save compatibility rule permits only matching action details and forward
status progress. It binds IDs, action, preview, target, interval and expiry;
generic actions additionally bind the execution tool, instance and arguments.
Other message metadata/history must match. Revocation, changed details or reversed
status still remount/redact the conversation. The independent status control
uses GET for ordinary states and explicit reconciliation for executing/unknown
outcomes, validates the same details and updates the card without repeating a
write. It aborts its request on unmount. An expired pending GET is normalized to
invalidated; the confirmation deadline never expires an already completed card.

## Automated evidence

The six focused suites (`action-receipt-workspace`, `proposal-presentation`,
`native-history`, `chat-message-copy`, `protected-workspaces`,
`chat-workspace-store`) pass 58 tests. They compose the actual protected service,
JSON store and client workspace store, and cover:

- Booking/cancellation save→reload→revocation with current authority.
- Forged completion flags, unsigned success text and unsigned model history.
- A 35-second delayed own-save acknowledgement while a confirmation remains
  busy, then executing→confirmed and draft preservation.
- Changed target, preview, expiry, action or generic arguments, status reversal
  and revoked records forcing remount/redaction.
- Native GET reconstruction of executing/confirmed states, denied proposal
  reads, bounded identifiers and stripping unapproved result fields.
- Expiry boundary behavior for Anny and generic proposals and receipt clipboard
  content without stale preparation copy or internal identifiers.

Web TypeScript/lint and the production-mode Next.js build pass. An actual build
of the complete Dockerfile with its allowlisted context also succeeds in the
pinned Node 24 Linux/arm64 image. The delivery PR records the exact candidate,
mandatory integration gate, CI and deployment outcome; local builds alone do
not establish a deployed revision.

An independent read-only review identified the pending-expiry display issue;
the fix and boundary regression were re-reviewed. No further actionable
regression was found in that bounded review.

## Browser evidence

A fresh local Node 26 TestIdP session with disposable PostgreSQL and no inherited
model credentials used explicit Dialog-Demo. The actual browser journey searched
workplaces in 1J for 21 October 10:00–16:00, selected Amrum 1, confirmed once,
reloaded, verified one confirmed card/no confirmation button, followed the
bookings link and observed one booking. Back in the same chat it listed bookings,
began cancellation, confirmed once and reloaded. Both completed cards remained;
the list reconstructed the cancelled booking. Explicit status checks on the
cancellation retained the confirmed status. No provider or live tenant was used.

At a simulated 390×844 viewport both receipt cards measure 358 pixels wide;
`innerWidth` and document scroll width are both 390. The mobile screenshot was
visually inspected; navigation, status action and bookings link fit. Temporary
viewport overrides were cleared and the owned runtime stopped. This is browser
simulation, not native iPhone/assistive-technology or M8 acceptance.

## Remaining scope

This repair does not complete M2, M6 or M7. The joined P1–P6/admin/reconnect/App
journeys and local UI timing remain open. Initial protected Dialog-Demo
clarifications still become unavailable on protected autosave; those unsigned
helpers need their own authorized host-message design. One compound office-type
request also leaves unmatched query words; the explicit neutral request worked.
These observations are retained, not counted as a full successful chat journey.
Receipts are bounded by the current core proposal lifetime and current service
account/binding authority, not permanent archival documents. M6 gold/workflow
measurements and a demonstrated Groq cache hit remain separate requirements.
