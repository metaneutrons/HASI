# Disposable-demo storage safeguards

Date: 2026-10-19. This is bounded M7 operational evidence, not complete
M2/M7 or institutional acceptance. The demo backup exception is unchanged.

## Qualified source and installation

[PR #124](https://github.com/metaneutrons/HASI/pull/124) merged as
`d0fae9cce662bf8a1dd32298fc74ae9de0f0e985` after exact-head CI
[39310079649](https://github.com/metaneutrons/HASI/actions/runs/39310079649).
Exact-main CI [39310823940](https://github.com/metaneutrons/HASI/actions/runs/39310823940)
also passed. Local PostgreSQL-backed qualification passed 1,156 tests plus one
intentional platform skip, backend build, root/web type checks and secrets.
The focused suites passed 24 controller checks and 13 maintenance checks;
both operational Node test suites (26 checks total) now run on CI Node 24/26.

The host installation completed at `2026-10-19T19:30:10Z`. It checked the
existing controller's pinned image, read-only controller bind and writable
state-directory bind before replacing source. Node 24.22.0 was copied from
that exact running image, compared byte-for-byte by SHA-256, then executed
and used for syntax checks on the host. No unpinned runtime download was used.

| Installed component | SHA-256 |
| --- | --- |
| Compiled deployment controller | `9d81da308a6bf6ee41012719d16a2d1d156bea75c377ab0f62242313768b56eb` |
| Host maintenance script | `41726d9da5fab351cffdd52c6bf43fd77e2fe213ea85b7a6d3b01ec11102f906` |
| Pinned-image Node binary | `67ca5783febb8bf85736c79fcdd92c8d6d465a0eb2a082672bcdfa76a506751c` |
| Private operator installer | `78cc135218000c1e63fea12b813cec9bb0a3073253650394b2da26b94909d0cc` |

The installer retained the previously installed controller as an immutable
recovery copy. Its stop/replace/restart helper was exercised locally with a
successful installation and injected stop, dry-run and rollback failures.
A failed stop still attempts restoration/restart; failed verification of a
rollback leaves the controller stopped rather than starting an unverified file.
These injected failures did not run on the public host.

## Observed behavior and preservation

At installation the root filesystem had 24,401,338,368 bytes available.
Dry-run and explicit apply both detected the in-flight exact-main build and
returned `skippedCount: 1`, with zero builder prunes and zero removed image tags.
This demonstrates build protection; it is not evidence of a low-space cleanup.
Offline countercases cover low/unavailable storage, active builds, container
image references and actual IDs, shared-lock contention and revalidation before
removal. The host was not deliberately filled to exercise the 8 GiB gate.

The updated controller resumed active/enabled. The maintenance timer is
enabled and waiting, with an initial delay of 15 minutes from activation
(`OnActiveSec=15min`) and an hourly interval thereafter. Its first scheduled
execution has not yet been observed in this record. The host records sanitized
installation metadata in its root-only operator-event directory.

Readback found the compatible public-demo floor `b53701a`, previous `69c87a5`
and current `442897d` images still present. Database and volume identities
were unchanged. All 345 still-active baseline rows were present and unchanged;
none had expired at this readback. The budget fingerprint remained
`0f16371ccf718735e0fbc510a17e448ad937e69f4b938e160812d867b7b7f5d3`.
No model call, budget reset, database replacement or volume deletion occurred.

At that checkpoint the public endpoint still reported ready at `442897d`,
while the automatic `d0fae9c` deployment was submitted. Its completed exact
revision/readiness and subsequent timer execution require separate readback;
this record does not turn a submitted deployment into a completed one.
See [the runbook](../../operations/demo-storage.md) and current
[M7 #54](https://github.com/metaneutrons/HASI/issues/54) for operational state.
