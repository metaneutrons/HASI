# M2 operational events and separate identity topology

Date: 2026-10-19. Baseline: `ab46cdee0611963e0ee33fe4004dbf1f8806759f`.
Scope: one technical M2 #49 qualification slice under Plan V4, not complete
P1–P6 or institutional acceptance. The candidate changes and exact CI identity
are recorded in the implementation PR and milestone issue.

## Implementation and checks

- `apps/api/src/operational-events.ts` emits only the closed request event,
  backend UUID, registered route template, bounded method, status and monotonic
  duration. Fastify raw request logging remains disabled. Production uses the
  structured console sink; trusted compositions can supply a sink.
- `tests/operational-events.test.ts` passed three cases: ordinary request and
  forged ID, denied/unmatched hostile inputs with redaction sentinels, and a
  throwing sink whose payload never reaches responses or console logs.
- `apps/web/src/lib/server/core-api.ts` returns only a valid backend UUID through
  `x-request-id`. Client headers cannot choose that identifier.
- `apps/api/src/test-idp.ts` supports constructor-owned, bounded TLS material;
  explicit test mode and loopback-only binding/callback rules remain. Production
  OIDC validators and PKCE checks are unchanged.
- `tests/test-idp-tls.test.ts` uses an ephemeral CA and server certificate, with
  normal certificate verification, and covers HTTPS authorization/discovery,
  untrusted-certificate denial, HTTP compatibility, prohibited modes/callbacks
  and oversized TLS inputs. Together with OIDC and operational events, all
  41 focused tests passed. Root TypeScript and affected ESLint checks passed;
  the actual production Next.js build passed.

## Real process run with synthetic identities

`scripts/qualify-production-topology.ts` ran against a new disposable local
PostgreSQL 18.6 container, a production Next.js 16.4.2 build and Node v26.11.1.
There were two separate API child processes and a distinct Next.js child,
loopback TLS reverse proxies and a native HTTPS Test-IdP. Child environments were
allowlisted and contained no provider/plugin credentials. Certificate trust was
process-local; no TLS verification bypass or system trust installation was used.
The database URL guard requires a literal loopback host, explicit port, exact
test database and no query/fragment overrides.

The final run passed:

1. Real Next.js page and API delivery; authenticated API requests traverse the
   frontend's production transport and a fixed configured HTTPS API origin.
2. PKCE authorization starts on one replica and completes on the other using
   shared PostgreSQL transactions/sessions. The callback returns to `/admin`.
   The session cookie has the `__Host-` prefix, Secure, HttpOnly, Path=/ and no Domain.
3. Anonymous administration, forged sessions, mock persona login, unapproved
   Host/origin and authorization callback replay are denied. An untrusted TLS
   request fails with the expected self-signed-certificate error. A forged
   request ID is replaced by a backend UUID returned through the frontend.
4. Twenty-four concurrent session requests resolve the same stable subject.
   Median: **21.67 ms**; p95: **27.18 ms**. These are local descriptive readings,
   not agreed throughput or end-user latency thresholds.
5. One exact API process is stopped and restarted. A request directed to that
   restarted backend resolves the existing session and operator grant.
6. A signed authority downgrade immediately denies administration on both
   replicas. Logout invalidates the shared session across both replicas.

The run made **zero model calls** and no real HsH/Anny request or write. Processes,
TLS listeners and temporary key files were removed. The disposable database is
caller-owned; the operator discards it after subsequent local regression checks.

## Limits and next gates

This does not qualify an isolated healthy plugin worker, signed external plugin
distribution, multi-worker update/rollback, integrated model-budget topology,
automatic browser journeys or agreed technical performance thresholds. Those
remain M2/P1–P6/BUD-A1/WEB-A1 work. Existing container metadata checks must not be
reported as healthy plugin execution: the earlier Node base-image probe is
insufficient for that claim.

Actual iPhone/Android, native keyboard and VoiceOver/TalkBack, participants, real
HsH source/identity/vendor conformance and institutional approval remain final
M8-A1–A7. No technical synthetic result passes or waives those criteria.
