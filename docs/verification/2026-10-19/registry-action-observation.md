# Trusted action-binding observation

Date: 2026-10-19. Local implementation: `3437d6d` over the unshipped action
invalidation branch. This is an observation primitive, not API invalidation,
deployed behavior or M2 acceptance.

The registry distinguishes a current binding, a definitive withdrawal and an
unavailable observation. Withdrawal requires a verified signed disabled-state
record or a verified signed catalogue disconnect. Missing records, invalid
signatures, failed storage, a missing managed contract or an unavailable worker
are unavailable, rather than evidence of revocation. A signed local disable can
still be established independently of worker availability.

Review found that the former refresh mutated a shared plugin object while
awaiting configuration. The corrected refresh builds an invocation-local copy,
then fences persisted state and signed catalogue connection revisions before
publishing the complete snapshot. Barrier-controlled tests interleave activation
and catalogue disconnection with the settings read. Both reject the stale read;
a subsequent stable observation succeeds or observes the signed withdrawal.

Root verification on Node 24.21.0:

```sh
pnpm exec vitest run tests/registry-action-observation.test.ts \
  tests/registry.test.ts tests/managed-registry-contract.test.ts
```

All 25 tests passed: eight observation cases, eleven registry cases and six
managed-contract cases. A separate selection including
`managed-plugin-contract.test.ts` passed 19 tests; it is a different selection,
not contradictory evidence. The author also passed full root TypeScript and
scoped ESLint checks; independent read-only review found no remaining blocker
in this bounded change.

Observation is not authorization. Execution still requires the existing actor,
binding, policy, exact-confirmation and compare-and-set checks. API/signing/status
wiring, audit retention/drain behavior and the compatible-core floor, old-writer
drain and forward-recovery exercise remain open before shipping the feature.
