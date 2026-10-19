# Demo disk-full recovery

Date: 2026-10-19. This records an actual operational incident during the
`31fbf29` deployment, not a deliberately destructive test.

## Observation and recovery

Public readiness initially returned `ready` at `31fbf29`, then application 503
and proxy 503. The root filesystem had zero available space on a roughly
38,105 MiB filesystem. PostgreSQL reported repeated PANIC/no-space/write
failures during recovery. Its container had not restarted or been OOM-killed;
there were no observed kernel OOM kills. Coolify logged SQLSTATE `08006`.

Only owned/reconstructible operating material was removed:

- The exact gateway qualification transfer archive was verified by SHA-256
  before deleting its server copy; its original remains on the development Mac.
- The same nonce-owned extracted operator bundle was removed after checking its
  retained inventory digest and ownership. Its local original, server inventory
  and result records remain. No wildcard cleanup was used.
- Unused Docker build cache was reclaimed without removing volumes.
- Twenty-eight exact application image tags older than the mandatory compatible
  `b53701a` floor were identified as ancestors locally, checked against **all**
  running and stopped container image references, and removed without force.
  The compatible floor and all newer application images were retained. No
  application or database container was removed.

The first owned-copy/cache cleanup restored PostgreSQL readiness. Subsequent
bounded cache/image cleanup recovered approximately 6,314 MiB available space.
This is an observed recovery margin, not a proven long-term retention policy.
The Coolify control-plane container was restarted to recover failed database
connections; HASI and its database were not restarted. Coolify then concluded
the interrupted deployment as failed. The controller's historical record is
retained, and no duplicate manual deployment was submitted.

## Data evidence and limits

Read-only verification retained all 179 still-active rows from the older
rollback baseline, with zero missing rows and the same database container and
volume. Six original rows had expired normally. Two values had changed. The
shared budget had already changed while the old `bd59928` app was still ready,
so its older fingerprint cannot be claimed unchanged for this deployment.

A separate full budget snapshot was captured at the first `31fbf29` readiness,
before the disk incident. After recovery the exact row, revision, value and all
nine settled reservations matched that snapshot; SHA-256 of its canonical
snapshot remained
`f371cbf6687b7b62710df4f69f2990b555a846dd0bff04ada895a921efa13db1`.
No ledger initialization/reset, token-price change, provider call or booking
write was used for recovery. The synthetic shared spending guard was retained.

Before the next main deployment a fresh read-only checkpoint recorded 186
active rows, one budget row and the same database/volume. Its budget-row
fingerprint was
`0f16371ccf718735e0fbc510a17e448ad937e69f4b938e160812d867b7b7f5d3`.
Different digest formats above describe different projections; they are not
interchangeable. No secret or full database content is published here.

The actual incident supplies bounded diagnosis/recovery evidence. It does not
complete M7: automatic image/cache retention and disk-headroom enforcement,
independent monitoring, stable complete delivery, integrated connection-loss
journeys and the M1–M6 prerequisites remain open. The disposable demo's agreed
no-backup scope does not waive durable state or budget preservation.
