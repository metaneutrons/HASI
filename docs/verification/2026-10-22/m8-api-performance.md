# M8-A9 local demo API performance qualification

Date: 2026-10-22. Result: the bounded local embedded-demo API run passed the
1,000 ms non-model API p95 target. This is local synthetic evidence; it does
not close M8 or establish performance for the public HTTPS deployment or
institutional TestIdP/two-API topology.

## Method and identity

The test used the optimized Next.js 16.4.2 standalone build at source commit
`b52598d705f938e52213c5bbd7691735bf7e3399` on branch
`fix/m8-self-service-qualification`. The API ran in test mode through an owned
HTTP loopback proxy to the embedded demo runtime and a local disposable
PostgreSQL database. Five distinct cookie jars established synthetic
employee sessions and linked demo-only Anny accounts. Preflight verified the
expected room and synthetic knowledge payloads and denied cross-workspace
knowledge-context resolution. The child received a fresh in-memory demo
secret and no provider credentials or budget bootstrap configuration.

The build command used a credential-scrubbed environment:

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME=/Users/fabian TMPDIR=/private/tmp LANG=en_US.UTF-8 NEXT_TELEMETRY_DISABLED=1 HASI_STANDALONE_BUILD=1 NEXT_PUBLIC_HASI_PUBLIC_DEMO=1 /opt/homebrew/bin/pnpm --filter @hasi/web build
```

The measured artifact's `BUILD_ID` was `mUVk-pauinNmaJzJu59HD`; its copy in
the standalone tree matched. The standalone server bundle SHA-256 is
`f9ee56c567cfa715f81e5fb7cec785a451bd4fdec80bb8d7ab8913da8a6dc857`. The
build files were observed at 2026-10-22 23:34 local time. An earlier work note
recorded a different generated build ID (`CUbriMY5PFXtnBLly25km`); no separate
build log for that earlier ID was retained. This result is tied to the
matching `mUVk-pauinNmaJzJu59HD` files present when the final run completed.

The stock qualifier initially stopped in preflight, before measured batches:
it requested `svc-001` revision 1 while the committed synthetic fixture is
revision 2. The qualifier used for the measured run derived the revision and
citation from the fixture and checked its ID, source, synthetic marker,
positive revision, and citation format. After the run, review found that
`.find()` could silently select the first of duplicate fixture IDs. The
current qualifier now requires exactly one `svc-001` match before applying
the same schema and citation checks. This selection guard is outside the
timed route. The measurement used qualifier SHA-256
`48e475738e638ef8aa4bc03599a1427a6ae8f3a1a37757ea666d007fd0c4d1ac`; the
current post-review file is not the exact file measured. No timing rerun was
made. Current targeted lint passed, and a separate fixture check confirmed
one `svc-001` match at revision 2 with citation
`knowledge:service_it:svc-001:2`.

The final tracked-run command was:

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME=/Users/fabian TMPDIR=/private/tmp LANG=en_US.UTF-8 HASI_DEMO_PERFORMANCE_QUALIFY=1 TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32791/hasi_topology_test /opt/homebrew/bin/node --import tsx scripts/qualify-demo-performance.ts
```

Each route ran two batches of 100 completed queries: five concurrent users,
20 sequential requests per user per batch. Caller timing includes dispatch,
receipt of the complete response, JSON parsing, and strict contract
validation. p95 uses nearest rank; any error or timeout fails its batch.

## Observed result

| Route | Batch 1 p95 | Batch 2 p95 | Samples per batch | Errors per batch |
| --- | ---: | ---: | ---: | ---: |
| `anny.resources` | 96.82 ms | 91.90 ms | 100 | 0 |
| `anny.availability` | 180.59 ms | 194.60 ms | 100 | 0 |
| `knowledge.search` | 323.28 ms | 310.84 ms | 100 | 0 |
| `knowledge.document` | 62.12 ms | 67.54 ms | 100 | 0 |
| `plugin-accounts.status` | 50.78 ms | 51.14 ms | 100 | 0 |

All ten normal batches passed the 1,000 ms threshold. Cold session setup was
211.27 ms and is reported separately. The same collector measured 100
`anny.resources` queries with a local 1,200 ms delay: zero errors, p95
1,347.32 ms, rejected by the same threshold gate. The countercase is not part
of the positive latency claim.

Run namespace: `demo-performance-2e7b24cf-2d44-420b-bd8c-ac627480d384`.
The harness reported `cleanupVerified: true`; the exact namespace was removed
transactionally after ownership and key checks. Operator notes record launch
of `postgres:18-bookworm` with
`--tmpfs /var/lib/postgresql:rw,nosuid,nodev,size=512m`, the exact container
name and host port, and successful `pg_isready`. The stop command printed the
container name, an exact-name listing showed it as `Dead`, then `rm -f`
completed and the next exact-name listing returned no rows. These are
operator observations; no container inspect output was retained. A bounded
Docker event query for the exact name returned no events, so image, mount, and
container-removal provenance are not independently verified by the harness or
engine-event evidence. No production database,
public endpoint, institution, live Anny service, model/provider, booking, or
cancellation was used. Synthetic login, consent, and context state existed
only in the disposable local namespace.

## Scope and retained evidence

This run covers the embedded local demo API in HTTP loopback test mode. It
does not measure public TLS/network performance, the public Hetzner deployment,
the separate institutional TestIdP/two-API topology, model latency, UI input
feedback, booking writes, all availability fan-out, or production load. Those
omissions are not passes. M8-A9 remains open for root's acceptance decision;
M8 remains open.

The result JSON preserves the exact route counts, p95 values, run namespace,
fixture identity, harness namespace-cleanup status, and source/build hashes.
The collector was not changed. A minimal corrected scratch runner and its earlier raw output
remain privately at `/private/tmp/hasi-m8-a9-final/`; runner SHA-256
`1818f6b43aa0c5bdc3b55655acfb99de5d88c9a1aad321224211eeb0e6844209`, raw JSON
SHA-256 `637bb494ff4fc2943428f94faeec4376eed69594aea66d093c3e3c483f8614c3`.
The canonical tracked-run raw JSON was also retained privately with SHA-256
`e1870db9502c63518f7e7d5ede54dcc64aa4ad35938f803aab7875e48ae75bca`.

Root checked the exact current fixture guard separately: one valid current fixture passed; missing and duplicate IDs, a non-synthetic marker, revision zero, and a mismatched citation were each rejected with `demo_knowledge_fixture_invalid`. This offline guard probe made no database or provider call and does not change the retained timed-run source identity.
