# Partial original-room model observations

On 22 October 2026, the CI-qualified original-case operator at
`c77ca53869cd68ce003afbb3dc8223b67b8f9ead` attempted five pinned cases across
five configured synthetic profiles. This is a partial development observation,
not a completed comparison, prompt-injection pass or M6/M7 acceptance.

## Actual observations

The run made **11 actual provider HTTP requests** and observed six of the
25 planned profile/case combinations. All five profiles were observed on
`anny-01`, whose original request omits the duration. Three observations ended
with a final model reply; two attempted native availability using invented
durations (60 and 120 minutes). Both attempts were rejected before execution.
These are recorded technical argument errors, not successful clarification
or graded answers.

The next observation, `anny-02` with Groq GPT-OSS 20B, received HTTP400. Usage
for that request is unknown. The operator denies automatic repair reservations;
the recorded sanitized error is `budget_unavailable`. This is not evidence of
daily-budget exhaustion or a known upstream cause. The schedule stopped without
retry. **19 planned observations remain unexecuted**, including the autumn and
spring clock cases, the pending-proposal pair and the original room-description
attack. No claim is made that the missing cases passed or that another runtime
variant substitutes for them.

All six isolated native fixtures closed successfully, and their observed effect
boundaries held. No booking proposal, confirmation, cancellation or source write
was executed in this run. The operator used full original benchmark evidence,
separately from the bridge's compact native resource projection; it did not
exercise the protected HTTP/browser route. Frozen case clocks affect only the
isolated booking/availability domain; authentication, expiry and budget keep
real time. Human assessment remains ungraded for final M8-A11/A12.

## Usage, shared budget and retention

Ten requests have complete reported usage: **31,401 input and 636 output tokens**.
Their configured tariff estimate is **USD0.014428275**; GWDG uses the explicitly
approved provisional operator price. This excludes the unknown request and is
not an invoice. Cache status remains unknown.

The same existing USD1/UTC-day ledger rose from 168,440 to 213,967 micro-USD:
27,669 micro-USD for known usage under the conservative common policy, plus a
retained 17,858 micro-USD unknown hold. Input/output counters include that
request's upper bounds, not fabricated usage. The ledger now has 103 entries:
98 settled, 5 unknown, 0 reserved and 0 released. No reset, refund or new allowance
was performed.

A separate read-only reconstruction reproduces the exact earlier 92-reservation
state and counters against the original pre-run PostgreSQL JSONB digest. It
first matches the current database digest and rejects a one-micro-USD counter
change. The 11 new entries and their charges exactly reconcile the delta.
All 565 then-active baseline records remain present after the run; all 564
non-budget values/revisions and the physical PostgreSQL/data volume are
unchanged. These are bounded snapshots, not proof of every intermediate event.

## Operator qualification and limits

The final operator image is Linux/amd64, non-root `node:node`,
`sha256:7843244ee6c5ce1a82220aa77e511ab1e2c7891ad98e387880734f2f04549b07`.
It was built from 484 individually verified Git files with their tracked modes.
Earlier networkless plan attempts failed because archive-created parent
directories had mode 0700; 72 source directories were corrected to 0755 before
rebuilding. The final image passed the 25-observation plan with no network,
credentials, fixture or budget access. A separate failed dispatch rejected the
read-only database-address probe before evaluator creation; its zero-call,
unchanged-ledger result is retained. CIDR-aware address comparison fixes that
probe without changing the database binding.

The actual job pins both serving and operator image identities, verifies that
the runtime database URL reaches the snapshotted physical database, and uses an
exclusive run identity. Credentials enter only the trusted runtime environment;
no values enter arguments, reports or source inputs. The detached job and its
owned container ended; cleanup is independently verified. The shared ledger
enforces each actual dispatch; unknown usage remains charged conservatively.

Private report identity:
`3ae4346b5617b585960070e3d1b3ddae3e0133cd202f46ac7912a0d243c8bb89`.
The report retains full model-visible messages/tools and bounded public provider
answer/tool fields; no reasoning, response headers or credentials. Latencies
include fixture setup/cleanup and are not isolated model-speed estimates.

[Machine-readable summary](original-room-model-observations-result.json).
