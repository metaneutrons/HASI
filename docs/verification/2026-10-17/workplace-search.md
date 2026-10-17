# Building search and requested-time regression

Date: 2026-10-17. Reported query: “Ich brauche am kommenden Montag ein Büro
im Gebäude 1J von 8–16 Uhr”.

## Reproduction and correction

A live Groq GPT-OSS 120B request on deployment `c072962719097efc71d67b618c4b16d7e2a581db`
returned `anny_search_resources` with `{ "kind": "workplace", "location": "Gebäude 1J" }`.
The literal location filter returned zero despite 27 workplace leaves associated
with 1J in the authorized snapshot. No new HsH room records were synthesized.
Building wording is normalized while explicit building/site/feature constraints
remain enforced. Empty search results explicitly do not establish availability
or absence of resources from the site's complete catalog.

The separate synthetic availability service previously offered only fixed UTC
start times. It now also checks the exact requested instant, deduplicated and
sorted with its existing alternatives, preserving past-time and overlap checks.
The Monday parser uses the Berlin calendar; at the report's server date,
2026-10-17, the coming Monday is 2026-10-19. Ambiguous or negated dates remain
unknown instead of inventing a booking date.

## Local qualification

- 245 tests passed, one PostgreSQL suite skipped locally and required in CI.
- Build, lint and type checks passed.
- Regression checks cover building prefixes, unknown/wrong buildings, explicit
  feature/site constraints, the complete reported sentence and ambiguous dates.
- The actual HsH demo catalog returns eight bounded cards with 19 further
  matches. An eight-hour 08:00–16:00 Berlin interval can produce a pending
  proposal; it does not confirm a booking. A booked overlapping interval becomes
  unavailable in the mock contract regression.
- Desktop UI check: one session has no count badge; two sessions show a round
  count directly in **Chats**. The embedded visual subtitle is removed; an
  accessible list heading remains. The compact mobile drawer retains its title.

Exact-head CI and deployed workflow evidence are recorded in the implementation
PR. Browser emulation does not establish native iPhone qualification. Room
availability, booking and source permissions remain synthetic.
