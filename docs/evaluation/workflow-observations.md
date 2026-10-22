# Typed workflow observations for offline evaluation

This is a bounded M6 harness contract, not a model-quality or complete application-workflow
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

## Synthetic application bridge

The test-only `scripts/evaluation/anny-fixture.ts` bridge uses the actual
`createDemoRuntime`, API proposal/confirmation routes, Anny plugin, execution
journal and HTTP mock. Each run owns a fresh isolated memory store, synthetic
employee account, Anny consent and loopback listener. A separate synthetic host
request reads the current proposal and confirms it through the authenticated
API. This establishes API confirmation, not a browser click or institutional
identity.

Expected confirmation details come from the pending server proposal. Observed
confirmation/attempt details come from successful store transitions and the
mock's persisted execution evidence, correlated by the server's execution ID.
The attempt's subject and argument digest are derived independently from the
committed source record. A response is deliberately lost only after the mock
commits; the core must retain `outcome_unknown`. Cancellation has a separately
identified setup booking. Setup effects are counted separately, not silently
ignored or confused with the cancellation under test.

The `anny-03-runtime` and `anny-06-runtime` development variants connect these
observations to the runner with exact trace and no-model-retry assertions. Their
model input uses sanitized status from that executed fixture and a generic user
request; it does not pretend the draft cases' static people, room names or
confirmation events were executed. An attempted model retry fails its own
proposal assertion even when the backend effect trace remains safe. Model output
never invokes an execute tool. The isolated fixture is consumed by one run and
closed afterwards; no production source or model provider is contacted. The
observer checks all source write requests as well as correlated committed
receipts: a rejected extra request with a missing/different execution binding
cannot disappear from the attempt count. An isolated counter-probe sends an
unauthenticated loopback write request and requires HTTP 401, zero added effects
and an ungraded observation. A separate counter-probe corrupts only a captured
receipt copy, leaving the actual private memory state intact, and requires the
observer to reject the argument/digest mismatch.

This bridge does not establish the original cases' UI provenance, cross-process
persistence, provider answer quality or general observer trust. The host owns the
fixture lifecycle; stamping a matching run envelope cannot make an arbitrary
observer truthful. Browser confirmation and independently persisted production
correlation remain separate evidence requirements.

The remaining integration must author the case-specific server oracles and
qualify the full evaluation lifecycle. The generic
`applicationEvents` and `trustedApplicationContext` draft fixture fields have not
been declared observations or silently treated as runtime evidence. The other
workflow/access/injection cases require event types appropriate to their effects.
The instrumented budgeted per-profile comparison remains technical M6 (#53).
Under V11, human answer review/adjudication belongs to final M8-A11/A12; proposed
benchmark counts/thresholds retain their existing approval status and no draft
case becomes gold. Institutional source/vendor semantics remain M8 (#80).

Contract-only checkpoint on 2026-10-20 (`c7d0aa1`): 45 focused tests in the two existing harness
suites and two new workflow suites passed, as did root/web typechecking and
affected type-aware lint. Independent bounded source review identified the
missing attempted-payload binding; attempts gained their own subject/digest and
two countercases, and the follow-up review found that contract gap closed. No
actual workflow executor or provider was run at that checkpoint. The subsequent
mandatory local pre-push gate passed backend build, root/web types, reference
preparation, secret checks and 1,434 tests plus one existing platform skip. The
application bridge and final CI/delivery require their own qualification.

Application-bridge checkpoint on 2026-10-20: eight focused tests passed, covering
both actions' lost replies, foreign/repeated confirmation, unsafe model retry,
corrupted captured receipt and an extra rejected unbound write request. The
previous five harness suites passed 51 tests before the last two counter-probes
were added; affected type-aware lint passed after those additions. Root/web type
checks passed during development. These are local synthetic results; final
full-suite/CI and delivery are recorded separately in the implementation PR.

## Provider response integration

The provider runner can use an explicitly registered workflow oracle/observer
with actual router usage, without accepting case/model-supplied observation code.
The [operator workflow mode](provider-observations.md#explicit-observed-workflow-mode)
constructs fresh isolated unknown-outcome variants. Its observer response copy
contains the provider answer/citations/proposals, not synthetic measurements.
Only independently obtained events can grade the trace. The runtime variant
model input contains sanitized status through frozen evidence; there is no
model tool executor or production action-context injection. This does not
complete the remaining technical access/injection families or the human answer
review now assigned to final M8-A11/A12 under V11.
