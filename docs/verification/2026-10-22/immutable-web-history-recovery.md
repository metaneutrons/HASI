# Protected-history recovery across immutable web images

Date: 2026-10-22. [Measured identities and observations](immutable-web-history-recovery.json).
This is bounded M7 technical operational evidence; M6/M7 acceptance remains open.

## Actual topology and inputs

The operator ran source `2b5f9e13479594b0a6131b899d0b1de5db66eeb8` in immutable
Linux/amd64 image `sha256:bd22d4f8bfc9b761942a8e92d7b149a5ce6fb03b9b25939f93ebaa6d20cb96e9`,
Node 24.22.0 as UID 1000. A separate disposable PostgreSQL 18 database, actual
TestIdP, two independent API processes and packaged reference 1.0.0 supplied
synthetic authority and data. The operator used host networking and a host-owned
same-path TMPDIR. It alone held the local Docker socket; sibling web containers
received only the generated public model CA file. No real model key or production
database configuration was supplied. Ten measured operator files match the
source commit byte-for-byte; the JSON retains their SHA-256 identities.

The application images were already qualified first-party post-format images:

| Selection | Revision | Immutable image |
| --- | --- | --- |
| Previous | `d2bcff0856ad3cd1d00dba0b3e33eb330c824282` | `sha256:e822e9132ef8fe6eab8e3093645b38e5321079d1c4f2f0d88a23a81ac29c7785` |
| Current | `ea79670ed42fe6f206068e9e74bc3c397f7a2f01` | `sha256:b09126e55e0ef943d47210c3367ebf0247b8ec38967988ed0831a5ea59120603` |

There was no tag-based selection, pull, rebuild of these application images,
namespace/key rotation or legacy verifier. OCI source/revision labels were
checked assertions, not publisher attestations. The reference artifact is a
workspace-local Git fixture, not independent publisher-distribution evidence.

The operator-only recipe appended to the existing Dockerfile was:

```dockerfile
FROM evaluation AS journey-operator
USER root:root
RUN apt-get update && apt-get install --no-install-recommends -y git openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node examples ./examples
RUN mkdir -p /opt/hasi-journey/pnpm-store /opt/hasi-journey/home && chown -R node:node /workspace /opt/hasi-journey
ENV npm_config_store_dir=/opt/hasi-journey/pnpm-store
ENV HOME=/opt/hasi-journey/home
USER node:node
RUN pnpm build:backend
RUN pnpm reference:prepare
COPY --chown=node:node LICENSE NOTICE ./
ENTRYPOINT ["pnpm", "journey:serve", "--web-images"]
CMD []
```

Its context was **only `git archive` of the exact source commit**, with an
operator-specific ignore file excluding node_modules and .git. This included
examples/LICENSE omitted from the ordinary app's copied files. It was not a
build from an operator checkout or secret-bearing environment. The production
Dockerfile/ignore rules remain unchanged. The pinned base, source/lock identities
and measured resulting image are retained; mutable Debian tool repositories do
not establish a future bit-for-bit reproducibility promise.

## Browser and state observations

The actual desktop browser completed TestIdP administration login, connected
the approved reference service, saved and activated its public configuration,
and separately approved personal mock consent. A real chat submission invoked
the protected chat/read handlers and created a server-bound result context.
The result card and dependent answer survived actual reload.

Terminal-only controls performed current → previous → current, then repeated
previous → current after provider-side mock revocation. There were **four live
replacements and five healthy image starts**, each with a distinct full
container ID and exact reported revision. The same API/IdP/account authorities,
signing material, scope, database and browser identity remained in use.

- Before opening the browser after each replacement, read-only SQL compared
  identities, revisions, value hashes and expiries. All 15, 16, 17 and 17 respective
  baseline rows were unchanged across the four replacements, including workspace,
  protected result contexts and the isolated budget; physical DB/volume identity
  was constant. The JSON retains comparable aggregate hashes.
- Previous-image reload restored the first card/answer. A new question completed
  another protected read. Forward reload restored both cards, and another
  question completed the third read. The observer recorded 6 fixture completions,
  three correlated latest-read results, zero omitted results, and four requests
  containing verified prior reference context. Prior-result/answer counters are
  aggregate occurrences across requests, not distinct-document counts.
- `revoke-reference` received correlated acknowledgements from both API replicas.
  Reload removed all three result bodies and their dependent answers. The three
  stored result contexts and budget remained unchanged; authority and workspace
  changed intentionally. No database deletion was used to manufacture denial.
- Rollback after revocation did not resurrect those bodies/answers. One further
  fixture-model request showed explicit connection recovery, which remained
  visible after the final forward reload. These response-specific statements
  are operator observations; no raw AX artifact was retained. The JSON records
  that observation and its evidentiary limit. Fixture calls increased 6→7 while
  all prior-reference/result/answer counters remained unchanged; the browser
  still exposed zero old cards.

There were **seven local fixture completions, zero actual provider requests**,
zero reference marks, journal/source-effect rows or observed executions. The one
reference invocation-bookkeeping row is not a count of distinct upstream reads.
No booking, cancellation, model quality, invoice saving or cache hit is inferred.

`quit` exited 0 and reported owned-process cleanup. Independent checks confirmed
all five web containers absent, fixture ports closed and generated directory
removed. All 17 caller-owned test-DB records remained unchanged after shutdown.
The owned browser tab and two-port local SSH tunnel were closed.

A separate read-only check of the public application still found exact serving
revision `16ad5020a002b451de77ee58d17a84dc2a3890a9` healthy. Its 553 still-active
pre-existing baseline rows were unchanged, zero missing/changed; one baseline
record's captured expiry had elapsed normally. The physical database/volume and
shared-budget fingerprint `72b2cc600f7c5c50ede3fb163cff6434957ed9465b21196f3b8d6fb61ad50f81`
were unchanged. The isolated fixture neither reset nor charged that ledger.

## Gates and limits

The focused three-file suite passed 48 tests; root types and scoped lint passed.
Independent review resolved partial-create cleanup/ownership, Docker selection,
origin-form routing and streamed-body bounds. Oversized 4097-byte and stalled
health bodies fail with cancellation/cleanup; an exact 4096-byte valid body passes.
The actual Linux Node 24 startup additionally verifies byte-stream support.
Full PostgreSQL push/exact-head CI and subsequent delivery are PR checkpoints,
not inferred from these focused results.

This complements the [actual Coolify rollback exercise](../2026-10-19/compatible-image-rollback.md)
with current protected-history-format reads. This run itself replaces only web
containers in the isolated topology; it does not qualify a public protected
production composition, roll back the Coolify control plane, restart all source
providers, prove physical network isolation, or admit a pre-format writer.
Existing qualified monitoring/UI evidence remains applicable. M6 actual-model
workflow/adversarial comparisons, human review/adjudication and thresholds still
block full M6/M7 acceptance. Real-device/institutional gates and positive Groq
cache proof remain M8, with CACHE-A1 specifically M8-A10.
