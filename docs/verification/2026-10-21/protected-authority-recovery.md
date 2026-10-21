# Protected history authority outage recovery

A temporary failure to obtain the current history authority previously became an
empty authority. `loadCurrent()` could then persist redacted messages. The store
now rejects reads and writes before mutation when the configured authority throws,
is empty or is malformed. The existing workspace routes return a generic 503.
A valid changed authority still redacts revoked content permanently.

## Regression evidence

The three new outage cases fail against the previous implementation because the
operation resolves instead of rejecting. With the change, 52 focused tests pass,
including the PostgreSQL workspace test. They cover stored value/revision/expiry
preservation, recovery, native/action history and the real-revocation countercase.
The fixture command tests independently check exact route/method isolation,
matching command IDs/state, both replica acknowledgements and cleanup on failure.

## Browser and database evidence

An optimized Next.js build, two API processes, PostgreSQL and Test-IdP run locally.
This recovery run uses the direct reference fixture, not a managed external plugin.
Dialog-Demo performs the knowledge search without any model calls or business write.

1. A VPN search returns three authorized source links, with one stable assistant
   message, and a draft is saved.
2. A private terminal control makes only `GET /api/history/authority` unavailable
   on both API processes. Editing the draft produces workspace PUT 503; explicit
   retry produces GET 503. The source answer is hidden and the live draft remains.
3. All four baseline database rows retain identical revision, value fingerprint
   and expiry throughout the failed GET and PUT.
4. Restoring the authority and explicitly retrying produces GET 200 and PUT 200.
   The same message and three revision-4 source links reappear. Reload retains
   them and the newer draft. The other three workspace rows remain unchanged.

Retry in this run uses keyboard Enter; it does not establish pointer hit-target
or native-device acceptance. Screenshots use an explicit 390×844 CSS-pixel clip.
The owned processes stop normally; the caller-supplied qualification database is
retained until the remaining checks finish.

The machine-readable result records source and artifact hashes. The browser
observations, fixture metadata and before/after screenshots are retained in
`/Users/fabian/.codex/attachments/hasi-external-qualification-20261021/` as
`authority-recovery-observations.json`, `authority-journey-evidence.json`,
`authority-outage-hidden.png` and `authority-restored-reloaded.png`.

## Limits

This verifies the identified destructive-redaction path. It does not establish
the cause of every earlier unknown action or draft transition in the separate
[external-plugin journey](external-plugin-joined-qualification.md). M2, M6 and M7
remain open; no human answer rating, provider cache hit, native accessibility,
institutional authorization or deployment result is inferred from this run.
