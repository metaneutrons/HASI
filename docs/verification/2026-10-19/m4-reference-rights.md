# M4 two-subject reference Anny read qualification

Date: 2026-10-19. Integration baseline: `4f73919b541f6096f60d29c52c8e9296a17e0ecd`.
Scope: synthetic M4 #51 subject/account/resource boundaries. This evidence is
not institutional Anny delegation or full milestone acceptance.

`tests/anny-reference-rights.test.ts` verifies two synthetic identities through
loopback TestIdP authorization-code flows and `OidcIdentityProvider`. Both use
the same application role. A trusted test-only `PluginAccountAdapter` maps their
distinct stable subjects to different fixture customer IDs and current resource
grants. The real `PluginAccountService.resolveAuthority`, host API, signed MCP
registry/plugin, `AnnyClient` and TCP HTTP Anny contract mock handle the reads.
Client writes are disabled; no real Anny service, credentials or model is used.

The focused suite passed **five cases** on Node v26.11.1 in the worker checkout.
Root integration then passed **12 cases across this suite and account-service
tests** on Node v26.11.1 and v24.21.0, affected ESLint and plain full-project
TypeScript. A broader worker lint attempt had lacked the web generated-project
prerequisite for the well-known route; it is not recorded as a passing full lint
run. Required CI remains the delivery PR's responsibility.

The integrated scenario establishes:

- A caller's query/body cannot select another subject, customer or grant set.
  The resource lists and own bookings differ for the two verified identities.
  Downstream booking-list requests use only the appropriate fixture customer ID.
- A permitted seminar-room availability read succeeds with a nonempty interval
  and reaches the actual mock HTTP endpoint. The same flow denies an ungranted
  computer-lab read before that availability endpoint is called.
- A cancellation proposal for the other customer's booking is denied. There
  is no cancellation HTTP request or business write.
- Changing the source grant takes effect on the next resource/bookings read.
  Revocation denies access without another downstream Anny request.
- Four separate negative cases make the reference mapping source report missing,
  ambiguous, duplicate and conflicting mappings. Current authority resolution
  fails closed and the account becomes unavailable, with no downstream read.

These mapping outcomes are explicit synthetic source-contract responses, not
tests of an implemented Anny account-discovery algorithm. They do not prove
that the real vendor detects ambiguity or enforces customer community rights.
Institutional identity release, supported customer delegation, actual resource
eligibility and vendor revocation behavior remain M8-A1/A3. Production TLS and
separate API/session topology have their own M2 evidence; this test uses the
explicit loopback HTTP test mode and an in-memory state store.
