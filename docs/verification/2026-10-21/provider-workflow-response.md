# Provider responses to independently observed action outcomes

Date: 2026-10-21. Implementation `aae5a8c0bc048cfcd79b7d3bcf5c23a1d3412ffa`.
[Allowlisted local evidence and source hashes](provider-workflow-response.json).
This is a bounded M6 harness/application integration, not a live-provider or
milestone result.

## Result and trust boundary

`pnpm evaluate:models --profiles groq-oss-120b --workflows` plans only the
registered booking/cancellation unknown-outcome runtime variants. Default mode
still plans eleven fixed-evidence cases. No case/model field can register an
observer, choose a service destination or create confirmation authority.
Live opt-in, the reviewed corpus pin, approved profile/pricing, existing shared
budget, request cap and connection stop-after-error behavior remain unchanged.

Each variant owns an actual loopback API/Anny mock, private memory state and
host-confirmed synthetic action. The source commits once and deliberately loses
the reply. A cancellation has a separate setup booking. Instrumentation derives
actor/argument/execution binding and events from proposal transitions and
persisted source evidence. It does not copy events from the provider response.
The factory binds one observation to its original case and frozen projected
input digest; the runner additionally checks the fresh run UUID and envelope.

The model sees only sanitized unknown status as frozen evidence through the
existing read-only evidence envelope. No proposal ID, confirming actor, expected
label, execution event or execute tool is exposed. The runner does not widen
chat/history authorization or inject a fabricated production action context.
Observer failure, reused/mismatched envelopes and corrupted evidence cannot
produce a passing trace. Real provider usage remains recorded when observation
fails; it is not replaced by synthetic measurements or zero cost.

The CLI closes each owned fixture after a response/error. An ungradable workflow
or failed cleanup stops the batch with an explicit reason and exit 2. The moved
fixture also closes its actual listener in `finally` when runtime shutdown
rejects. This fixes a failure-path resource leak for operator use.

## Validation

- All 120 tests across 12 evaluation suites pass on Node 26.11.1/macOS arm64;
  root/web types and affected type-aware lint pass.
- Actual isolated booking/cancellation effects remain one per target while a
  fake HTTPS provider answers. Cross-run model projections match despite private
  action identities differing. Case mutation changes the projected digest and
  is rejected by the original fixture observer.
- Provider/observer errors, response-copy mutation, stale run/case/input binding,
  reused observation, denied registration and explicit workflow CLI boundaries
  have countercases. Existing extra-source-attempt and corrupted-receipt Anny
  executor controls remain covered.
- A runtime-close fault leaves the actual listener stopped. Restoring only the
  original fixture makes this same test fail (`expected true to be false`,
  exit 1); fixed source was restored and the full evaluation suite passed.
- Independent scoped source review found no actionable issue after frozen-input
  binding and shutdown handling. Full pre-push/hosted CI and delivery identities
  are recorded in the implementation PR, separately from this local result.

All provider responses/usage in these local tests are explicit fixtures. No
real provider call, production booking/cancellation, deployed-state reset or
shared-budget modification was used by this qualification.

## Limits and next work

This is response/control evaluation after an observed unknown outcome, not a
model-driven search/proposal/confirmation loop or the original static cases.
Model clock/status are fixed; private executed action dates are dynamic. Fixture
preparation/observation are excluded from provider latency. The trace/no-proposal
oracle does not grade answer semantics, completeness or helpfulness.

Live budgeted per-profile observations, blinded claim-level human review,
critical-finding adjudication, approved thresholds and the remaining
workflow/access/injection families remain M6 work. Native devices/institutional
acceptance remain M8. CACHE-A1 is separately deferred to M8-A10 under plan V9.
