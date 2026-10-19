# PostgreSQL expiry fixture clock

Date: 2026-10-19. Baseline: `abd65199fdabef6abc55c398fe3c880249a5d087`.

The local mandatory pre-push for the Plan V5 documentation candidate stopped
because two PostgreSQL integration tests failed. The first wrote a deadline of
`Date.now() - 1` and immediately expected PostgreSQL to treat it as expired. The
row was still readable; the later bounded-cleanup test then found one extra
expired row in the same test namespace. The candidate was not pushed.

These fixtures assumed that the Node host and the PostgreSQL VM clocks agree
within one millisecond. They are separate clock authorities; the production
store correctly evaluates deadlines using PostgreSQL `clock_timestamp()`.
The tests now use an explicit fixed past date for the expired fixtures. They
retain all replacement, stale-revision, namespace-isolation, non-expiring active
row and bounded cleanup assertions. No database clock, production SQL, timeout,
retry or assertion changes.

The actual disposable PostgreSQL focused suite passes all four tests; scoped
ESLint and whitespace checks pass. Required integration results belong to the
exact candidate and are recorded separately. The observed failure is consistent
with the invalid cross-clock assumption; no exact clock-offset measurement was
captured at the failure instant. This repairs the fixture, not production
clock synchronization or full M2/M7 qualification.
