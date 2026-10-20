# Protected action-history renewal

Date: 2026-10-20. Code baseline: `8c7bcd48b051acf0531a285491cebcc57fbda3a4`
(PR #141); the intervening library-roadmap PR changes documentation only.
[Measured inputs/results](action-history-renewal-result.json) identify the code,
test inputs and bounded outcomes. This follows the failed expiry/renewal journey
in [the reference recovery fixture](reference-recovery-fixture.md). It is not
complete M2/P4/P6 or M7 acceptance.

## Change

The protected workspace retains signed server-only action references while
removing denied display data and dependent model history. A reference identifies
only its owner/scope-bound conversation/message location and proposal UUID, with
a sticky read-only flag. Fresh authenticated Core GETs reconstruct authorized
receipts after renewal. Historical pending actions stay invalidated; browser
input cannot mint a handle, move it to another row or reset old confirmation.
Deleted, moved, duplicate and repurposed rows discard their handles. Saves carry
references only from the verified current CAS envelope. Load rewrites keep the
original retention deadline.

Core GET also projects expired, changed-policy and revision-stale pending
proposals as invalidated, without changing stored business state. It retains all
existing read/confirm/reconcile checks. The synthetic consent callback now uses
full same-origin document navigation, matching a real provider callback, so the
protected workspace loads before actionable chat controls mount. The earlier
SPA return exposed stale controls until its periodic refresh; this observation
was not accepted as a pass. See [the authority contract](../../architecture/action-history-recovery.md).

## Evidence

- The isolated old protected-store implementation fails the confirmed-receipt
  recovery case with `undefined` after renewal. The corrected store passes it.
  Temporary counterprobe files were removed without replacing working sources.
- The strengthened store tests establish valid initial model/source evidence,
  then its persistent removal and fresh card reconstruction after denial and
  renewal. They include pending/unknown/executing/confirmed states, denied/foreign
  first saves, forged/tampered sidecars, stale CAS, deletion, relocation, role
  changes and duplicate message IDs. Native-history tests keep recovery reads
  authenticated, GET-only and under the existing whole-workspace cap.
- The Core API projection cases failed before the route change and pass after it;
  fresh preparation/confirmation remains allowed, and changed read rights do not
  reveal the target. These use synthetic authority drift; the browser exercises
  actual synthetic account renewal.
- The first joined browser run recovers both an HTTP-reply loss and a later SDK
  acknowledgement loss across account expiry/renewal, including an independent
  process restart. Explicit source reconciliation confirms the existing receipt
  without another execution. The observed checkpoint has four local model calls,
  two effects/two execute requests, one dropped HTTP reply, two source/journal
  rows and no real provider calls. Drafts remain; old pending cards are invalidated.

That first run reached its fixed 30-minute lifetime near a fifth fresh
preparation. Its subsequent autosave redaction coincides with service shutdown;
the held process later reports exit 0, all owned processes stopped and the caller
DB retained. The fifth confirmation and final totals are unqualified. One
consent state also expired during a pause and was safely rejected, then restarted.
The temporary runtime evidence directory was removed by normal cleanup; observed
checkpoint and restart identities are retained in this result rather than
claiming an unavailable final artifact.

A fresh independent browser follow-up completed synthetic installation and
account setup, but its first prompt was not submitted. Its checkpoint records
zero model calls, zero effects and zero execution requests. The fixture was
stopped cleanly (exit 0, owned processes stopped, caller DB retained); metadata
was copied before cleanup and its digest is recorded. Normal preparation and
confirmation after renewal with historical invalidated cards remains unqualified
in the browser. Setup is not counted as a journey pass. The independent bounded
in-process mixed-save reproduction does pass, as do fresh Core confirmations.

## Later bounded follow-up — 2026-10-20

The [fresh-confirmation browser run](renewal-fresh-confirmation.md) subsequently
completes the normal fresh prepare/reload/confirm case after actual synthetic account
renewal, with the old card invalidated and exactly one effect retained across an
independent plugin restart. The earlier incomplete runs above remain incomplete.
This supersedes only their missing normal-action observation, not the broader
remaining M2/M7 gates below.

## Integration and remaining scope

The prior Node 24 PostgreSQL coverage run passed 1,374 tests in 151 files, with
one existing platform skip and all configured floors passing. Two later runs
after an additional bounds case failed with test/readiness timeouts under local
load; those runs are not accepted. A bounded-worker coverage run also timed out and was interrupted (exit 130).
The six relevant test files then passed all 55 cases without coverage and with
two workers (38.16 s), including PostgreSQL. This isolates instrumentation/load
sensitivity but does not turn the failed full coverage attempts into passes.
The default-worker and two-worker mandatory push attempts also timed out and
were rejected. Two deliberately expensive functional cases now have their own
finite 60 s deadlines: source recovery retains its real 10.01 s cooldown and
immediate 429 countercheck; budget accounting retains all 2,048 windows and
assertions. The default 15 s deadline, coverage floors and application latency
criteria are unchanged. All 17 focused cases in those two files pass with
PostgreSQL (26.48 s). Independent review found no blocker in this adjustment.
An attempted global clock advance failed signed downstream recovery checks and
was discarded completely.

Lint, root/web typechecks and the production web build pass. Independent review found no scoped defect;
initial test-fixture clock and lint weaknesses were corrected before integration.

Complete disconnect/revocation/later-model-context, managed pending-action
update/disable/rollback, mobile/keyboard/local UI latency, formal M6 comparison
and M7 operations remain open. Fabian's separate public-demo native Anny
confirmation failure and knowledge-citation/link UX findings are retained in the
current milestone issues for follow-up. This change does not claim to fix them.
Actual devices, institutional authorization and API p95 remain the agreed M8
acceptance work.
