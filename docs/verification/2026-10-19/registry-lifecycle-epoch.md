# Active registry lifecycle epochs

Date: 2026-10-19. Scope: M2/P3-A3/P5-A3 supporting action-binding correction,
not complete proposal invalidation or immutable invalidation audit.

The registry previously hashed active manifest, enablement, configuration and
transport policy. A disable/enable sequence could restore exactly the previous
binding if no proposal access occurred while disabled. A pending action could
therefore become eligible again under its original binding. Managed deployment
routes already have a separate monotonic revision, but local enablement and
ordinary remote-manifest transitions did not.

Active registry state now includes a signed opaque lifecycle revision. A change
to enablement or the active manifest replaces it within the same state CAS.
No-op enablement and candidate discovery retain it. The proposal/invocation
binding includes that revision, so returning to the same visible settings does
not restore old action eligibility. Replicas and reconstructed registries read
the same signed revision. Configuration activation and managed route changes
retain their existing independent fences.

Existing signed state without the new field is verified against its original
signature before use. The first effective transition adds the revision. The
registry never adds the field before verifying a stored record and never
re-signs an unverified injected revision. This preserves stored plugin state;
no application database, session or budget reset is involved.

Focused tests cover two registry instances, no-op enablement, disable/enable,
reconstruction, candidate-only changes, actual activation, an existing signed
record without a revision, and rejection of a modified unsigned revision.
The registry, action-reconciliation and managed-contract tests passed together
(24 tests), including an API-level countercheck: the old proposal makes zero
writes after disable/enable; a freshly prepared proposal confirms successfully
and makes exactly one write. The registry suite contains 8 tests. Scoped ESLint and root TypeScript checks passed under Node 24.
Exact integration CI and delivery are recorded separately in #49/#47.

This changes binding identity, so pre-change pending proposals require fresh
preparation. Claimed executions keep their execution IDs and existing unknown
outcome handling; this change does not add a replay path. Explicit invalidated
status/audit, unavailable-versus-withdrawn classification and their integrated
browser/runtime qualification remain separate work.

Independent review found a deployment gate: older binaries strictly reject the
new signed field. Mixed-version serving and rollback to a pre-epoch binary are
therefore not qualified. This candidate must not ship until a reviewed migration,
writer-drain and forward-recovery/minimum-version strategy is implemented and
exercised. The no-store install constructor was corrected to retain the seeded
epoch; a process-local reconstruction regression now passes. These are open gates,
not backward-compatibility promises or accepted rollback evidence.
