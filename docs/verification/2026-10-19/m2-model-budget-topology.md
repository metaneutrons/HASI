# M2 shared model-budget runtime evidence

Date: 2026-10-19. Integration baseline: `4f73919b541f6096f60d29c52c8e9296a17e0ecd`.
Scope: BUD-A1 under M2 #49, using synthetic identities and a local provider.
This does not accept all M2, provider billing, browser or institutional gates.

`scripts/qualify-model-budget-topology.ts` starts two production API processes
and two real production Next.js processes behind trusted loopback TLS proxies.
They share a disposable PostgreSQL 18.6 container and the unchanged budget policy.
The signed authority directory, native TLS TestIdP, PKCE/session path, timestamp
receipts, actual `/api/chat` handler and provider admission all execute. The only
model endpoint is a fixed synthetic OpenAI-compatible HTTPS server on loopback.
Child environments are explicitly allowlisted; no real provider keys are passed.

The script discovers a local Docker Unix socket, rejects inherited database
URLs, creates its own exact `hasi_budget_topology_test` database, never pulls an
image and removes only its labelled/named container and anonymous volume.
Synthetic keys and listeners are removed before a qualified report is emitted.
Root moved port allocations inside cleanup protection before the Node 24 run.
Missing opt-in and an inherited database URL both exited 1 for the expected
preflight reason without a qualified report or fixture creation.

## Observed runs

| Runtime | Script SHA-256 | Requests admitted / denied | Provider requests / responses | Post-restart denials |
| --- | --- | --- | --- | --- |
| Node v26.11.1, root clean-build run | `2a59ffbb1ff675d09543416c463ac0a5905bab27a25586e3a5280307c96b8ebe` | 1 / 3 | 1 / 1 | 2 |
| Node v24.21.0, root integration run | `2a59ffbb1ff675d09543416c463ac0a5905bab27a25586e3a5280307c96b8ebe` | 1 / 3 | 1 / 1 | 2 |

Both execute Next.js 16.4.2. The Node 24 run used the unchanged earlier frontend
artifact `YzJo0D8zUE1fsi6DKxCnM` and API sources originating at
`a9c47b5e8bbab3b4dfc46731d0f635e010b1ee69`; `apps/api/src`, `apps/web/src` and
`packages/state` are unchanged from that revision to the integration baseline.
Root then updated the clean checkout to that baseline, installed locked
dependencies offline (zero downloads), and executed all three documented
build/qualification commands verbatim with an empty environment except their
explicit inputs. The Node 26 run used that freshly compiled backend/frontend,
build ID `KFqtb-gGNRvDOPqnO3lnQ`. These build IDs were read from their unchanged
artifacts; the reports did not emit them. The later M3 image-review change is
outside the exercised budget path. Both root runs completed owned cleanup.

Both reports identify policy digest
`7b5dc2b8fad6cd27d420dc9de0b12e14fb28d915b872ef62a547b7a7fb78e291`:
86,400,000 ms UTC window, 1,250,000 input tokens, 250,000 output tokens and
1,000,000 micro-USD. No production ledger, price, quota or counter was reset.

## Positive and counter evidence

- Before initialization, the actual chat HTTP path returned 503 with the
  sanitized `budget_unavailable` event and zero fake-provider requests.
- Public ledger `reserve`/`settle` calls conservatively held 990,000 micro-USD
  using unknown synthetic usage. This is test setup, not actual spend.
- Four concurrent, separately timestamped chat requests traversed both Next.js
  replicas. One provider response was deliberately held. Three exact HTTP 429
  budget denials and their sanitized `budget_exhausted` codes arrived before
  that response was released. The fake provider received only one request.
- The shared PostgreSQL snapshot accounted for every in-flight reservation,
  stayed within dollar/token limits and added no reservation for denied calls.
  The admitted request returned the expected synthetic completion and settled.
- Public synthetic ledger calls consumed the remaining allowance, without SQL
  edits or a reset. Final state was exactly 1,000,000 micro-USD, 12,494 input
  tokens and 247,501 output tokens, including conservative unknown-use holds.
- After replacing one exact Next.js process, one request traversed each live
  replica and both returned the exact budget denial. No further provider call
  or reservation was created. A missing fixture CA was rejected normally;
  certificate verification was never disabled.

No real provider call or business action occurred. The measured race timings
(Node 26 p50/p95 47.84/69.94 ms; Node 24 53.61/66.65 ms) include the deliberate
provider barrier and are not production latency measurements. The proxy records
aggregate replica targets, not a request-to-replica/result attribution trace;
it does not identify which named replica admitted the successful call or prove
API request distribution merely from starting two API processes.

Existing ledger/router tests separately cover admission, unknown/invalid usage,
timeouts, cancellation and fallback policy. This bounded runtime exercise uses
one local custom profile with no fallback; it does not test provider invoice
accuracy, real rate limits, full model evaluation, browser behavior, actual
plugins or final M8. GWDG's approved temporary Groq estimate remains unchanged.

## Timeout followed by exhausted fallback admission

The router regression `keeps a timed-out provider hold when fallback admission
is exhausted` composes the real `ModelBudgetLedger`, `MemoryJsonStore` and
`createModelBudgetAdmission`. A synthetic Groq request is admitted, then its
provider transport rejects with `TimeoutError`. Its 1,536-token output
reservation remains held with unknown usage. The explicitly allowed GWDG
fallback requests its own reservation, which the exhausted shared output limit
rejects before any GWDG provider request. The caller receives the sanitized
`budget_exhausted` error, without the private synthetic timeout detail.

Assertions cover reservation order, exactly one provider request, one retained
unresolved/unknown reservation, and unchanged output usage at 1,536 tokens.
The focused router suite passed 119 cases locally before integration. This is
a deterministic router/ledger regression, not a second multi-process topology
run, live provider timeout or provider billing measurement. No production policy,
tariff, counter or credential changes are involved.
