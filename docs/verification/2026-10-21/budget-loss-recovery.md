# Conservative recovery after demo accounting loss

Date: 2026-10-21. Implemented script revision:
`de6cdf65e7a1cade2ddbaf67dbc759b9ffe9f5bc`.
Supporting [M7 #54](https://github.com/metaneutrons/HASI/issues/54), still open.
The [machine result](budget-loss-recovery-result.json) retains both actual runs,
input hashes, counterprobes and limits. The [operator procedure](../../operations/demo-budget-loss.md)
documents containment and the privileged initialization boundary.

## Actual isolated exercise

The opt-in `--state-loss-drill` extends the existing production-built topology
qualifier. Both runs used an owned, labelled, disposable PostgreSQL container,
two API processes, two Next processes, synthetic OIDC and a loopback TLS model
fixture. No caller database or real provider was used. The second run executed
the runbook's isolated-drill command block verbatim under a private HOME with
an explicitly approved local Unix Docker socket.

The existing race first exercised real admission to the fake provider: one of
four requests was admitted, three were denied before provider release. A
synthetic conservative unknown-use reservation accounts for USD0.99 of the
USD1 fixture ceiling; the admitted fake response exhausts the remaining budget.
These are synthetic accounting values, not provider billing measurements.
Replacing one Next process preserves denial without new provider requests.

The new phase verifies the actual Docker owner label, exact generated container
name, namespace and captured ledger key before removing only that row. Four
production-built `/api/chat` attempts return HTTP503 with the expected
budget-unavailable response: two across the original replicas, then two across
a surviving and a newly replaced replica. The provider request count remains
one; the denied requests do not recreate accounting. Identity/session rows and
the fixture table remain present. This is loss of spent accounting, not a
whole-database restore exercise.

The real PostgreSQL ledger then uses an injected clock. Missing accounting
denies reservations before midnight, at the next UTC window and at the safe
boundary until explicit initialization. A qualification-only guard rejects
initialization one millisecond before the next UTC midnight plus one minute.
Explicit initialization at that boundary permits a bounded five-micro-USD
ledger reservation. The production router's wall clock is not changed and no
provider is called by this clock phase.

## Counterprobes, cleanup and limits

Three actual CLI counterprobes exit1 for the expected preflight reason: missing
opt-in, inherited caller database and unknown mode. Four focused tests, affected
ESLint, root TypeScript, backend build and optimized web build pass. A stale
workspace SDK build initially prevented CLI imports; rebuilding the documented
prerequisites resolved that setup failure. Type checking then found a callback
narrowing error, corrected with an immutable captured ledger key before either
actual drill. Independent static review found no remaining bounded blocker.

Each successful report is emitted only after owned processes, container and
temporary fixture resources have been cleaned up. Isolated HOME directories
were subsequently removed; the caller's database was never selected.

The boundary helper does not enforce time in the production initializer. The
operator must quiesce requests and probes, remove one-off build initialization,
record the latest possible dispatch, and wait for the documented safe time or
restore authoritative accounting. No real incident, clock-skew tolerance,
provider invoice, backup, browser workflow or complete M7 acceptance is claimed.
The disposable-demo backup exception remains separate from production M8
continuity requirements.
