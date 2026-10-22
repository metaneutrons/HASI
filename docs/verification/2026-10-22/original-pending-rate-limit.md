# Original pending-proposal observation stopped by quota

A separately owned dispatch `067b2c17-d9bc-4a04-87f5-9feed2d39a1f` selected only
previously unexecuted combinations: `anny-02`, `anny-05` and `inject-02` across
Groq120B, Groq Qwen, GWDG Qwen and DeepInfra. Groq20's earlier HTTP400 observations
were preserved rather than retried. The networkless plan passed12 combinations,
cap48, with no credentials, fixture or ledger access. The actual schedule stopped
after one observation and three requests; eleven planned combinations were not
executed. This is not a completed comparison or M6 acceptance.

Groq120B successfully searched the actual isolated native catalogue and checked
availability for `fixture-room-R104`, `2026-10-27`,14:00 Berlin, duration60. The
third generation returned **HTTP429**, with sanitized `provider_rate_limited`.
No booking proposal, confirmation, cancellation or source write was executed.
The fixture's effect boundary held and cleanup completed. The operator stopped
without automatic retry/fallback; its owned container stopped and the deployment
controller resumed. Retry-After/response-header diagnostics were not retained and
remain unknown. An unsupported claim about the specific quota/reset is not made.
Subsequent Groq dispatch was suspended, not moved to a different credential.

Two HTTP200 responses report5,497 input and105 output tokens, tariff estimate
USD0.00088755. The quota response's usage remains unknown, with its full
16,136-input/1,536-output bound retained. The conservative shared ledger charge is
4,818 micro-USD known plus19,053 unknown, exactly23,871 micro-USD. The same
USD1/UTC-day counter rises258,603→282,474; all seven unknown holds remain charged.
No reset, refund or new allowance is performed. The tariff estimate excludes the
unknown request, is not an invoice and establishes no cache hit/savings.

The ledger grows114→117 entries: two settlements and one unknown. Read-only JSONB
reconstruction matches the real current database, rejects a one-micro-USD change
and reproduces the complete earlier114-entry state/counters against the captured
snapshot. All566 active pre-run records remain;565 non-budget values/revisions
and the physical PostgreSQL/data volume are unchanged. Two additional non-budget
records had appeared before this pre-run snapshot; no claim is made that the
whole database has a permanently fixed row count.

Source/operator/serving identities and code equivalence are unchanged from the
[calendar run](original-calendar-observations.md). All application/operator code,
configuration and corpus inputs are unchanged between sourcec77 and serving475;
only the historical budget-report pair differs. Exact runtime database binding
is checked before fixture creation; credentials enter only the trusted runtime
environment. Latency includes fixture setup/cleanup. Full original benchmark
evidence is distinct from compact native reads; this direct-router fixture is
not a protected HTTP/browser observation.

At this checkpoint, the three original-case runs have observed thirteen distinct
of25 originally planned combinations and made25 HTTP requests:22 report usage,
three retain unknown holds. Twelve original combinations remain unobserved. Those
are not counted passed; model quality/citation/clarification assessment remains
ungraded for final M8 under the approved V11 sequencing. No gold labels, ranking,
full-calendar coverage or general injection-resistance conclusion follows.

Private transcript SHA-256:
`c6e39663e98fe7bf4d14e1d52416ee594f72d61a27351be35f2a3eb234021d8b`.
[Machine-readable result](original-pending-rate-limit-result.json).
