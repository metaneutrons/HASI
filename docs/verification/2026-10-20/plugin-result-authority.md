# Protected generic plugin result authority

Date: 2026-10-20. Baseline: `3c418653b18df872918eb607c329112a93aabc15`.
Scope: M2/P3/P4/P6 result-history boundary; local candidate, not full milestone
acceptance, deployed integration or real-model evaluation.

## Implementation

The authenticated protected read route accepts only a conversation, host-signed
assistant call and selected call ID. It resolves the current authorized hashed
tool name and invokes the fixed Core API, enforcing read-only effect through
Core and the registry. Only the actual bounded Core response and host source
classification can create a result record. The owner/scope-separated signed
record binds conversation, call, tool, arguments, classification, current
authority and expiry. No browser-submitted result is signed.

Later model requests and workspace save/load reconstruct output from that
record. Cards must match the initiating signed call; derived assistant evidence
includes result dependencies. Expired, altered, foreign, unavailable or revoked
evidence cannot authorize retained output. The model receives a bounded,
untrusted-data wrapper requiring a fresh read for current conditions. Generic
actions retain their separate proposal/confirmation/execution path.

The initial browser attempt exposed a second defect: intermediate generic calls
were rejected by native-only interrupted-history schemas; repeated identical
failure notifications and an unstable render callback caused an update loop.
Interrupted generic exchanges now use the same safe no-replay salvage as native
calls. Stable callbacks and deduplicated failures prevent that loop. A completed
exchange retains its result references. Escaped truncation previews also remain
inside the 8,000-character wire limit after JSON serialization.

## Actual joined browser journey

The documented joined fixture ran Next.js, two independent API processes sharing
the disposable PostgreSQL database, selectable TestIdP and the separately
packaged reference plugin. Synthetic namespace:
`8a340379-e8a9-40fa-a104-5b25303c2bc7`. Reference 1.0.0 source
`a78e853e6d685a07693f733812a256a74656285b`, manifest digest
`5cbee0101afb557940503dea42ebb8af228caafd6386942a50002d1d298be8b4`, artifact
`c8bd64079dd091e5003d684e0b2a096244f921e81fa3047002161d86d538c47e`.

Observed through the actual browser:

- Administrator connected the approved reference service, saved its public label
  and explicitly activated the configuration across the two API replicas.
- Personal synthetic consent returned a connected status immediately; the
  earlier transient account-status error did not recur in these two runs.
- A status question made two local fixture-model calls. Its observer counted
  one correlated reference result, zero omitted results and zero real-provider
  calls. The result card and derived answer survived an actual page reload.
- `expire-reference` acknowledged clock advancement on both API replicas.
  Reload removed both the retained result body and derived answer. DOM checks
  confirmed neither the synthetic account result nor the previous answer text
  remained visible.
- A draft survived navigation to Connected services, explicit renewal and return
  to the original conversation. Renewal did not resurrect the invalidated old
  result. A new question succeeded: final counters were four fixture-model calls,
  two correlated reference results, zero omissions and zero real-provider calls.
- At emulated width 390, document width and scroll width were both 390. The
  temporary viewport override was cleared. This bounded layout observation is
  not native iPhone, keyboard, assistive-technology or full mobile acceptance.
- `quit` reported owned-process cleanup and retention of the caller-owned test
  database. The first non-interactive run was explicitly stopped with SIGTERM
  and confirmed clean before the interactive run started.

The observer's positive/omission counter-probes remain in the fixture tests;
counting a second static completion alone would not prove tool-data delivery.
Private screenshots record the preserved and revoked states; they contain only
synthetic data. No institutional source or real model credential was used.

## Remaining qualification

Focused tests cover signed storage/tampering/owner/conversation/expiry/bounds,
read-only effect with a stale API projection, classifications, error redaction,
model dependency withdrawal, protected card reconstruction, concurrent saves,
interrupted exchanges and failure-notification recursion. Independent focused
reviews cover store/evidence, endpoint/effect and workspace boundaries. The full
PostgreSQL-backed coverage run passes 1,336 tests across 148 files, with one
existing platform-specific skip; statement coverage is 80.98%, branches 77.81%,
functions 88.24%, lines 88.50%. The production frontend build passes. Exact-head
CI, runtime-container qualification and delivery results belong to the
implementation PR.

This report does not accept the complete action/update/rollback/unknown-outcome,
mobile/keyboard/UI-feedback, M6 workflow/gold/cache or M7 operational matrices.
The proof format intentionally has no pre-release legacy verifier. Old images
cannot be assumed to read new result references; history-format rollback and
forward recovery remain operational qualification work. Database, sessions and
budget were not reset. Public MCP Apps remain off; real-device and institutional
qualification remain M8.
