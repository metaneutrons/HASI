# Relay fixture port selection

Date: 2026-10-19. Repair baseline: `318d3ccf22822a0c156f91c42538ce31606045f5`.

Rebased PR #104 CI `39252468287`, Node 26 job `118059407414`, failed the
connect-timeout relay test: the child exited with code 1 before the first
connection. Node 24 passed. The child intentionally prints no configuration or
startup diagnostics, so this log alone does not establish the exact cause.

Inspection found an incompatible port-allocation probe. The fixture selected a
free port on `127.0.0.1`, but the real relay listens on `0.0.0.0`. On Linux, the
loopback probe can accept a port already held by the synthetic target on a
private interface; the wildcard relay then fails with `EADDRINUSE`. An isolated
`node:26-alpine` Docker probe reproduced this exact kernel behavior. The Mac
counterpart allowed the wildcard bind, so it cannot qualify this Linux case.

The fixture now probes the same wildcard address as the relay. A new Linux-only
countercheck binds a target/private port, demonstrates that loopback accepts
the same port while wildcard rejects it, and verifies that the allocator picks
a different available port. It is explicitly skipped on macOS. This removes
the demonstrated incompatible-address selection; the ordinary close-to-child-
startup gap remains and is not claimed eliminated.

No production relay code, network policy, timeout, connection cap, byte limit,
assertion, retry count or CI gate is relaxed. The focused Mac relay suite passed
16 tests with the one Linux countercheck skipped; scoped ESLint and whitespace
checks passed. Exact-head Linux CI must execute the new countercheck before
integration. This is bounded fixture evidence, not complete M2/P5 isolation
acceptance or proof that the historical failure had this cause.
