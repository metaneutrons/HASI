# Binding-driven proposal invalidation API slice

Date: 2026-10-19. Local implementation evidence, not deployment or M2 acceptance.

The API composes its proposal guard through the registry, which retains the
server-owned signing key and scope. Hosted compositions require durable registry
authority. Process-local development retains its existing confirmation checks.
Neither a request nor a plugin can select a key, scope, observation or secret.

The guard checks the exact proposal's owner before any registry observation or
audit projection, then rechecks ownership after the ledger read. This relies on
the application's immutable proposal-owner invariant; it is not a transaction
across unrelated owner records. A foreign already-invalidated proposal cannot
trigger a pending outbox projection. Invalid signatures are not accepted as
invalidation evidence.

A definitive changed binding or signed withdrawal invalidates only a pending
proposal, retaining a signed event on the same CAS-written row. An owner read or
confirmation receives a fixed HTTP 409 `proposal_invalidated`, without old
arguments or previews. An unavailable authority leaves the proposal unchanged
and returns HTTP 503; it is not treated as revocation. Executing/unknown outcomes
retain their execution identities and existing reconciliation requirements.
The existing execution-time authority and CAS checks remain in force.

Invalidated proposal-content retention is an absolute server-derived deadline:
the proposal expiry plus 24 hours. Reads do not extend it. The separate digest-only
audit projection still has the provisional no-expiry policy documented in
`proposal-invalidation-ledger.md`; production retention and a background drain
remain unresolved. Projection retry occurs only on a subsequent exact owned read,
not by a newly claimed background worker.

Root verification on Node 24.21.0:

```sh
pnpm exec vitest run tests/plugin-lifecycle.test.ts \
  tests/proposal-binding-guard.test.ts tests/proposal-invalidation.test.ts \
  tests/action-reconciliation.test.ts tests/server-demo.test.ts
```

All 62 tests passed. This includes an HTTP-level disable/re-enable countercase:
foreign reads cause no observation, the owner's read durably invalidates the
proposal, repeat confirmation cannot change it and no execution occurs. A second
HTTP case leaves the exact pending revision unchanged during GET/confirmation
authority outages, then executes once after recovery despite repeated confirmation.
Scoped root TypeScript and ESLint passed. Independent API review found no blocker.

The compatible-core floor, old-writer drain and compatible forward-recovery
exercise remain required before shipping the new signed registry field. Frontend
invalidated/retry states are a separate concurrent implementation. No live
provider, institutional business write, state reset or milestone acceptance was
performed by this qualification.
