# Local five-user demo query performance

Date: 2026-10-19. Application build baseline:
`bd599280ee16d9b002697c6af38a0d1237269fc3`. This is the first bounded local
measurement against the agreed Plan V6 API target. It does not accept full
M2/M7, qualify public HTTPS performance or establish the 200 ms UI target.

## Topology and method

The actual optimized Next.js 16.4.2 standalone build ran in a separate Node
24.21.0 process on the development Mac. It used the actual demo runtime,
application API, signed registry, Anny mock, permission-aware knowledge fixtures
and a disposable loopback PostgreSQL database. Requests passed through an owned
loopback HTTP proxy, including the runtime's internal origin-pinned requests.
This is the embedded demo API topology, not the separate production API/IdP
topology or Hetzner throughput. HTTP loopback explicitly selects test API mode
and non-Secure local cookies; public HTTPS policy/transport is not qualified.

Five distinct cookie jars obtained server-issued workspaces and employee test
sessions, then explicitly linked their synthetic Anny accounts. Cyclic foreign
workspace knowledge-context lookups were denied before measurement. No actual
SSO, institutional data, live Anny or model endpoint was used. The child process
received no provider credentials or budget bootstrap configuration.

Each route ran two batches, each with five concurrent streams of 20 sequential
requests: 100 completed samples per batch, 1,000 measured queries overall.
Time includes dispatch, receipt of the complete response, JSON and strict
contract validation. Anny host provenance is validated as well as resource and
interval contents. Errors/timeouts invalidate a batch. The p95 calculation is
nearest rank, with a maximum permitted p95 of 1,000 ms. Cold session setup was
recorded separately at 461.10 ms.

## Observed result

The [sanitized result](demo-performance-local-result.json) preserves the exact
build ID, source/fixture hashes, run namespace and both batches.

| Query | Batch 1 p95 | Batch 2 p95 |
| --- | ---: | ---: |
| Authorized resource catalog | 181.43 ms | 120.16 ms |
| One permitted workplace, exact future 60-minute availability | 131.54 ms | 110.32 ms |
| Synthetic Service-IT knowledge search | 446.55 ms | 542.57 ms |
| Authorized cited document lookup | 113.07 ms | 118.05 ms |
| Linked plug-in account status | 82.00 ms | 89.39 ms |

All ten batches completed 100 samples with zero errors. The same collector
then measured 100 resource queries with an intentional local 1,200 ms delay:
p95 1,339.12 ms, zero errors, rejected by the same target gate. The overall
qualifier succeeds only when the normal batches pass and this countercase is
rejected. The delayed result is not included in the positive latency claim.

The child and proxy were stopped, and only marker-owned state in the exact
nonce namespace was removed transactionally after checking all keys. Cleanup
was verified. The shared production budget, database and demo service were
not accessed.

## Development failures and limits

Three preceding attempts failed during preflight before any measured batch.
The instrument initially assumed the wrong session-mode label, omitted the
host provenance envelope and resolved an import-only package through CommonJS.
Those assumptions were corrected against the actual runtime contracts. Its
first cleanup failed because a workspace created before schema validation was
not recorded. Root verified the exact owner marker and two known registry keys,
removed only those three rows, and read back an empty namespace. Cookie IDs are
now recorded before payload validation, cleanup always closes its pool, and
the later attempts all verified cleanup.

The query set does not cover a complete conversational multi-resource search,
all availability fan-out, admin mutation, generation latency, provider limits,
public network/TLS, mobile rendering or production load. UI input-to-visible
feedback at 200 ms still needs its own instrument and delayed countercase.
Required CI, review, merge and deployment remain separate gates.

Run only with the fixed disposable loopback database and explicit opt-in, after
building with `NEXT_PUBLIC_HASI_PUBLIC_DEMO=1 HASI_STANDALONE_BUILD=1`:

```sh
HASI_DEMO_PERFORMANCE_QUALIFY=1 \
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32775/hasi_topology_test \
node --import tsx scripts/qualify-demo-performance.ts
```

Use a credential-free environment. The runner rejects ambient production,
provider-credential and PostgreSQL override variables; it never starts a build
or selects a public target itself.
