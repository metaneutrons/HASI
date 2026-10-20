# Protected generic action history follow-up

Date: 2026-10-20. Baseline: `60e09d9f5f8403254d72998af2c81fafe0ef4199`
(PR #140). [Measured inputs/results](plugin-action-history-result.json) identify
the implementation files and independent reference artifacts. This corrects the
projection/interruption findings from [the recovery fixture](reference-recovery-fixture.md),
not its separate expiry/renewal failure or the complete M2/P6 acceptance.

## Correction and authority boundary

A generic preparation card previously carried cosmetic model attribution. The
server reconstructs it as a current host-owned action receipt and removes that
attribution. Own-save comparison now permits that presentation difference only
for an otherwise identical generic action with forward status and the exact
canonical server tool/summary. It applies the server projection, not the submitted
model label or arbitrary client text. Action arguments, identity, preview,
expiry, status direction and all other message fields remain guarded.

New generic preparation cards omit model attribution. Supplementary generic
confirmation/preflight/error notices use the transient composer status rather
than unsigned assistant transcript rows. Model-context removal notices do the
same. The existing proposal card supplies the authoritative persistent action
summary. No signature, source/context verification, business confirmation or
retry rule is relaxed.

## Regression and countercase

The actual protected-store/client-store test delays a server acknowledgement,
adds cosmetic model metadata, advances the same proposal to unknown, and creates
a new chat and draft while the save is outstanding. Before the correction, the
valid case fails because the action session epoch increases. With the correction,
its canonical receipt, active chat, new draft and saved state remain, without
that remount. An altered-target countercase still invalidates the old state:
model attribution and old text disappear, active confirmation is cleared, and
the result is either the current canonical target or the unavailable placeholder.
Existing revoked/changed-preview/expiry/action/status-reversal and forged-model-
history tests remain in force.

Independent review verified that ignored cosmetic fields cannot preserve other
unverified content. Review also required the changed-target test to assert the
safe resulting content and cleared confirmation, rather than remount alone;
those assertions pass under Node 24.

## Actual browser observations

The held TestIdP/two-API/reference-plugin composition used only synthetic data
and the deterministic local model. Administrator connection, draft activation
and personal consent were completed through the actual UI.

An earlier candidate in this run exposed another unsigned transcript row: the
server's context-removal notice. Its next-turn failure was retained as a failed
observation, then that notice was moved to transient status as described above.
The final code was exercised in a fresh conversation in the same isolated run:

- Prepare and explicitly confirm a mark, losing its SDK acknowledgement after
  the effect commits; the persistent card shows unknown outcome without a
  second unsigned assistant error.
- Restart the independent process and query status to recover the source receipt.
- Immediately request another preparation in the same conversation, then confirm
  it normally. The next request completes without the previous authority/save
  interruption.
- Reload and observe two visible confirmed action cards, no unavailable-answer
  text, no authority-save error and no interrupted-request banner.
- Create a third conversation, type a draft, navigate to Connected services and
  return. The draft remains. Returning to the action conversation still shows
  its two confirmed cards.

Across the whole fixture, including the earlier failed candidate, there were
four local model calls, three business effects and exactly three execute
requests, three journal/source rows and one discarded confirmed HTTP reply.
These totals are not per-final-conversation measurements. No real provider was
contacted. The owned fixture stopped with exit 0 and retained the caller's test
PostgreSQL database.

## Remaining qualification

The earlier expiry/renewal test loses the action card permanently; this change
does not add a recovery reference or pass that journey. Full account revocation
and later model-context checks, managed pending-action update/disable/rollback,
the keyboard/mobile/local UI-latency matrix, formal M6 comparisons and remaining
M7 operations stay open. Other native/tool diagnostic paths have not received
blanket product acceptance from this generic action test. Physical devices and
institutional approval remain M8; API p95 remains M8-A9.

## Integration validation

Node 24 lint, root/web typechecks and the production web build pass. The full
PostgreSQL-enabled coverage run passes 1,354 tests in 150 files with one existing
platform skip; configured coverage floors pass (statements 80.99%, branches
77.82%, functions 88.24%, lines 88.50%). The generated Next.js development type
imports return to their tracked production form during that build and are not
part of the change.

The delivery PR records the exact final head, mandatory pre-push, CI and
merge/deployment result.
