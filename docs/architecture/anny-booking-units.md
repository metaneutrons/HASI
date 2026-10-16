# anny booking units and office hierarchy

Date: 2026-10-16. HASI interprets an office request as a request for one
workplace, unless the user explicitly describes a different task. A meeting room
or lecture hall is a whole-room booking with a separate person capacity.

## Verified source structure

The authorized read-only HsH catalog contains 61 resource records: 30 roots and
31 children, with every parent ID resolving inside the catalog. Tenant category
`60` (`Flex Desk`) contains 18 office containers and 37 bookable workplace
leaves; category `6` (`Meetingraum`) contains six meeting rooms. The workplaces
belong to 24 offices: 18 have separately identified desk children, while six
single-place root resources have no child resource. No lecture halls are
present. Supporting the `lecture_hall` type does not invent such source data.

The original 30-record export omitted children because the default global
listing excluded them. A fresh paginated Admin index request with
`filter[exclude_child_resources]=false` returned 50 + 11 records. With
`include=parent,category,resource_properties.property,services`, it supplied all
31 actual parent relationships and six numeric `Kapazität` properties. The
filter and parent expansion are observed Admin behavior, but are absent from
the pinned Admin OpenAPI parameter allowlists. The Customer specification
documents the exclude-child filter. Tests record the observed Admin contract;
the distinction from documented behavior must remain explicit. The token's
parent-specific child route returned 403; no access was inferred from that
failure and no live write was attempted.

Anny's `quantity` is the number of parallel bookable slots. It is not a room's
person capacity. Each bookable leaf in this snapshot has quantity one; the
composition rejects a different value rather than silently turning a pooled
resource into an exclusive booking. Person capacity comes only from a positive
integer, explicitly numeric `Kapazität` property. Workplace capacity stays null;
the product's one-workplace booking unit is not an invented source seat count.
See the [field provenance](../evaluation/anny-room-snapshot.md) and the vendor's
[Admin OpenAPI](https://docs.anny.co/developers/openapi/admin.openapi.json) and
[Customer OpenAPI](https://docs.anny.co/developers/openapi/customer.openapi.json).

## Application contract

The sanitized snapshot retains the full hierarchy. The demo composition offers
only 43 leaves to the mock API, plugin presentation and identity grants. A
forged proposal or availability request for an office container is rejected
server-side. Searching by office name matches its actual workplaces through
their `parentName`; it never manufactures child IDs from a desk count or name.
For workplaces, a `location` filter also searches that actual office name.
This handles models that express a requested office as a location instead of a
query without dropping the user's requirement or treating an office as a room
booking. Whole-room location filters still use the room's location only.

The anny plugin emits `kind` (`workplace`, `meeting_room`, `lecture_hall`, or
generic `room`), `parentId`, `parentName`, and the separate nullable `capacity`.
The chat tool accepts the same kind filter; `room` searches whole rooms and
excludes workplaces. A person-capacity search cannot return a desk as a meeting
space. Multiple requested workplaces require distinct leaf selections and
separate exact confirmations; HASI does not multiply a booking quantity or
claim that one desk reserves the office. Ambiguous group requests should be
clarified in the conversation.

Cards identify an individual workplace and its office. Server-generated
proposal and booking names contain both the desk and its parent office, so
repeated source names such as `Arbeitsplatz 1` remain distinguishable. Execution
binds the actual leaf resource ID and the exact confirmed interval. Booking
one desk leaves a sibling available in the simulation. This is demo behavior,
not qualification of the institution's live exclusivity or booking rules.

The original synthetic fixtures without type metadata remain generic rooms.
Previously saved chat cards can still load, but their text grants no authority;
selection rechecks the current server catalog. The offline dialogue parser also
maps office/workplace wording and keeps at most eight resource cards per reply.

Each model call receives the current server time in `Europe/Berlin` and
explicit ISO calendar dates for today, tomorrow and the day after tomorrow.
These advance Berlin calendar days rather than 24-hour durations, including
across daylight-saving changes. The same context is supplied to Groq, GWDG and
custom profiles. Earlier chat messages do not yet have individual trusted
timestamps in the model context; an ambiguous reference to an older relative
date requires clarification. Calendar context does not make model output
authoritative: the exact absolute date remains visible on the proposal and
requires user confirmation.

## State migration and limits

The expanded output contract is anny plugin version 0.3.0. The deployed host
explicitly approves the exact previous 0.2.0 manifest digest
`325f50953082e8b1156d3c1807a1310b492e61bbcdc84d9d6fd9cd48952db66b`.
The registry's existing signed-state migration preserves the enabled flag and
backs up the prior signed slot. It does not automatically approve an arbitrary
third-party update. Old pending proposals fail the plugin-version check and
must be prepared again.

The changed resource IDs produce a new synthetic calendar namespace under the
existing catalog isolation policy. Earlier demo bookings remain in their old
retained namespace and are not converted into guessed desk bookings. Rolling
back requires restoring the verified old registry slot as documented in
[knowledge MCP migration](knowledge-mcp.md), or a forward fix; moving the Vercel
alias alone does not undo registry state.

All availability and booking writes remain synthetic and workspace-scoped.
Real SSO, source access, service eligibility and live anny bookings are separate
qualification work. The demo's workplace service preference is explicit
simulation configuration, not evidence of real booking permission.
