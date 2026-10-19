# Demo room-search reset regression

Date: 2026-10-19. Bounded deterministic Dialog-Demo behavior; no provider
quality claim and not full M2/M7 acceptance.

[PR #114](https://github.com/metaneutrons/HASI/pull/114), exact candidate
`6ee2e511753835685a6a432073e97dcd023926a2`, passed all five required checks
in [CI 39272270200](https://github.com/metaneutrons/HASI/actions/runs/39272270200).
Its merge `255afe8876eb46685d005a1fb6cee4856cdb48fb` passed
[exact-main CI 39272864503](https://github.com/metaneutrons/HASI/actions/runs/39272864503).
The automatic controller completed Coolify job `anlv8qqlg3al6lzudxm0frbs`
with one exact-revision public readiness check at `2026-10-19T15:00:58.756Z`.
The immutable image ID is
`sha256:df4442dc993b39c5b9fa5f8e4f312e969363d2c8090f82f5f030a850a271497f`.

The failure was reproduced in the public browser before the fix: a full new
search command left `neue raumsuche` in the resource keyword filter, making
otherwise appropriate resources disappear. The parser now consumes that command
phrase separately from resource names. The regression failed before the change,
then passed with the fixed October 19 clock, October 20 10:00–16:00 interval,
1J location and single-workplace office filter. The resource-name control keeps
`grace hopper` and finds resource 190449. Root repeated 24 focused parser/time
tests; the mandatory local gate passed 1,068 tests and one Linux-only macOS skip.

After public health reported the exact merged revision, root reloaded the
existing synthetic employee conversation, retained Dialog-Demo, and submitted:

> Neue Raumsuche: Ich brauche morgen ein Einzelbüro im Gebäude 1J von 10 bis 16 Uhr.

The last assistant result reported October 20, 10:00, 360 minutes, location 1J
and seven appropriate single-workplace offices: four cards plus “Weitere 3
anzeigen”. No booking was confirmed and no model was called. The existing
invalidated proposal and both chat sessions remained. The content-free DB
comparison at `2026-10-19T14:59:39.296Z` found zero missing still-valid baseline
rows, one earlier intentional proposal invalidation and the unchanged shared
budget fingerprint from the [core cutover](live-core-epoch-cutover.md).

This fixes the explicit reset phrase in the deterministic demo parser. It does
not establish how a live model handles every natural-language room request.
