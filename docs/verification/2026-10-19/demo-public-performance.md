# Public five-user API performance

Date: 2026-10-19. Status: **the knowledge-search 1,000 ms p95 target still
fails**. Fabian's subsequent Plan V7 decision transfers acceptance of that
API threshold to M8-A9; it no longer blocks M2/M7. The local ≤ 200 ms UI gate
remains. The failed measurements below are preserved unchanged. These are
synthetic, non-model public HTTPS measurements. They do not
establish UI response time, full M2/M7, institutional rights or model quality.

## Method and identities

Both runs used the same reviewed runner, SHA-256
`e3f12fa9bcfad5d380103cd933b37675528cd550767652d44cf4ba4dd48b6b6e`,
and its fixed public origin/route/body allowlist. Five freshly authenticated
synthetic employees had separate demo workspaces and explicit demo-only Anny
consent. Each batch collected 20 validated responses per user at five concurrent
users: 100 samples, nearest-rank p95, with two batches planned per route. Errors
and timeouts fail the batch, with no retries. Cold sessions are separate.

The caller used Node 26.11.1 on macOS arm64. Timings include HTTPS, complete
bounded JSON acquisition and contract validation. The pinned local source
hashes identify the collector/contracts; they do not assert that every deployed
implementation file is identical to that local reference checkout. The expected
public build revision is independently checked before requests.

The API contract's same local collector previously accepted the normal case and
rejected an intentionally delayed local countercase; see
[local query qualification](demo-query-performance.md). No artificial delay was
introduced on the public server. The probe invokes neither chat/generation nor
booking/cancellation; only fresh test login/consent/context state is created.
Owned workspaces remain under normal expiry, without deleting others' data.

## Observed results

| Route | Baseline `69c87a5`, batch 1 / 2 p95 ms | Loopback `c4c55ef`, batch 1 / 2 p95 ms |
| --- | --- | --- |
| Anny resources | 506.47 / 479.14 | 520.27 / 462.73 |
| Anny availability | 508.53 / 454.43 | 437.60 / 401.37 |
| Knowledge search | **1,634.99** / not run | **1,315.45** / not run |
| Knowledge document | Not run | Not run |
| Personal account status | Not run | Not run |

Each run stopped after the first failed knowledge batch: 500 valid measurements,
566 HTTP requests, zero observed response errors and zero model/chat/generation
calls. The five fresh sessions and all measured resource/availability batches
passed; neither entire API performance run passed. The omitted knowledge/account
batches must not be represented as measured.

The baseline ran at 19:00:25.673–19:01:26.791 UTC. Its original raw JSON was not
retained; the prior loopback report preserves its observed aggregate values.
The repeat ran at 19:42:53.150–19:43:47.743 UTC against exact build
`c4c55efc9506b8bbfc273101baff80b20c2d3cfb`. The host's loopback flag was
verified active and the automatic deployment was completed before launch, with
no pending physical build. The repeat's knowledge median was 1,122.51 ms and
maximum 1,483.89 ms; cold-session p95 was 654.42 ms (five samples).

[The public result artifact](demo-public-performance-loopback.json) preserves
the repeat's measured fields, route sample/error counts and timing digests.
Only the local ownership-file pathname was removed. Original result SHA-256:
`410712ff11e25eacfa4996439e59532c68bc9a3ffa2280bbb909801093d2a643`.
Its original private copy is retained with mode 0600. Because the measurement
failed fast, the runner did not perform its final revision check; separate
operational readback is not mislabeled as that unrun check.

Loopback reduced the observed knowledge p95 but did not meet the target.
PR #126 subsequently merged the content-keyed compiled output-validator reuse
as `84818822ecbbbdcad12d8b805c3dd62d7800dc5c`, with successful head
CI39314172508 and main CI39314872469. Public readiness reached that exact
revision, but this report contains no post-#126 measurement. A prepared repeat
was not launched after Fabian deferred the API acceptance target; no result is
inferred for the new candidate. Future M8-A9 qualification must identify its
then-current source and deployment. Neither run changes source
rights or proves a provider prompt-cache hit or billing savings.
