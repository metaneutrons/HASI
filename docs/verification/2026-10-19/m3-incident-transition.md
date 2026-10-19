# Synthetic incident transitions and deployed knowledge journey

Date: 2026-10-19. Integration baseline:
`c8d1631747d4882fd993827db90c5011f6eb4c49`.
Scope: technical M3 incident freshness and public-demo source/context checks.
This does not accept M3 before its remaining dependencies or qualify M8.

## Signed incident transition

The second scenario in `tests/knowledge-adapter-flow.test.ts` sends one
synthetic HTML incident through the actual `WebContentAdapter`, exact content
review, `ContentSnapshotProducer`, signed source exports, institutional
repository, signed MCP/registry, host context store and API. Source transport,
embedding vectors, identities, authority and time are controlled test fixtures;
the store is in-memory and requests use Fastify injection.

It observes active revision 1, then a newly signed resolved revision 2 without
changing the text. The former context becomes exactly `{status: unavailable}`
with its context ID and no documents; the former source citation returns 404.
After the incident validity interval ends, both retrieval and retained context
deny the incident even while the source snapshot is otherwise fresh. After
source expiry, search fails closed. A fresh signed snapshot restores active
revision 3 and its current citation; the old contexts/citations remain denied.
Unchanged text is embedded only once throughout the transition. This is not a
live incident feed or an embedding quality measurement.

## Public-demo network exercise

`scripts/qualify-demo-knowledge.ts` targets only the fixed public synthetic demo.
It requires explicit opt-in, verified TLS and an exact expected deployment SHA.
Responses are bounded, redirects are observed without following them and only
known bounded cookie pairs are retained in the runner's memory. No provider
key, admin session or business tool is used.

The journey uses student and employee sessions in the same newly created test
workspace with distinct session values. It checks German/English documents,
revisioned citations and freshness fields, source-filtered search, denied
employee/admin-only content, own versus foreign retained context, wrong source
revision and the restricted reviewed HTML source link. All returned search and
context documents must remain synthetic. The generic demo audience rules are
fixtures, not institutional ACL evidence.

The runner authenticates each observed session before logout and probes a
protected document with the old session afterward. A logout HTTP 200 alone is
insufficient. Missing/unknown credentials or failed invalidation make cleanup
unverified and the result unsuccessful. Normal session and context records use
the deployed durable store; synthetic workspace/context records retain their
normal TTL. This run is not free of database I/O or temporary session writes.
It makes zero chat/model calls and changes no bookings, admin settings or
budget policy.

The dated deployment check uses this exact SHA; for a later run, first verify
and explicitly select its replacement revision:

```sh
HASI_DEMO_KNOWLEDGE_QUALIFY=1 \
HASI_EXPECTED_REVISION=c8d1631747d4882fd993827db90c5011f6eb4c49 \
pnpm exec tsx scripts/qualify-demo-knowledge.ts
```

The script's mocked guard suite covers the allowed journey and denied opt-in,
revision/TLS/cookie boundaries, hidden result leaks, workspace changes, missing
session acknowledgement and a no-op logout that returns 200. These countercases
qualify the measurement logic; the actual network result is separate evidence.
The public synthetic demo does not serve the signed institutional incident
pipeline exercised above, so their results are not interchangeable.

The [actual network result](m3-demo-knowledge-result.json) passed all eight checks
at the exact baseline revision above: 23 HTTP requests, zero chat/model calls,
and both observed sessions verified invalid after logout. Runner source
SHA-256: `ec6a67c444689f84af6c12759b18a409011420407f45b4d048cc44d161071e3d`. These are selected runner/source identities,
not complete transitive provenance. The 15 cases across the adapter and guard
suites pass on Node v26.11.1 and v24.21.0; the 13 guard cases are mocked
measurement counterchecks, separate from the actual network run. Scoped lint,
full root TypeScript and diff checks pass. Hosted CI is recorded in the delivery
PR and M3 #50. Institution-specific source rights, incident semantics, native
devices and owner acceptance remain M8. M2 managed-runtime/admin/distribution
work remains open independently of these bounded M3 checks.
