# Managed installer administration and private control plane

Date: 2026-10-19. Integration baseline: `9aea970a2d4f0c01dd7286425448d97c75dcc28c`.
Scope: M2/P5/P6 implementation follow-up, not full milestone acceptance.

The standalone trusted worker composes the actual Docker driver, coordinator,
route binding, signed settings, candidate manifest preflight, credential-grant
fence, private gateway and signed administration RPC. The production API launcher
constructs the RPC client and settings/route bindings without a Docker socket.
The admin exposes approved releases, initial configuration, explicit review,
activation, cancellation, rollback, synchronization and reconciliation. It does
not accept repository URLs, image addresses, arbitrary origins, raw launch
policies, actor identities or secret references from the browser.

Focused tests exercise the actual coordinator with a simulated deployment
driver. They cover staged review, update/rollback, exact cancellation,
uncertain stage/delete outcomes, reconstruction, lost intent acknowledgement,
same-command replay denial, changed payloads, stale state, manifest preflight
failure, current admin revocation, copied signed completion records,
same-digest candidate replacement during preflight, schema incompatibility and
configuration synchronization while a candidate exists. A separate reconcile
can resolve coordinator state without claiming a missing original command
completion was recorded. The historical receipt remains uncertain; current
installation state is a separate field.

Real loopback HTTP tests exercise signed RPC, wrong scope/key/actor/body/method,
expiry, cookie/origin/query denial, bounded responses and current service
authority. Responses are signed against a fresh request nonce; a loopback
impersonator replaying an earlier valid signed response is rejected. A full
32-installation catalogue larger than the former 256 KiB cap roundtrips within
the new bounded response budget. Candidate preflight tests use a real synthetic HTTP server, a
simulated exact Docker endpoint resolver and synthetic credentials. They reject
manifest mismatch, HTML, redirects, authentication failure, invalid credential
headers, oversized bodies and a moved endpoint after fetching.

The worker composition test uses the actual private listeners, signed authority
directory and disposable PostgreSQL. It prepares configuration before any
container exists, closes/reconstructs the worker **within one test process**,
reads the persisted revision and denies a freshly revoked signed administrator.
Its Docker socket path is intentionally nonexistent: this is setup/state/RPC
evidence, not actual container install/update or OS-process restart evidence.

Independent review found and prompted repairs for false completed outcomes,
completion-record replay, same-release candidate replacement, synchronization
eligibility and stale runtime credentials. Credential snapshots bind public
custody revisions before Docker I/O; gateway resolution/dispatch denies changed
or revoked assignments rather than inheriting a fresh grant for an old runtime.
No real provider call, business write, budget reset or production state mutation
is part of these tests.

The first local full build passed, including the production Next.js build. The
initial full regression/coverage run passed 947 tests in 102 files; later repair
tests and mandatory pre-push/CI results are tracked at the candidate revision in
#49. The first full lint run found one unnecessary test assertion, which was
removed; the subsequent full lint passed. These observations do not qualify
unexecuted browser or container cases.

Still required under the unchanged plan: actual deployed Linux managed lifecycle
and recovery, external artifact inventory/source acquisition, capability/claim
review presentation, host registry pin adoption after managed updates, explicit
pending-action invalidation and immutable audit, and remaining browser/admin and
cross-contract matrices. A configured entrypoint is not deployed qualification.
Real device/native assistive technology and institutional acceptance remain M8.
