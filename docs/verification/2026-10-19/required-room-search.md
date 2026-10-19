# Required room search and pre-read prose

Date: 2026-10-19. Integration baseline: `20bd019e79098bea2c5e10a8b36a29fdeb9afdcc`.
Scope: offline regression for the reported office-search conversation, not live
provider qualification or complete M4/M6 acceptance.

The current router already denies a room-discovery task before provider I/O if
the authenticated tool catalogue lacks resource search. When available, it
requests a native `anny_search_resources` call for the initial discovery turn.
The pinned AI SDK also rejects a text-only response violating that forced choice;
inspection and the synthetic provider test confirm that boundary. A response
combining the valid search call with contradictory prose was still permitted,
and the chat rendered that prose before executing the search. The reported live
failure is not proven to have followed this exact path.

HASI now enforces its own postcondition: exactly one initial resource-search
call must be returned for that restricted turn. Accompanying model prose is not
returned to the UI. Native search activity and result cards supply feedback;
answers after the actual read remain outside this initial-turn restriction.
No source permission, model selection, budget or confirmation gate is bypassed.

Synthetic Groq-format HTTP fixtures cover the exact German office request,
text-only violation, contradictory prose with a valid search call, and duplicate
search calls. Missing authorization still causes zero provider calls. A valid
call retains its arguments and measured usage. A tool-choice violation thrown
inside the SDK before usage is exposed retains the existing conservative budget
reservation; it is not falsely settled as zero or as measured tokens. No extra
retry or provider fallback is introduced.

These checks make no live model or Anny call and establish no real availability
or booking. They do not prove that a model's later answer is grounded; that
remains part of the separate M6 evaluation.
