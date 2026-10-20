# Typed workflow observations for offline evaluation

This is a bounded M6 harness contract, not a model-quality or application-workflow
qualification. The development cases remain drafts; no gold case or acceptance
threshold is promoted by this change. No production executor, provider transport,
real API write or budget bypass is supplied.

A model response can contain answer text, citations, proposed calls and synthetic
measurements. It cannot supply application observations. A server-registered
`observeWorkflow` function is required whenever an explicit oracle contains
`workflow_trace_exact`. Missing or incompatible registration fails before the
model transport runs. An observer without a workflow oracle is a configuration
error. Cases and their natural-language expected labels cannot register code or
establish observations.

The observer runs only after the transport response passes its strict schema.
It receives the case ID, a fresh workflow run UUID, the exact authorized model
projection digest and a copy of the validated response. The host adapter must
obtain observations from its own instrumented application fixture; a model claim
of consent or success is never a confirmation or effect. The model input remains
the existing allowlisted projection: clocks, user messages and authorized source
evidence. No expected labels, fixture events, oracle, observer or run UUID are
added to that projection.

## Observation envelope and events

The strict version-1 envelope binds `runId`, `caseId`, `inputDigestSha256` and an
ordered `events` array. Another run's envelope is rejected even when case and
model projection are identical. The bounded plain-JSON preflight rejects proxy,
accessor, cycle, non-JSON and oversized inputs before recursive validation.

| Event | Bounded fields | Meaning |
| --- | --- | --- |
| `action_confirmation` | action, subject, proposalId, actionDigestSha256 | Host observation of the exact authenticated confirmation and bound details |
| `action_attempt` | action, subject, proposalId, actionDigestSha256, attempt, outcome | Host observation of an attempt; outcome is confirmed, outcome_unknown or rejected |

Actions currently cover `book` and `cancel_booking`. Empty traces are permitted
for explicit no-event oracles. The observer must derive the attempt digest from the actual submitted action
parameters and record the actual on-behalf-of subject; copying the confirmation
digest/subject without observing the attempt cannot establish that binding.
The exact ordered comparison detects missing,
additional, reordered or mismatched confirmation/attempt events; a second attempt
after an expected single unknown outcome fails. This parser does not itself
validate authentication, authorize actions, implement reconciliation or prove an
observer truthful. Those behaviors require the actual application executor and
independently verified instrumentation.

A current observation is accepted only when all three envelope bindings match.
Observer exceptions, invalid data and mismatched bindings yield `not_run`, never
a passing grade. Observation data is not accepted from the model response. The
observer's response copy cannot mutate the recorded model response. The recorded
assessment contains assertion statuses and a domain-separated observation digest,
not raw event/subject/proposal data. The oracle digest remains tied to the expected
trace; the observation digest also includes the fresh run UUID.

## Bounded checks and remaining integration

Focused tests exercise the existing `anny-03` and `anny-06` draft cases using an
explicitly injected synthetic observer. They cover one unknown-outcome attempt,
extra/missing/reordered events, wrong confirming or attempting subject/action/details, errors and invalid
observations, case/projection/run binding, model-supplied fields, unsupported
observer registration and response-copy isolation. Parser checks include hostile
objects and bounded input. These tests qualify the harness plumbing only. They
are not an execution of the room/cancellation workflow or a live-provider result.

The next slice must connect this contract to observations of the actual synthetic
application executor and author the case-specific server oracles. The generic
`applicationEvents` and `trustedApplicationContext` draft fixture fields have not
been declared observations or silently treated as runtime evidence. The other
workflow/access/injection cases require event types appropriate to their effects.
Gold review/adjudication, agreed thresholds, the larger separated corpus and the
instrumented budgeted per-profile comparison remain in M6 (#53). Institutional
source/vendor semantics remain in M8 (#80).

Local verification on 2026-10-20: 45 focused tests in the two existing harness
suites and two new workflow suites passed, as did root/web typechecking and
affected type-aware lint. Independent bounded source review identified the
missing attempted-payload binding; attempts gained their own subject/digest and
two countercases, and the follow-up review found that contract gap closed. No
actual workflow executor or provider was run. Required full-suite/CI qualification
and delivery remain separate from this local result.
