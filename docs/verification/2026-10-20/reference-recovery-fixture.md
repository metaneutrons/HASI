# Independent reference recovery fixture

Date: 2026-10-20. Baseline: `de76b24d278f346c01d1334c458e7bf31ef592dd`.
This is a bounded M2/P6 qualification prerequisite, not acceptance of M2, M6
or M7. [Measured identities and results](reference-recovery-result.json) retain
final implementation source hashes and the independently packaged artifact pair. All accounts,
actions and model responses were synthetic; no real provider was contacted.

## Durable boundary

The independent reference artifact now includes a Node 24 SQLite module. The
joined launcher places its private state file outside both versioned artifacts.
An atomic transaction stores a business counter and immutable source receipt;
the separate SDK execution journal and invocation replay records also persist.
Receipt identity includes subject, installation and execution ID; its full
binding additionally pins tool, canonical arguments, configuration revision and
linked account. Changed bindings/accounts cannot reuse a receipt. Journal and
source records have no automatic expiry, preserving idempotency. The explicit
`:memory:` fallback is for older bounded fixtures and proves no restart safety.

Fault controls travel through correlated IPC on owned processes. A fixed loopback
proxy can discard one actual confirmed `execute_mark` response, matching its
JSON-RPC request ID. It never follows a client-selected target or retries a
write. Other controls lose the SDK acknowledgement after the effect commits,
make the synthetic source unavailable, and restart/switch the independent
artifact. Status reconciliation reads a source receipt; it never calls the
write handler. Artifact switches are not managed administrator update approval
or host rollback qualification.

## Observed browser journeys

1. With two API processes, actual TestIdP login, administrator connection,
   draft/configuration activation and personal consent, the chat prepared a
   generic action and displayed its separate host confirmation. The source
   counter remained zero before confirmation. The loss proxy then received a
   confirmed upstream reply and discarded it. The chat showed unknown outcome.
   After reference process restart and page reload, its status button recovered
   confirmed. Counters stayed at one effect / one execute request / one lost
   reply, with one local model call. This first run exposed the IPC shutdown
   hang below; it is not graceful-shutdown evidence.
2. A fresh run packaged the corrected server. Losing the SDK acknowledgement
   committed a source receipt but left the journal unknown. A status query while
   the synthetic source was unavailable remained unknown. Reference restart
   retained the exact counter/journal/source counts.
3. Expiring the account on both API replicas removed the action card. Consent
   renewal restored the personal connection, but the earlier card did not return.
   This product failure remains open; this sequence does not pass task-preserving
   reauthentication.
4. In a fresh conversation after renewal, another explicitly confirmed mark lost
   its SDK acknowledgement. After restart, the status button reconciled it from
   the retained source. Repeating status and reloading preserved confirmed,
   with exactly two total effects and two execute requests across the two actions.
   Aggregate journal inspection showed one unknown (the earlier inaccessible
   action) and one confirmed receipt. Two local model calls were used in this run.
5. Explicit process switches to independently packaged 1.0.1 and back to 1.0.0
   retained two effects, two journal rows and two source receipts, with graceful
   exit and readiness required. No managed UI activation or rollback is claimed.

The browser action probes preceded the final proxy-ingress and command-queue
corrections. The corrected independent reference artifact is identified above;
final launcher startup/shutdown and proxy socket behavior have separate probes
below. This is not an exact-final-candidate full browser acceptance claim.

## Independent review and negative probes

- State tests reopen the actual SQLite file and exercise source reconciliation,
  changed arguments/configuration/account denial, account/installation/subject
  isolation, CAS conflicts and replay denial across reopen. SQLite main/WAL/SHM
  files were observed as mode 0600.
- Review reproduced an IPC child remaining alive after SIGTERM because its
  message listener retained the channel. Shutdown now closes the server/SQLite
  and disconnects IPC; corrected joined restarts require exit 0 without a signal.
- Proxy tests exercise actual HTTP/socket loss, unrelated/error replies that do
  not consume the fault, subsequent normal calls without write retries, fixed
  target/route denial, unfinished oversize uploads, slow rejected routes,
  timeout, pending-close and idempotent cleanup. Review required prompt socket
  closure after rejected/oversized unfinished requests; the raw-socket probes
  cover that correction.
- Review found a queued-command teardown race. Shutdown now marks the fixture,
  ignores later commands and drains the serialized command chain before stopping
  children. On the final launcher, `restart-reference`, `stats`, `quit`, then a
  queued restart/version switch produced exactly one restart acknowledgement,
  exit 0 and owned cleanup; the post-quit commands never spawned a child. The
  caller-owned database was retained.

## Remaining product failures

Unsigned supplementary unknown-outcome text is correctly redacted by protected
history. Generic preparation also attaches cosmetic model metadata that the
server-owned proposal projection removes. During a concurrent save these
projection differences can invalidate the workspace and interrupt the next turn
or revert newly created conversations. Do not weaken display/model evidence
verification to preserve those strings. Use the authoritative proposal summary
and qualify overlapping saves with a separate correction.

The expiry/renewal action-card loss above also needs an authorized recovery
reference that survives temporary lack of service access without retaining
protected display data. Full reauthentication/task return, disconnect/revocation
with later model context, managed pending-action update/disable/rollback, complete
mobile/keyboard/UI-latency journeys and M6 comparisons remain open. Real-device
and institutional acceptance remain M8; API p95 remains M8-A9.

## Integration validation

Node 24 local lint, root/web typechecks and the production web build pass. The
PostgreSQL-enabled coverage run passes 1,352 tests in 150 files, with one existing
platform skip. Coverage floors pass: statements 80.99%, branches 77.82%, functions
88.24%, lines 88.50%. The standalone packaging/qualification tests pass, including
the newly copied state module. These tests do not establish the unresolved
product journeys above.

The delivery PR records the exact final head, mandatory pre-push, CI and
merge/deployment state.
