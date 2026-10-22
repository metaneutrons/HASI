# Original room-case observation track

This development operator addresses the original `anny-01`, `anny-02`, `anny-04`,
`anny-05` and `inject-02` cases without replacing them with a contemporary 1J
search. The bundled corpus and each parsed case are pinned. Expected assertions,
grading labels and runner-only tool fixtures are excluded from model input.

Plan without credentials, database access, fixtures or network:

```sh
pnpm evaluate:original-rooms --profiles groq-oss-120b
```

An explicitly admitted run additionally needs `HASI_MODEL_EVALUATION=1`, the
reviewed 40-character `HASI_EVALUATION_BUILD_REVISION`, the existing deployment
`DATABASE_URL` and the selected provider's server-side credential. Resolve these
through the approved custody/runtime process; never put their values in command
arguments or this document. BUD-A1 and current shared-budget admission remain
prerequisites. The report path must be new; it is created exclusively with mode
0600 and flushed after each record.

```sh
pnpm evaluate:original-rooms --profiles groq-oss-120b --cases anny-02,inject-02 --max-calls 12 --run --output /private/tmp/hasi-original-rooms-new.ndjson
```

The second command is an operator template, not a claim that a paid run passed.
Normal automated tests use synthetic provider responses and fake admission.

## Evidence and execution boundaries

The direct production model router receives the original user messages, case
clock and full authorized benchmark evidence as untrusted tool-role documents.
The native Anny bridge still uses its normal compact resource projection;
notably, its description limit is 80 characters. These are two distinct inputs.
The full benchmark projection deliberately keeps the complete original room
description attack. It is not evidence that the same text passes through the
protected HTTP route, current history reconstruction or the browser journey.
Both the actual outgoing messages/tool definitions and bounded public provider
answer/tool-call fields are retained for review; reasoning and response headers
are excluded. Raw input reports are private evaluation artifacts, not production
prompt logging.

Each case owns an isolated TestIdP/API/signed-MCP/Anny-contract fixture. Birke
uses resource `fixture-room-R104`, four seats and a screen. The poisoned variant
uses the original `inject-02` description verbatim. The spring-gap fixture uses
`fixture-room-F207`; its description is the original calendar-gap evidence, not
an additional room-description source or an inferred institutional fact.

Only `anny-02` and `inject-02` may execute native availability and preparation,
for exactly 27 October 2026, 14:00–15:00 Europe/Berlin, at Birke. Preparation
requires the bridge's preceding exact availability receipt. A successful native
pending proposal ends the observation immediately: the native preview supplies
the next step, with no redundant model generation. The incomplete-duration,
ambiguous autumn clock and nonexistent spring clock cases may search or ask for
clarification, but cannot execute native availability or preparation. Wrong
intervals, resource IDs and parallel calls are retained as rejected attempts.
Provider proposals rejected earlier by router/SDK validation remain in the
bounded response capture; they are not successful native calls.

`proposal_only` describes an execution boundary, not least-privilege identity
qualification. The current production API preview gate requires a synthetic
base `rooms:execute` entitlement. The fixture reports that entitlement openly,
while its effective Anny account grants read/prepare, its API transport denies
action/confirmation/cancellation/reconciliation routes, and its Anny client and
contract mock independently deny source writes. No confirmation is model-callable.
Fixture cleanup and native effects are checked even when a model/provider fails.

Case time affects router calendar context, bridge interpretation and the isolated
plug-in/mock booking/availability domain checks. Trusted constructor callbacks
keep frozen intervals reproducible after their historical date; no HTTP/body or
environment clock override is accepted. Defaults remain real time. Its
canonical UTC representation supplies the controlled message-time anchors.
Authentication, replay, aggregate TTL, proposal expiry and the existing shared USD 1/UTC-day budget use
real time. The existing durable admission is obtained before fixture creation;
there is no alternate ledger, initialization, refund or budget reset.

## Measurement limits

The global actual-HTTP cap is 1–64, with at most six requests per case and one
admission per dispatch. An automatic router repair attempt is denied before an
additional reservation or dispatch. No fallback is allowed. The CLI rotates
profiles by case/repetition and paces connections (60 seconds GWDG, 30 seconds
others). Unknown/unconfirmed usage, incomplete capture, provider failures,
unsafe effects or failed cleanup stop the schedule; outstanding conservative
charges remain. Unexecuted observations are explicitly counted.

Native boundary success cannot grade model intent, a clarification's adequacy,
citation support or a claim of booking success. These remain semantic-review
items. The fixed evidence/native-effect track, scripted transport regressions
and actual paid observations must be reported separately. None alone accepts
M6, M7, institutional rights or production writes.
